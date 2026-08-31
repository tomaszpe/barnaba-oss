"""Acceptance test for the WHOLE of `process_chunk`, not just the models and helpers.

It guards one property that cannot be checked at class level: the response describes ONLY the
work done for the current request. Inherited provenance would describe different audio and be
false evidence the gateway has no way to detect - and repairing that on the gateway side
(comparing `decode_id`) would only mask the wrong source.
"""
import asyncio
import json
import sys
import time
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

import whisper_service as ws  # noqa: E402
from provenance import ALIGNMENT_EXACT, ALIGNMENT_FILTERED_WINDOW, ALIGNMENT_UNALIGNED  # noqa: E402

SR = 16000
PROVENANCE_FIELDS = (
    "decode_id", "input_pcm_sha256", "input_start_sample", "input_end_sample",
    "decode_requested_at_ms", "decode_started_at_ms", "decode_finished_at_ms",
    "executor_wait_ms", "inference_ms", "worker_total_ms", "decode_total_ms",
    "transcribe_status", "provenance_status", "provenance_reason", "confirmed_word_spans",
    "partial_provenance_status", "partial_word_spans", "partial_alignment_status",
    "stable_provenance_status", "stable_word_spans", "stable_alignment_status",
    "text_token_count", "span_token_count",
    "alignment_status", "alignment_reason", "unaligned_word_count",
    "non_word_level_chunk", "aligned_span",
)

# Two decodes of the same utterance: LocalAgreement-2 only confirms a prefix once it has seen
# it a SECOND time, so a single call yields no delta. Without this, the span assertions would
# have to hang under `if response.confirmed_text:` and would pass while checking nothing.
HYPOTHESIS_1 = "Hiob sprach"
CHUNKS_1 = [
    {"text": "Hiob", "timestamp": (0.0, 0.5)},
    {"text": "sprach", "timestamp": (0.5, 1.0)},
]
HYPOTHESIS_2 = "Hiob sprach zum Herrn"
CHUNKS_2 = CHUNKS_1 + [
    {"text": "zum", "timestamp": (1.0, 1.5)},
    {"text": "Herrn", "timestamp": (1.5, 2.0)},
]


def speech(seconds=2.0, amplitude=0.2):
    t = np.linspace(0, seconds, int(SR * seconds), dtype=np.float32)
    return (amplitude * np.sin(2 * np.pi * 220 * t)).astype(np.float32)


@pytest.fixture
def session(monkeypatch):
    """A real service session with the model and VAD stubbed out."""
    ws.sessions.clear()
    session = ws.TranscriptionSession("test-session")
    ws.sessions["test-session"] = session

    monkeypatch.setattr(ws, "should_transcribe", lambda audio: True)
    monkeypatch.setattr(ws.WhisperSingleton, "get_instance", classmethod(lambda cls: object()))
    monkeypatch.setattr(session.vad_processor, "process_chunk",
                        lambda audio: (None, True), raising=False)
    yield session
    ws.sessions.clear()


def call(audio, is_final=False):
    request = ws.StreamChunkRequest(
        session_id="test-session", audio=audio.tolist(), sample_rate=SR, is_final=is_final
    )
    # Python 3.14: no implicit loop on the main thread -> `asyncio.run`.
    return asyncio.run(ws.process_chunk("test-session", request))


def stub_pipeline(monkeypatch, text, chunks):
    """Substitutes the model result without running Whisper.

    The singleton is stubbed as well: without that the test pulls the real model from HF
    (200 s) and is unsuitable for CI.
    """
    monkeypatch.setattr(ws, "_run_pipeline", lambda pipe, audio, kwargs, use_chunking=False: {
        "text": text, "chunks": chunks,
    })
    monkeypatch.setattr(ws.WhisperSingleton, "get_instance", classmethod(lambda cls: object()))
    monkeypatch.setattr(ws.WhisperSingleton, "get_prompt_ids", classmethod(lambda cls: None))
    monkeypatch.setattr(ws, "_log_whisper_runtime_diagnostics", lambda *a, **k: None)


def decode_until_confirmed_delta(monkeypatch):
    """Drives the session to a CONFIRMED delta. Returns (response_1, response_2)."""
    stub_pipeline(monkeypatch, HYPOTHESIS_1, CHUNKS_1)
    first = call(speech(2.0))
    stub_pipeline(monkeypatch, HYPOTHESIS_2, CHUNKS_2)
    second = call(speech(2.0))
    return first, second


