"""Timestamp counters: two axes, a fingerprint, no text, no repair."""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from chunk_diagnostics import (  # noqa: E402
    COMPARED_FIELDS,
    MAX_POSITIONS,
    TIMESTAMP_STATUSES,
    diff_summaries,
    summarize_chunk_timestamps,
    timestamp_fingerprint,
)

SR = 16000
# Words from a real leak - the same ones the fix gate rests on.
LEAKED = ("des", "Wenn", "Minuten", "Gelassenheit")


def chunk(text, start, end):
    return {"text": text, "timestamp": (start, end)}


# ── axis 1: timestamp statuses, disjoint ──────────────────────────────────────────────────────────

def test_timestamp_statuses_are_disjoint_and_cover_every_chunk():
    chunks = [
        chunk("Wenn", 0.0, 0.5),                   # valid
        chunk("des", 2.18, 2.18),                  # zero length
        chunk("Minuten", 3.0, 2.0),                # reversed
        chunk("Gelassenheit", float("inf"), 1.0),  # non-finite
        chunk("x", -1.0, 0.5),                     # negative start
        {"text": "y", "timestamp": None},          # missing
        chunk("z", 0.0, 99.0),                     # outside the snapshot
    ]
    s = summarize_chunk_timestamps(chunks, sample_rate=SR, snapshot_samples=SR * 10)

    assert sum(s[status] for status in TIMESTAMP_STATUSES) == s["chunk_count"] == 7
    assert (s["zero_length"], s["reversed"], s["non_finite"]) == (1, 1, 1)
    assert (s["negative_start"], s["missing_timestamp"], s["beyond_snapshot"]) == (1, 1, 1)
    assert s["timestamp_valid"] == 1


def test_zero_length_and_reversed_are_not_one_bucket():
    """In production both ended as `zero_or_reversed` - here they must be separated."""
    s = summarize_chunk_timestamps([chunk("a", 1.0, 1.0), chunk("b", 2.0, 1.5)])
    assert (s["zero_length"], s["reversed"]) == (1, 1)


def test_beyond_snapshot_uses_the_sample_domain():
    """The same domain as `relative_timestamp_to_samples` - samples, not seconds."""
    inside = summarize_chunk_timestamps([chunk("a", 0.0, 1.0)], sample_rate=SR, snapshot_samples=SR)
    beyond = summarize_chunk_timestamps([chunk("a", 0.0, 5.0)], sample_rate=SR, snapshot_samples=SR)
    assert inside["timestamp_valid"] == 1 and inside["beyond_snapshot"] == 0
    assert beyond["beyond_snapshot"] == 1 and beyond["timestamp_valid"] == 0

    unknown = summarize_chunk_timestamps([chunk("a", 0.0, 5.0)], sample_rate=SR)
    assert unknown["beyond_snapshot"] == 0 and unknown["timestamp_valid"] == 1


# -- axis 2: content shape and real usability -----------------------------------

def test_multi_token_chunk_has_a_valid_timestamp_but_is_not_usable():
    """`align_text_to_spans()` rejects a multi-token chunk as `non_word_level_chunk`.

    A counter that called such a chunk "usable" would promise evidence production never
    creates - exactly the class of defect closed earlier on this track.
    """
    s = summarize_chunk_timestamps([chunk("two words", 4.0, 4.5)], snapshot_samples=SR * 10)
    assert s["timestamp_valid"] == 1
    assert s["multi_token"] == 1
    assert s["provenance_usable"] == 0


def test_empty_text_with_a_valid_timestamp_is_not_usable_either():
    """`chunks_to_word_spans()` skips a chunk with no text - no span is created."""
    s = summarize_chunk_timestamps([chunk("", 0.0, 0.5)], snapshot_samples=SR * 10)
    assert s["timestamp_valid"] == 1 and s["empty_text"] == 1
    assert s["provenance_usable"] == 0


def test_usable_requires_both_axes():
    chunks = [
        chunk("Wenn", 0.0, 0.5),        # valid + single token -> usable
        chunk("two words", 1.0, 1.5),   # valid, but multi-token
        chunk("des", 2.18, 2.18),       # single token, but a zero-length interval
    ]
    s = summarize_chunk_timestamps(chunks, snapshot_samples=SR * 10)
    assert s["provenance_usable"] == 1
    assert s["single_token"] == 2 and s["multi_token"] == 1
    assert s["empty_text"] + s["single_token"] + s["multi_token"] == s["chunk_count"]


# ── where the degenerates are ─────────────────────────────────────────────────────────────────────

def test_positions_show_where_in_the_window_degenerates_sit():
    chunks = [chunk(f"w{i}", i * 1.0, i * 1.0 + 0.5) for i in range(10)]
    chunks[0] = chunk("w0", 0.0, 0.0)
    chunks[9] = chunk("w9", 9.0, 9.0)
    s = summarize_chunk_timestamps(chunks)

    assert s["zero_length_positions"] == [0, 9]
    assert s["zero_length_first_pos_pct"] == 0.0
    assert s["zero_length_last_pos_pct"] == 100.0
    assert s["degenerate_pct"] == 20.0


