const COORDINATED_ORIGINS = new Set(['partial_fallback', 'deadline_fallback']);
const MAX_PENDING_REEVALUATIONS = 4;

const payloadMetrics = (text) => {
  const value = String(text || '');
  return {
    chars: value.length,
    words: value.trim() ? value.trim().split(/\s+/).length : 0,
  };
};

const releaseIdentity = (releaseMeta = {}) => ({
  sessionEpoch: releaseMeta.sessionEpoch ?? null,
  releaseSeq: releaseMeta.releaseSeq ?? null,
  sourceHash: releaseMeta.sourceHash ?? null,
  emittedSourceHash: releaseMeta.emittedSourceHash ?? null,
});

const winnerFields = (winner) => ({
  winner_origin: winner.origin,
  winner_payload_chars: winner.payloadChars,
  winner_payload_words: winner.payloadWords,
  winner_accepted_enqueue_order: winner.acceptedEnqueueOrder,
  winner_session_epoch: winner.sessionEpoch,
  winner_release_seq: winner.releaseSeq,
  winner_source_hash: winner.sourceHash,
  winner_emitted_source_hash: winner.emittedSourceHash,
});

const candidateFields = (candidate, prefix = '') => ({
  [`${prefix}origin`]: candidate.origin,
  [`${prefix}payload_chars`]: candidate.payloadChars,
  [`${prefix}payload_words`]: candidate.payloadWords,
  [`${prefix}accepted_enqueue_order`]: candidate.acceptedEnqueueOrder,
  [`${prefix}session_epoch`]: candidate.sessionEpoch,
  [`${prefix}release_seq`]: candidate.releaseSeq,
  [`${prefix}source_hash`]: candidate.sourceHash,
  [`${prefix}emitted_source_hash`]: candidate.emittedSourceHash,
});

/**
 * Pure FQF-2 shadow transition at the accepted-enqueue boundary.
 *
 * The returned decision is evidence for a future re-evaluation seam. It never
 * authorizes suppression. Opposite-origin payload text is retained only in the
 * bounded in-memory pending list so it can be evaluated after the winner's
 * history commit; telemetry builders never expose it.
 */
export const observeFallbackAcceptedEnqueue = ({
  state = null,
  churchId,
  origin,
  text,
  releaseMeta = null,
  nowMs,
  ttlMs,
  policyApplied = false,
}) => {
  if (!COORDINATED_ORIGINS.has(origin)) {
    return { state, event: null, observed: false, requiresReevaluation: false };
  }
  if (!Number.isFinite(nowMs)) throw new TypeError('nowMs must be finite');
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError('ttlMs must be positive');

  const acceptedEnqueueOrder = (state?.lastAcceptedEnqueueOrder || 0) + 1;
  const metrics = payloadMetrics(text);
  const identity = releaseIdentity(releaseMeta || {});
  const candidate = {
    origin,
    payloadChars: metrics.chars,
    payloadWords: metrics.words,
    acceptedEnqueueOrder,
    acceptedAtMs: nowMs,
    ...identity,
  };
  const activeWinner = state?.winner && nowMs < state.winner.armedUntilMs
    ? state.winner
    : null;

  if (!activeWinner) {
    const winner = { ...candidate, armedUntilMs: nowMs + ttlMs };
    return {
      state: {
        lastAcceptedEnqueueOrder: acceptedEnqueueOrder,
        winner,
        pendingReevaluations: [],
        pendingOverflowCount: 0,
      },
      observed: true,
      requiresReevaluation: false,
      event: {
        stage: 'fqf_fallback_coordinator_shadow',
        churchId,
        policy_applied: policyApplied,
        decision: 'armed',
        requires_reevaluation: false,
        ttl_ms: ttlMs,
        ...winnerFields(winner),
      },
    };
  }

  const nextState = {
    lastAcceptedEnqueueOrder: acceptedEnqueueOrder,
    winner: activeWinner,
    pendingReevaluations: state?.pendingReevaluations || [],
    pendingOverflowCount: state?.pendingOverflowCount || 0,
  };
  const reservationAgeMs = nowMs - activeWinner.acceptedAtMs;
  if (activeWinner.origin === origin) {
    return {
      state: nextState,
      observed: true,
      requiresReevaluation: false,
      event: {
        stage: 'fqf_fallback_coordinator_shadow',
        churchId,
        policy_applied: policyApplied,
        decision: 'same_origin_within_window',
        requires_reevaluation: false,
        ttl_ms: ttlMs,
        reservation_age_ms: reservationAgeMs,
        ...winnerFields(activeWinner),
        ...candidateFields(candidate, 'candidate_'),
      },
    };
  }

  const reevaluationCandidate = { ...candidate, payloadText: String(text || '') };
  const readyNow = Number.isFinite(activeWinner.historyCommittedAtMs);
  const overflowed = !readyNow && nextState.pendingReevaluations.length >= MAX_PENDING_REEVALUATIONS;
  const pendingReevaluations = readyNow
    ? nextState.pendingReevaluations
    : [...nextState.pendingReevaluations, reevaluationCandidate]
        .slice(-MAX_PENDING_REEVALUATIONS);

  return {
    state: {
      ...nextState,
      pendingReevaluations,
      pendingOverflowCount: nextState.pendingOverflowCount + (overflowed ? 1 : 0),
    },
    observed: true,
    requiresReevaluation: true,
    candidate: reevaluationCandidate,
    reevaluationCandidate: readyNow ? reevaluationCandidate : null,
    event: {
      stage: 'fqf_fallback_coordinator_shadow',
      churchId,
      policy_applied: policyApplied,
      decision: 'would_require_reevaluation',
      requires_reevaluation: true,
      ttl_ms: ttlMs,
      reservation_age_ms: reservationAgeMs,
      pending_reevaluation_count: pendingReevaluations.length,
      pending_overflow_count: nextState.pendingOverflowCount + (overflowed ? 1 : 0),
      ...winnerFields(activeWinner),
      ...candidateFields(candidate, 'loser_'),
    },
  };
};

