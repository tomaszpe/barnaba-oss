import { createHmac, randomBytes } from 'node:crypto';

const WORD_RE = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;
const VALID_MODES = new Set(['off', 'shadow']);

const tokensFor = (text) => (
    String(text || '').normalize('NFC').toLocaleLowerCase('de-CH').match(WORD_RE) || []
);

const safeLineage = (lineage) => {
    const spans = Array.isArray(lineage?.wordSpans) ? lineage.wordSpans : [];
    const validSpans = spans.filter((span) => (
        Number.isSafeInteger(span?.startSample)
        && Number.isSafeInteger(span?.endSample)
        && span.endSample > span.startSample
    ));
    const coordinateIds = [...new Set(
        validSpans.map((span) => span.logicalChunkId).filter(Boolean),
    )];
    return {
        status: lineage?.status || 'missing',
        reason: lineage?.reason || null,
        spans: validSpans,
        coordinateIds,
        decodeIds: [...new Set(validSpans.map((span) => span.decodeId).filter(Number.isSafeInteger))],
    };
};

export function createRepObserver({
    mode = 'off', evalLog = () => {}, keyFactory = randomBytes, ngramWords = 8,
    protectedTextEnabled = false,
} = {}) {
    const normalizedMode = VALID_MODES.has(String(mode).toLowerCase())
        ? String(mode).toLowerCase() : 'off';
    const keys = new Map();
    const coordinateSpacesByChurch = new Map();
    let eventSeq = 0;

    const keyFor = (churchId, coordinateIds, sessionEpoch) => {
        const identity = `${churchId}:${coordinateIds.join(',') || sessionEpoch || 'unproven'}`;
        if (!keys.has(identity)) keys.set(identity, keyFactory(32));
        return keys.get(identity);
    };

    const observe = ({
        stage, churchId, text, lineage = null, releaseMeta = null, decodeId = null,
        outcome = null, blockStage = null, filterDecisions = [],
    }) => {
        if (normalizedMode !== 'shadow') return null;
        try {
            const started = performance.now();
            const words = tokensFor(text);
            const safe = safeLineage(lineage);
            const churchSpaces = coordinateSpacesByChurch.get(churchId) || new Set();
            for (const id of safe.coordinateIds) churchSpaces.add(id);
            coordinateSpacesByChurch.set(churchId, churchSpaces);
            const digest = words.length > 0
                ? createHmac('sha256', keyFor(churchId, safe.coordinateIds, releaseMeta?.sessionEpoch))
                    .update(words.join('\x1f')).digest('hex')
                : null;
            const ngramSize = Math.max(2, Number.parseInt(ngramWords, 10) || 8);
            const ngramHmacs = [];
            for (let index = 0; index + ngramSize <= words.length; index++) {
                ngramHmacs.push(
                    createHmac('sha256', keyFor(
                        churchId, safe.coordinateIds, releaseMeta?.sessionEpoch,
                    )).update(words.slice(index, index + ngramSize).join('\x1f')).digest('hex'),
                );
            }
            const starts = safe.spans.map((span) => span.startSample);
            const ends = safe.spans.map((span) => span.endSample);
            const event = {
                schema_version: 1,
                event: 'rep_stage_observation',
                stage,
                service: 'gateway',
                church_id: churchId,
                session_epoch: releaseMeta?.sessionEpoch ?? null,
                coordinate_space_ids: safe.coordinateIds,
                decode_ids: decodeId == null
                    ? safe.decodeIds : [...new Set([decodeId, ...safe.decodeIds])],
                release_seq: releaseMeta?.releaseSeq ?? null,
                event_seq: ++eventSeq,
                token_count: words.length,
                token_hmac_sha256: digest,
                ngram_hmac_sha256: ngramHmacs,
                lineage_status: safe.status,
                lineage_reason: safe.reason,
                word_span_count: safe.spans.length,
                span_start_sample: starts.length ? Math.min(...starts) : null,
                span_end_sample: ends.length ? Math.max(...ends) : null,
                whisper_session_change_count: Math.max(0, churchSpaces.size - 1),
                outcome,
                block_stage: blockStage,
                filter_decisions: filterDecisions,
                policy_applied: false,
                emitted_text_changed: false,
            };
            if (protectedTextEnabled === true) {
                event.protected_ngram_text = Array.from(
                    { length: Math.max(0, words.length - ngramSize + 1) },
                    (_, index) => words.slice(index, index + ngramSize).join(' '),
                );
            }
            event.observer_ms = Number((performance.now() - started).toFixed(4));
            evalLog(event);
            return event;
        } catch {
            return null;
        }
    };

    const closeChurch = (churchId) => {
        if (normalizedMode !== 'shadow') return null;
        const spaces = coordinateSpacesByChurch.get(churchId) || new Set();
        const event = {
            schema_version: 1,
            event: 'rep_session_closed',
            stage: 'session_end',
            service: 'gateway',
            church_id: churchId,
            event_seq: ++eventSeq,
            whisper_session_change_count: Math.max(0, spaces.size - 1),
            policy_applied: false,
            emitted_text_changed: false,
        };
        evalLog(event);
        coordinateSpacesByChurch.delete(churchId);
        for (const identity of keys.keys()) {
            if (identity.startsWith(`${churchId}:`)) keys.delete(identity);
        }
        return event;
    };

    return Object.freeze({ mode: normalizedMode, observe, closeChurch });
}

export { tokensFor };
