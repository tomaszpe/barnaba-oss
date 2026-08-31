import {
  classifyRevisionFamily,
  lineageRanges,
  revisionIdentity,
  revisionWords,
} from './revisionAdmissionEvidence.js';
import { sourceMapFromLineage, sourceMapTelemetry } from './sourceMap.js';
import { revisionActionEligibility } from './revisionActionEligibility.js';
import { sourceWordCount } from './sourceLineage.js';

export const DEFAULT_REVISION_ADMISSION_CONFIG = Object.freeze({
  enabled: false,
  windowSec: 180,
  maxFamilies: 128,
  minLexicalAnchorWords: 4,
  maxWordsPerRelease: 256,
  sourceMapV2ShadowEnabled: false,
});

const positiveInteger = (value) => Number.isInteger(value) && value > 0;
const MAX_LATCHED_DECISIONS_PER_FAMILY = 64;
const MAX_V2_SUPERSEDED_GENERATIONS = 64;
const MAX_RELEASE_IDENTITIES = 512;

const normalizeConfig = (input = {}) => ({
  enabled: input.enabled === true,
  windowSec: Number(input.windowSec ?? DEFAULT_REVISION_ADMISSION_CONFIG.windowSec),
  maxFamilies: Number(input.maxFamilies ?? DEFAULT_REVISION_ADMISSION_CONFIG.maxFamilies),
  minLexicalAnchorWords: Number(input.minLexicalAnchorWords ?? DEFAULT_REVISION_ADMISSION_CONFIG.minLexicalAnchorWords),
  maxWordsPerRelease: Number(input.maxWordsPerRelease ?? DEFAULT_REVISION_ADMISSION_CONFIG.maxWordsPerRelease),
  sourceMapV2ShadowEnabled: input.sourceMapV2ShadowEnabled === true,
});

const validateConfig = (config) => {
  if (!config.enabled) return [];
  const errors = [];
  if (!positiveInteger(config.windowSec)) errors.push('windowSec must be a positive integer');
  if (!positiveInteger(config.maxFamilies)) errors.push('maxFamilies must be a positive integer');
  if (!positiveInteger(config.minLexicalAnchorWords)) errors.push('minLexicalAnchorWords must be a positive integer');
  if (!positiveInteger(config.maxWordsPerRelease)) errors.push('maxWordsPerRelease must be a positive integer');
  if (config.maxWordsPerRelease < config.minLexicalAnchorWords) errors.push('maxWordsPerRelease must cover lexical anchor');
  return errors;
};

const ticketEventFields = (ticket) => ({
  revision_ticket_kind: ticket?.kind ?? 'missing',
  revision_ticket_id: ticket?.ticketId ?? null,
  revision_family_id: ticket?.familyId ?? null,
  revision_generation: ticket?.generation ?? null,
  revision_evidence: ticket?.evidence ?? 'missing_ticket',
  revision_apply_eligible: ticket?.applyEligible === true,
  revision_scorable: ticket?.scorable === true,
  revision_component_count: ticket?.componentCount ?? null,
  source_map_v2_shadow_enabled: ticket?.sourceMapV2ShadowEnabled === true,
  source_map_v2_status: ticket?.sourceMapV2Status ?? 'disabled',
  source_map_v2_coverage_ratio: ticket?.sourceMapV2CoverageRatio ?? 0,
  revision_relation_v2: ticket?.revisionRelationV2 ?? 'disabled',
  revision_relation_v2_overlap_samples: ticket?.revisionRelationV2OverlapSamples ?? 0,
  revision_relation_v2_shared_coordinate_space_count:
    ticket?.revisionRelationV2SharedCoordinateSpaceCount ?? 0,
  t1_drop_whole_v2_eligible: ticket?.t1DropWholeV2Eligible === true,
  t1_drop_whole_v2_reason: ticket?.t1DropWholeV2Reason ?? 'disabled',
  t1_revision_relation_v2: ticket?.t1RevisionRelationV2 ?? 'disabled',
  t1_revision_shared_coordinate_space_count_v2:
    ticket?.t1RevisionSharedCoordinateSpaceCountV2 ?? 0,
  t2_supersede_pending_v2_eligible: ticket?.t2SupersedePendingV2Eligible === true,
  t2_supersede_pending_v2_reason: ticket?.t2SupersedePendingV2Reason ?? 'disabled',
  t2_revision_relation_v2: ticket?.t2RevisionRelationV2 ?? 'disabled',
  t2_revision_shared_coordinate_space_count_v2:
    ticket?.t2RevisionSharedCoordinateSpaceCountV2 ?? 0,
  revision_supersedes_generations_v2: Array.isArray(ticket?.supersedesGenerationsV2)
    ? ticket.supersedesGenerationsV2.slice(-MAX_V2_SUPERSEDED_GENERATIONS)
    : [],
  revision_supersession_chain_v2_truncated: ticket?.supersessionChainV2Truncated === true,
});