export const cancelFallbackAcceptedEnqueue = ({ state = null, releaseMeta = null }) => {
  if (!state) return state;
  const identity = releaseIdentity(releaseMeta || {});
  const matches = (candidate) => candidate
    && identity.sessionEpoch !== null
    && identity.releaseSeq !== null
    && candidate.sessionEpoch === identity.sessionEpoch
    && candidate.releaseSeq === identity.releaseSeq;
  const cancelledWinner = matches(state.winner);
  return {
    ...state,
    winner: cancelledWinner ? null : state.winner,
    pendingReevaluations: cancelledWinner
      ? []
      : (state.pendingReevaluations || []).filter(candidate => !matches(candidate)),
    pendingOverflowCount: cancelledWinner ? 0 : state.pendingOverflowCount,
  };
};

const identityMatchesWinner = (winner, releaseMeta) => {
  const identity = releaseIdentity(releaseMeta || {});
  return identity.sessionEpoch !== null
    && identity.releaseSeq !== null
    && identity.sessionEpoch === winner.sessionEpoch
    && identity.releaseSeq === winner.releaseSeq;
};

export const acknowledgeFallbackHistoryCommit = ({
  state = null,
  churchId,
  releaseMeta = null,
  nowMs,
}) => {
  const winner = state?.winner;
  if (!winner || !identityMatchesWinner(winner, releaseMeta)) {
    return { state, event: null, acknowledged: false, reevaluationCandidates: [] };
  }
  if (!Number.isFinite(nowMs)) throw new TypeError('nowMs must be finite');
  if (nowMs < winner.acceptedAtMs) throw new RangeError('history commit precedes accepted enqueue');
  if (Number.isFinite(winner.historyCommittedAtMs)) {
    return { state, event: null, acknowledged: false, reevaluationCandidates: [] };
  }

  const reevaluationCandidates = state.pendingReevaluations || [];
  const committedWinner = { ...winner, historyCommittedAtMs: nowMs };
  return {
    state: {
      lastAcceptedEnqueueOrder: state.lastAcceptedEnqueueOrder,
      winner: committedWinner,
      pendingReevaluations: [],
      pendingOverflowCount: 0,
    },
    acknowledged: true,
    reevaluationCandidates,
    event: {
      stage: 'fqf_fallback_coordinator_shadow',
      churchId,
      policy_applied: false,
      decision: 'winner_history_committed',
      requires_reevaluation: reevaluationCandidates.length > 0,
      accepted_enqueue_to_history_commit_ms: nowMs - winner.acceptedAtMs,
      pending_reevaluation_count: reevaluationCandidates.length,
      pending_overflow_count: state.pendingOverflowCount || 0,
      ...winnerFields(committedWinner),
    },
  };
};

export const fallbackCoordinatorShadowConfigErrors = ({
  enabled,
  ttlMs,
  minTailWords = 3,
  historyCommitOnAcceptEnabled = true,
}) => {
  if (!enabled) return [];
  const errors = [];
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    errors.push('deadline fallback TTL must be a positive finite number');
  }
  if (!Number.isInteger(minTailWords) || minTailWords < 1) {
    errors.push('minimum re-evaluation tail must be a positive integer');
  }
  if (!historyCommitOnAcceptEnabled) {
    errors.push('FQF-1 accepted-output history commit must be enabled');
  }
  return errors;
};

export const acknowledgeFallbackFirstBroadcast = ({
  state = null,
  churchId,
  releaseMeta = null,
  nowMs,
}) => {
  const winner = state?.winner;
  if (!winner) return { state, event: null, acknowledged: false };
  if (!Number.isFinite(nowMs)) throw new TypeError('nowMs must be finite');

  if (!identityMatchesWinner(winner, releaseMeta)) {
    return { state, event: null, acknowledged: false };
  }
  if (nowMs < winner.acceptedAtMs) throw new RangeError('broadcast precedes accepted enqueue');

  return {
    state: {
      lastAcceptedEnqueueOrder: state.lastAcceptedEnqueueOrder,
      winner: null,
      pendingReevaluations: [],
      pendingOverflowCount: 0,
    },
    acknowledged: true,
    event: {
      stage: 'fqf_fallback_coordinator_shadow',
      churchId,
      policy_applied: false,
      decision: 'winner_first_broadcast',
      requires_reevaluation: false,
      queued_to_first_broadcast_ms: nowMs - winner.acceptedAtMs,
      ...winnerFields(winner),
    },
  };
};
