from concurrent.futures import Future
import asyncio
import time

import pytest

from rep_retry_budget import DEFAULT_RETRY_EXTRA_MS, MAX_RETRY_EXTRA_MS, RetryDeadline, RetrySkipped


class Clock:
    def __init__(self, now=10.0):
        self.now = now

    def __call__(self):
        return self.now


def test_owner_limit_is_two_seconds_total_not_per_stage():
    clock = Clock()
    deadline = RetryDeadline.start(clock)
    assert DEFAULT_RETRY_EXTRA_MS == 2000
    assert MAX_RETRY_EXTRA_MS == 2800
    assert deadline.expires_at == 12.0
    clock.now += .25  # PCM
    assert deadline.remaining_seconds() == 1.75
    clock.now += .5  # admission/queue
    assert deadline.remaining_seconds() == 1.25
    clock.now += 1  # inference
    assert deadline.remaining_seconds() == .25
    clock.now += .25  # validation consumes the rest: NOT accepted at the deadline.
    with pytest.raises(RetrySkipped, match="deadline_exhausted"):
        deadline.require_remaining()


@pytest.mark.parametrize("now", [12.0, 12.001, 30.0])
def test_completed_future_cannot_replace_original_at_or_after_deadline(now):
    clock = Clock()
    deadline = RetryDeadline.start(clock)
    future = Future()
    future.set_result("retry text")
    clock.now = now
    output = "original text"
    try:
        output = deadline.result(future)
    except RetrySkipped:
        pass
    assert output == "original text"


def test_reserve_profile_is_one_frozen_total_budget():
    from dataclasses import FrozenInstanceError
    clock = Clock()
    deadline = RetryDeadline.start(clock, total_ms=2800)
    clock.now += 2.6
    assert deadline.remaining_seconds() == pytest.approx(.2)
    with pytest.raises(FrozenInstanceError):
        deadline.total_ms = 3600
    clock.now = 12.8
    with pytest.raises(RetrySkipped, match="deadline_exhausted"):
        deadline.require_remaining()


@pytest.mark.parametrize("budget", [0, 1999, 2001, 2801, True, "2800", 2800.0])
def test_unapproved_budget_rejected(budget):
    with pytest.raises(ValueError, match="approved"):
        RetryDeadline.start(total_ms=budget)


def test_just_in_time_is_only_timing_success_not_quality_go():
    clock = Clock()
    deadline = RetryDeadline.start(clock)
    future = Future()
    future.set_result("unvalidated candidate")
    clock.now = 11.999
    assert deadline.result(future) == "unvalidated candidate"


def test_result_handoff_does_not_get_a_fresh_budget():
    clock = Clock()
    deadline = RetryDeadline.start(clock)
    clock.now += 1.75

    class HandoffFuture(Future):
        def result(self, timeout=None):
            assert timeout == .25
            clock.now = 12.0
            return "too late"

    with pytest.raises(RetrySkipped, match="deadline_exhausted"):
        deadline.result(HandoffFuture())


@pytest.mark.parametrize("error,reason", [(RuntimeError("private detail"), "worker_error"),
                                         (TimeoutError(), "worker_timeout")])
def test_worker_error_has_a_stable_fail_open_reason(error, reason):
    future = Future()
    future.set_exception(error)
    with pytest.raises(RetrySkipped, match=reason):
        RetryDeadline.start().result(future)


@pytest.mark.parametrize("required", [-1, float("nan"), float("inf"), True, "100"])
def test_invalid_headroom_fails_open(required):
    with pytest.raises(RetrySkipped, match="invalid_headroom"):
        RetryDeadline.start().require_remaining(required)


def test_headroom_includes_preparation_and_exact_boundary_is_rejected():
    clock = Clock()
    deadline = RetryDeadline.start(clock)
    clock.now += .5
    with pytest.raises(RetrySkipped, match="deadline_exhausted"):
        deadline.require_remaining(1500)
    assert deadline.require_remaining(1499) == 1.5


@pytest.mark.parametrize("now", [9, float("nan"), float("inf")])
def test_invalid_clock_cannot_extend_budget(now):
    clock = Clock()
    deadline = RetryDeadline.start(clock)
    clock.now = now
    with pytest.raises(RetrySkipped, match="invalid_monotonic_clock"):
        deadline.result(Future())


def test_async_timeout_does_not_cancel_worker_or_block_event_loop():
    async def scenario():
        future = Future()
        future.set_running_or_notify_cancel()
        ticks = []
        async def tick():
            await asyncio.sleep(.02)
            ticks.append(True)
        deadline = RetryDeadline(time.monotonic() - 1.9)
        ticker = asyncio.create_task(tick())
        with pytest.raises(RetrySkipped, match="deadline_exhausted"):
            await deadline.wait(future)
        assert ticks == [True]
        assert not future.cancelled()
        future.set_exception(RuntimeError("late, private error"))
        await ticker
        await asyncio.sleep(0)
    asyncio.run(scenario())


def test_async_success_and_worker_failure():
    async def scenario():
        good, bad = Future(), Future()
        good.set_result("candidate")
        bad.set_exception(ValueError("private"))
        assert await RetryDeadline.start().wait(good) == "candidate"
        with pytest.raises(RetrySkipped, match="worker_error"):
            await RetryDeadline.start().wait(bad)
    asyncio.run(scenario())


def test_async_caller_cancellation_preserves_worker():
    async def scenario():
        future = Future()
        future.set_running_or_notify_cancel()
        waiter = asyncio.create_task(RetryDeadline.start().wait(future))
        await asyncio.sleep(0)
        waiter.cancel()
        with pytest.raises(asyncio.CancelledError):
            await waiter
        assert not future.cancelled()
        future.set_result("must not be applied")
        await asyncio.sleep(0)
    asyncio.run(scenario())