def test_request_without_decode_has_no_provenance_at_all(session, monkeypatch):
    """Buffer too short: no provenance field may be populated."""
    response = call(np.zeros(int(SR * 0.2), dtype=np.float32))
    for field in PROVENANCE_FIELDS:
        assert getattr(response, field) is None, field


def test_second_request_never_inherits_the_first_decode(session, monkeypatch):
    """Core of the acceptance test: A decodes, B does not - B must have clean fields."""
    stub_pipeline(monkeypatch, "Hiob sprach", [
        {"text": "Hiob", "timestamp": (0.0, 0.5)},
        {"text": "sprach", "timestamp": (0.5, 1.0)},
    ])
    first = call(speech(2.0))
    assert first.decode_id == 1, "the first request must perform a decode"
    assert first.input_pcm_sha256

    # Second request: too little new audio to trigger a decode
    monkeypatch.setattr(session.audio_buffer, "should_process", lambda: False)
    second = call(np.zeros(int(SR * 0.1), dtype=np.float32))

    for field in PROVENANCE_FIELDS:
        assert getattr(second, field) is None, field
    assert second.decode_id != first.decode_id or second.decode_id is None


def test_decode_raising_does_not_inherit_previous_provenance(session, monkeypatch):
    """A pipeline exception must not leave someone else's evidence behind.

    We do not assume the exception propagates - we guard the PROPERTY: whatever happens, the
    next response without a decode has clean fields.
    """
    stub_pipeline(monkeypatch, "Hiob sprach", [{"text": "Hiob", "timestamp": (0.0, 0.5)}])
    first = call(speech(2.0))
    assert first.decode_id == 1

    def boom(*args, **kwargs):
        raise RuntimeError("pipeline down")

    monkeypatch.setattr(ws, "_run_pipeline", boom)
    try:
        failed = call(speech(2.0))
    except Exception:
        failed = None
    if failed is not None:
        # If the service returned a response despite the error, it must not carry A's evidence either.
        assert failed.input_pcm_sha256 != first.input_pcm_sha256 or failed.decode_id != first.decode_id

    # Directly, rather than via "the next request does not decode": that would ALSO pass with a
    # session locked by the in-progress flag, i.e. under exactly the failure being guarded.
    assert session.transcription_in_progress is False

    monkeypatch.setattr(session.audio_buffer, "should_process", lambda: False)
    after = call(np.zeros(int(SR * 0.1), dtype=np.float32))
    for field in PROVENANCE_FIELDS:
        assert getattr(after, field) is None, field


def test_failure_before_the_inner_try_still_releases_the_session(session, monkeypatch):
    """An exception from the snapshot escapes OUTSIDE the inner `try` - the flag must still clear.

    Without `try/finally` around the whole cycle, `transcription_in_progress` stayed `True` and
    the Whisper session rejected every subsequent chunk as `coalesced_skip` for the rest of the
    process lifetime.
    """
    stub_pipeline(monkeypatch, HYPOTHESIS_1, CHUNKS_1)

    def boom():
        raise RuntimeError("snapshot down")

    monkeypatch.setattr(session.audio_buffer, "snapshot_for_decode", boom)
    with pytest.raises(RuntimeError):
        call(speech(2.0))

    assert session.transcription_in_progress is False


def test_exact_delta_returns_complete_spans(session, monkeypatch):
    """The production span path, checked UNCONDITIONALLY.

    An earlier version hid these assertions under `if response.confirmed_text:` - with no
    LocalAgreement confirmation the test was green without touching the sidecar once.
    """
    first, second = decode_until_confirmed_delta(monkeypatch)

    # First decode: it happened, but confirmed no delta - the status has to SAY so.
    assert first.confirmed_text == ""
    assert first.provenance_status == "no_confirmed_delta"
    assert first.provenance_reason is None
    assert first.partial_text == HYPOTHESIS_1
    assert first.partial_provenance_status == "complete"
    assert [span["text"] for span in first.partial_word_spans] == HYPOTHESIS_1.split()

    assert second.alignment_status == ALIGNMENT_EXACT
    assert second.transcribe_status == "accepted"
    assert second.confirmed_text == HYPOTHESIS_2
    assert second.provenance_status == "complete"
    assert second.provenance_reason is None, "complete evidence has nothing to explain"
    assert len(second.confirmed_word_spans) == len(second.confirmed_text.split())
    assert [s["text"] for s in second.confirmed_word_spans] == second.confirmed_text.split()
    assert all(s["end_sample"] > s["start_sample"] for s in second.confirmed_word_spans)
    # The spans describe ONLY the decoded snapshot, not some arbitrary point on the time axis.
    assert second.confirmed_word_spans[0]["start_sample"] >= second.input_start_sample
    assert second.confirmed_word_spans[-1]["end_sample"] <= second.input_end_sample
    assert second.partial_text == "zum Herrn"
    assert second.partial_provenance_status == "complete"
    assert [span["text"] for span in second.partial_word_spans] == ["zum", "Herrn"]
    assert second.stable_text == "Hiob sprach"
    assert second.stable_provenance_status == "complete"
    assert [span["text"] for span in second.stable_word_spans] == ["Hiob", "sprach"]


