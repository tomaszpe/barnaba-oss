"""Acceptance tests for the probe ON THE PRODUCTION `process_chunk` PATH.

The neighbouring module (`test_token_timestamp_probe.py`) guards the counters themselves. Here
we check properties invisible at function level: that the flag OFF changes nothing in the ASR
response, that with the flag ON both measurement points meet on `decode_id`, and that a
diagnostics failure does not take emission away from the listener.
"""
import asyncio
import json
import logging
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

import whisper_service as ws  # noqa: E402
from token_timestamp_probe import (  # noqa: E402
    SUPPORTED_DECODE_ASR_VERSIONS,
    WordGrouping,
    active_probe,
    make_probe_pipeline_class,
)

SR = 16000

# Real words from a past leak - they must pass through the model and NOT appear in the probe log.
HYPOTHESIS = "Wenn des Minuten Gelassenheit"
LEAKED = ("Wenn", "des", "Minuten", "Gelassenheit")
# Two tokens with THE SAME timestamp: exactly the shape `_decode_asr` turns into a
# zero-length range.
TOKEN_TIMESTAMPS = [0.0, 0.5, 0.5, 1.2, 1.8]
CHUNKS = [
    {"text": "Wenn", "timestamp": (0.0, 0.5)},
    {"text": "des", "timestamp": (0.5, 0.5)},          # zero-length range
    {"text": "Minuten", "timestamp": (0.5, 1.2)},
    {"text": "Gelassenheit", "timestamp": (1.2, 1.8)},
]


class FakeTensor:
    def __init__(self, values):
        self._values = list(values)

    def tolist(self):
        return list(self._values)


class FakeTokens:
    def __init__(self, rows):
        self._rows = [list(row) for row in rows]
        self.shape = (len(self._rows), len(self._rows[0]) if self._rows else 0)

    def __getitem__(self, index):
        return FakeTensor(self._rows[index])


# Token identifiers deliberately UNUSUAL: if one ever leaked into a log, this test catches it.
TOKEN_IDS = [40404, 50021, 60111, 70333]

GROUPING = WordGrouping(
    strip_prompt=lambda ids: ids,
    is_special=lambda token: False,
    detect_language=lambda token: None,
    combine_tokens_into_words=lambda tokens, language: [[i] for i in range(len(tokens))],
    timestamp_begin=99999,
    time_precision=0.02,
    library_version=SUPPORTED_DECODE_ASR_VERSIONS[0],
)


class FakeBase:
    """A base class for the diagnostic subclass - returns a ready `_forward` output."""

    def __init__(self, token_timestamps, token_ids=None):
        self.output = {
            "tokens": FakeTokens([token_ids if token_ids is not None else TOKEN_IDS]),
            "token_timestamps": [FakeTensor(token_timestamps)],
        }

    def _forward(self, model_inputs, *args, **kwargs):
        return self.output


ProbePipeline = make_probe_pipeline_class(
    FakeBase, grouping_builder=lambda pipe: getattr(pipe, "grouping", None))


def speech(seconds=2.0, amplitude=0.2):
    t = np.linspace(0, seconds, int(SR * seconds), dtype=np.float32)
    return (amplitude * np.sin(2 * np.pi * 220 * t)).astype(np.float32)


@pytest.fixture
def session(monkeypatch):
    ws.sessions.clear()
    session = ws.TranscriptionSession("probe-session")
    ws.sessions["probe-session"] = session
    monkeypatch.setattr(ws, "should_transcribe", lambda audio: True)
    monkeypatch.setattr(session.vad_processor, "process_chunk",
                        lambda audio: (None, True), raising=False)
    yield session
    ws.sessions.clear()


