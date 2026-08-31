"""The first DIRECT suite for `TimestampDeduplicator`.

Until this suite existed the class was tested only indirectly, in trim scenarios
(`test_trim_overlap_policy.py`). It decides which words leave Whisper at all, so it was the
most important untested element of the track.

The tests also guard that:
  * `overlap_tolerance` is a PROPORTION of word length, not milliseconds (corrected docstring),
  * the span sidecar travels with the text through reset and carry-over,
  * spans are computed from the integer sample counter, not from reconstructed seconds,
  * the history window is UNCHANGED - fixing it changes emission and goes in its own commit.
"""
import sys
from pathlib import Path

import pytest

# whisper_service.py imports heavy dependencies at module load; the class is pure, so the
# module is loaded only to extract it (the import is cached by pytest).
sys.path.insert(0, str(Path(__file__).resolve().parent))
import whisper_service as ws  # noqa: E402
from whisper_service import TimestampDeduplicator  # noqa: E402

SR = 16000


def chunk(text, start, end):
    return {"text": text, "timestamp": (start, end)}


def make(min_new_words=2, overlap_tolerance=0.1):
    return TimestampDeduplicator(overlap_tolerance=overlap_tolerance, min_new_words=min_new_words)


# ── the basics: duplicate, delta, pending ─────────────────────────────────────────────────────────

def test_exact_duplicate_at_the_same_timestamp_is_skipped():
    dedup = make()
    assert dedup.process([chunk("Hiob", 0.0, 0.5), chunk("sprach", 0.5, 1.0)]) == "Hiob sprach"
    # same audio, same content - nothing new may come out
    assert dedup.process([chunk("Hiob", 0.0, 0.5), chunk("sprach", 0.5, 1.0)]) is None
    assert dedup._duplicates_skipped == 2


def test_word_added_at_the_front_does_not_re_emit_the_tail():
    """Whisper prepends words at the START; positions shift, timestamps do not."""
    dedup = make()
    dedup.process([chunk("Du", 0.5, 0.8), chunk("hast", 0.8, 1.2)])
    delta = dedup.process([chunk("Ja", 0.2, 0.4), chunk("Du", 0.5, 0.8),
                           chunk("hast", 0.8, 1.2), chunk("recht", 1.2, 1.6)])
    assert delta is not None
    assert "Du" not in delta.split()
    assert delta.split() == ["Ja", "recht"]


def test_partial_overlap_below_tolerance_is_new_content():
    dedup = make(min_new_words=1)
    dedup.process([chunk("eins", 0.0, 1.0)])
    # 5% of the word length - below the 0.1 threshold, so this is a new word
    delta = dedup.process([chunk("zwei", 0.95, 1.95)])
    assert delta == "zwei"


def test_overlap_tolerance_is_a_ratio_of_word_duration_not_milliseconds():
    """The same ABSOLUTE overlap of 100 ms: a duplicate for a short word, new for a long one."""
    short = make(min_new_words=1, overlap_tolerance=0.1)
    short.process([chunk("kurz", 0.0, 0.3)])
    # 0.3 s word, 0.1 s overlap = 33% > 10% -> duplicate/replace, nothing comes out
    assert short.process([chunk("kurz", 0.2, 0.5)]) is None

    long = make(min_new_words=1, overlap_tolerance=0.1)
    long.process([chunk("lang", 0.0, 2.0)])
    # 2.0 s word, 0.1 s overlap = 5% < 10% -> a new word
    assert long.process([chunk("lang", 1.9, 3.9)]) == "lang"


def test_fuzzy_replacement_above_08_swaps_the_word_without_emitting_it():
    """>80% overlap plus different text = the same utterance rewritten from a longer buffer."""
    dedup = make(min_new_words=1)
    dedup.process([chunk("Felser", 0.0, 0.5)])
    assert dedup.process([chunk("Felsen", 0.0, 0.5)]) is None
    assert dedup._fuzzy_replacements == 1
    assert dedup.confirmed_words[0][0] == "Felsen"


def test_pending_words_survive_until_the_threshold_is_reached():
    dedup = make(min_new_words=3)
    assert dedup.process([chunk("eins", 0.0, 0.3)]) is None
    assert dedup.pending_words == ["eins"]
    assert dedup.process([chunk("zwei", 0.3, 0.6)]) is None
    delta = dedup.process([chunk("drei", 0.6, 0.9)])
    assert delta == "eins zwei drei"
    assert dedup.pending_words == []


def test_sentence_end_flushes_below_the_word_threshold():
    dedup = make(min_new_words=5)
    assert dedup.process([chunk("Amen.", 0.0, 0.4)]) == "Amen."


