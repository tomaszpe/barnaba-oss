export const WS_IP_RATE_LIMIT = Object.freeze({
    maxMessages: 500,
    windowMs: 60000,
});

export const WS_LISTENER_TELEMETRY_RATE_LIMIT = Object.freeze({
    maxMessages: 240,
    windowMs: 60000,
});

export function isConnectionScopedListenerTelemetry(message, clientState) {
    return message?.type === 'latency_ack'
        && clientState?.authenticated === true
        && clientState?.type === 'client'
        && typeof message.txId === 'string'
        && message.txId.length > 0
        && message.txId.length <= 128
        && Number.isFinite(message.receivedAt);
}

export function takeRateLimitSlot(previous, nowMs, config) {
    const expired = !previous || nowMs > previous.resetTime;
    const state = expired
        ? { count: 0, resetTime: nowMs + config.windowMs, warned: false }
        : { ...previous };

    state.count += 1;
    const allowed = state.count <= config.maxMessages;
    const shouldWarn = !allowed && !state.warned;
    if (shouldWarn) state.warned = true;

    return {
        state,
        allowed,
        shouldWarn,
        shouldClose: state.count > config.maxMessages * 2,
    };
}