def stub_pipeline(monkeypatch, token_timestamps=TOKEN_TIMESTAMPS, chunks=CHUNKS,
                  text=HYPOTHESIS, grouping=GROUPING, token_ids=None):
    """Substitutes the model, but THROUGH the diagnostic subclass.

    The key point: `_run_pipeline` calls `_forward` of the same subclass that ships to
    production, so the measurement is produced the same way (`active_probe()`) rather than
    through a test stub.
    """
    inner = ProbePipeline(token_timestamps, token_ids)
    inner.grouping = grouping

    def fake_run_pipeline(pipe, audio, kwargs, use_chunking=False):
        inner._forward({"input_features": audio})
        return {"text": text, "chunks": chunks}

    monkeypatch.setattr(ws, "_run_pipeline", fake_run_pipeline)
    monkeypatch.setattr(ws.WhisperSingleton, "get_instance", classmethod(lambda cls: object()))
    monkeypatch.setattr(ws.WhisperSingleton, "get_prompt_ids", classmethod(lambda cls: None))
    monkeypatch.setattr(ws, "_log_whisper_runtime_diagnostics", lambda *a, **k: None)


def call(audio, session_id="probe-session"):
    request = ws.StreamChunkRequest(
        session_id=session_id, audio=audio.tolist(), sample_rate=SR, is_final=False
    )
    return asyncio.run(ws.process_chunk(session_id, request))


def diag_events(caplog, event):
    out = []
    for record in caplog.records:
        message = record.getMessage()
        if message.startswith("[WHISPER_DIAG] "):
            payload = json.loads(message[len("[WHISPER_DIAG] "):])
            if payload.get("event") == event:
                out.append(payload)
    return out


def decode_once(monkeypatch, enabled):
    monkeypatch.setattr(ws, "TOKEN_TIMESTAMP_PROBE_ENABLED", enabled)
    stub_pipeline(monkeypatch)
    return call(speech(2.0))


# ── flag OFF ──────────────────────────────────────────────────────────────────────────────────────

def test_flag_off_emits_no_probe_event(session, monkeypatch, caplog):
    with caplog.at_level(logging.INFO, logger="whisper_service"):
        decode_once(monkeypatch, enabled=False)
    assert diag_events(caplog, "token_timestamp_probe") == []
    # The chunk audit works as before - the probe pushed nothing out.
    assert len(diag_events(caplog, "chunk_timestamp_audit")) == 1


def test_flag_off_and_on_give_the_same_asr_result(session, monkeypatch):
    """Acceptance condition 1: diagnostics change neither the text nor the provenance."""
    off = decode_once(monkeypatch, enabled=False)
    ws.sessions["probe-session"] = ws.TranscriptionSession("probe-session")
    monkeypatch.setattr(ws.sessions["probe-session"].vad_processor, "process_chunk",
                        lambda audio: (None, True), raising=False)
    on = decode_once(monkeypatch, enabled=True)

    stable = ("partial_text", "confirmed_text", "stable_text", "is_speech",
              "has_new_transcription", "la_confirmed_word_count", "la_confirmed_char_count",
              "decode_id", "input_pcm_sha256", "input_start_sample", "input_end_sample",
              "transcribe_status", "provenance_status", "provenance_reason",
              "confirmed_word_spans", "text_token_count", "span_token_count",
              "alignment_status", "alignment_reason", "unaligned_word_count",
              "non_word_level_chunk", "aligned_span")
    for field in stable:
        assert getattr(off, field) == getattr(on, field), field


def test_pipeline_kwargs_are_empty_when_flag_is_off(monkeypatch):
    monkeypatch.setattr(ws, "TOKEN_TIMESTAMP_PROBE_ENABLED", False)
    assert ws._token_timestamp_probe_pipeline_kwargs() == {}


def test_pipeline_kwargs_carry_the_subclass_when_flag_is_on(monkeypatch):
    monkeypatch.setattr(ws, "TOKEN_TIMESTAMP_PROBE_ENABLED", True)
    kwargs = ws._token_timestamp_probe_pipeline_kwargs()
    if not kwargs:
        pytest.skip("transformers is not available in this environment")
    assert set(kwargs) == {"pipeline_class"}
    assert kwargs["pipeline_class"].__name__ == "TokenTimestampProbePipeline"


def test_missing_base_class_does_not_block_the_service(monkeypatch):
    """Unavailable diagnostics are a warning, not a startup failure."""
    monkeypatch.setattr(ws, "TOKEN_TIMESTAMP_PROBE_ENABLED", True)
    monkeypatch.setattr(ws, "build_probe_pipeline_class", lambda: None)
    assert ws._token_timestamp_probe_pipeline_kwargs() == {}


# ── flag ON ───────────────────────────────────────────────────────────────────────────────────────