export class RevisionAdmissionShadow {
  constructor({ config = {}, logFn = () => {}, now = Date.now } = {}) {
    this.config = normalizeConfig(config);
    this.configErrors = validateConfig(this.config);
    this.enabled = this.config.enabled && this.configErrors.length === 0;
    this._logFn = logFn;
    this._now = now;
    this._churches = new Map();
  }

  registerAccepted({ churchId, text, releaseMeta = null }) {
    if (!this.enabled) return null;
    try {
      return this._registerAccepted({ churchId, text, releaseMeta });
    } catch {
      return null;
    }
  }

  preflightAccepted({ churchId, text, releaseMeta = null }) {
    if (!this.enabled) return Object.freeze({ decision: 'disabled', accept: true, reason: 'shadow_disabled' });
    const sessionEpoch = releaseMeta?.sessionEpoch ?? null;
    const releaseSeq = releaseMeta?.releaseSeq ?? null;
    if (!churchId || !sessionEpoch || !Number.isSafeInteger(releaseSeq)) {
      return Object.freeze({ decision: 'unscorable', accept: true, reason: 'missing_accepted_identity' });
    }
    const existing = this._churches.get(churchId);
    if (!existing || existing.sessionEpoch !== sessionEpoch) {
      return Object.freeze({ decision: 'accept', accept: true, reason: 'new_session_epoch' });
    }
    const fingerprint = this._releaseFingerprint({ sessionEpoch, releaseSeq, releaseMeta, text });
    const recorded = existing.releases.get(releaseSeq);
    if (recorded) {
      const conflict = recorded.fingerprint !== fingerprint;
      return Object.freeze({
        decision: conflict ? 'reject' : 'duplicate',
        accept: false,
        reason: conflict ? 'release_identity_conflict' : 'exact_release_retry',
      });
    }
    if (existing.latestReleaseSeq !== null && releaseSeq < existing.latestReleaseSeq) {
      return Object.freeze({ decision: 'reject', accept: false, reason: 'stale_release_seq' });
    }
    return Object.freeze({ decision: 'accept', accept: true, reason: 'monotonic_release_seq' });
  }

