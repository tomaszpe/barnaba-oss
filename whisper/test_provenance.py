"""Tests for the sample domain and STRICT matching.

Each test guards one property whose loss would break the replay guard: the absolute sample
axis, the absence of fuzzy alignment, and an explicit `unaligned` instead of guessing.
"""
import hashlib
import json

import numpy as np
import pytest

from provenance import (
    ALIGNMENT_EXACT,
    ALIGNMENT_FILTERED_WINDOW,
    ALIGNMENT_UNALIGNED,
    align_text_to_spans,
    align_text_to_subspans,
    relative_timestamp_to_samples,
    canonical_text,
    chunks_to_word_spans,
    merge_spans,
    overlap_samples,
    pcm_sha256,
    ProvenanceError,
)
from ring_buffer import GrowingAudioBuffer

SR = 16000


def chunk(text, start, end):
    return {"text": text, "timestamp": (start, end)}


# -- the absolute sample domain --------------------------------------------------

def test_buffer_offset_is_derived_from_the_sample_counter():
    buffer = GrowingAudioBuffer(max_buffer_seconds=30.0)
    buffer.add(np.ones(SR * 10, dtype=np.float32))
    assert buffer.get_input_span() == (0, SR * 10)
    assert buffer.buffer_offset == 0.0

    result = buffer.trim_at_time(5.0, overlap_seconds=1.0)
    assert result.did_trim
    # 5 s requested - 1 s of overlap = 4 s = 64000 samples, exactly
    assert result.trimmed_samples == 4 * SR
    assert buffer.get_buffer_start_sample() == 4 * SR
    assert buffer.buffer_offset == pytest.approx(4.0)
    assert buffer.get_input_span() == (4 * SR, 10 * SR)


def test_force_trim_moves_the_counter_by_the_samples_it_actually_removed():
    """Regression: the offset grew by the float `trim_time` while audio was cut by the int `trim_samples`."""
    buffer = GrowingAudioBuffer(max_buffer_seconds=30.0)
    odd_length = SR * 7 + 333          # deliberately an odd number of samples
    buffer.add(np.ones(odd_length, dtype=np.float32))

    before = buffer.get_buffer_start_sample()
    remaining_before = len(buffer.audio_buffer)
    buffer.force_trim_at_half()
    removed = remaining_before - len(buffer.audio_buffer)

    assert buffer.get_buffer_start_sample() == before + removed
    # the time axis and the actual audio must not drift apart by even one sample
    assert buffer.get_input_span()[0] == buffer.get_buffer_start_sample()
    assert buffer.buffer_offset == pytest.approx(buffer.get_buffer_start_sample() / SR)


def test_many_trims_do_not_accumulate_drift():
    """Twenty trims: the sum of removed samples must equal the buffer boundary."""
    buffer = GrowingAudioBuffer(max_buffer_seconds=30.0)
    removed_total = 0
    for _ in range(20):
        buffer.add(np.ones(SR * 3 + 101, dtype=np.float32))
        before = len(buffer.audio_buffer)
        buffer.force_trim_at_half()
        removed_total += before - len(buffer.audio_buffer)
    assert buffer.get_buffer_start_sample() == removed_total
    assert buffer.buffer_offset == pytest.approx(removed_total / SR)


def test_clear_never_reuses_sample_numbers():
    """The sample axis is MONOTONIC within the object.

    Resetting the counter on `clear()` meant new audio received the same numbers as the old -
    two different fragments of the same session had an identical span, so the replay guard would
    be comparing things that are not comparable.
    """
    buffer = GrowingAudioBuffer(max_buffer_seconds=30.0)
    buffer.add(np.ones(SR * 5, dtype=np.float32))
    span_before = buffer.get_input_span()

    buffer.clear()
    buffer.add(np.ones(SR * 2, dtype=np.float32))
    span_after = buffer.get_input_span()

    assert span_after[0] >= span_before[1], "new audio must not receive old sample numbers"
    assert overlap_samples(span_before, span_after) == 0


