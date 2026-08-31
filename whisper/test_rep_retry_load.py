"""Deterministic concurrency gates for E4/E5; no model or container required."""

import asyncio
import threading

import pytest

from rep_retry_budget import RetryDeadline
from rep_retry_executor import RetryExecutor
from rep_retry_pcm import ParentDecodeKey
from rep_retry_selection import select_single_retry
from rep_shadow import coordinate_space_id


def parent(number: int) -> ParentDecodeKey:
    session = f"load-session-{number}"
    return ParentDecodeKey(session, coordinate_space_id(session), number)


@pytest.mark.parametrize("budget_ms", [2000, 2800])
def test_concurrent_retry_load_is_single_flight_and_keeps_every_rejected_original(budget_ms):
    executor = RetryExecutor(max_workers=4, max_retry_parents=64)
    started = threading.Event()
    release = threading.Event()
    decode_count = 0
    count_lock = threading.Lock()
    originals = [object() for _ in range(32)]

    def blocking_decode():
        nonlocal decode_count
        with count_lock:
            decode_count += 1
        started.set()
        assert release.wait(timeout=2)
        return object()

    async def attempt(index, decode):
        return await select_single_retry(
            originals[index],
            parent=parent(index),
            deadline=RetryDeadline.start(total_ms=budget_ms),
            executor=executor,
            decode=decode,
            validate=lambda _: True,
            measured_headroom_ms=1,
        )

    async def scenario():
        admitted = asyncio.create_task(attempt(0, blocking_decode))
        assert await asyncio.to_thread(started.wait, 1)
        rejected = await asyncio.gather(*(
            attempt(index, lambda: object()) for index in range(1, len(originals))
        ))
        release.set()
        return await admitted, rejected

    try:
        admitted, rejected = asyncio.run(scenario())
        assert admitted.applied is True
        assert admitted.reason == "validated_within_deadline"
        assert decode_count == 1
        assert all(not result.applied for result in rejected)
        assert all(result.reason == "retry_work_pending" for result in rejected)
        assert all(result.value is originals[index] for index, result in enumerate(rejected, 1))
        assert executor.occupancy == (0, False)
    finally:
        release.set()
        executor.shutdown()


def test_normal_load_blocks_retry_without_consuming_or_mutating_original():
    executor = RetryExecutor(max_workers=2, max_retry_parents=8)
    normal_started = threading.Event()
    normal_release = threading.Event()
    original = {"text": "original"}
    decoded = []

    def normal_work():
        normal_started.set()
        assert normal_release.wait(timeout=2)

    async def scenario():
        normal = asyncio.get_running_loop().run_in_executor(executor, normal_work)
        assert await asyncio.to_thread(normal_started.wait, 1)
        result = await select_single_retry(
            original,
            parent=parent(100),
            deadline=RetryDeadline.start(total_ms=2800),
            executor=executor,
            decode=lambda: decoded.append(True),
            validate=lambda _: True,
            measured_headroom_ms=1,
        )
        normal_release.set()
        await normal
        return result

    try:
        result = asyncio.run(scenario())
        assert result.value is original
        assert result.applied is False
        assert result.reason == "normal_work_pending"
        assert decoded == []
        assert executor.occupancy == (0, False)
    finally:
        normal_release.set()
        executor.shutdown()
