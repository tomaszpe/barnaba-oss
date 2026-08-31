import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))  # run from repo root or whisper/

from ring_buffer import GrowingAudioBuffer
from trim_context import build_overlap_text_from_timestamps


def test_trim_result_uses_effective_offset_when_audio_overlap_is_kept():
    buf = GrowingAudioBuffer(
        min_chunk_seconds=1.0,
        max_buffer_seconds=30.0,
        sample_rate=10,
    )
    buf.add(np.arange(200, dtype=np.float32))

    result = buf.trim_at_time(12.0, overlap_seconds=1.0)

    assert result.did_trim
    assert result.requested_trim_time == 12.0
    assert result.effective_trim_time == 11.0
    assert result.kept_overlap_seconds == 1.0
    assert result.new_buffer_offset == 11.0
    assert buf.get_buffer_offset() == 11.0
    assert buf.duration_seconds == 9.0
    assert buf.get_full_buffer()[0] == 110.0


def test_retained_overlap_keeps_same_absolute_word_time_after_trim():
    buf = GrowingAudioBuffer(
        min_chunk_seconds=1.0,
        max_buffer_seconds=30.0,
        sample_rate=10,
    )
    buf.add(np.zeros(200, dtype=np.float32))

    before_abs = (11.2, 11.5)
    result = buf.trim_at_time(12.0, overlap_seconds=1.0)

    replayed_relative = (0.2, 0.5)
    replayed_abs = (
        result.new_buffer_offset + replayed_relative[0],
        result.new_buffer_offset + replayed_relative[1],
    )

    assert replayed_abs == before_abs


def test_overlap_warm_start_text_is_selected_by_timestamp_window():
    confirmed_words = [
        ("old", 10.4, 10.7),
        ("overlap", 11.1, 11.4),
        ("region", 11.5, 11.8),
        ("future", 12.2, 12.5),
    ]

    overlap_text = build_overlap_text_from_timestamps(
        confirmed_words,
        overlap_start_abs=11.0,
        overlap_end_abs=12.0,
    )

    assert overlap_text == "overlap region"


def test_trim_keeps_wider_overlap_when_requested():
    # TRIM_OVERLAP_SEC (28.06.2026): widening overlap must retain more audio before trim.
    buf = GrowingAudioBuffer(
        min_chunk_seconds=1.0,
        max_buffer_seconds=30.0,
        sample_rate=10,
    )
    buf.add(np.arange(200, dtype=np.float32))

    result = buf.trim_at_time(12.0, overlap_seconds=3.0)

    assert result.did_trim
    assert result.effective_trim_time == 9.0
    assert result.kept_overlap_seconds == 3.0
    assert result.new_buffer_offset == 9.0


def test_shadow_overlap_window_widens_word_count():
    # Replicates _perform_buffer_trim shadow geometry: trim_point_abs is fixed; a wider
    # window [trim_point_abs - w, trim_point_abs] catches >= words than a narrower one.
    confirmed_words = [
        ("a", 7.1, 7.4),   # in 3s/5s window, NOT in 1s
        ("b", 8.6, 8.9),   # in 2s/3s/5s, NOT in 1s
        ("c", 9.2, 9.5),   # in every window (1s..5s)
    ]
    trim_point_abs = 10.0

    def shadow(w):
        return len(build_overlap_text_from_timestamps(
            confirmed_words, trim_point_abs - w, trim_point_abs, max_words=10000
        ).split())

    assert shadow(1.0) == 1   # only "c"
    assert shadow(2.0) == 2   # "b","c"
    assert shadow(3.0) == 3   # "a","b","c"
    assert shadow(5.0) == 3


def test_large_overlap_skips_short_trim_without_cap():
    # Documents the bug the cap defends against: overlap >= trim_time => trim is SKIPPED.
    buf = GrowingAudioBuffer(min_chunk_seconds=1.0, max_buffer_seconds=30.0, sample_rate=10)
    buf.add(np.arange(200, dtype=np.float32))  # 20s

    result = buf.trim_at_time(4.0, overlap_seconds=5.0)  # overlap > trim_time
    assert not result.did_trim  # buffer would grow -> more hard_limit -> confound


def test_overlap_cap_preserves_min_real_trim():
    # _perform_buffer_trim caps applied overlap to max(0, trim_time - 1.0) so a short trim
    # still removes >= 1s of audio instead of being skipped.
    buf = GrowingAudioBuffer(min_chunk_seconds=1.0, max_buffer_seconds=30.0, sample_rate=10)
    buf.add(np.arange(200, dtype=np.float32))

    trim_time = 4.0
    configured_overlap = 5.0
    applied_overlap = min(configured_overlap, max(0.0, trim_time - 1.0))  # = 3.0
    result = buf.trim_at_time(trim_time, overlap_seconds=applied_overlap)

    assert result.did_trim
    assert result.effective_trim_time == 1.0  # exactly the 1s floor
    assert result.kept_overlap_seconds == 3.0


def test_post_trim_prompt_is_limited_to_two_uses():
    buf = GrowingAudioBuffer(
        min_chunk_seconds=1.0,
        max_buffer_seconds=30.0,
        sample_rate=10,
    )
    buf.add(np.zeros(200, dtype=np.float32))
    buf.trim_at_time(12.0, new_prompt="confirmed context", overlap_seconds=1.0)

    assert buf.get_prompt() == "confirmed context"
    assert buf.get_prompt() == "confirmed context"
    assert buf.get_prompt() == ""
    assert not buf.get_stats()["has_prompt"]