def test_last_position_is_tracked_independently_of_the_sample_cap():
    """REGRESSION: with more than 20 degenerates the last RECORDED index is not the last occurrence.

    The previous version computed `last_pos_pct` from the truncated list and reported ~65.5%
    instead of 100% for 30 zero-length chunks - i.e. it was wrong precisely where degenerates are
    most numerous.
    """
    chunks = [chunk(f"w{i}", 1.0, 1.0) for i in range(30)]
    s = summarize_chunk_timestamps(chunks)

    assert s["zero_length"] == 30
    assert len(s["zero_length_positions"]) == MAX_POSITIONS       # the list is still truncated
    assert s["zero_length_first_pos"] == 0 and s["zero_length_last_pos"] == 29
    assert s["zero_length_first_pos_pct"] == 0.0
    assert s["zero_length_last_pos_pct"] == 100.0


# ── fingerprint ───────────────────────────────────────────────────────────────────────────────────

def test_fingerprint_sees_a_value_change_that_counters_cannot():
    """The heart of the fix: `(0.0, 0.5)` and `(7.0, 8.0)` are BOTH `timestamp_valid`."""
    a = [chunk("x", 0.0, 0.5)]
    b = [chunk("x", 7.0, 8.0)]
    sa = summarize_chunk_timestamps(a, snapshot_samples=SR * 100)
    sb = summarize_chunk_timestamps(b, snapshot_samples=SR * 100)

    assert sa["timestamp_valid"] == sb["timestamp_valid"] == 1     # the counter does NOT see the difference
    assert diff_summaries(sa, sb)["classification_counts_identical"] is True
    assert diff_summaries(sa, sb)["timestamps_identical"] is False  # the fingerprint sees it


def test_fingerprint_depends_on_order():
    a = [chunk("x", 0.0, 0.5), chunk("y", 1.0, 1.5)]
    b = [chunk("x", 1.0, 1.5), chunk("y", 0.0, 0.5)]
    assert timestamp_fingerprint(a).digest != timestamp_fingerprint(b).digest


def test_fingerprint_separates_missing_from_malformed_and_from_types():
    variants = [
        [{"text": "a", "timestamp": None}],
        [{"text": "a", "timestamp": (0.0,)}],
        [chunk("a", 0, 1)],
        [chunk("a", 0.0, 1.0)],
        [chunk("a", float("nan"), 1.0)],
    ]
    prints = [timestamp_fingerprint(v).digest for v in variants]
    assert len(set(prints)) == len(prints), "different shapes must give different fingerprints"


def test_fingerprint_is_stable_for_identical_input():
    chunks = [chunk("a", 0.0, 0.5), {"text": "b", "timestamp": None}, chunk("c", 2.18, 2.18)]
    assert timestamp_fingerprint(chunks) == timestamp_fingerprint(list(chunks))
    assert timestamp_fingerprint([]) == timestamp_fingerprint(None)
    # a missing timestamp is a FAITHFULLY represented state, so the fingerprint stays COMPLETE
    assert timestamp_fingerprint(chunks).complete is True


def test_fingerprint_never_ingests_chunk_text():
    """Text must not enter even the hashed MATERIAL."""
    a = [chunk("Gelassenheit", 0.0, 0.5)]
    b = [chunk("Geld", 0.0, 0.5)]
    assert timestamp_fingerprint(a) == timestamp_fingerprint(b)
    assert timestamp_fingerprint(a).complete is True


def test_unencodable_value_marks_the_fingerprint_incomplete():
    """Text where a number belongs: it is not encoded - but then "identical" MUST NOT be said.

    `Geld` and `Gelassenheit` deliberately produce the same type token (privacy). If the verdict
    stayed `true`, the absence of a difference would follow from NARROWED encoding, not from the
    data.
    """
    a = [{"text": "x", "timestamp": ("Geld", 1.0)}]
    b = [{"text": "x", "timestamp": ("Gelassenheit", 1.0)}]
    fa, fb = timestamp_fingerprint(a), timestamp_fingerprint(b)

    assert fa.digest == fb.digest          # text does not enter the material
    assert "Gelassenheit" not in fa.digest and "Geld" not in fa.digest
    assert fa.complete is False and fb.complete is False

    sa = summarize_chunk_timestamps(a)
    sb = summarize_chunk_timestamps(b)
    d = diff_summaries(sa, sb)
    assert d["timestamps_comparable"] is False
    assert d["timestamps_identical"] is None, "narrowed encoding must not impersonate agreement"


