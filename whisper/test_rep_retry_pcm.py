from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
import hashlib
import threading

import numpy as np
import pytest

from provenance import pcm_sha256
from rep_retry_budget import RetrySkipped
from rep_retry_pcm import ParentDecodeKey, ParentPcmLeases
from ring_buffer import DecodeInputSnapshot, GrowingAudioBuffer


def snapshot(start=0, count=16):
    return DecodeInputSnapshot(np.arange(count, dtype=np.float32), start, start + count)


def retain(store, value=None, decode_id=1, expires_at=20):
    value = value if value is not None else snapshot()
    return store.retain(value, parent_decode_id=decode_id,
                        parent_pcm_sha256=pcm_sha256(value.audio), expires_at=expires_at)


@pytest.fixture
def store():
    instance = ParentPcmLeases("session-a", max_bytes=640_000, max_leases=4, clock=lambda: 10)
    yield instance
    instance.close()


def test_absolute_slice_survives_real_buffer_trim_and_clear(store):
    buffer = GrowingAudioBuffer()
    buffer.add(np.arange(160_000, dtype=np.float32))
    parent = buffer.snapshot_for_decode()
    lease = retain(store, parent)
    buffer.trim_at_time(5, overlap_seconds=1)
    buffer.clear()
    segment = store.slice_absolute(lease, 16_000, 48_000)
    assert segment.start_sample == 16_000
    assert segment.end_sample == 48_000
    assert segment.pcm == parent.audio[16_000:48_000].tobytes()
    assert segment.pcm_sha256 == hashlib.sha256(segment.pcm).hexdigest()
    assert segment.lease.pcm_sha256 == pcm_sha256(parent.audio)


def test_retention_is_immutable_even_if_caller_mutates_snapshot(store):
    parent = snapshot(123)
    lease = retain(store, parent)
    expected = parent.audio[1:3].tobytes()
    parent.audio[:] = -1
    segment = store.slice_absolute(lease, 124, 126)
    assert segment.pcm == expected
    with pytest.raises(ValueError):
        segment.audio()[0] = 123
    with pytest.raises(ValueError):
        segment.audio().setflags(write=True)


@pytest.mark.parametrize("start,end", [(99, 101), (100, 117), (100, 100),
                                       (102, 101), (100.0, 102), (True, 102)])
def test_invalid_ranges_never_clamp_or_round(store, start, end):
    lease = retain(store, snapshot(100))
    with pytest.raises(RetrySkipped, match="pcm_range_unavailable"):
        store.slice_absolute(lease, start, end)


@pytest.mark.parametrize("value", [
    DecodeInputSnapshot(np.zeros(4, dtype=np.float64), 0, 4),
    DecodeInputSnapshot(np.zeros(8, dtype=np.float32)[::2], 0, 4),
    DecodeInputSnapshot(np.zeros((2, 2), dtype=np.float32), 0, 4),
    DecodeInputSnapshot(np.zeros(4, dtype=np.float32), 0, 5),
    DecodeInputSnapshot(np.zeros(4, dtype=np.float32), -1, 3),
    DecodeInputSnapshot(np.zeros(0, dtype=np.float32), 0, 0),
])
def test_invalid_snapshot_is_never_resampled_or_reinterpreted(store, value):
    with pytest.raises(RetrySkipped, match="invalid_pcm_snapshot"):
        store.retain(value, parent_decode_id=1, parent_pcm_sha256="bad", expires_at=20)
    assert store.retained_bytes == 0


def test_parent_hash_must_describe_copied_bytes(store):
    with pytest.raises(RetrySkipped, match="parent_pcm_hash_mismatch"):
        store.retain(snapshot(), parent_decode_id=1, parent_pcm_sha256="0" * 64, expires_at=20)
    assert store.retained_bytes == 0


def test_forged_handle_or_other_session_never_accesses_pcm(store):
    lease = retain(store)
    other = ParentPcmLeases("session-b", max_bytes=64, max_leases=1, clock=lambda: 10)
    try:
        with pytest.raises(RetrySkipped, match="pcm_lease_unavailable"):
            other.slice_absolute(lease, 0, 1)
        with pytest.raises(RetrySkipped, match="pcm_lease_unavailable"):
            store.slice_absolute(replace(lease), 0, 1)
    finally:
        other.close()


def test_expiry_releases_retained_bytes_and_never_revives_old_handle():
    now = [10.0]
    store = ParentPcmLeases("session-a", max_bytes=64, max_leases=1, clock=lambda: now[0])
    try:
        old = retain(store, expires_at=11)
        now[0] = 11
        assert store.retained_bytes == 0
        fresh = retain(store, expires_at=12)
        assert fresh.lease_id != old.lease_id
        with pytest.raises(RetrySkipped, match="pcm_lease_unavailable"):
            store.slice_absolute(old, 0, 1)
    finally:
        store.close()


def test_reset_means_close_then_new_store_and_invalidates_old_handles(store):
    old = retain(store)
    store.close()
    assert store.retained_bytes == 0
    with pytest.raises(RetrySkipped, match="session_closed"):
        store.slice_absolute(old, 0, 1)
    with pytest.raises(RetrySkipped, match="session_closed"):
        retain(store)
    replacement = ParentPcmLeases("session-a", max_bytes=64, max_leases=1, clock=lambda: 10)
    try:
        retain(replacement)
        with pytest.raises(RetrySkipped, match="pcm_lease_unavailable"):
            replacement.slice_absolute(old, 0, 1)
    finally:
        replacement.close()


@pytest.mark.parametrize("max_bytes,max_leases", [(64, 4), (640, 1)])
def test_capacity_skips_without_evicting_valid_parent(max_bytes, max_leases):
    store = ParentPcmLeases("session", max_bytes=max_bytes, max_leases=max_leases, clock=lambda: 10)
    try:
        first = retain(store)
        with pytest.raises(RetrySkipped, match="pcm_capacity"):
            retain(store, decode_id=2)
        assert store.slice_absolute(first, 0, 16).pcm == snapshot().audio.tobytes()
        store.release(first)
        store.release(first)  # Idempotent release, no negative accounting.
        assert store.retained_bytes == 0
        retain(store, decode_id=2)
    finally:
        store.close()


def test_same_parent_cannot_overwrite_its_retained_pcm(store):
    retain(store)
    with pytest.raises(RetrySkipped, match="parent_already_retained"):
        retain(store)


def test_concurrent_retention_has_atomic_capacity():
    store = ParentPcmLeases("session", max_bytes=64, max_leases=1, clock=lambda: 10)
    start = threading.Barrier(4)

    def attempt(number):
        start.wait(timeout=2)
        try:
            return retain(store, decode_id=number)
        except RetrySkipped as skipped:
            return skipped.reason

    try:
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(attempt, range(4)))
        assert sum(not isinstance(result, str) for result in results) == 1
        assert results.count("pcm_capacity") == 3
        assert store.retained_bytes == 64
    finally:
        store.close()


@pytest.mark.parametrize("decode_id", [-1, True, "1/retry/1", 1.5])
def test_non_parent_or_retry_decode_identity_is_rejected(store, decode_id):
    with pytest.raises(RetrySkipped, match="invalid_parent_identity"):
        retain(store, decode_id=decode_id)


def test_coordinate_space_must_belong_to_session():
    with pytest.raises(RetrySkipped, match="invalid_parent_identity"):
        ParentDecodeKey("session-a", "other-coordinate", 1)
