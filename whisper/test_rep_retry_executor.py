import threading
import time
import asyncio

import pytest

from rep_retry_budget import RetryDeadline, RetrySkipped
from rep_retry_executor import RetryExecutor
from rep_retry_pcm import ParentDecodeKey
from rep_shadow import coordinate_space_id


def parent(number=1, session="session"):
    return ParentDecodeKey(session, coordinate_space_id(session), number)


@pytest.fixture
def executor():
    instance = RetryExecutor(max_workers=2, max_retry_parents=8)
    yield instance
    instance.shutdown()


def retry(executor, work=lambda: "candidate", key=None, deadline=None, headroom=1):
    return executor.submit_retry(key or parent(), deadline or RetryDeadline.start(), work,
                                 measured_headroom_ms=headroom)


def blocked_work(started, release):
    started.set()
    assert release.wait(timeout=3), "Test must release its worker"
    return "candidate"


def test_normal_running_and_queued_are_counted_before_worker_start():
    executor = RetryExecutor(max_workers=1, max_retry_parents=8)
    started, release = threading.Event(), threading.Event()
    try:
        first = executor.submit_normal(lambda: blocked_work(started, release))
        assert started.wait(timeout=1)
        second = executor.submit_normal(lambda: "normal")
        assert executor.occupancy == (2, False)
        with pytest.raises(RetrySkipped, match="normal_work_pending"):
            retry(executor)
        assert second.cancel()  # Queued cancellation releases only its own reservation.
        assert executor.occupancy == (1, False)
    finally:
        release.set()
        executor.shutdown()
    assert first.result() == "candidate"
    assert executor.occupancy == (0, False)


def test_async_executor_protocol_accounts_for_normal_work(executor):
    started, release = threading.Event(), threading.Event()
    async def scenario():
        task = asyncio.get_running_loop().run_in_executor(
            executor, blocked_work, started, release)
        try:
            assert await asyncio.to_thread(started.wait, 1)
            assert executor.occupancy == (1, False)
            with pytest.raises(RetrySkipped, match="normal_work_pending"):
                retry(executor)
        finally:
            release.set()
        assert await task == "candidate"
        assert executor.occupancy == (0, False)
    asyncio.run(scenario())


def test_timeout_keeps_running_retry_reserved_and_late_result_is_rejected(executor):
    started, release, finished = threading.Event(), threading.Event(), threading.Event()
    # Almost all of the SAME two-second budget has already been spent preparing.
    deadline = RetryDeadline(time.monotonic() - 1.8)
    future = retry(executor, lambda: blocked_work(started, release), deadline=deadline)
    future.add_done_callback(lambda _: finished.set())
    try:
        assert started.wait(timeout=1)
        original = "original"
        try:
            original = deadline.result(future)
        except RetrySkipped as skipped:
            assert skipped.reason == "deadline_exhausted"
        assert original == "original"
        assert future.running()
        assert future.cancel() is False
        assert executor.occupancy == (0, True)
        with pytest.raises(RetrySkipped, match="retry_work_pending"):
            retry(executor, key=parent(2))
        # Normal work is never rejected merely because a retry still occupies GPU.
        assert executor.submit_normal(lambda: "normal").result(timeout=1) == "normal"
    finally:
        release.set()
    assert finished.wait(timeout=1)
    assert executor.occupancy == (0, False)
    with pytest.raises(RetrySkipped, match="deadline_exhausted"):
        future.result(timeout=1)
    with pytest.raises(RetrySkipped, match="parent_already_attempted"):
        retry(executor)


@pytest.mark.parametrize("headroom", [None, 0, -1, float("inf"), float("nan"), True, "100"])
def test_unknown_or_invalid_headroom_never_admits_retry(executor, headroom):
    with pytest.raises(RetrySkipped, match="headroom_unproven"):
        retry(executor, headroom=headroom)
    assert executor.occupancy == (0, False)


