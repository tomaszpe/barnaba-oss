"""Fail-open single-attempt orchestration. Not a live eligibility/quality oracle."""
from dataclasses import dataclass
from typing import Any, Callable

from rep_retry_budget import RetryDeadline, RetrySkipped
from rep_retry_executor import RetryExecutor
from rep_retry_pcm import ParentDecodeKey


@dataclass(frozen=True)
class RetryOutcome:
    value: Any
    applied: bool
    reason: str


async def select_single_retry(original: Any, *, parent: ParentDecodeKey,
                              deadline: RetryDeadline, executor: RetryExecutor,
                              decode: Callable, validate: Callable,
                              measured_headroom_ms: float | None = None) -> RetryOutcome:
    """Caller creates deadline BEFORE preparation; validation shares that budget.

    validate must prove the replacement safe, not merely that decoding succeeded.
    A missing/uncertain oracle returns non-True and therefore keeps the original.
    No callbacks apply late output. Executor owns the one-attempt parent ledger.
    """
    def work():
        candidate = decode()
        deadline.require_remaining()
        if validate(candidate) is not True:
            raise RetrySkipped("uncertain_result")
        deadline.require_remaining()
        return candidate

    try:
        future = executor.submit_retry(parent, deadline, work,
                                       measured_headroom_ms=measured_headroom_ms)
        candidate = await deadline.wait(future)
        return RetryOutcome(candidate, True, "validated_within_deadline")
    except RetrySkipped as skipped:
        return RetryOutcome(original, False, skipped.reason)
    except Exception:
        return RetryOutcome(original, False, "worker_error")
