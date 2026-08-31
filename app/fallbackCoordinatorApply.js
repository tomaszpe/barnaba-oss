const candidateIdentityKey = (candidate = {}) => {
  const epoch = typeof candidate.sessionEpoch === 'string'
    ? candidate.sessionEpoch.trim()
    : '';
  const seq = candidate.releaseSeq;
  if (!epoch || seq === null || seq === undefined) return null;
  return `${epoch}:${seq}`;
};

export const FALLBACK_COORDINATOR_APPLY_MAX_WAIT_MS = 5000;

export const fallbackEmissionOriginForTelemetry = (releaseMeta = null, sourceCandidates = []) => {
  const origins = new Set([
    releaseMeta?.origin,
    ...sourceCandidates.map(candidate => candidate?.releaseMeta?.origin),
  ].filter(Boolean));
  if (origins.size === 0) return null;
  if (origins.size === 1) return [...origins][0];
  return 'mixed';
};

export const fallbackEmissionSessionEpochForTelemetry = (releaseMeta = null, sourceCandidates = []) => {
  const epochs = new Set([
    releaseMeta?.sessionEpoch,
    ...sourceCandidates.map(candidate => candidate?.releaseMeta?.sessionEpoch),
  ].map(value => typeof value === 'string' ? value.trim() : '').filter(Boolean));
  return epochs.size === 1 ? [...epochs][0] : null;
};

export const conservativeFallbackApplyDecision = (projection = null) => {
  if (projection?.action === 'drop_history_repeat') {
    return { action: 'drop', reason: 'drop_history_repeat' };
  }
  return {
    action: 'enqueue_full',
    reason: projection?.action || 'evaluation_unavailable',
  };
};

export const fallbackCoordinatorApplyConfigErrors = ({
  enabled,
  shadowEnabled,
  historyCommitOnAcceptEnabled,
}) => {
  if (!enabled) return [];
  const errors = [];
  if (!shadowEnabled) errors.push('FQF-2 shadow must be enabled');
  if (!historyCommitOnAcceptEnabled) {
    errors.push('FQF-1 accepted-output history commit must be enabled');
  }
  return errors;
};

export class FallbackCoordinatorApplyWaiters {
  constructor({
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    maxWaitMs = FALLBACK_COORDINATOR_APPLY_MAX_WAIT_MS,
  } = {}) {
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    if (!Number.isFinite(maxWaitMs) || maxWaitMs <= 0) {
      throw new TypeError('maxWaitMs must be positive');
    }
    this.maxWaitMs = maxWaitMs;
    this.byChurch = new Map();
  }

  wait({ churchId, candidate, deadlineMs, generation }) {
    const key = candidateIdentityKey(candidate);
    if (!key) {
      return Promise.resolve({ status: 'fail_open', reason: 'missing_lineage' });
    }
    if (!Number.isInteger(generation) || generation < 1) {
      return Promise.resolve({ status: 'fail_open', reason: 'missing_generation' });
    }
    const deadlineRemainingMs = Number(deadlineMs) - this.now();
    if (!Number.isFinite(deadlineRemainingMs) || deadlineRemainingMs <= 0) {
      return Promise.resolve({ status: 'fail_open', reason: 'timeout' });
    }
    const remainingMs = Math.min(deadlineRemainingMs, this.maxWaitMs);
    const timeoutReason = deadlineRemainingMs > this.maxWaitMs
      ? 'wait_cap_timeout'
      : 'timeout';

    let churchWaiters = this.byChurch.get(churchId);
    if (churchWaiters?.has(key)) {
      return Promise.resolve({ status: 'fail_open', reason: 'duplicate_lineage' });
    }
    if (!churchWaiters) {
      churchWaiters = new Map();
      this.byChurch.set(churchId, churchWaiters);
    }

    return new Promise((resolve) => {
      const finish = (result) => {
        const current = churchWaiters.get(key);
        if (!current) return false;
        this.clearTimer(current.timer);
        churchWaiters.delete(key);
        if (churchWaiters.size === 0) this.byChurch.delete(churchId);
        resolve(result);
        return true;
      };
      const timer = this.setTimer(
        () => finish({ status: 'fail_open', reason: timeoutReason }),
        remainingMs,
      );
      churchWaiters.set(key, { finish, timer, generation });
    });
  }

  resolve({ churchId, candidate, projection }) {
    const key = candidateIdentityKey(candidate);
    const waiter = key ? this.byChurch.get(churchId)?.get(key) : null;
    return waiter?.finish({ status: 'evaluated', projection }) || false;
  }

  failOpenChurch(churchId, reason = 'church_cleanup', generation = null) {
    const churchWaiters = this.byChurch.get(churchId);
    if (!churchWaiters) return 0;
    const waiters = [...churchWaiters.values()].filter(
      waiter => generation === null || waiter.generation === generation,
    );
    for (const waiter of waiters) {
      waiter.finish({ status: 'fail_open', reason });
    }
    return waiters.length;
  }

  get size() {
    let count = 0;
    for (const churchWaiters of this.byChurch.values()) count += churchWaiters.size;
    return count;
  }
}

export class PerChurchEnqueueSequencer {
  constructor() {
    this.tails = new Map();
  }

  run(churchId, task) {
    if (!churchId) return Promise.reject(new TypeError('churchId is required'));
    if (typeof task !== 'function') return Promise.reject(new TypeError('task must be a function'));

    const previous = this.tails.get(churchId) || Promise.resolve();
    const result = previous.catch(() => undefined).then(task);
    const tail = result.catch(() => undefined);
    this.tails.set(churchId, tail);
    tail.finally(() => {
      if (this.tails.get(churchId) === tail) this.tails.delete(churchId);
    });
    return result;
  }

  get size() {
    return this.tails.size;
  }
}