  _registerAccepted({ churchId, text, releaseMeta }) {
    const nowMs = this._now();
    const sessionEpoch = releaseMeta?.sessionEpoch ?? null;
    const releaseSeq = releaseMeta?.releaseSeq ?? null;
    if (!churchId || !sessionEpoch || releaseSeq === null || !Number.isFinite(nowMs)) {
      return this._registerUnscorable({ churchId, sessionEpoch, releaseSeq, releaseMeta, text, nowMs });
    }

    const state = this._stateFor(churchId, sessionEpoch);
    this._prune(state, nowMs);
    const releaseFingerprint = this._releaseFingerprint({ sessionEpoch, releaseSeq, releaseMeta, text });
    const recordedRelease = state.releases.get(releaseSeq);
    if (recordedRelease) {
      if (recordedRelease.fingerprint === releaseFingerprint) return recordedRelease.ticket;
      return this._registerUnscorable({
        churchId, sessionEpoch, releaseSeq, releaseMeta, text, nowMs,
        evidence: 'release_identity_conflict',
      });
    }
    if (state.latestReleaseSeq !== null && releaseSeq < state.latestReleaseSeq) {
      return this._registerUnscorable({
        churchId, sessionEpoch, releaseSeq, releaseMeta, text, nowMs,
        evidence: 'stale_release_seq',
      });
    }
    const words = revisionWords(text, this.config.maxWordsPerRelease);
    const ranges = lineageRanges(releaseMeta?.sourceLineage);
    const match = classifyRevisionFamily({
      families: [...state.families.values()],
      ranges,
      words,
      lineageStatus: releaseMeta?.sourceLineage?.status ?? 'missing',
      minLexicalAnchorWords: this.config.minLexicalAnchorWords,
    });
    const family = match.family || this._newFamily({ state, churchId, sessionEpoch, releaseSeq, releaseMeta, nowMs });
    const sourceMap = sourceMapFromLineage(releaseMeta?.sourceLineage, {
      expectedWordCount: sourceWordCount(text),
    });
    const eligibilityAgainst = (ticketOrMap) => {
      const previousMap = ticketOrMap?.sourceMap || ticketOrMap;
      return this.config.sourceMapV2ShadowEnabled && previousMap
        ? revisionActionEligibility(previousMap, sourceMap)
        : null;
    };
    const latestEligibility = eligibilityAgainst(match.family?.sourceMap);
    const pendingEligibility = eligibilityAgainst(match.family?.pending);
    const checkpointEligibility = eligibilityAgainst(match.family?.lastCheckpointed);
    const generation = family.generation + 1;
    const provedSupersededTickets = [
      pendingEligibility?.t1DropWhole.eligible === true ? family.pending : null,
      checkpointEligibility?.t2SupersedePending.eligible === true ? family.lastCheckpointed : null,
    ].filter(Boolean);
    const allSupersededGenerationsV2 = [...new Set(provedSupersededTickets.flatMap((ticket) => [
      ticket.generation,
      ...(Array.isArray(ticket.supersedesGenerationsV2) ? ticket.supersedesGenerationsV2 : []),
    ]))].sort((left, right) => left - right);
    const supersessionChainV2Truncated = provedSupersededTickets.some(
      (ticket) => ticket.supersessionChainV2Truncated === true,
    ) || allSupersededGenerationsV2.length > MAX_V2_SUPERSEDED_GENERATIONS;
    const supersedesGenerationsV2 = Object.freeze(
      allSupersededGenerationsV2.slice(-MAX_V2_SUPERSEDED_GENERATIONS),
    );
    const t1Eligibility = pendingEligibility?.t1DropWhole ?? {
      eligible: false, reason: 'no_pending_generation',
    };
    const t2Eligible = provedSupersededTickets.length > 0;
    const t2Reason = t2Eligible
      ? 'proved_newer_covers_older'
      : checkpointEligibility?.t2SupersedePending.reason
        ?? pendingEligibility?.t2SupersedePending.reason
        ?? 'no_pending_or_checkpointed_generation';
    const t2ProofEligibility = checkpointEligibility?.t2SupersedePending.eligible === true
      ? checkpointEligibility
      : pendingEligibility?.t2SupersedePending.eligible === true ? pendingEligibility : null;
    const t2DiagnosticEligibility = t2ProofEligibility
      ?? checkpointEligibility
      ?? pendingEligibility;
    const t2Relation = t2DiagnosticEligibility?.relation.relation ?? 'unproven';
    const ticket = Object.freeze({
      version: 1,
      kind: 'single',
      ticketId: revisionIdentity('ticket', family.id, generation, releaseSeq, releaseMeta?.sourceHash),
      churchId,
      familyId: family.id,
      generation,
      evidence: match.evidence,
      applyEligible: match.applyEligible === true,
      scorable: match.scorable !== false,
      sessionEpoch,
      releaseSeq,
      sourceHash: releaseMeta?.sourceHash ?? null,
      componentCount: 1,
      sourceMapV2ShadowEnabled: this.config.sourceMapV2ShadowEnabled,
      sourceMap,
      sourceMapV2Status: sourceMap.status,
      sourceMapV2CoverageRatio: sourceMap.coverage.ratio,
      revisionRelationV2: latestEligibility?.relation.relation ?? 'unproven',
      revisionRelationV2OverlapSamples: latestEligibility?.relation.overlapSamples ?? 0,
      revisionRelationV2SharedCoordinateSpaceCount:
        latestEligibility?.relation.sharedCoordinateSpaceCount ?? 0,
      t1DropWholeV2Eligible: t1Eligibility.eligible === true,
      t1DropWholeV2Reason: t1Eligibility.reason,
      t1RevisionRelationV2: pendingEligibility?.relation.relation ?? 'unproven',
      t1RevisionSharedCoordinateSpaceCountV2:
        pendingEligibility?.relation.sharedCoordinateSpaceCount ?? 0,
      t2SupersedePendingV2Eligible: t2Eligible,
      t2SupersedePendingV2Reason: t2Reason,
      t2RevisionRelationV2: t2Relation,
      t2RevisionSharedCoordinateSpaceCountV2:
        t2DiagnosticEligibility?.relation.sharedCoordinateSpaceCount ?? 0,
      supersedesGenerationsV2,
      supersessionChainV2Truncated,
    });
    const replacedPendingGeneration = family.pending?.generation ?? null;
    family.generation = generation;
    family.pending = ticket;
    family.ranges = ranges;
    family.words = words;
    family.lineageStatus = releaseMeta?.sourceLineage?.status ?? 'missing';
    family.sourceMap = sourceMap;
    family.updatedAtMs = nowMs;

    this._log({
      stage: 'fqf_t1_revision_admission_shadow',
      phase: 'accepted_enqueue',
      policy_applied: false,
      churchId,
      session_epoch: sessionEpoch,
      release_seq: releaseSeq,
      source_hash: releaseMeta?.sourceHash ?? null,
      ...ticketEventFields(ticket),
      family_state: family.active ? 'active_plus_pending' : 'pending_only',
      active_generation: family.active?.generation ?? null,
      pending_generation: family.pending?.generation ?? null,
      replaced_pending_generation: replacedPendingGeneration,
      matched_release_seq: match.family?.latestReleaseSeq ?? null,
      span_overlap_samples: match.spanOverlapSamples ?? 0,
      lexical_anchor_length: match.lexicalAnchorLength ?? 0,
      disjoint_span_lexical_match: match.disjointSpans === true,
      source_lineage_status: releaseMeta?.sourceLineage?.status ?? 'missing',
      ...(this.config.sourceMapV2ShadowEnabled ? sourceMapTelemetry(sourceMap) : {}),
    });
    family.latestReleaseSeq = releaseSeq;
    state.latestReleaseSeq = releaseSeq;
    state.releases.set(releaseSeq, Object.freeze({ fingerprint: releaseFingerprint, ticket }));
    while (state.releases.size > MAX_RELEASE_IDENTITIES) {
      state.releases.delete(state.releases.keys().next().value);
    }
    return ticket;
  }

