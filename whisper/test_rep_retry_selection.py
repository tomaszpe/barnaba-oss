import asyncio
import threading
import time

import pytest

from rep_retry_budget import RetryDeadline
from rep_retry_executor import RetryExecutor
from rep_retry_selection import select_single_retry
from test_rep_retry_executor import parent


@pytest.mark.parametrize("budget", [2000, 2800])
@pytest.mark.parametrize("valid", [True, False, None, 1, "true"])
def test_only_explicit_validation_applies_and_one_attempt_per_parent(budget, valid):
    original, candidate, calls = object(), object(), []
    executor = RetryExecutor(max_workers=1, max_retry_parents=4)
    def decode():
        calls.append(True)
        return candidate
    async def attempt():
        return await select_single_retry(original, parent=parent(),
            deadline=RetryDeadline.start(total_ms=budget), executor=executor,
            decode=decode, validate=lambda _: valid, measured_headroom_ms=1)
    try:
        first = asyncio.run(attempt())
        assert first.applied is (valid is True)
        assert first.value is (candidate if valid is True else original)
        second = asyncio.run(attempt())
        assert second.value is original and not second.applied
        assert second.reason == "parent_already_attempted"
        assert len(calls) == 1
    finally:
        executor.shutdown()


@pytest.mark.parametrize("budget", [2000, 2800])
def test_late_result_never_mutates_original_or_gets_second_attempt(budget):
    original, release = {"text": "original"}, threading.Event()
    executor = RetryExecutor(max_workers=1, max_retry_parents=4)
    def decode():
        release.wait(2)
        return {"text": "late"}
    async def scenario():
        deadline = RetryDeadline(time.monotonic() - budget / 1000 + .08,
                                 total_ms=budget)
        result = await select_single_retry(original, parent=parent(), deadline=deadline,
            executor=executor, decode=decode, validate=lambda _: True, measured_headroom_ms=1)
        assert result.value is original and not result.applied
        assert result.reason == "deadline_exhausted"
        assert executor.occupancy == (0, True)
        release.set()
        return result
    try:
        result = asyncio.run(scenario())
    finally:
        release.set()
        executor.shutdown()
    assert result.value == {"text": "original"}


def test_validation_time_and_error_keep_original():
    original = object()
    for error in (False, True):
        now = [10.0]
        executor = RetryExecutor(max_workers=1, max_retry_parents=4)
        deadline = RetryDeadline.start(lambda: now[0], total_ms=2800)
        def validate(_):
            if error:
                raise RuntimeError("private")
            now[0] = 12.8
            return True
        try:
            result = asyncio.run(select_single_retry(original, parent=parent(),
                deadline=deadline, executor=executor, decode=lambda: "candidate",
                validate=validate, measured_headroom_ms=1))
            assert result.value is original and not result.applied
            assert result.reason == ("worker_error" if error else "deadline_exhausted")
        finally:
            executor.shutdown()