def test_decode_provenance_event_is_emitted_after_the_delta(session, monkeypatch):
    """Telemetry must see the span verdict, not merely the fact that a decode happened.

    Writing history and the event BEFORE `process_with_spans()` produced logs without
    `provenance_status` and without `confirmed_word_spans` - the first run could not compute
    from them what this track declares as its result.
    """
    events = []
    real_diag = ws._log_whisper_diag
    monkeypatch.setattr(
        ws, "_log_whisper_diag",
        lambda event, **fields: events.append((event, fields)) or real_diag(event, **fields),
    )

    _, second = decode_until_confirmed_delta(monkeypatch)

    decode_events = [fields for event, fields in events if event == "decode_provenance"]
    assert len(decode_events) == 2, "one event per decode"
    first_event, last = decode_events
    assert first_event["provenance_status"] == "no_confirmed_delta"
    assert first_event["confirmed_word_span_count"] == 0
    assert last["provenance_status"] == "complete"
    assert last["confirmed_word_span_count"] == len(second.confirmed_text.split())
    assert last["confirmed_span_start_sample"] == second.confirmed_word_spans[0]["start_sample"]
    assert last["confirmed_span_end_sample"] == second.confirmed_word_spans[-1]["end_sample"]
    # The verdict yes, the words no: the delta text has no business reaching cloud logs.
    assert "confirmed_word_spans" not in last
    assert "partial_word_spans" not in last
    assert "stable_word_spans" not in last
    assert last["partial_word_span_count"] == len(second.partial_word_spans)
    assert last["stable_word_span_count"] == len(second.stable_word_spans)

    # The session history carries the full verdict together with the spans.
    assert session.last_decode_provenance["provenance_status"] == "complete"
    assert session.last_decode_provenance["decode_id"] == second.decode_id
    assert [s["text"] for s in session.last_decode_provenance["confirmed_word_spans"]] == \
        second.confirmed_text.split()


def test_diag_failure_neither_blocks_the_session_nor_the_response(session, monkeypatch):
    """An observability event must not block the session or break the request.

    Diagnostics sit in `finally` AFTER the flag is released and are fail-open. Were it the other
    way round, an exception from the logger or from payload construction would reproduce exactly
    the failure this `finally` was added to remove: a session stuck on
    `transcription_in_progress=True`.
    """
    stub_pipeline(monkeypatch, HYPOTHESIS_1, CHUNKS_1)
    real_diag = ws._log_whisper_diag

    def exploding_diag(event, **fields):
        if event == "decode_provenance":
            raise RuntimeError("diag down")
        return real_diag(event, **fields)

    monkeypatch.setattr(ws, "_log_whisper_diag", exploding_diag)
    response = call(speech(2.0))

    assert response.decode_id == 1, "the request must return normally despite the diagnostics error"
    assert session.transcription_in_progress is False
    # History is written BEFORE diagnostics, so an event failure does not take it away.
    assert session.last_decode_provenance["decode_id"] == 1


def test_non_monotonic_spans_keep_the_text_but_lose_provenance(session, monkeypatch):
    """Non-chronological chunks: the text goes out unchanged, there is NO evidence.

    Before the sidecar got its monotonicity rule, the same decode could report
    `alignment_status=unaligned (non-monotonic start)` and `provenance_status=complete`
    simultaneously - two paths for the same evidence disagreeing about the same audio, while the
    aggregate range described an order the audio never had.
    """
    stub_pipeline(monkeypatch, HYPOTHESIS_1, CHUNKS_1)
    call(speech(2.0))
    # "Herrn" ends at 3.0 s, and the following "zum" starts at 1.0 s.
    stub_pipeline(monkeypatch, HYPOTHESIS_2, CHUNKS_1 + [
        {"text": "Herrn", "timestamp": (1.5, 3.0)},
        {"text": "zum", "timestamp": (1.0, 1.4)},
    ])
    second = call(speech(2.0))

    # EMISSION UNCHANGED: all four words still go out to the gateway.
    assert second.confirmed_text == "Hiob sprach Herrn zum"
    # There is no evidence and both paths say the same thing.
    assert second.provenance_status == "incomplete_provenance"
    assert second.provenance_reason == "non_monotonic"
    assert second.confirmed_word_spans == []
    assert second.alignment_status == ALIGNMENT_UNALIGNED
    # a reason code with no source text
    assert (second.alignment_reason or "").startswith("non_monotonic_start")
    assert "Herrn" not in (second.alignment_reason or "")


