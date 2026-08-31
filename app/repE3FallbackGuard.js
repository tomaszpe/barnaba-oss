// E3 repairs one Gateway re-dispatch: a deadline reusing an accepted partial
// from the very same decode/input. This is not a text-similarity ASR filter.
export function createRepE3FallbackGuard({ enabled = false, maxEntries = 32 } = {}) {
    const entries = new Map();
    function keyFor({ text, provenance: p } = {}) {
        if (!enabled || !text || !p?.whisperSessionId
            || !Number.isSafeInteger(p.decodeId) || p.decodeId < 0
            || !/^[a-f0-9]{64}$/i.test(p.inputPcmSha256 || '')
            || !Number.isSafeInteger(p.inputStartSample) || p.inputStartSample < 0
            || !Number.isSafeInteger(p.inputEndSample) || p.inputEndSample <= p.inputStartSample) return null;
        return JSON.stringify([p.whisperSessionId, p.decodeId, p.inputPcmSha256,
            p.inputStartSample, p.inputEndSample, text]);
    }
    return {
        async trackPartial(candidate, dispatch) {
            const key = keyFor(candidate);
            if (!key) return dispatch();
            let entry = entries.get(key);
            if (!entry) {
                if (entries.size >= maxEntries) {
                    const evictable = [...entries].find(([, value]) => value.pending === 0);
                    if (!evictable) return dispatch(); // Capacity failure must not delete speech.
                    entries.delete(evictable[0]);
                }
                entry = { pending: 0, accepted: false };
                entries.set(key, entry);
            }
            entry.pending++;
            try {
                const result = await dispatch();
                if (result?.acceptedForTranslation === true) entry.accepted = true;
                return result;
            } finally {
                entry.pending--;
                if (!entry.pending && !entry.accepted) entries.delete(key);
            }
        },
        deadlineDecision(candidate) {
            const key = keyFor(candidate);
            const entry = key ? entries.get(key) : null;
            const reason = !enabled ? 'disabled' : !key ? 'missing_input_identity'
                : entry?.accepted ? 'same_input_already_accepted'
                : entry?.pending ? 'same_input_inflight' : 'not_previously_dispatched';
            return { applied: Boolean(entry?.accepted || entry?.pending), reason };
        },
    };
}