# -- (4) atomic snapshot of the decoder input ------------------------------------

def test_snapshot_pairs_audio_with_its_own_span():
    buffer = GrowingAudioBuffer(max_buffer_seconds=30.0)
    buffer.add(np.ones(SR * 3, dtype=np.float32))
    snapshot = buffer.snapshot_for_decode()

    assert snapshot.start_sample == 0
    assert snapshot.end_sample == SR * 3
    assert snapshot.sample_count == len(snapshot.audio) == SR * 3


def test_snapshot_is_immune_to_audio_arriving_afterwards():
    """The hash and the range must describe THE SAME tensor - otherwise the evidence is false."""
    buffer = GrowingAudioBuffer(max_buffer_seconds=30.0)
    buffer.add(np.ones(SR * 3, dtype=np.float32))
    snapshot = buffer.snapshot_for_decode()
    digest = pcm_sha256(snapshot.audio)

    buffer.add(np.zeros(SR * 2, dtype=np.float32))      # a chunk that used to slip between locks

    assert snapshot.sample_count == SR * 3
    assert pcm_sha256(snapshot.audio) == digest
    assert buffer.get_input_span()[1] == SR * 5


def test_snapshot_after_trim_carries_the_shifted_origin():
    buffer = GrowingAudioBuffer(max_buffer_seconds=30.0)
    buffer.add(np.ones(SR * 10, dtype=np.float32))
    buffer.trim_at_time(5.0, overlap_seconds=1.0)
    snapshot = buffer.snapshot_for_decode()
    assert snapshot.start_sample == 4 * SR
    assert snapshot.end_sample == 10 * SR


def test_buffer_offset_cannot_be_assigned_directly():
    """A mutation restoring the accumulated float must fail to compile at runtime."""
    buffer = GrowingAudioBuffer(max_buffer_seconds=30.0)
    with pytest.raises(AttributeError):
        buffer.buffer_offset = 7.5


# -- input hash ------------------------------------------------------------------

def test_identical_pcm_gives_identical_hash_and_different_pcm_does_not():
    a = np.linspace(-1, 1, SR, dtype=np.float32)
    b = a.copy()
    c = a.copy()
    c[123] += 0.001
    assert pcm_sha256(a) == pcm_sha256(b)
    assert pcm_sha256(a) != pcm_sha256(c)


def test_hash_is_taken_over_float32_bytes_not_text():
    a = np.zeros(16, dtype=np.float32)
    assert len(pcm_sha256(a)) == 64


def test_known_digest_is_pinned():
    """A known digest: changing how the hash is computed must turn this red, not pass quietly."""
    a = np.zeros(4, dtype=np.float32)
    assert pcm_sha256(a) == hashlib.sha256(b"\x00" * 16).hexdigest()


def test_hash_refuses_anything_that_is_not_the_exact_tensor():
    """NO fallback to repr(): no exact bytes means no provenance."""
    with pytest.raises(ProvenanceError):
        pcm_sha256([0.0, 1.0])                                  # a list, not an ndarray
    with pytest.raises(ProvenanceError):
        pcm_sha256(np.zeros(8, dtype=np.float64))               # wrong dtype
    with pytest.raises(ProvenanceError):
        pcm_sha256(np.zeros(8, dtype=np.float32)[::2])          # a view, not a contiguous tensor


# -- strict matching ---------------------------------------------------------------

def test_exact_alignment_maps_every_word_to_absolute_samples():
    chunks = [chunk("Das", 0.0, 0.4), chunk("Thema", 0.4, 0.9), chunk("ist", 0.9, 1.1)]
    result = align_text_to_spans("Das Thema ist", chunks, buffer_start_sample=32000)

    assert result.status == ALIGNMENT_EXACT
    assert result.unaligned_word_count == 0
    assert [w.text for w in result.word_spans] == ["Das", "Thema", "ist"]
    assert result.word_spans[0].start_sample == 32000
    assert result.word_spans[-1].end_sample == 32000 + int(round(1.1 * SR))
    assert result.span == (32000, 32000 + int(round(1.1 * SR)))