def test_oversized_delta_is_rejected_and_clears_the_buffer():
    dedup = make(min_new_words=1)
    chunks = [chunk(f"w{i}", i * 0.1, i * 0.1 + 0.09) for i in range(85)]
    assert dedup.process(chunks) is None
    assert dedup.pending_words == []
    assert dedup.pending_spans == []


# ── buffer_offset i carry-over ────────────────────────────────────────────────────────────────────

def test_buffer_offset_shifts_words_into_absolute_time():
    dedup = make(min_new_words=1)
    dedup.process([chunk("alt", 0.0, 0.5)], buffer_offset=0.0)
    # the same word, but after a 10 s trim - different audio, so NOT a duplicate
    delta = dedup.process([chunk("alt", 0.0, 0.5)], buffer_offset=10.0)
    assert delta == "alt"
    assert len(dedup.confirmed_words) == 2


def test_same_absolute_time_across_a_trim_is_still_a_duplicate():
    dedup = make(min_new_words=1)
    dedup.process([chunk("Wort", 12.0, 12.5)], buffer_offset=0.0)
    # after a 12 s trim the same audio has relative time 0.0
    assert dedup.process([chunk("Wort", 0.0, 0.5)], buffer_offset=12.0) is None


def test_history_is_bounded_only_when_trims_advance_the_offset():
    """History shrinks ONLY when trims advance `buffer_offset`."""
    dedup = make(min_new_words=1)
    for i in range(400):
        # the offset grows as it would with regular trims
        dedup.process([chunk(f"w{i}", 0.0, 0.5)], buffer_offset=float(i))
    assert len(dedup.confirmed_words) < 400


def test_known_defect_history_grows_without_trims():
    """A PIN for a known defect, NOT fixed in this patch.

    Without a single trim `buffer_offset` stays 0, so the cutoff never fires and the "60 s
    window" holds the whole session. The fix (a cutoff from the buffer's
    `current_audio_end_sample`) changes which words count as duplicates - i.e. changes the
    EMITTED TEXT - so it goes in its own commit with its own gate. When that commit lands, this
    test is to be deliberately inverted, not quietly deleted.
    """
    dedup = make(min_new_words=1)
    for i in range(400):
        dedup.process([chunk(f"w{i}", i * 1.0, i * 1.0 + 0.5)], buffer_offset=0.0)
    assert len(dedup.confirmed_words) == 400


# -- spans: the contract for the replay guard ------------------------------------

def test_process_with_spans_returns_absolute_samples_for_the_delta():
    dedup = make(min_new_words=1)
    delta, records, status, reason = dedup.process_with_spans([chunk("Hiob", 1.0, 1.5)], buffer_start_sample=2 * SR)
    assert delta == "Hiob"
    assert records == [{"text": "Hiob", "start_sample": 3 * SR, "end_sample": int(round(3.5 * SR))}]


def test_process_with_spans_emits_exactly_the_same_text_as_process():
    """Compatibility: the first change must not touch the emitted text."""
    plain, spanned = make(min_new_words=2), make(min_new_words=2)
    frames = [
        [chunk("Das", 0.0, 0.3), chunk("Thema", 0.3, 0.8)],
        [chunk("Das", 0.0, 0.3), chunk("Thema", 0.3, 0.8), chunk("ist", 0.8, 1.0), chunk("gut.", 1.0, 1.4)],
    ]
    for frame in frames:
        expected = plain.process(list(frame))
        actual, _, _, _ = spanned.process_with_spans(list(frame), buffer_start_sample=0)
        assert actual == expected


def test_spans_cover_every_word_of_the_delta():
    dedup = make(min_new_words=2)
    delta, records, status, reason = dedup.process_with_spans(
        [chunk("eins", 0.0, 0.3), chunk("zwei", 0.3, 0.6), chunk("drei", 0.6, 0.9)],
        buffer_start_sample=0,
    )
    assert len(records) == len(delta.split())
    assert [r["text"] for r in records] == delta.split()
    assert all(r["end_sample"] > r["start_sample"] for r in records)


def test_no_delta_means_no_spans():
    dedup = make(min_new_words=5)
    delta, records, status, reason = dedup.process_with_spans([chunk("sam", 0.0, 0.3)], buffer_start_sample=0)
    assert delta is None
    assert records == []


@pytest.mark.parametrize("start_sample", [0, 120000, 1_973_333])
def test_spans_track_the_buffer_origin_exactly(start_sample):
    """A non-round `start_sample` must not be lost to second-based rounding."""
    dedup = make(min_new_words=1)
    _, records, _status, _reason = dedup.process_with_spans([chunk("x", 0.5, 1.0)], buffer_start_sample=start_sample)
    assert records[0]["start_sample"] == start_sample + int(round(0.5 * SR))
    assert records[0]["end_sample"] == start_sample + int(round(1.0 * SR))


# ── the span sidecar: reset and carry-over (fix 2) ────────────────────────────────────────────────