def test_probe_event_joins_the_chunk_audit_by_decode_id(session, monkeypatch, caplog):
    with caplog.at_level(logging.INFO, logger="whisper_service"):
        response = decode_once(monkeypatch, enabled=True)

    probes = diag_events(caplog, "token_timestamp_probe")
    audits = diag_events(caplog, "chunk_timestamp_audit")
    assert len(probes) == 1 and len(audits) == 1
    assert probes[0]["decode_id"] == audits[0]["decode_id"] == response.decode_id
    assert probes[0]["probe_status"] == "ok"
    assert probes[0]["forward_calls"] == 1


def test_probe_event_attributes_the_zero_span_to_generation(session, monkeypatch, caplog):
    """The CAUSAL path on the production track: the boundary of a specific zero-length word.

    The reproduced boundaries give the same digest as the audit of real chunks, so the verdict
    carries no `_candidate` suffix - and only then may one say "the defect is in `generate()`".
    """
    with caplog.at_level(logging.INFO, logger="whisper_service"):
        decode_once(monkeypatch, enabled=True)
    probe = diag_events(caplog, "token_timestamp_probe")[0]
    assert probe["reproduction_matches"] is True
    assert probe["attribution_basis"] == "word_boundary"
    assert probe["layer_verdict"] == "generation"
    assert probe["raw_equal_at_word_boundary"] == 1
    assert probe["word_zero_length"] == probe["zero_length_words_reproduced"] == 1


def test_without_grouping_the_production_path_reports_only_a_candidate(session, monkeypatch, caplog):
    """No tokenizer facade => no causal evidence => the verdict carries the suffix."""
    monkeypatch.setattr(ws, "TOKEN_TIMESTAMP_PROBE_ENABLED", True)
    with caplog.at_level(logging.INFO, logger="whisper_service"):
        stub_pipeline(monkeypatch, grouping=None)
        call(speech(2.0))
    probe = diag_events(caplog, "token_timestamp_probe")[0]
    assert probe["layer_verdict"] == "generation_candidate"
    assert probe["attribution_basis"] == "sequence_candidate"
    assert probe["totals"]["boundary_statuses"] == ["no_grouping"]


@pytest.mark.parametrize("token_id", TOKEN_IDS)
def test_token_ids_never_reach_the_log(session, monkeypatch, caplog, token_id):
    """Token ids are read TRANSIENTLY to reproduce the grouping and must not leave the process."""
    with caplog.at_level(logging.INFO, logger="whisper_service"):
        decode_once(monkeypatch, enabled=True)
    payload = json.dumps(diag_events(caplog, "token_timestamp_probe")[0], ensure_ascii=False)
    assert str(token_id) not in payload


def test_dead_probe_is_visible_as_no_measurement_not_as_clean_result(session, monkeypatch, caplog):
    """Flag ON, but the subclass never reached the pipeline: there is NO measurement and that
    has to be visible.

    This is exactly the state the smoke gate must not let through - the events are produced, the
    join is complete, and nothing was measured.
    """
    monkeypatch.setattr(ws, "TOKEN_TIMESTAMP_PROBE_ENABLED", True)
    monkeypatch.setattr(ws, "_PROBE_PIPELINE_CLASS_NAME", None)
    stub_pipeline(monkeypatch)
    # A plain pipeline: the subclass's `_forward` is never called.
    monkeypatch.setattr(ws, "_run_pipeline",
                        lambda pipe, audio, kwargs, use_chunking=False: {
                            "text": HYPOTHESIS, "chunks": CHUNKS})
    with caplog.at_level(logging.INFO, logger="whisper_service"):
        call(speech(2.0))

    probe = diag_events(caplog, "token_timestamp_probe")[0]
    assert probe["probe_status"] == "no_measurement"
    assert probe["forward_calls"] == 0
    assert probe["layer_verdict"] == "undetermined"
    assert probe["environment"]["probe_pipeline_class"] is None


