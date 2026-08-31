const DEFAULT_INVALID_THRESHOLD = 3;
const DEFAULT_INVALID_WINDOW_MS = 60000;

const positiveInt = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

class TranslationProviderHealth {
    constructor({
        invalidThreshold = DEFAULT_INVALID_THRESHOLD,
        invalidWindowMs = DEFAULT_INVALID_WINDOW_MS,
        now = () => Date.now(),
        onAlert = () => {},
    } = {}) {
        this.invalidThreshold = positiveInt(invalidThreshold, DEFAULT_INVALID_THRESHOLD);
        this.invalidWindowMs = positiveInt(invalidWindowMs, DEFAULT_INVALID_WINDOW_MS);
        this.now = now;
        this.onAlert = onAlert;
        this.invalidRequestTimestamps = [];
        this.invalidAlertActive = false;
        this.stats = {
            policyBlocksPrompt: 0,
            policyBlocksCompletion: 0,
            policyBlocksUnknown: 0,
            droppedSegments: 0,
            providerFailures: 0,
            requestInvalid: 0,
            requestInvalidAlerts: 0,
            criticalAlerts: 0,
        };
    }

    recordFailure(error) {
        if (error?.kind === 'content_filter') {
            this.recordPolicyBlock(error.filterSource);
            return;
        }

        if (error?.kind === 'request_invalid') {
            this.recordInvalidRequest(error);
            return;
        }

        if (error?.kind === 'circuit_open') return;
        this.stats.providerFailures++;
        if (error?.kind === 'auth_or_deployment') {
            this.stats.criticalAlerts++;
            this.onAlert({
                level: 'critical',
                kind: error.kind,
                code: error.code,
                status: error.status,
                diagnostic: error.operatorDiagnostic || null,
            });
        }
    }

    recordPolicyBlock(filterSource) {
        if (filterSource === 'prompt') this.stats.policyBlocksPrompt++;
        else if (filterSource === 'completion') this.stats.policyBlocksCompletion++;
        else this.stats.policyBlocksUnknown++;
    }

    recordDroppedSegment() {
        this.stats.droppedSegments++;
    }

    recordInvalidRequest(error) {
        const nowMs = this.now();
        this.pruneInvalidRequests(nowMs);
        this.invalidRequestTimestamps.push(nowMs);
        this.stats.requestInvalid++;

        if (this.invalidRequestTimestamps.length >= this.invalidThreshold && !this.invalidAlertActive) {
            this.invalidAlertActive = true;
            this.stats.requestInvalidAlerts++;
            this.onAlert({
                level: 'error',
                kind: error.kind,
                code: error.code,
                status: error.status,
                count: this.invalidRequestTimestamps.length,
                windowMs: this.invalidWindowMs,
                diagnostic: error.operatorDiagnostic || null,
            });
        }
    }

    pruneInvalidRequests(nowMs = this.now()) {
        const cutoff = nowMs - this.invalidWindowMs;
        this.invalidRequestTimestamps = this.invalidRequestTimestamps.filter((ts) => ts >= cutoff);
        if (this.invalidRequestTimestamps.length < this.invalidThreshold) {
            this.invalidAlertActive = false;
        }
    }

    getStatus() {
        this.pruneInvalidRequests();
        return {
            ...this.stats,
            requestInvalidInWindow: this.invalidRequestTimestamps.length,
            requestInvalidAlertThreshold: this.invalidThreshold,
            requestInvalidWindowMs: this.invalidWindowMs,
        };
    }
}

export {
    TranslationProviderHealth,
};