def test_invalid_timestamp_is_reported_as_its_own_reason(session, monkeypatch):
    """`invalid_timestamp` is NOT `missing_span` - two different defects, two different conclusions.

    Collapsing them would remove any way to tell a model defect (a bad timestamp) from a contract
    defect (a word with no sample axis). Only the code goes to the log: the body of
    `ProvenanceError` contains `repr(word)`, i.e. source text.
    """
    stub_pipeline(monkeypatch, HYPOTHESIS_1, CHUNKS_1)
    call(speech(2.0))
    stub_pipeline(monkeypatch, HYPOTHESIS_2, CHUNKS_1 + [
        {"text": "zum", "timestamp": (1.0, 1.4)},
        {"text": "Herrn", "timestamp": (1.5, float("inf"))},   # conversion rejected
    ])
    second = call(speech(2.0))

    assert second.confirmed_text == "Hiob sprach zum Herrn"   # emission unchanged
    assert second.provenance_status == "incomplete_provenance"
    assert second.provenance_reason == "invalid_timestamp"
    assert second.confirmed_word_spans == []
    assert "Herrn" not in (second.provenance_reason or "")


def test_filtered_delta_reports_policy_not_a_provenance_reason(session, monkeypatch):
    """Gate 2 removes spans by POLICY, not for lack of evidence - `reason` must return to `None`.

    The delta here is both a hallucination and carries a bad timestamp. If `reason` survived from
    the previous step, the downstream buckets would count the same case once as a timestamp
    defect and once as a filter decision - two different defects under one number.
    """
    from hallucination_filter import HallucinationReason

    # ONLY the detector verdict for the delta is stubbed - the rest of the path is real.
    # Patterns that actually trigger gate 2 are simultaneously caught by gate 1 over the whole
    # text, so without this the branch is unreachable from `process_chunk`.
    real_detect = ws.detect_hallucination
    monkeypatch.setattr(ws, "detect_hallucination", lambda text: (
        HallucinationReason(code="single_word_repeat", matched_span="Herrn", detail="test")
        if "Herrn" in (text or "") else real_detect(text)
    ))

    stub_pipeline(monkeypatch, HYPOTHESIS_1, CHUNKS_1)
    call(speech(2.0))
    stub_pipeline(monkeypatch, HYPOTHESIS_2, CHUNKS_1 + [
        {"text": "zum", "timestamp": (1.0, 1.4)},
        {"text": "Herrn", "timestamp": (1.5, float("inf"))},   # bad timestamp: reason set before gate 2
    ])
    second = call(speech(2.0))

    assert second.confirmed_text == "", "a hallucination does not reach the gateway"
    assert second.provenance_status == "delta_filtered"
    assert second.provenance_reason is None
    assert second.confirmed_word_spans == []


def test_dedup_sidecar_applies_the_same_monotonicity_rule_as_alignment(session):
    """The rule guarded directly on the deduplicator, not only through `process_chunk`."""
    from whisper_service import TimestampDeduplicator

    ordered = TimestampDeduplicator().process_with_spans(
        [{"text": "Aaa", "timestamp": (0.0, 1.0)}, {"text": "Bbb", "timestamp": (1.5, 3.0)}],
        buffer_start_sample=0, input_end_sample=SR * 4, sample_rate=SR,
    )
    assert ordered[0] == "Aaa Bbb" and ordered[2] == "complete" and len(ordered[1]) == 2
    assert ordered[3] is None

    reversed_ = TimestampDeduplicator().process_with_spans(
        [{"text": "Aaa", "timestamp": (1.5, 3.0)}, {"text": "Bbb", "timestamp": (0.0, 1.0)}],
        buffer_start_sample=0, input_end_sample=SR * 4, sample_rate=SR,
    )
    # The same text as with the correct order - ONLY the evidence disappears.
    assert reversed_ == ("Aaa Bbb", [], "incomplete_provenance", "non_monotonic")

    # Strict nesting (`A[0,3s]` + `B[1,2s]`) does not reach the sidecar today:
    # `_is_duplicate` sees 100% coverage and does a fuzzy replace, so the delta is one word.
    nested = TimestampDeduplicator().process_with_spans(
        [{"text": "Aaa", "timestamp": (0.0, 3.0)}, {"text": "Bbb", "timestamp": (1.0, 2.0)}],
        buffer_start_sample=0, input_end_sample=SR * 4, sample_rate=SR,
    )
    assert nested == (None, [], "no_delta", None)