def test_probe_event_carries_runtime_versions(session, monkeypatch, caplog):
    with caplog.at_level(logging.INFO, logger="whisper_service"):
        decode_once(monkeypatch, enabled=True)
    environment = diag_events(caplog, "token_timestamp_probe")[0]["environment"]
    assert environment["transformers_version"] == ws.transformers.__version__
    assert environment["torch_version"] == ws.torch.__version__
    assert environment["model_revision"] == ws.MODEL_CONFIG.get("model_revision")
    assert environment["return_timestamps"] == ws.TRANSCRIBE_CONFIG["return_timestamps"]


@pytest.mark.parametrize("word", LEAKED)
def test_probe_event_contains_no_source_text(session, monkeypatch, caplog, word):
    with caplog.at_level(logging.INFO, logger="whisper_service"):
        decode_once(monkeypatch, enabled=True)
    payload = json.dumps(diag_events(caplog, "token_timestamp_probe")[0], ensure_ascii=False)
    assert word not in payload


def test_probe_state_does_not_leak_between_decodes(session, monkeypatch, caplog):
    """No global `last_result`: the second decode has its own measurement and its own `decode_id`."""
    monkeypatch.setattr(ws, "TOKEN_TIMESTAMP_PROBE_ENABLED", True)
    with caplog.at_level(logging.INFO, logger="whisper_service"):
        stub_pipeline(monkeypatch, token_timestamps=[0.0, 0.5, 0.5])
        call(speech(2.0))
        stub_pipeline(monkeypatch, token_timestamps=[0.0, 0.4, 0.8, 1.2])
        call(speech(2.0))

    probes = diag_events(caplog, "token_timestamp_probe")
    assert len(probes) == 2
    assert probes[0]["decode_id"] != probes[1]["decode_id"]
    assert probes[0]["totals"]["count"] == 3 and probes[1]["totals"]["count"] == 4
    assert probes[0]["totals"]["adjacent_equal_raw"] == 1
    assert probes[1]["totals"]["adjacent_equal_raw"] == 0
    assert active_probe() is None


# ── fail-open ─────────────────────────────────────────────────────────────────────────────────────

def test_probe_logging_failure_does_not_change_the_response(session, monkeypatch, caplog):
    """Acceptance condition: a diagnostics exception is fail-open and does not touch emission."""
    monkeypatch.setattr(ws, "TOKEN_TIMESTAMP_PROBE_ENABLED", True)

    def boom(*args, **kwargs):
        raise RuntimeError("Gelassenheit")

    monkeypatch.setattr(ws, "classify_zero_span_layer", boom)
    with caplog.at_level(logging.INFO, logger="whisper_service"):
        stub_pipeline(monkeypatch)
        response = call(speech(2.0))

    assert response.partial_text
    assert response.decode_id == 1
    assert diag_events(caplog, "token_timestamp_probe") == []
    warnings = [r.getMessage() for r in caplog.records if r.levelno >= logging.WARNING]
    assert any("TOKEN_TS_PROBE" in message for message in warnings)
    # The exception type name - never its message, which can carry source content.
    assert any("RuntimeError" in message for message in warnings)
    assert not any("Gelassenheit" in message for message in warnings)


def test_forward_measurement_failure_does_not_change_the_response(session, monkeypatch, caplog):
    """A failure while reading the tensor: emission unchanged, probe status EXPLICIT."""
    monkeypatch.setattr(ws, "TOKEN_TIMESTAMP_PROBE_ENABLED", True)

    class Exploding(dict):
        def get(self, *args, **kwargs):
            raise RuntimeError("Gelassenheit")

    class ExplodingBase:
        def _forward(self, model_inputs, *args, **kwargs):
            return Exploding()

    exploding = make_probe_pipeline_class(ExplodingBase)()

    def fake_run_pipeline(pipe, audio, kwargs, use_chunking=False):
        exploding._forward({})
        return {"text": HYPOTHESIS, "chunks": CHUNKS}

    stub_pipeline(monkeypatch)
    monkeypatch.setattr(ws, "_run_pipeline", fake_run_pipeline)
    with caplog.at_level(logging.INFO, logger="whisper_service"):
        response = call(speech(2.0))

    probe = diag_events(caplog, "token_timestamp_probe")[0]
    assert response.partial_text
    assert probe["probe_status"] == "failed"
    assert probe["probe_failures"] == ["RuntimeError"]
    assert probe["layer_verdict"] == "undetermined"
