import { describe, expect, it, vi } from 'vitest';
import {
  conservativeFallbackApplyDecision,
  FALLBACK_COORDINATOR_APPLY_MAX_WAIT_MS,
  fallbackEmissionOriginForTelemetry,
  fallbackEmissionSessionEpochForTelemetry,
  fallbackCoordinatorApplyConfigErrors,
  FallbackCoordinatorApplyWaiters,
  PerChurchEnqueueSequencer,
} from '../fallbackCoordinatorApply.js';

const candidate = (releaseSeq = 2) => ({ sessionEpoch: 'epoch', releaseSeq });

describe('FQF-2 conservative APPLY', () => {
  it('preserves final enqueue FIFO while the first church task is waiting', async () => {
    const sequencer = new PerChurchEnqueueSequencer();
    const order = [];
    let releaseFirst;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });

    const first = sequencer.run('church', async () => {
      order.push('first_enter');
      await firstGate;
      order.push('first_enqueue');
    });
    const second = sequencer.run('church', async () => order.push('second_enqueue'));
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['first_enter']);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first_enter', 'first_enqueue', 'second_enqueue']);
    expect(sequencer.size).toBe(0);
  });

  it('keeps churches independent and continues FIFO after a rejected task', async () => {
    const sequencer = new PerChurchEnqueueSequencer();
    const order = [];
    let releaseChurchA;
    const churchAGate = new Promise((resolve) => { releaseChurchA = resolve; });

    const blockedA = sequencer.run('church-a', async () => {
      await churchAGate;
      throw new Error('expected');
    });
    const churchB = sequencer.run('church-b', async () => order.push('church-b'));
    const nextA = sequencer.run('church-a', async () => order.push('church-a-next'));

    await churchB;
    expect(order).toEqual(['church-b']);
    releaseChurchA();
    await expect(blockedA).rejects.toThrow('expected');
    await nextA;
    expect(order).toEqual(['church-b', 'church-a-next']);
    expect(sequencer.size).toBe(0);
  });

  it('drops only a complete history repeat and never applies a projected trim', () => {
    expect(conservativeFallbackApplyDecision({ action: 'drop_history_repeat' }))
      .toEqual({ action: 'drop', reason: 'drop_history_repeat' });
    for (const action of [
      'keep_full',
      'trim_and_emit_tail',
      'tail_too_short',
      'unsafe_open_cut',
      'shadow_error',
    ]) {
      expect(conservativeFallbackApplyDecision({ action }))
        .toEqual({ action: 'enqueue_full', reason: action });
    }
    expect(conservativeFallbackApplyDecision(null))
      .toEqual({ action: 'enqueue_full', reason: 'evaluation_unavailable' });
  });

  it('refuses APPLY without both prerequisite flags', () => {
    expect(fallbackCoordinatorApplyConfigErrors({
      enabled: true,
      shadowEnabled: false,
      historyCommitOnAcceptEnabled: false,
    })).toEqual([
      'FQF-2 shadow must be enabled',
      'FQF-1 accepted-output history commit must be enabled',
    ]);
    expect(fallbackCoordinatorApplyConfigErrors({
      enabled: false,
      shadowEnabled: false,
      historyCommitOnAcceptEnabled: false,
    })).toEqual([]);
  });

  it('rejects an invalid waiter ceiling', () => {
    expect(() => new FallbackCoordinatorApplyWaiters({ maxWaitMs: 0 }))
      .toThrow('maxWaitMs must be positive');
  });

  it('attributes queue telemetry without mislabelling merged origins', () => {
    expect(fallbackEmissionOriginForTelemetry({ origin: 'partial_fallback' }, []))
      .toBe('partial_fallback');
    expect(fallbackEmissionOriginForTelemetry(null, [
      { releaseMeta: { origin: 'deadline_fallback' } },
    ])).toBe('deadline_fallback');
    expect(fallbackEmissionOriginForTelemetry({ origin: 'deadline_fallback' }, [
      { releaseMeta: { origin: 'partial_fallback' } },
    ])).toBe('mixed');
    expect(fallbackEmissionOriginForTelemetry()).toBeNull();
  });

  it('uses one explicit epoch for telemetry and rejects mixed or missing identity', () => {
    expect(fallbackEmissionSessionEpochForTelemetry({ sessionEpoch: 'epoch-a' }, []))
      .toBe('epoch-a');
    expect(fallbackEmissionSessionEpochForTelemetry(null, [
      { releaseMeta: { sessionEpoch: 'epoch-a' } },
      { releaseMeta: { sessionEpoch: 'epoch-a' } },
    ])).toBe('epoch-a');
    expect(fallbackEmissionSessionEpochForTelemetry({ sessionEpoch: 'epoch-a' }, [
      { releaseMeta: { sessionEpoch: 'epoch-b' } },
    ])).toBeNull();
    expect(fallbackEmissionSessionEpochForTelemetry()).toBeNull();
  });

  it('resolves a parked candidate from the winner history commit', async () => {
    const clearTimer = vi.fn();
    const waiters = new FallbackCoordinatorApplyWaiters({
      now: () => 1000,
      setTimer: vi.fn(() => 7),
      clearTimer,
    });
    const pending = waiters.wait({
      churchId: 'church', candidate: candidate(), deadlineMs: 7500, generation: 1,
    });

    expect(waiters.size).toBe(1);
    expect(waiters.resolve({
      churchId: 'church',
      candidate: candidate(),
      projection: { action: 'drop_history_repeat' },
    })).toBe(true);
    await expect(pending).resolves.toEqual({
      status: 'evaluated',
      projection: { action: 'drop_history_repeat' },
    });
    expect(clearTimer).toHaveBeenCalledWith(7);
    expect(waiters.size).toBe(0);
  });

  it('fails open on missing lineage, expiry, and church cleanup', async () => {
    const waiters = new FallbackCoordinatorApplyWaiters({
      now: () => 2000,
      setTimer: vi.fn(() => 8),
      clearTimer: vi.fn(),
    });
    await expect(waiters.wait({
      churchId: 'church',
      candidate: {},
      deadlineMs: 3000,
      generation: 1,
    })).resolves.toEqual({ status: 'fail_open', reason: 'missing_lineage' });
    await expect(waiters.wait({
      churchId: 'church',
      candidate: candidate(3),
      deadlineMs: 2000,
      generation: 1,
    })).resolves.toEqual({ status: 'fail_open', reason: 'timeout' });

    await expect(waiters.wait({
      churchId: 'church',
      candidate: candidate(3),
      deadlineMs: 3000,
    })).resolves.toEqual({ status: 'fail_open', reason: 'missing_generation' });

    const pending = waiters.wait({
      churchId: 'church',
      candidate: candidate(4),
      deadlineMs: 4000,
      generation: 1,
    });
    expect(waiters.failOpenChurch('church')).toBe(1);
    await expect(pending).resolves.toEqual({ status: 'fail_open', reason: 'church_cleanup' });
    expect(waiters.size).toBe(0);
  });

  it('fails a duplicate lineage open without replacing the original waiter', async () => {
    const waiters = new FallbackCoordinatorApplyWaiters({
      now: () => 1000,
      setTimer: vi.fn(() => 9),
      clearTimer: vi.fn(),
    });
    const first = waiters.wait({
      churchId: 'church', candidate: candidate(), deadlineMs: 7500, generation: 1,
    });

    await expect(waiters.wait({
      churchId: 'church',
      candidate: candidate(),
      deadlineMs: 7500,
      generation: 1,
    })).resolves.toEqual({ status: 'fail_open', reason: 'duplicate_lineage' });
    expect(waiters.size).toBe(1);

    expect(waiters.resolve({
      churchId: 'church',
      candidate: candidate(),
      projection: { action: 'drop_history_repeat' },
    })).toBe(true);
    await expect(first).resolves.toEqual({
      status: 'evaluated',
      projection: { action: 'drop_history_repeat' },
    });
    expect(waiters.size).toBe(0);
  });

  it('caps waiting at five seconds and names cap expiry separately from winner TTL', async () => {
    let expire;
    const setTimer = vi.fn((callback) => {
      expire = callback;
      return 10;
    });
    const waiters = new FallbackCoordinatorApplyWaiters({
      now: () => 1000,
      setTimer,
      clearTimer: vi.fn(),
    });
    const pending = waiters.wait({
      churchId: 'church',
      candidate: candidate(5),
      deadlineMs: 7500,
      generation: 1,
    });

    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), FALLBACK_COORDINATOR_APPLY_MAX_WAIT_MS);
    expire();
    await expect(pending).resolves.toEqual({
      status: 'fail_open',
      reason: 'wait_cap_timeout',
    });
  });

  it('uses the earlier winner TTL when it is below the five-second ceiling', async () => {
    let expire;
    const setTimer = vi.fn((callback) => {
      expire = callback;
      return 12;
    });
    const waiters = new FallbackCoordinatorApplyWaiters({
      now: () => 1000,
      setTimer,
      clearTimer: vi.fn(),
    });
    const pending = waiters.wait({
      churchId: 'church',
      candidate: candidate(8),
      deadlineMs: 4000,
      generation: 1,
    });

    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 3000);
    expire();
    await expect(pending).resolves.toEqual({ status: 'fail_open', reason: 'timeout' });
  });

  it('fails open only waiters from the rejected winner generation', async () => {
    const waiters = new FallbackCoordinatorApplyWaiters({
      now: () => 1000,
      setTimer: vi.fn(() => 11),
      clearTimer: vi.fn(),
    });
    const oldGeneration = waiters.wait({
      churchId: 'church', candidate: candidate(6), deadlineMs: 5000, generation: 3,
    });
    const newGeneration = waiters.wait({
      churchId: 'church', candidate: candidate(7), deadlineMs: 5000, generation: 4,
    });

    expect(waiters.failOpenChurch('church', 'winner_enqueue_rejected', 3)).toBe(1);
    await expect(oldGeneration).resolves.toEqual({
      status: 'fail_open', reason: 'winner_enqueue_rejected',
    });
    expect(waiters.size).toBe(1);
    expect(waiters.resolve({
      churchId: 'church',
      candidate: candidate(7),
      projection: { action: 'keep_full' },
    })).toBe(true);
    await expect(newGeneration).resolves.toMatchObject({ status: 'evaluated' });
  });
});