def test_nfc_and_whitespace_normalisation_still_counts_as_exact():
    """Production does NFC + strip + single spaces - that must not break matching."""
    decomposed = "Bu\u0308cher"        # 'u' + combining diaeresis (NFD)
    composed = "B\u00fccher"            # 'u-umlaut' as a single code point (NFC)
    assert decomposed != composed
    chunks = [chunk(composed, 0.0, 0.8), chunk("sind", 0.8, 1.0)]
    result = align_text_to_spans("  " + decomposed + "   sind \n", chunks, buffer_start_sample=0)
    assert result.status == ALIGNMENT_EXACT


def test_canonical_text_matches_the_real_production_normaliser():
    """Parity with `preprocess_transcription`: drift between the two implementations is a SILENT unaligned."""
    from hallucination_filter import preprocess_transcription

    samples = [
        "Bu\u0308cher sind gut",
        "  Das   Thema \n ist \t wichtig ",
        "Gelassenheit verlaengert das Leben",
    ]
    for sample in samples:
        produced = preprocess_transcription(sample)
        if produced is None:
            continue
        assert canonical_text(sample) == canonical_text(produced) == produced


def test_canonical_text_matches_production_steps():
    assert canonical_text("  a\t\tb\nc  ") == "a b c"
    assert canonical_text("") == ""


def test_word_substitution_is_unaligned_not_repaired():
    """"Geld" instead of "Gelassenheit" must NOT be repaired by similarity."""
    chunks = [chunk("Wie", 0.0, 0.2), chunk("bekommst", 0.2, 0.6), chunk("du", 0.6, 0.8),
              chunk("mehr", 0.8, 1.0), chunk("Geld", 1.0, 1.4)]
    result = align_text_to_spans("Wie bekommst du mehr Gelassenheit", chunks, buffer_start_sample=0)

    assert result.status == ALIGNMENT_UNALIGNED
    assert result.unaligned_word_count == 1
    assert result.reason == "token_sequence_mismatch"
    assert result.span is None


def test_token_count_mismatch_reports_both_counts_not_a_difference():
    """A length difference does not say how many tokens drifted - it must be None plus both counters."""
    chunks = [chunk("eins", 0.0, 0.2), chunk("zwei", 0.2, 0.4)]
    result = align_text_to_spans("eins zwei drei", chunks, buffer_start_sample=0)
    assert result.status == ALIGNMENT_UNALIGNED
    assert result.unaligned_word_count is None
    assert (result.text_token_count, result.span_token_count) == (3, 2)
    assert result.reason.startswith("token_count_mismatch")


def test_missing_timestamps_are_unaligned_never_guessed():
    chunks = [{"text": "Das", "timestamp": (None, None)}]
    result = align_text_to_spans("Das", chunks, buffer_start_sample=0)
    assert result.status == ALIGNMENT_UNALIGNED
    assert result.reason == "no_word_timestamps"


def test_filtered_window_must_be_declared_by_the_caller():
    """Empty text does NOT prove the filter fired - it may be an empty model result or an error."""
    chunks = [chunk("whatever", 0.0, 0.5)]

    declared = align_text_to_spans("", chunks, buffer_start_sample=0, window_filtered=True)
    assert declared.status == ALIGNMENT_FILTERED_WINDOW
    assert declared.reason == "window_rejected_by_filter"

    undeclared = align_text_to_spans("", chunks, buffer_start_sample=0)
    assert undeclared.status == ALIGNMENT_UNALIGNED
    assert undeclared.reason == "empty_accepted_text_without_filter_signal"


def test_multi_token_chunk_is_unaligned_not_silently_accepted():
    """The pipeline declares PER-WORD timestamps.

    A chunk with several tokens means one audio range describes several words - there is no way
    to say which samples belong to which word. That ambiguity must not enter the accumulator;
    its real frequency is measured separately.
    """
    chunks = [chunk("Das Thema", 0.0, 0.9), chunk("ist", 0.9, 1.1)]
    result = align_text_to_spans("Das Thema ist", chunks, buffer_start_sample=0)
    assert result.status == ALIGNMENT_UNALIGNED
    assert result.reason.startswith("non_word_level_chunk")
    assert result.span is None


