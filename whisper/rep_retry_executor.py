"""Atomic accounting for all normal and retry submissions in Whisper.

Idle admission cannot prevent GPU interference from normal work arriving later.
Measured contention and the remaining R0/R1 gates are still required.
"""
from __future__ import annotations

from concurrent.futures import Future, ThreadPoolExecutor
from functools import partial
import math
import threading
from typing import Callable, TypeVar

from rep_retry_budget import RetryDeadline, RetrySkipped
from rep_retry_pcm import ParentDecodeKey


T = TypeVar("T")


class RetryExecutor:
    def __init__(self, *, max_workers: int, max_retry_parents: int):
        if type(max_workers) is not int or max_workers <= 0:
            raise ValueError("Positive worker count required")
        if type(max_retry_parents) is not int or max_retry_parents <= 0:
            raise ValueError("Positive attempt-ledger limit required")
        self._pool = ThreadPoolExecutor(max_workers=max_workers)
        self._lock = threading.RLock()
        self._normal_pending = 0
        self._retry_pending = False
        self._attempted: set[ParentDecodeKey] = set()
        self._max_retry_parents = max_retry_parents
        self._closed = False

    def submit(self, fn: Callable[..., T], /, *args, **kwargs) -> Future[T]:
        """Executor protocol: covers both existing asyncio.run_in_executor routes."""
        return self.submit_normal(partial(fn, *args, **kwargs))

    @property
    def queue_size(self) -> int:
        return self._pool._work_queue.qsize()

    def submit_normal(self, work: Callable[[], T]) -> Future[T]:
        with self._lock:
            if self._closed:
                raise RuntimeError("Executor closed")
            self._normal_pending += 1  # Reserve before enqueue, not when worker starts.
            try:
                future = self._pool.submit(work)
            except BaseException:
                self._normal_pending -= 1
                raise
            future.add_done_callback(self._normal_finished)
            return future

    def _normal_finished(self, future: Future) -> None:
        with self._lock:
            self._normal_pending -= 1

    def submit_retry(self, parent: ParentDecodeKey, deadline: RetryDeadline,
                     work: Callable[[], T], *, measured_headroom_ms: float | None = None) -> Future[T]:
        with self._lock:
            if self._closed:
                raise RetrySkipped("executor_closed")
            if not isinstance(parent, ParentDecodeKey):
                raise RetrySkipped("invalid_parent_identity")
            if (type(measured_headroom_ms) not in (int, float) or not math.isfinite(measured_headroom_ms)
                    or measured_headroom_ms <= 0):
                raise RetrySkipped("headroom_unproven")
            deadline.require_remaining(measured_headroom_ms)
            if self._normal_pending:
                raise RetrySkipped("normal_work_pending")
            if self._retry_pending:
                raise RetrySkipped("retry_work_pending")
            if parent in self._attempted:
                raise RetrySkipped("parent_already_attempted")
            if len(self._attempted) >= self._max_retry_parents:
                # Never evict and inadvertently allow a second attempt for an old parent.
                raise RetrySkipped("attempt_ledger_capacity")
            self._attempted.add(parent)
            self._retry_pending = True
            try:
                future = self._pool.submit(self._run_retry, deadline, measured_headroom_ms, work)
            except BaseException:
                self._retry_pending = False
                raise  # Attempt stays consumed, even if submission failed.
            future.add_done_callback(self._retry_finished)
            return future

    def _run_retry(self, deadline: RetryDeadline, headroom_ms: float, work: Callable[[], T]) -> T:
        with self._lock:
            if self._normal_pending:
                raise RetrySkipped("normal_work_pending")
            deadline.require_remaining(headroom_ms)
        value = work()  # Never hold the accounting lock during inference/validation.
        deadline.require_remaining()
        return value

    def _retry_finished(self, future: Future) -> None:
        with self._lock:
            self._retry_pending = False  # Only real completion/cancel-before-start releases it.

    @property
    def occupancy(self) -> tuple[int, bool]:
        with self._lock:
            return self._normal_pending, self._retry_pending

    def shutdown(self, wait: bool = True, *, cancel_futures: bool = False) -> None:
        with self._lock:
            self._closed = True
        self._pool.shutdown(wait=wait, cancel_futures=cancel_futures)