  _registerUnscorable({
    churchId, sessionEpoch, releaseSeq, releaseMeta, text, nowMs,
    evidence = 'missing_accepted_identity',
  }) {
    const sourceMap = sourceMapFromLineage(releaseMeta?.sourceLineage, {
      expectedWordCount: sourceWordCount(text),
    });
    const ticket = Object.freeze({
      version: 1,
      kind: 'unscorable',
      ticketId: revisionIdentity('unscorable', churchId, sessionEpoch, releaseSeq, nowMs),
      churchId: churchId || null,
      familyId: null,
      generation: null,
      evidence,
      applyEligible: false,
      scorable: false,
      sessionEpoch,
      releaseSeq,
      sourceHash: releaseMeta?.sourceHash ?? null,
      componentCount: 1,
      sourceMapV2ShadowEnabled: this.config.sourceMapV2ShadowEnabled,
      sourceMap,
      sourceMapV2Status: sourceMap.status,
      sourceMapV2CoverageRatio: sourceMap.coverage.ratio,
      revisionRelationV2: 'unproven',
      revisionRelationV2OverlapSamples: 0,
      revisionRelationV2SharedCoordinateSpaceCount: 0,
      t1DropWholeV2Eligible: false,
      t1DropWholeV2Reason: evidence,
      t1RevisionRelationV2: 'unproven',
      t1RevisionSharedCoordinateSpaceCountV2: 0,
      t2SupersedePendingV2Eligible: false,
      t2SupersedePendingV2Reason: evidence,
      t2RevisionRelationV2: 'unproven',
      t2RevisionSharedCoordinateSpaceCountV2: 0,
      supersedesGenerationsV2: Object.freeze([]),
      supersessionChainV2Truncated: false,
    });
    this._log({
      stage: 'fqf_t1_revision_admission_shadow', phase: 'accepted_enqueue', policy_applied: false,
      churchId: churchId || null, session_epoch: sessionEpoch, release_seq: releaseSeq,
      source_hash: releaseMeta?.sourceHash ?? null, ...ticketEventFields(ticket),
    });
    return ticket;
  }