def test_infinite_timestamp_is_rejected_as_provenance_error():
    """`inf` passed the NaN check, then blew up with OverflowError in `round()` - outside the contract."""
    for bad in (float("inf"), float("-inf")):
        with pytest.raises(ProvenanceError):
            chunks_to_word_spans([chunk("x", 0.0, bad)], buffer_start_sample=0)
        with pytest.raises(ProvenanceError):
            chunks_to_word_spans([chunk("x", bad, 1.0)], buffer_start_sample=0)


def test_sub_sample_interval_rounding_to_zero_is_rejected():
    """A positive interval shorter than a sample must not enter the ledger as an empty span."""
    with pytest.raises(ProvenanceError):
        chunks_to_word_spans([chunk("x", 0.00001, 0.00002)], buffer_start_sample=0)


def test_non_monotonic_starts_are_rejected():
    """A[1s,2s] + B[0s,1s] produced `exact` and an aggregate span of (16000, 16000) - a fiction."""
    chunks = [chunk("A", 1.0, 2.0), chunk("B", 0.0, 1.0)]
    with pytest.raises(ProvenanceError):
        chunks_to_word_spans(chunks, buffer_start_sample=0)

    result = align_text_to_spans("A B", chunks, buffer_start_sample=0)
    assert result.status == ALIGNMENT_UNALIGNED
    # a code with no source text
    assert result.reason.startswith("non_monotonic_start")
    assert result.span is None


def test_slightly_overlapping_words_are_still_accepted():
    """Slight overlap between words is normal - what is forbidden is starts moving BACKWARDS."""
    chunks = [chunk("A", 0.0, 0.60), chunk("B", 0.55, 1.10)]
    result = align_text_to_spans("A B", chunks, buffer_start_sample=0)
    assert result.status == ALIGNMENT_EXACT


def test_partial_hypothesis_maps_to_one_exact_contiguous_run():
    chunks = [
        chunk("Hiob", 0.0, 0.4),
        chunk("sprach", 0.4, 0.9),
        chunk("zum", 0.9, 1.1),
        chunk("Herrn", 1.1, 1.5),
    ]
    result = align_text_to_subspans("zum Herrn", chunks, buffer_start_sample=32000)

    assert result.status == ALIGNMENT_EXACT
    assert [span.text for span in result.word_spans] == ["zum", "Herrn"]
    assert result.word_spans[0].start_sample == 32000 + int(round(0.9 * SR))


def test_partial_hypothesis_refuses_ambiguous_or_non_contiguous_matches():
    repeated = [chunk("Hiob", 0.0, 0.4), chunk("Hiob", 0.5, 0.9)]
    separated = [chunk("zum", 0.0, 0.4), chunk("alten", 0.4, 0.7), chunk("Herrn", 0.7, 1.0)]

    ambiguous = align_text_to_subspans("Hiob", repeated, buffer_start_sample=0)
    non_contiguous = align_text_to_subspans("zum Herrn", separated, buffer_start_sample=0)

    assert ambiguous.status == ALIGNMENT_UNALIGNED
    assert ambiguous.reason == "subtext_match_not_unique"
    assert non_contiguous.status == ALIGNMENT_UNALIGNED
    assert non_contiguous.reason == "subtext_not_contiguous"


def test_spans_are_absolute_after_a_trim():
    """After a trim the same relative times must give DIFFERENT absolute samples."""
    chunks = [chunk("Hiob", 0.0, 0.5)]
    before = align_text_to_spans("Hiob", chunks, buffer_start_sample=0)
    after = align_text_to_spans("Hiob", chunks, buffer_start_sample=4 * SR)
    assert before.word_spans[0].start_sample == 0
    assert after.word_spans[0].start_sample == 4 * SR


