"""Bounded, exact parent PCM leases for offline E4 tests, not live retention."""
from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import math
import threading
import time
from typing import Callable
from uuid import uuid4

import numpy as np

from rep_retry_budget import RetrySkipped
from rep_shadow import coordinate_space_id
from ring_buffer import DecodeInputSnapshot


@dataclass(frozen=True)
class ParentDecodeKey:
    session_id: str
    coordinate_space_id: str
    decode_id: int

    def __post_init__(self) -> None:
        if (not self.session_id or self.coordinate_space_id != coordinate_space_id(self.session_id)
                or type(self.decode_id) is not int or self.decode_id < 0):
            raise RetrySkipped("invalid_parent_identity")


@dataclass(frozen=True)
class PcmLease:
    parent: ParentDecodeKey
    lease_id: str
    start_sample: int
    end_sample: int
    pcm_sha256: str
    expires_at: float


@dataclass(frozen=True)
class RetryPcmSlice:
    lease: PcmLease
    start_sample: int
    end_sample: int
    pcm_sha256: str
    pcm: bytes = field(repr=False)

    def audio(self) -> np.ndarray:
        """Read-only bytes-backed float32; cannot re-enable writes via setflags."""
        return np.frombuffer(self.pcm, dtype=np.float32)


class ParentPcmLeases:
    """One session. Close and recreate on reset; stale handles never revive.

    No guessed TTL/memory defaults: R0 must establish them before integration.
    The cap counts retained snapshots. The caller owns any returned slice bytes;
    future integration must bound that memory too (one admitted retry at a time).
    Expiry is checked on every operation; close releases storage immediately.
    """

    def __init__(self, session_id: str, *, max_bytes: int, max_leases: int,
                 clock: Callable[[], float] = time.monotonic):
        if not session_id or type(max_bytes) is not int or max_bytes <= 0:
            raise ValueError("Session and positive byte limit required")
        if type(max_leases) is not int or max_leases <= 0:
            raise ValueError("Positive lease limit required")
        self.session_id = session_id
        self.coordinate_space_id = coordinate_space_id(session_id)
        self.max_bytes, self.max_leases = max_bytes, max_leases
        self._clock, self._lock = clock, threading.Lock()
        self._entries: dict[str, tuple[PcmLease, bytes]] = {}
        self._bytes = 0
        self._closed = False

    def _now(self) -> float:
        now = self._clock()
        if not math.isfinite(now):
            raise RetrySkipped("invalid_monotonic_clock")
        return now

    def _prune(self, now: float) -> None:
        expired = [key for key, (lease, _) in self._entries.items() if now >= lease.expires_at]
        for key in expired:
            self._bytes -= len(self._entries.pop(key)[1])

    @property
    def retained_bytes(self) -> int:
        with self._lock:
            self._prune(self._now())
            return self._bytes

    def retain(self, snapshot: DecodeInputSnapshot, *, parent_decode_id: int,
               parent_pcm_sha256: str, expires_at: float) -> PcmLease:
        """Caller owns the parent's atomic snapshot; verify against its decode hash."""
        parent = ParentDecodeKey(self.session_id, self.coordinate_space_id, parent_decode_id)
        with self._lock:
            now = self._now()
            self._prune(now)
            if self._closed:
                raise RetrySkipped("session_closed")
            if not math.isfinite(expires_at) or expires_at <= now:
                raise RetrySkipped("pcm_expired")
            self._validate_snapshot(snapshot)
            if any(lease.parent == parent for lease, _ in self._entries.values()):
                raise RetrySkipped("parent_already_retained")
            if (len(self._entries) >= self.max_leases
                    or self._bytes + snapshot.audio.nbytes > self.max_bytes):
                raise RetrySkipped("pcm_capacity")
            pcm = snapshot.audio.tobytes()
            digest = hashlib.sha256(pcm).hexdigest()
            if digest != parent_pcm_sha256:
                raise RetrySkipped("parent_pcm_hash_mismatch")
            if self._now() >= expires_at:
                raise RetrySkipped("pcm_expired")
            lease = PcmLease(parent, uuid4().hex, snapshot.start_sample,
                             snapshot.end_sample, digest, expires_at)
            self._entries[lease.lease_id] = (lease, pcm)
            self._bytes += len(pcm)
            return lease

    @staticmethod
    def _validate_snapshot(snapshot: DecodeInputSnapshot) -> None:
        audio = snapshot.audio
        if (not isinstance(audio, np.ndarray) or audio.dtype != np.float32
                or audio.ndim != 1 or not audio.flags.c_contiguous
                or type(snapshot.start_sample) is not int or snapshot.start_sample < 0
                or type(snapshot.end_sample) is not int
                or snapshot.end_sample <= snapshot.start_sample
                or snapshot.sample_count != audio.size):
            raise RetrySkipped("invalid_pcm_snapshot")

    def slice_absolute(self, lease: PcmLease, start_sample: int, end_sample: int) -> RetryPcmSlice:
        with self._lock:
            now = self._now()
            self._prune(now)
            if self._closed:
                raise RetrySkipped("session_closed")
            entry = self._entries.get(lease.lease_id)
            if entry is None or entry[0] is not lease:
                raise RetrySkipped("pcm_lease_unavailable")
            if (type(start_sample) is not int or type(end_sample) is not int
                    or not lease.start_sample <= start_sample < end_sample <= lease.end_sample):
                raise RetrySkipped("pcm_range_unavailable")
            start_byte = (start_sample - lease.start_sample) * 4
            end_byte = (end_sample - lease.start_sample) * 4
            pcm = entry[1][start_byte:end_byte]
            digest = hashlib.sha256(pcm).hexdigest()
            if self._now() >= lease.expires_at:
                raise RetrySkipped("pcm_expired")
            return RetryPcmSlice(lease, start_sample, end_sample, digest, pcm)

    def release(self, lease: PcmLease) -> None:
        with self._lock:
            entry = self._entries.get(lease.lease_id)
            if entry is not None and entry[0] is lease:
                self._bytes -= len(self._entries.pop(lease.lease_id)[1])

    def close(self) -> None:
        with self._lock:
            self._closed = True
            self._entries.clear()
            self._bytes = 0