def test_numpy_scalars_keep_their_exact_value_in_the_fingerprint():
    """The Transformers pipeline can return NumPy scalars.

    An earlier version recognised only built-in `int`/`float`, so `float32(0.5)` and
    `float32(7.0)` produced an IDENTICAL token - the fingerprint reported "no change" for two
    different sequences, i.e. exactly the false evidence it is meant to prevent.
    """
    np = pytest.importorskip("numpy")
    a = [chunk("x", np.float32(0.5), np.float32(1.0))]
    b = [chunk("x", np.float32(7.0), np.float32(8.0))]
    fa, fb = timestamp_fingerprint(a), timestamp_fingerprint(b)

    assert fa.digest != fb.digest
    assert fa.complete is True and fb.complete is True
    # the same value in a NumPy type and a built-in type is the same value
    assert timestamp_fingerprint([chunk("x", np.float64(0.5), np.float64(1.0))]).digest ==         timestamp_fingerprint([chunk("x", 0.5, 1.0)]).digest
    # and the same at the verdict level
    assert diff_summaries(summarize_chunk_timestamps(a), summarize_chunk_timestamps(b))["timestamps_identical"] is False


def test_precision_is_not_lost_in_the_fingerprint():
    """`float.hex()` records the value losslessly - 0.1 does not become an approximation."""
    a = [chunk("x", 0.1, 0.2)]
    b = [chunk("x", 0.1 + 1e-16, 0.2)]
    assert timestamp_fingerprint(a).digest != timestamp_fingerprint(b).digest


# -- result hygiene --------------------------------------------------------------

def test_timestamp_types_are_names_never_values():
    chunks = [
        chunk("a", 0.0, 0.5), chunk("b", 1, 2), chunk("c", float("nan"), 1.0),
        {"text": "d", "timestamp": None}, {"text": "e", "timestamp": (0.0,)},
    ]
    s = summarize_chunk_timestamps(chunks)
    for key in ("float/float", "int/int", "nan/float", "missing", "malformed"):
        assert s["timestamp_types"][key] == 1


def test_summary_never_carries_source_text():
    chunks = [chunk(w, 2.18, 2.18) for w in LEAKED] + [chunk("Gelassenheit ist", 0.0, 1.0)]
    blob = json.dumps(summarize_chunk_timestamps(chunks, snapshot_samples=SR), ensure_ascii=False)
    for word in LEAKED:
        assert word not in blob, f"word {word} reached the summary"


def test_summary_does_not_repair_anything():
    chunks = [chunk("a", 2.18, 2.18)]
    before = json.dumps(chunks, sort_keys=True)
    summarize_chunk_timestamps(chunks)
    assert json.dumps(chunks, sort_keys=True) == before


def test_shape_is_constant_regardless_of_data():
    """EXACT equality of the key set for every input.

    A previous test allowed `set(s) <= set(full)`, so a missing field of ANY kind passed - and
    that is exactly how `zero_length_*_pos_pct` appeared only when there were degenerates. A
    consumer then cannot tell "there were no degenerates" from "it was not computed".
    """
    variants = [
        [],
        None,
        [chunk("a", 0.0, 0.5)],                            # no degenerates
        [chunk("a", 1.0, 1.0), chunk("b", 2.0, 2.0)],      # two zero-length
        [{"text": "x", "timestamp": ("Geld", 1.0)}],       # incomplete fingerprint
    ]
    key_sets = [set(summarize_chunk_timestamps(v)) for v in variants]
    for keys in key_sets[1:]:
        assert keys == key_sets[0], "the summary shape depends on the data"

    empty = summarize_chunk_timestamps([])
    assert empty["chunk_count"] == 0 and empty["degenerate_pct"] == 0.0
    assert empty["provenance_usable"] == 0 and empty["timestamp_fingerprint"]
    # the positional fields EXIST and are explicitly empty, rather than disappearing
    assert empty["zero_length_first_pos_pct"] is None
    assert empty["zero_length_last_pos_pct"] is None


class TestDiffSummaries:
    def test_identical_input_gives_both_verdicts_true(self):
        chunks = [chunk("a", 0.0, 0.5), chunk("b", 1.0, 1.0)]
        one = summarize_chunk_timestamps(chunks, snapshot_samples=SR * 5)
        two = summarize_chunk_timestamps(chunks, snapshot_samples=SR * 5)
        d = diff_summaries(one, two)
        assert d == {"comparable": True, "timestamps_comparable": True,
                     "timestamps_identical": True,
                     "classification_counts_identical": True, "changed_fields": []}

    def test_a_difference_points_at_the_field(self):
        one = summarize_chunk_timestamps([chunk("a", 0.0, 0.5), chunk("b", 1.0, 1.0)])
        two = summarize_chunk_timestamps([chunk("a", 0.0, 0.5)])
        d = diff_summaries(one, two)
        assert d["classification_counts_identical"] is False
        assert d["timestamps_identical"] is False
        assert "chunk_count" in d["changed_fields"] and "zero_length" in d["changed_fields"]

    def test_missing_side_is_not_silently_called_identical(self):
        one = summarize_chunk_timestamps([chunk("a", 0.0, 0.5)])
        assert diff_summaries(one, None)["timestamps_identical"] is None
        assert diff_summaries(None, one)["classification_counts_identical"] is None
        assert diff_summaries(one, None)["comparable"] is False

    def test_compared_fields_cover_both_axes(self):
        for field in TIMESTAMP_STATUSES:
            assert field in COMPARED_FIELDS
        for field in ("empty_text", "single_token", "multi_token", "provenance_usable"):
            assert field in COMPARED_FIELDS