@pytest.mark.parametrize("bad", [
    (1.0, 0.5),          # reversed
    (0.5, 0.5),          # zero length
    (-0.2, 0.5),         # negative start
    (float("nan"), 0.5),  # NaN
])
def test_malformed_timestamps_raise_instead_of_being_repaired(bad):
    """Swapping start/end was guessing the model's intent - the contract is 'exact or nothing'."""
    with pytest.raises(ProvenanceError):
        chunks_to_word_spans([chunk("x", bad[0], bad[1])], buffer_start_sample=0)


def test_span_beyond_the_decoded_input_is_rejected():
    with pytest.raises(ProvenanceError):
        chunks_to_word_spans([chunk("x", 0.0, 5.0)], buffer_start_sample=0, input_end_sample=SR)


def test_malformed_timestamp_surfaces_as_unaligned_not_as_a_crash():
    result = align_text_to_spans("x", [chunk("x", 1.0, 0.5)], buffer_start_sample=0)
    assert result.status == ALIGNMENT_UNALIGNED
    assert result.reason.startswith("invalid_timestamp")
    assert result.span is None


# ── the union of ranges (the basis of the replay ledger) ──────────────────────────────────────────

def test_merge_spans_joins_touching_and_overlapping_ranges():
    assert merge_spans([(0, 100), (100, 200)]) == [(0, 200)]
    assert merge_spans([(0, 100), (50, 150)]) == [(0, 150)]
    assert merge_spans([(0, 100), (200, 300)]) == [(0, 100), (200, 300)]
    assert merge_spans([(10, 10)]) == []


def test_overlap_samples_counts_only_the_shared_part():
    assert overlap_samples((0, 100), (50, 150)) == 50
    assert overlap_samples((0, 100), (100, 200)) == 0
    assert overlap_samples((0, 1000), (200, 300)) == 100


def test_envelope_uses_min_start_and_max_end_not_first_and_last():
    """A nested span: A[0, 3s] and B[1s, 2s] have increasing starts, but the last word ends
    EARLIER. A hull built from first/last would understate the ledger entry."""
    chunks = [chunk("A", 0.0, 3.0), chunk("B", 1.0, 2.0)]
    result = align_text_to_spans("A B", chunks, buffer_start_sample=0)
    assert result.status == ALIGNMENT_EXACT
    assert result.span == (0, 3 * SR)


def test_shared_validator_is_the_same_for_both_paths():
    """The deduplicator sidecar and alignment must use THE SAME function."""
    from provenance import relative_timestamp_to_samples

    assert relative_timestamp_to_samples(0.5, 1.0, 100, 8000) == (4100, 8100)
    for bad in ((float("inf"), 1.0), (0.5, 0.5), (-1.0, 1.0), (0.00001, 0.00002)):
        with pytest.raises(ProvenanceError):
            relative_timestamp_to_samples(bad[0], bad[1], 0, SR)
    with pytest.raises(ProvenanceError):
        relative_timestamp_to_samples(0.0, 5.0, 0, SR, input_end_sample=SR)


# -- response contract and decode identity ---------------------------------------

def test_response_provenance_fields_are_optional_and_absent_by_default():
    """An older gateway must keep working unchanged: all the new fields are optional."""
    from whisper_service import StreamChunkResponse

    response = StreamChunkResponse(
        session_id="s", partial_text="", confirmed_text="",
        is_speech=False, has_new_transcription=False,
    )
    for field in ("decode_id", "input_pcm_sha256", "input_start_sample", "input_end_sample",
                  "decode_requested_at_ms", "decode_started_at_ms", "decode_finished_at_ms",
                  "executor_wait_ms", "inference_ms", "worker_total_ms", "decode_total_ms",
                  "transcribe_status",
                  "provenance_status", "provenance_reason",
                  "confirmed_word_spans", "text_token_count",
                  "span_token_count", "alignment_status", "alignment_reason",
                  "unaligned_word_count", "non_word_level_chunk", "aligned_span"):
        assert getattr(response, field) is None, field


