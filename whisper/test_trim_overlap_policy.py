"""Per-reason trim overlap policy + livelock invariant (Phase 1a/1b, 28.06.2026).

Locks the contract that prevents the overlap=5 livelock: FORCE trims must keep a SMALL
overlap (so effective_trim clears the hard limit) while NORMAL trims may keep a wide one
(LA warm-start quality). See whisper_service._trim_overlap_for_reason / config.py.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))  # run from repo root or whisper/

import whisper_service as w
from config import STREAMING_CONFIG

NORMAL = ("sentence_confirmed", "sentence_boundary")
FORCE = ("hard_limit", "proactive_hard_limit", "emergency", "hallucination_burst")


def test_normal_reasons_get_wide_overlap():
    assert w._trim_overlap_for_reason("sentence_confirmed") == 5.0
    assert w._trim_overlap_for_reason("sentence_boundary") == 3.0


def test_force_reasons_get_small_overlap():
    for r in FORCE:
        assert w._trim_overlap_for_reason(r) == 1.0, r


def test_unknown_reason_defaults_to_force_small():
    # Safe default: an unrecognised reason must NOT accidentally get a wide overlap.
    assert w._trim_overlap_for_reason("something_new") == STREAMING_CONFIG["trim_overlap_force_sec"]


def test_livelock_invariant_force_strictly_smaller_than_normal():
    # The invariant that prevents the 96s stall: force overlap must be small enough that
    # effective_trim (= force_trim_time - overlap) clears the hard limit. Concretely it must
    # be < the normal overlaps (which can be as large as the hard limit itself).
    force = max(w._trim_overlap_for_reason(r) for r in FORCE)
    normal = min(w._trim_overlap_for_reason(r) for r in NORMAL)
    assert force < normal


def test_livelock_guard_threshold_present_and_sane():
    n = STREAMING_CONFIG["livelock_guard_max_hard_trims"]
    assert isinstance(n, int) and 1 <= n <= 20

def test_c7_post_submit_reasons_stay_in_force_bucket():
    # C.7 changes ordering only. It must not widen force-trim overlap back toward the
    # overlap=5 livelock geometry.
    assert w._trim_overlap_for_reason("hard_limit_post_submit") == STREAMING_CONFIG["trim_overlap_force_sec"]
    assert w._trim_overlap_for_reason("hard_limit_deferred") == STREAMING_CONFIG["trim_overlap_force_sec"]


def test_c7_submit_before_trim_flag_defaults_off():
    assert STREAMING_CONFIG["force_trim_submit_before_trim_enabled"] is False

class _FakeAudioBuffer:
    def __init__(self, seconds=14.0, offset=100.0):
        self.audio_buffer = [0] * int(w.SAMPLE_RATE * seconds)
        self._offset = offset

    def get_buffer_offset(self):
        return self._offset


class _FakeTimestampDeduplicator:
    def __init__(self, confirmed_words=None):
        self.confirmed_words = confirmed_words or []


class _FakeSession:
    def __init__(self, confirmed_words=None):
        self.session_id = "test-session"
        self.pending_force_trim_time = None
        self.pending_force_trim_reason = None
        self.pre_submit_attempts = 0
        self.pre_submit_completions = 0
        self.audio_buffer = _FakeAudioBuffer()
        self.timestamp_deduplicator = _FakeTimestampDeduplicator(confirmed_words)


def test_c7_pending_force_trim_counts_attempt_once_and_tracks_updates(monkeypatch):
    events = []
    monkeypatch.setattr(w, "_log_whisper_diag", lambda event, **fields: events.append((event, fields)))
    session = _FakeSession()

    w._set_pending_force_trim(session, 7.0, "hard_limit_post_submit")
    w._set_pending_force_trim(session, 8.0, "hard_limit_deferred")

    assert session.pending_force_trim_time == 8.0
    assert session.pending_force_trim_reason == "hard_limit_deferred"
    assert session.pre_submit_attempts == 1
    assert [e[0] for e in events] == ["hard_limit_pre_submit", "hard_limit_pre_submit_update"]
    assert events[0][1]["legacy_drop_start_abs_s"] == 100.0
    assert events[0][1]["legacy_drop_end_abs_s"] == 106.0


def test_c7_post_submit_clears_pending_and_preserves_reason(monkeypatch):
    events = []
    trims = []
    monkeypatch.setattr(w, "_log_whisper_diag", lambda event, **fields: events.append((event, fields)))
    monkeypatch.setattr(w, "_perform_buffer_trim", lambda session, trim_time, chunks, reason: trims.append((trim_time, chunks, reason)))
    session = _FakeSession()
    session.pending_force_trim_time = 8.0
    session.pending_force_trim_reason = "hard_limit_deferred"

    w._perform_pending_force_trim_after_submit(session, [], "geretteter Text")

    assert session.pending_force_trim_time is None
    assert session.pending_force_trim_reason is None
    assert session.pre_submit_completions == 1
    assert trims == [(8.0, [], "hard_limit_deferred")]
    assert events[0][0] == "hard_limit_post_submit"
    assert events[0][1]["pre_submit_confirmed_words"] == 2
    assert events[0][1]["pre_submit_confirmed_preview"] == "geretteter Text"

def test_c9_word_boundary_snap_defaults_off_and_logs_probe(monkeypatch):
    events = []
    monkeypatch.setattr(w, "_log_whisper_diag", lambda event, **fields: events.append((event, fields)))
    monkeypatch.setitem(STREAMING_CONFIG, "force_trim_word_boundary_snap_enabled", False)
    monkeypatch.setitem(STREAMING_CONFIG, "force_trim_word_boundary_snap_window_sec", 1.2)
    session = _FakeSession(confirmed_words=[("word", 105.9, 106.4)])

    snapped = w._snap_force_trim_time_to_word_boundary(session, 7.0, "hard_limit", source="chunk_add")

    assert snapped == 7.0
    assert events[0][0] == "force_trim_word_boundary_snap_probe"
    assert events[0][1]["enabled"] is False
    assert events[0][1]["applied"] is False
    assert events[0][1]["would_snap"] is True
    assert events[0][1]["source"] == "chunk_add"
    assert events[0][1]["would_snap_trim_s"] == 7.6
    assert events[0][1]["would_snap_delta_s"] == 0.6
    assert events[0][1]["nearest_word_end_distance_s"] == 0.4


def test_c9_word_boundary_snap_aligns_effective_cut_when_enabled(monkeypatch):
    events = []
    monkeypatch.setattr(w, "_log_whisper_diag", lambda event, **fields: events.append((event, fields)))
    monkeypatch.setitem(STREAMING_CONFIG, "force_trim_word_boundary_snap_enabled", True)
    monkeypatch.setitem(STREAMING_CONFIG, "force_trim_word_boundary_snap_window_sec", 1.2)
    session = _FakeSession(confirmed_words=[("word", 105.9, 106.4)])

    snapped = w._snap_force_trim_time_to_word_boundary(session, 7.0, "hard_limit", source="chunk_add")

    # Original hard-limit trim=7.0 with force overlap=1.0 cuts effectively at abs 106.0.
    # Snapping to word end 106.4 plus 200ms safety margin converts back to requested trim=7.6.
    assert snapped == pytest.approx(7.6)
    assert events[0][1]["applied"] is True
    assert events[0][1]["snap_delta_s"] == 0.6
    assert events[0][1]["would_snap_delta_s"] == 0.6
    assert events[0][1]["snap_direction"] == "forward"


def test_c9_word_boundary_snap_keeps_legacy_trim_when_no_nearby_word(monkeypatch):
    events = []
    monkeypatch.setattr(w, "_log_whisper_diag", lambda event, **fields: events.append((event, fields)))
    monkeypatch.setitem(STREAMING_CONFIG, "force_trim_word_boundary_snap_enabled", True)
    monkeypatch.setitem(STREAMING_CONFIG, "force_trim_word_boundary_snap_window_sec", 0.5)
    session = _FakeSession(confirmed_words=[("old", 100.2, 100.6)])

    snapped = w._snap_force_trim_time_to_word_boundary(session, 7.0, "hard_limit", source="chunk_add")

    assert snapped == 7.0
    assert events[0][1]["applied"] is False
    assert events[0][1]["would_snap"] is False
    assert events[0][1]["nearest_word_end_distance_s"] == 5.4