  isCurrent(ticket) {
    if (!this.enabled) return {
      decision: 'disabled', reason: 'shadow_disabled', currentGeneration: null,
      v2Decision: 'disabled', v2Reason: 'shadow_disabled',
    };
    if (!ticket || ticket.kind !== 'single' || !ticket.scorable || !ticket.familyId) {
      return {
        decision: 'unscorable', reason: ticket?.evidence || 'missing_ticket', currentGeneration: null,
        v2Decision: 'unscorable', v2Reason: ticket?.t1DropWholeV2Reason || 'missing_ticket',
      };
    }
    const state = this._churches.get(ticket.churchId || '');
    const nowMs = this._now();
    if (state && Number.isFinite(nowMs)) this._prune(state, nowMs);
    const family = state?.families.get(ticket.familyId);
    if (!family || state.sessionEpoch !== ticket.sessionEpoch) {
      return {
        decision: 'unscorable', reason: 'family_not_live', currentGeneration: null,
        v2Decision: 'unscorable', v2Reason: 'family_not_live',
      };
    }
    const latched = family.decisions.get(ticket.ticketId);
    if (latched) return latched;
    const current = family.pending || family.active;
    if (!current) return {
      decision: 'unscorable', reason: 'family_empty', currentGeneration: null,
      v2Decision: 'unscorable', v2Reason: 'family_empty',
    };
    const isLatest = current.generation === ticket.generation;
    return {
      decision: isLatest ? 'emit_whole' : 'would_drop_whole',
      reason: isLatest ? 'latest_generation' : 'superseded_generation',
      currentGeneration: current.generation,
      v2Decision: isLatest || !current.supersedesGenerationsV2?.includes(ticket.generation)
        ? 'emit_whole'
        : 'would_drop_whole',
      v2Reason: isLatest
        ? 'latest_generation'
        : current.supersedesGenerationsV2?.includes(ticket.generation)
          ? current.t1DropWholeV2Reason
          : 'supersession_chain_not_proved',
    };
  }