def test_reset_clears_the_span_sidecar_with_the_text():
    """Regression: `reset()` cleared `pending_words` but left the spans of the previous state."""
    dedup = make(min_new_words=5)
    dedup.process_with_spans([chunk("a", 0.0, 0.3), chunk("b", 0.3, 0.6)], buffer_start_sample=0)
    assert dedup.pending_spans, "the spans must wait together with the text"

    dedup.reset()
    assert dedup.pending_words == []
    assert dedup.pending_spans == []
    assert dedup.last_delta_spans == []


def test_carry_over_context_clears_the_span_sidecar():
    dedup = make(min_new_words=5)
    dedup.process_with_spans([chunk("a", 0.0, 0.3)], buffer_start_sample=0)
    dedup.carry_over_context()
    assert dedup.pending_words == []
    assert dedup.pending_spans == []
    assert dedup.last_delta_spans == []


def test_delta_after_reset_never_carries_spans_from_the_previous_state():
    dedup = make(min_new_words=2)
    dedup.process_with_spans([chunk("stare", 0.0, 0.3)], buffer_start_sample=0)
    dedup.reset()
    delta, records, status, reason = dedup.process_with_spans(
        [chunk("neues", 0.0, 0.3), chunk("Audio", 0.3, 0.6)], buffer_start_sample=10 * SR
    )
    assert delta == "neues Audio"
    assert [r["text"] for r in records] == ["neues", "Audio"]
    assert all(r["start_sample"] >= 10 * SR for r in records)


# ── spans counted in the sample domain (fix 1) ────────────────────────────────────────────────────

def test_spans_are_built_from_the_integer_sample_counter():
    """Without reassembling absolute time in seconds."""
    dedup = make(min_new_words=1)
    _, records, _status, _reason = dedup.process_with_spans([chunk("x", 0.5, 1.0)], buffer_start_sample=123457)
    assert records[0]["start_sample"] == 123457 + int(round(0.5 * SR))
    assert records[0]["end_sample"] == 123457 + int(round(1.0 * SR))


def test_history_window_semantics_are_unchanged_by_this_patch():
    """The "no change to emission" gate: the window is still measured from `buffer_offset`, not
    from the audio.

    The fix is DELIBERATELY deferred to a separate commit - it changes which words count as
    duplicates, i.e. it changes the emitted text.
    """
    dedup = make(min_new_words=1)
    dedup.process([chunk("stare", 0.0, 0.5)], buffer_offset=0.0)
    dedup.process([chunk("nowe", 200.0, 200.5)], buffer_offset=0.0)
    assert "stare" in [w for w, _, _ in dedup.confirmed_words]


def test_sidecar_records_are_integers_from_the_moment_they_are_created():
    """Records are not reconstructed from seconds - they are born as samples."""
    dedup = make(min_new_words=1)
    origin = 1_973_333
    _, records, _status, _reason = dedup.process_with_spans([chunk("x", 0.5, 1.0)], buffer_start_sample=origin)

    assert dedup.pending_spans == []          # drained once the delta has been sent
    assert isinstance(records[0]["start_sample"], int)
    assert records[0]["start_sample"] == origin + int(round(0.5 * SR))
    # the sidecar has no seconds left to reconstruct
    assert set(dedup.last_delta_spans[0]) == {"text", "start_sample", "end_sample"}


def test_plain_process_records_a_hole_instead_of_guessing_a_span():
    """Without a supplied sample axis, NO span is created.

    The sidecar records a REASON CODE (`missing_span`) precisely so that a later emission can
    say `incomplete_provenance` with a disjoint reason, instead of handing over evidence for
    part of the delta. The earlier `None` conflated a missing sample axis with a rejected
    timestamp.
    """
    dedup = make(min_new_words=1)
    assert dedup.process([chunk("x", 0.5, 1.0)], buffer_offset=7.0) == "x"
    assert dedup.last_delta_spans == ["missing_span"]
    assert dedup.pending_spans == []


def test_span_origin_is_cleared_even_when_processing_raises():
    dedup = make(min_new_words=1)
    try:
        dedup.process_with_spans([{"text": "x", "timestamp": None}], buffer_start_sample=100)
    except Exception:
        pass
    assert dedup._span_origin_sample is None


# ── fixes after review (05.08, round 2) ───────────────────────────────────────────────────────────

def test_non_default_sample_rate_is_honoured():
    """Regression: `sample_rate` was ignored in favour of the global SAMPLE_RATE=16000."""
    dedup = make(min_new_words=1)
    delta, records, status, reason = dedup.process_with_spans(
        [chunk("x", 0.5, 1.0)], buffer_start_sample=100, sample_rate=8000
    )
    assert (delta, status) == ("x", "complete")
    assert records == [{"text": "x", "start_sample": 4100, "end_sample": 8100}]