def test_response_has_no_decode_in_flight_field():
    """`decode_in_flight_at_fallback` must NOT come from the Whisper response.

    The response arrives after inference completes, so live state is measured by the gateway.
    """
    from whisper_service import StreamChunkResponse

    assert "decode_in_flight_at_fallback" not in StreamChunkResponse.model_fields


def test_decode_id_is_allocated_per_session_and_monotonic():
    from whisper_service import TranscriptionSession

    session = TranscriptionSession("s1")
    assert session.decode_seq == 0
    session.decode_seq += 1
    first = session.decode_seq
    session.decode_seq += 1
    assert session.decode_seq == first + 1
    assert TranscriptionSession("s2").decode_seq == 0      # a separate space per session


def test_hash_and_bounds_come_from_the_same_snapshot():
    """The hash is computed from `snapshot.audio`, and the boundaries from the same object."""
    buffer = GrowingAudioBuffer(max_buffer_seconds=30.0)
    buffer.add(np.ones(SR * 2, dtype=np.float32))
    snapshot = buffer.snapshot_for_decode()

    digest = pcm_sha256(snapshot.audio)
    assert snapshot.end_sample - snapshot.start_sample == len(snapshot.audio)
    buffer.add(np.zeros(SR, dtype=np.float32))
    assert pcm_sha256(snapshot.audio) == digest


# -- no provenance message carries source text -----------------------------------

# Words from a REAL leak observed in a DEV smoke run - these exact words reached
# `whisper_request_completed` through `alignment_reason`.
LEAKED_WORDS = ("des", "Wenn", "Minuten", "Gelassenheit")


def _no_source_word(blob: str) -> bool:
    return not any(w in blob for w in LEAKED_WORDS)


@pytest.mark.parametrize("bad", [
    (float("nan"), 1.0),
    (float("inf"), 1.0),
    (2.18, 2.18),          # a degenerate interval - the most common case on a live model
    (-1.0, 1.0),
    ("x", 1.0),
])
def test_timestamp_errors_carry_numbers_but_never_the_word(bad):
    with pytest.raises(ProvenanceError) as exc:
        relative_timestamp_to_samples(bad[0], bad[1], 0, SR)
    message = str(exc.value)
    assert _no_source_word(message), message
    # the reason code stays DISJOINT and readable
    assert message.startswith("invalid_timestamp:")
    assert ":" in message.split(" ")[0]


def test_alignment_reason_never_carries_the_word():
    """`alignment_reason` travels to the HTTP response, to the event and to the gateway cloud log."""
    chunks = [
        {"text": "Wenn", "timestamp": (0.0, 0.0)},          # zero-length interval
        {"text": "Gelassenheit", "timestamp": (0.5, 1.0)},
    ]
    result = align_text_to_spans("Wenn Gelassenheit", chunks, 0, SR)
    assert result.status == ALIGNMENT_UNALIGNED
    assert _no_source_word(result.reason or ""), result.reason
    assert (result.reason or "").startswith("invalid_timestamp:zero_or_reversed")
    # the whole response dict must be clean as well
    assert _no_source_word(json.dumps(
        {k: v for k, v in result.to_dict().items() if k != "word_spans"}, ensure_ascii=False))


def test_non_monotonic_and_multi_token_reasons_are_text_free():
    back_in_time = [
        {"text": "Minuten", "timestamp": (1.5, 3.0)},
        {"text": "des", "timestamp": (0.0, 1.0)},
    ]
    result = align_text_to_spans("Minuten des", back_in_time, 0, SR)
    assert result.status == ALIGNMENT_UNALIGNED
    assert result.reason.startswith("non_monotonic_start")
    assert _no_source_word(result.reason)

    multi = [{"text": "Wenn des Minuten", "timestamp": (0.0, 1.0)}]
    result2 = align_text_to_spans("Wenn des Minuten", multi, 0, SR)
    assert result2.reason.startswith("non_word_level_chunk:tokens=")
    assert _no_source_word(result2.reason)