def test_diag_range_is_min_max_even_for_unordered_spans():
    """Defence in depth on a pure helper, independent of the rule in the sidecar.

    The sidecar rejects non-monotonic series today, so such a payload does not arise in
    production. If that rule ever loosened, the first and last record would understate the range
    while the event still looked credible. Cases: nesting `A[0,3s]` + `B[1,2s]`, and reversed
    order.
    """
    nested_payload = ws._build_decode_provenance_diag({
        "provenance_status": "complete",
        "confirmed_word_spans": [
            {"text": "A", "start_sample": 0, "end_sample": 3 * SR},
            {"text": "B", "start_sample": 1 * SR, "end_sample": 2 * SR},
        ],
    })
    assert nested_payload["confirmed_word_span_count"] == 2
    assert nested_payload["confirmed_span_start_sample"] == 0
    # The last record ends at 2 s, the true coverage reaches 3 s.
    assert nested_payload["confirmed_span_end_sample"] == 3 * SR
    assert "confirmed_word_spans" not in nested_payload

    reversed_payload = ws._build_decode_provenance_diag({
        "confirmed_word_spans": [
            {"text": "A", "start_sample": 24000, "end_sample": 48000},
            {"text": "B", "start_sample": 0, "end_sample": 16000},
        ],
    })
    assert reversed_payload["confirmed_span_start_sample"] == 0
    assert reversed_payload["confirmed_span_end_sample"] == 48000

    empty_payload = ws._build_decode_provenance_diag({"confirmed_word_spans": []})
    assert empty_payload["confirmed_word_span_count"] == 0
    assert empty_payload["confirmed_span_start_sample"] is None
    assert empty_payload["confirmed_span_end_sample"] is None


def test_chunk_timestamp_audit_compares_raw_with_alignment(session, monkeypatch):
    """Equality of the two measurements EXONERATES our post-processing, with data.

    A measured run produced 137 x `zero_or_reversed` and the question "who produces this".
    Reading the code says `_run_pipeline` returns chunks untouched - but that has to be PROVEN by
    measuring on both sides, not assumed.
    """
    events = []
    real_diag = ws._log_whisper_diag
    monkeypatch.setattr(
        ws, "_log_whisper_diag",
        lambda event, **fields: events.append((event, fields)) or real_diag(event, **fields),
    )
    stub_pipeline(monkeypatch, "Hiob sprach zum Herrn", [
        {"text": "Hiob", "timestamp": (0.0, 0.5)},
        {"text": "sprach", "timestamp": (2.18, 2.18)},     # degenerate, as seen in production
        {"text": "zum", "timestamp": (1.0, 0.5)},          # reversed
        {"text": "Herrn", "timestamp": (1.5, 2.0)},
    ])
    call(speech(2.0))

    audit = [f for e, f in events if e == "chunk_timestamp_audit"]
    assert len(audit) == 1
    a = audit[0]
    assert a["comparable"] is True
    # A FINGERPRINT, not just a counter: two different sequences land in the same buckets
    assert a["timestamps_identical"] is True, "our code moved the timestamps after `_run_pipeline`"
    assert a["classification_counts_identical"] is True, f"changed fields: {a['changed_fields']}"
    assert a["pipeline_output"]["zero_length"] == 1 and a["pipeline_output"]["reversed"] == 1
    assert a["pipeline_output"]["timestamp_fingerprint"] == a["at_alignment"]["timestamp_fingerprint"]
    # no source text in the diagnostic event
    blob = json.dumps(a, ensure_ascii=False, default=str)
    for word in ("Hiob", "sprach", "Herrn"):
        assert word not in blob, f"word {word} leaked into the audit"