def test_remaining_budget_must_cover_measured_work(executor):
    deadline = RetryDeadline(time.monotonic() - 1)
    with pytest.raises(RetrySkipped, match="deadline_exhausted"):
        retry(executor, deadline=deadline, headroom=1500)
    assert executor.occupancy == (0, False)


def test_concurrent_retry_admission_allows_one_worker_only(executor):
    started, release = threading.Event(), threading.Event()
    future = retry(executor, lambda: blocked_work(started, release))
    try:
        assert started.wait(timeout=1)
        with pytest.raises(RetrySkipped, match="retry_work_pending"):
            retry(executor, key=parent(2, session="another"))
    finally:
        release.set()
    assert future.result(timeout=1) == "candidate"


def test_capacity_does_not_evict_attempt_history():
    executor = RetryExecutor(max_workers=1, max_retry_parents=1)
    started, release, finished = threading.Event(), threading.Event(), threading.Event()
    future = retry(executor, lambda: blocked_work(started, release))
    future.add_done_callback(lambda _: finished.set())
    try:
        assert started.wait(timeout=1)
        release.set()
        assert finished.wait(timeout=1)
        assert future.result() == "candidate"
        with pytest.raises(RetrySkipped, match="parent_already_attempted"):
            retry(executor)
        with pytest.raises(RetrySkipped, match="attempt_ledger_capacity"):
            retry(executor, key=parent(2))
    finally:
        release.set()
        executor.shutdown()


def test_submit_error_unwinds_occupancy_but_does_not_retry_same_parent(executor, monkeypatch):
    def failing_submit(*args, **kwargs):
        raise RuntimeError("executor submit failed")

    monkeypatch.setattr(executor._pool, "submit", failing_submit)
    with pytest.raises(RuntimeError):
        retry(executor)
    assert executor.occupancy == (0, False)
    with pytest.raises(RetrySkipped, match="parent_already_attempted"):
        retry(executor)
    with pytest.raises(RuntimeError):
        executor.submit_normal(lambda: None)
    assert executor.occupancy == (0, False)


def test_worker_error_keeps_original_and_releases_on_real_finish(executor):
    started, release, finished = threading.Event(), threading.Event(), threading.Event()

    def fail():
        blocked_work(started, release)
        raise ValueError("decoder failure")

    deadline = RetryDeadline.start()
    future = retry(executor, fail, deadline=deadline)
    future.add_done_callback(lambda _: finished.set())
    try:
        assert started.wait(timeout=1)
    finally:
        release.set()
    assert finished.wait(timeout=1)
    with pytest.raises(RetrySkipped, match="worker_error"):
        deadline.result(future)
    assert executor.occupancy == (0, False)


def test_closed_executor_rejects_new_work(executor):
    executor.shutdown()
    with pytest.raises(RetrySkipped, match="executor_closed"):
        retry(executor)
    with pytest.raises(RuntimeError, match="Executor closed"):
        executor.submit_normal(lambda: None)


@pytest.mark.parametrize("late_normal", [False, True])
def test_worker_rechecks_deadline_and_normal_arrivals_before_inference(executor, monkeypatch, late_normal):
    entered, release, normal_release = threading.Event(), threading.Event(), threading.Event()
    now = [10.0]
    deadline = RetryDeadline.start(lambda: now[0])
    original_run = executor._run_retry
    decoded = []

    def delayed_start(*args):
        entered.set()
        assert release.wait(timeout=2)
        return original_run(*args)

    monkeypatch.setattr(executor, "_run_retry", delayed_start)
    future = retry(executor, lambda: decoded.append(True), deadline=deadline)
    try:
        assert entered.wait(timeout=1)
        if late_normal:
            executor.submit_normal(lambda: normal_release.wait(timeout=2))
            expected = "normal_work_pending"
        else:
            now[0] = 12.0
            expected = "deadline_exhausted"
        release.set()
        with pytest.raises(RetrySkipped, match=expected):
            future.result(timeout=1)
        assert decoded == []
    finally:
        release.set()
        normal_release.set()