def test_mixing_both_apis_never_returns_a_partial_proof():
    """A word added by the plain `process()` has no span.

    If the wrapper returned what it holds, we would get evidence for ONE word that looked like
    evidence for the whole delta `a b c` - more dangerous than an explicit absence of provenance.
    """
    dedup = make(min_new_words=3)
    dedup.process([chunk("a", 0.0, 0.3)], buffer_offset=0.0)          # no sample axis
    delta, records, status, reason = dedup.process_with_spans(
        [chunk("b", 0.4, 0.6), chunk("c", 0.7, 0.9)], buffer_start_sample=0
    )
    assert delta == "a b c"                    # emission unchanged
    assert records == []                       # but ZERO spans
    assert status == "incomplete_provenance"
    # DISJOINT reason: the word "a" arrived on a path with no sample axis, not via a bad timestamp.
    assert reason == "missing_span"


def test_clean_path_through_one_api_stays_complete():
    dedup = make(min_new_words=3)
    dedup.process_with_spans([chunk("a", 0.0, 0.3)], buffer_start_sample=0)
    delta, records, status, reason = dedup.process_with_spans(
        [chunk("b", 0.4, 0.6), chunk("c", 0.7, 0.9)], buffer_start_sample=0
    )
    assert (delta, status) == ("a b c", "complete")
    assert reason is None, "complete evidence has nothing to explain"
    assert [r["text"] for r in records] == ["a", "b", "c"]


def test_invalid_timestamp_inside_a_delta_marks_it_incomplete_without_dropping_words():
    """Validation shared with `provenance.py`: `inf` creates no span, but the word still ships."""
    dedup = make(min_new_words=1)
    delta, records, status, reason = dedup.process_with_spans(
        [chunk("zly", float("inf"), 1.0), chunk("ok", 0.1, 0.4)], buffer_start_sample=0
    )
    assert delta == "zly ok"                   # no change to the emission
    assert records == []
    assert status == "incomplete_provenance"
    # `inf` is a REJECTED CONVERSION, not a historical hole - the buckets must tell them apart.
    assert reason == "invalid_timestamp"


def test_no_delta_reports_its_own_status():
    dedup = make(min_new_words=5)
    delta, records, status, reason = dedup.process_with_spans([chunk("sam", 0.0, 0.3)], buffer_start_sample=0)
    assert (delta, records, status, reason) == (None, [], "no_delta", None)


def test_reason_never_leaks_the_source_word():
    """Reason codes reach cloud logs - the body of `ProvenanceError` carries `repr(word)`."""
    dedup = make(min_new_words=1)
    _, _, status, reason = dedup.process_with_spans(
        [chunk("Gelassenheit", float("nan"), 1.0)], buffer_start_sample=0
    )
    assert status == "incomplete_provenance"
    assert reason == "invalid_timestamp"
    assert "Gelassenheit" not in reason
    assert reason in ws.PROVENANCE_REASONS


# -- snapshot boundaries and argument validation ---------------------------------

def test_timestamp_beyond_the_snapshot_is_not_a_proof():
    """A binding condition: the sidecar must know where the decoded input ends.

    A 0-5 s timestamp against a 1 s snapshot used to come back as `complete`, because the
    wrapper did not pass `input_end_sample`.
    """
    dedup = make(min_new_words=1)
    delta, records, status, reason = dedup.process_with_spans(
        [chunk("x", 0.0, 5.0)], buffer_start_sample=0, input_end_sample=SR
    )
    assert delta == "x"                        # no change to the emission
    assert records == []
    assert status == "incomplete_provenance"


def test_timestamp_inside_the_snapshot_stays_complete():
    dedup = make(min_new_words=1)
    delta, records, status, reason = dedup.process_with_spans(
        [chunk("y", 0.0, 0.5)], buffer_start_sample=0, input_end_sample=SR
    )
    assert (delta, status) == ("y", "complete")
    assert records[0]["end_sample"] == SR // 2


@pytest.mark.parametrize("kwargs", [
    {"buffer_start_sample": -1},
    {"buffer_start_sample": 1.5},
    {"buffer_start_sample": True},
    {"buffer_start_sample": 0, "sample_rate": 0},
    {"buffer_start_sample": 0, "sample_rate": -16000},
    {"buffer_start_sample": 0, "sample_rate": 16000.0},
    {"buffer_start_sample": 100, "input_end_sample": 50},
    {"buffer_start_sample": 0, "input_end_sample": 1.5},
])
def test_invalid_arguments_are_rejected_not_silently_coerced(kwargs):
    """A silent `int()` on a bad value would turn a wrong snapshot into believable samples."""
    dedup = make(min_new_words=1)
    with pytest.raises(ValueError):
        dedup.process_with_spans([chunk("x", 0.0, 0.2)], **kwargs)
