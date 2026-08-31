"""One end-to-end REP retry deadline shared by offline and async callers."""
from __future__ import annotations

from concurrent.futures import Future, TimeoutError
import asyncio
from dataclasses import dataclass
import math
import time
from typing import Callable, Final, TypeVar


# Owner decision 2026-08-26: prefer 2s; 2.8s is a preselected reserve profile.
# Never restart or extend an in-flight attempt's total end-to-end budget.
DEFAULT_RETRY_EXTRA_MS: Final = 2000
MAX_RETRY_EXTRA_MS: Final = 2800
T = TypeVar("T")


class RetrySkipped(Exception):
    """Keep the original output; the reason is safe to include in telemetry."""

    def __init__(self, reason: str):
        self.reason = reason
        super().__init__(reason)


@dataclass(frozen=True)
class RetryDeadline:
    started_at: float
    clock: Callable[[], float] = time.monotonic
    total_ms: int = DEFAULT_RETRY_EXTRA_MS

    def __post_init__(self) -> None:
        if not math.isfinite(self.started_at):
            raise ValueError("Retry start must be a finite monotonic timestamp")
        if type(self.total_ms) is not int or self.total_ms not in (2000, 2800):
            raise ValueError("Only the approved 2000ms and 2800ms profiles are allowed")

    @classmethod
    def start(cls, clock: Callable[[], float] = time.monotonic, *,
              total_ms: int = DEFAULT_RETRY_EXTRA_MS) -> RetryDeadline:
        """Call once at the suspect decision, BEFORE PCM/admission work."""
        return cls(clock(), clock, total_ms)

    @property
    def expires_at(self) -> float:
        return self.started_at + self.total_ms / 1000

    def remaining_seconds(self) -> float:
        now = self.clock()
        if not math.isfinite(now) or now < self.started_at:
            raise RetrySkipped("invalid_monotonic_clock")
        return max(0.0, self.expires_at - now)

    def require_remaining(self, required_ms: float = 0) -> float:
        if type(required_ms) not in (int, float) or not math.isfinite(required_ms) or required_ms < 0:
            raise RetrySkipped("invalid_headroom")
        remaining = self.remaining_seconds()
        if remaining <= required_ms / 1000:
            raise RetrySkipped("deadline_exhausted")
        return remaining

    def result(self, future: Future[T]) -> T:
        """Wait only the unused budget; never cancel/release a running worker.

        Synchronous offline helper; never call on the service's asyncio event loop.
        The future must include any validation work in its total duration.
        Returning here is ONLY a timing result, not quality approval or APPLY.
        The caller retains the original on RetrySkipped. No late-result callback
        may alter that output. CPU scheduling is not a hard-real-time guarantee.
        """
        remaining = self.require_remaining()
        try:
            value = future.result(timeout=remaining)
        except RetrySkipped:
            raise
        except TimeoutError as error:
            reason = "deadline_exhausted" if not self.remaining_seconds() else "worker_timeout"
            raise RetrySkipped(reason) from error
        except Exception as error:
            raise RetrySkipped("worker_error") from error
        self.require_remaining()  # Includes result handoff; exact deadline is too late.
        return value

    async def wait(self, future: Future[T]) -> T:
        """Do not block the event loop or cancel a non-preemptible GPU worker."""
        wrapped = asyncio.wrap_future(future)
        # Retrieve late exceptions even when the waiter has timed out/disconnected.
        wrapped.add_done_callback(lambda done: None if done.cancelled() else done.exception())
        try:
            value = await asyncio.wait_for(asyncio.shield(wrapped), self.require_remaining())
        except RetrySkipped:
            raise
        except asyncio.TimeoutError as error:
            reason = "deadline_exhausted" if not self.remaining_seconds() else "worker_timeout"
            raise RetrySkipped(reason) from error
        except Exception as error:
            raise RetrySkipped("worker_error") from error
        self.require_remaining()
        return value
