import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const serverSource = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

/**
 * Wiring of the in-flight evidence into `server.js`.
 *
 * A SAFETY NET, NOT A GATE. The behaviour of the evidence itself is guarded by unit tests
 * (`whisperRequestEvidence.test.mjs`, `whisperRequestTracker.test.mjs`); `server.js` calls
 * `listen()` at the top level, so it cannot be imported and executed. These assertions prove
 * ONLY that the read happens once, sits in each named branch, and that nobody along the way
 * turns a candidate into evidence.
 */

/** The `evalLog` record that starts with the given marker. */
function evalRecord(marker) {
    const start = serverSource.indexOf(marker);
    expect(start, `marker not found: ${marker}`).toBeGreaterThan(-1);
    return serverSource.slice(start, start + 900);
}

describe('a single read point', () => {
    it('server.js reads the tracker ONLY through `whisperRequestEvidence`', () => {
        // two occurrences: the import from the client module + the single call in the helper
        const reads = serverSource.match(/getWhisperRequestsInFlight/g) || [];
        expect(reads).toHaveLength(2);
        expect(serverSource).toContain(
            'return buildWhisperRequestEvidence(getWhisperRequestsInFlight(churchId), options);'
        );
    });

    it('does not defer the read past an `await` - the value must describe the MOMENT of decision', () => {
        expect(serverSource).not.toMatch(/await\s+whisperRequestEvidence\s*\(/);
        expect(serverSource).not.toMatch(/whisperRequestEvidence\s*\([^)]*\)\s*;\s*await/);
    });

    it('does not assemble a record from two reads', () => {
        // every `evalLog` record has at most one evidence spread
        for (const record of serverSource.split('evalLog({').slice(1)) {
            const block = record.slice(0, record.indexOf('});') + 3);
            const spreads = block.match(/\.\.\.whisperRequestEvidence\(/g) || [];
            expect(spreads.length).toBeLessThanOrEqual(1);
        }
    });
});

describe('POSITIVE decisions carry evidence and a candidate', () => {
    it('pause_deadline_fallback (refined path)', () => {
        const record = evalRecord("stage: 'pause_deadline_fallback', churchId,\n            emit_mode: payload.mode");
        expect(record).toContain('...whisperRequestEvidence(churchId, { publication: true })');
    });

    it('pause_deadline_fallback (legacy raw partial)', () => {
        const record = evalRecord("emit_mode: 'raw_partial'");
        expect(record).toContain('...whisperRequestEvidence(churchId, { publication: true })');
    });

    it('age_budget_fallback publication gets its own event, at the moment of the decision', () => {
        const record = evalRecord("stage: 'whisper_request_evidence'");
        expect(record).toContain("decision: 'age_budget_fallback'");
        expect(record).toContain('...whisperRequestEvidence(churchId, { publication: true })');
        // before emission, not after it
        const evidenceIdx = serverSource.indexOf("stage: 'whisper_request_evidence'");
        const emitIdx = serverSource.indexOf("origin: 'partial_fallback'", evidenceIdx);
        expect(evidenceIdx).toBeLessThan(emitIdx);
    });
});

describe('NEGATIVE decisions carry evidence too', () => {
    it('deadline_no_safe_payload', () => {
        const record = evalRecord("stage: 'deadline_no_safe_payload'");
        expect(record).toContain('...whisperRequestEvidence(churchId)');
        // no publication => no candidate flag
        expect(record).not.toContain('publication: true');
    });

    it('deadline_fallback_blocked', () => {
        const record = evalRecord("stage: 'deadline_fallback_blocked'");
        expect(record).toContain('...whisperRequestEvidence(churchId)');
        expect(record).not.toContain('publication: true');
    });

    it('fallback_release_policy: hold - both branches', () => {
        // ASR fallback holds ONLY. `logEmissionDecision(... decision: 'hold')` in the
        // translation queue is a different decision, outside this contract - deliberately
        // without evidence.
        const holds = serverSource
            .split("stage: 'fallback_release_policy', churchId, decision: 'hold'").slice(1);
        expect(holds).toHaveLength(2);
        for (const hold of holds) {
            const block = hold.slice(0, hold.indexOf('});') + 3);
            expect(block).toContain('...whisperRequestEvidence(churchId)');
            expect(block).not.toContain('publication: true');
        }
    });
});

describe('the completion event', () => {
    it('re-maps the READY, sanitised completion without transformation', () => {
        expect(serverSource).toContain(
            "evalLog({ stage: 'whisper_request_completed', churchId, ...completion });"
        );
        // server.js touches neither the spans nor the delta text - sanitisation is the tracker's job
        expect(serverSource).not.toContain('confirmedWordSpans');
        expect(serverSource).not.toContain('completion.provenance.');
    });

    it('hooked into the chunk send together with latencyTxId', () => {
        const call = evalRecord('sendStreamingChunk(churchId, samples, sampleRate, isFinal');
        expect(call).toContain('latencyTxId');
        expect(call).toContain('onRequestCompleted: (completion) => logWhisperRequestCompleted(churchId, completion)');
    });
});

describe('no behaviour change and no over-interpretation', () => {
    it('no branch calls the candidate proof of premature publication', () => {
        expect(serverSource).not.toMatch(/premature_publication(?!_candidate)/);
        expect(serverSource).not.toMatch(/premature[_a-z]*_(proof|proven|confirmed)/);
    });

    it('does not introduce a notion of "a decode in progress" on the gateway side', () => {
        // the gateway sees OPEN WORK; `decode_proof` is written after the fact, in the tracker
        expect(serverSource).not.toContain('decode_in_flight');
        expect(serverSource).not.toMatch(/decoding_in_progress|decode_running/);
    });

    it('the evidence adds neither a wait nor a new timeout to the fallback path', () => {
        for (const site of serverSource.split('whisperRequestEvidence(churchId').slice(1)) {
            const around = site.slice(0, 200);
            expect(around).not.toMatch(/setTimeout|sleep\(|await /);
        }
    });
});
