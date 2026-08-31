/**
 * Resolve target languages for a queued emission at the last responsible moment.
 *
 * Listener language changes are WebSocket subscription changes, not translation
 * session changes. A queued emission must therefore follow the languages that
 * are active when the worker is ready to translate, not the snapshot captured
 * when ASR first enqueued the text.
 */
function resolveQueuedEmissionLanguages(activeLanguages) {
    if (!Array.isArray(activeLanguages)) return [];
    return [...new Set(activeLanguages.filter(Boolean))];
}

export { resolveQueuedEmissionLanguages };