def test_chunk_rate_loop_reports_status_instead_of_raising(session, monkeypatch):
    """A hallucination loop (chunk rate > 12/s) must give an EXPLICIT status, not an exception.

    This branch returned a pair while the caller unpacked a triple - instead of
    `filtered_chunk_rate` a ValueError propagated, was swallowed by the outer `except`, and the
    response came back with no provenance at all.
    """
    dense = [
        {"text": f"w{i}", "timestamp": (i * 0.05, i * 0.05 + 0.04)}
        for i in range(40)  # 40 chunks in 2 s = 20/s; the threshold is 12/s
    ]
    stub_pipeline(monkeypatch, " ".join(c["text"] for c in dense), dense)
    response = call(speech(2.0))

    assert response.transcribe_status == "filtered_chunk_rate"
    assert response.alignment_status == ALIGNMENT_FILTERED_WINDOW
    assert response.confirmed_text == ""
    assert response.decode_id == 1, "a decode happened, so provenance must exist"


def test_timestamp_beyond_the_snapshot_keeps_text_but_drops_spans(session, monkeypatch):
    """A timestamp beyond the decoded input: text unchanged, zero spans."""
    stub_pipeline(monkeypatch, "Hiob sprach", [
        {"text": "Hiob", "timestamp": (0.0, 0.5)},
        {"text": "sprach", "timestamp": (0.5, 99.0)},      # far outside the 2 s snapshot
    ])
    response = call(speech(2.0))

    assert response.alignment_status == ALIGNMENT_UNALIGNED
    assert "invalid_timestamp" in (response.alignment_reason or "")
    assert not response.confirmed_word_spans
    if response.confirmed_text:
        assert response.provenance_status == "incomplete_provenance"


def test_filtered_window_comes_from_an_explicit_status(session, monkeypatch):
    """The filter rejected the window -> `filtered_window`. A plain empty model result -> NOT."""
    stub_pipeline(monkeypatch, "Untertitel der Amara.org-Community", [
        {"text": "Untertitel", "timestamp": (0.0, 0.5)},
    ])
    filtered = call(speech(2.0))
    assert filtered.transcribe_status == "filtered_preprocess"
    assert filtered.alignment_status == ALIGNMENT_FILTERED_WINDOW

    stub_pipeline(monkeypatch, "", [])
    empty = call(speech(2.0))
    assert empty.transcribe_status == "empty_model_output"
    assert empty.alignment_status != ALIGNMENT_FILTERED_WINDOW


def test_timings_separate_queue_wait_from_inference(session, monkeypatch):
    """Three disjoint timings, each named for what it measures.

    `inference_ms` covers `_run_pipeline` ONLY; the whole worker including the return to the
    event loop is `worker_total_ms`. A single aggregate number called "inference" would repeat
    the `decode_duration_ms` mistake - on a track whose purpose is to separate waiting from
    computing.
    """
    def slow_pipeline(pipe, audio, kwargs, use_chunking=False):
        time.sleep(0.02)
        return {"text": "Hiob", "chunks": [{"text": "Hiob", "timestamp": (0.0, 0.5)}]}

    stub_pipeline(monkeypatch, "Hiob", [{"text": "Hiob", "timestamp": (0.0, 0.5)}])
    monkeypatch.setattr(ws, "_run_pipeline", slow_pipeline)
    response = call(speech(2.0))

    assert response.executor_wait_ms is not None
    assert response.inference_ms is not None
    assert response.worker_total_ms is not None
    assert response.decode_total_ms is not None
    assert response.inference_ms >= 20.0, "the measurement must cover the actual inference"
    # the worker contains the inference, and the whole decode contains the worker plus the executor queue
    assert response.worker_total_ms + 1e-6 >= response.inference_ms
    assert response.decode_total_ms + 1e-6 >= response.worker_total_ms
    assert response.decode_finished_at_ms >= response.decode_started_at_ms


def test_hash_describes_the_snapshot_that_was_decoded(session, monkeypatch):
    captured = {}

    def capture(pipe, audio, kwargs, use_chunking=False):
        captured["audio"] = np.array(audio, dtype=np.float32)
        return {"text": "Hiob", "chunks": [{"text": "Hiob", "timestamp": (0.0, 0.5)}]}

    monkeypatch.setattr(ws, "_run_pipeline", capture)
    monkeypatch.setattr(ws, "pipe", object(), raising=False)
    response = call(speech(2.0))

    from provenance import pcm_sha256
    assert response.input_pcm_sha256 == pcm_sha256(captured["audio"])
    assert response.input_end_sample - response.input_start_sample == len(captured["audio"])