  observeCheckpoint({ churchId, ticket, language = null, emissionId = null, checkpoint = 'accepted_output_pre_tts' }) {
    if (!this.enabled) return null;
    const result = this._latchDecision(churchId, ticket);
    const event = {
      stage: 'fqf_t1_revision_admission_shadow', phase: checkpoint, policy_applied: false,
      churchId: churchId || null, session_epoch: ticket?.sessionEpoch ?? null,
      release_seq: ticket?.releaseSeq ?? null, source_hash: ticket?.sourceHash ?? null,
      language, emissionId, ...ticketEventFields(ticket),
      shadow_decision: result.decision, shadow_reason: result.reason,
      current_generation: result.currentGeneration,
      source_map_v2_shadow_decision: result.v2Decision,
      source_map_v2_shadow_reason: result.v2Reason,
    };
    this._log(event);
    return event;
  }

  clear(churchId) { this._churches.delete(churchId); }

  _stateFor(churchId, sessionEpoch) {
    const existing = this._churches.get(churchId);
    if (existing?.sessionEpoch === sessionEpoch) return existing;
    const state = {
      churchId,
      sessionEpoch,
      families: new Map(),
      nextFamily: 1,
      latestReleaseSeq: null,
      releases: new Map(),
    };
    this._churches.set(churchId, state);
    return state;
  }

  _releaseFingerprint({ sessionEpoch, releaseSeq, releaseMeta, text }) {
    return revisionIdentity(
      'accepted_release',
      sessionEpoch,
      releaseSeq,
      releaseMeta?.sourceHash,
      releaseMeta?.emittedSourceHash,
      text,
    );
  }

  _newFamily({ state, churchId, sessionEpoch, releaseSeq, releaseMeta, nowMs }) {
    const id = revisionIdentity('family', churchId, sessionEpoch, releaseSeq, releaseMeta?.sourceHash, state.nextFamily++);
    const family = {
      id,
      generation: 0,
      active: null,
      pending: null,
      decisions: new Map(),
      ranges: [],
      words: [],
      lineageStatus: 'missing',
      sourceMap: null,
      lastCheckpointed: null,
      updatedAtMs: nowMs,
      latestReleaseSeq: null,
    };
    state.families.set(id, family);
    return family;
  }

  _latchDecision(churchId, ticket) {
    if (ticket?.churchId && ticket.churchId !== churchId) {
      return { decision: 'unscorable', reason: 'church_mismatch', currentGeneration: null };
    }
    const result = this.isCurrent(ticket);
    if (!ticket?.familyId || ticket.kind !== 'single' || result.decision === 'unscorable') return result;
    const state = this._churches.get(ticket.churchId || '');
    const family = state?.families.get(ticket.familyId);
    if (!family || family.decisions.has(ticket.ticketId)) return result;
    // Shadow never blocks the live path, so every observed pre-TTS checkpoint is
    // an actually emitted generation even when the hypothetical T1 decision is drop.
    family.lastCheckpointed = ticket;
    if (result.decision === 'emit_whole') {
      family.active = ticket;
      if (family.pending?.ticketId === ticket.ticketId) family.pending = null;
    }
    family.decisions.set(ticket.ticketId, Object.freeze({ ...result }));
    while (family.decisions.size > MAX_LATCHED_DECISIONS_PER_FAMILY) {
      family.decisions.delete(family.decisions.keys().next().value);
    }
    return family.decisions.get(ticket.ticketId);
  }

  _prune(state, nowMs) {
    const cutoff = nowMs - this.config.windowSec * 1000;
    for (const [id, family] of state.families) {
      if (family.updatedAtMs < cutoff) state.families.delete(id);
    }
    const overflow = state.families.size - this.config.maxFamilies;
    if (overflow <= 0) return;
    const oldest = [...state.families.values()].sort((a, b) => a.updatedAtMs - b.updatedAtMs).slice(0, overflow);
    for (const family of oldest) state.families.delete(family.id);
  }

  _log(event) {
    try { this._logFn(event); } catch { /* shadow is fail-open */ }
  }
}

export const revisionAdmissionTelemetry = (releaseMeta) => (
  releaseMeta?.revisionTicket ? ticketEventFields(releaseMeta.revisionTicket) : {}
);

export const createRevisionAdmissionShadow = (options) => new RevisionAdmissionShadow(options);
