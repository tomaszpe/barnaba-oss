import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const serverSource = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

describe('server progressive TTS delivery identity', () => {
    it('uses one canonical helper in both progressive dispatch paths', () => {
        expect([...serverSource.matchAll(/broadcastProgressiveTtsChunk\(\{/g)]).toHaveLength(3);
        expect([...serverSource.matchAll(/const onChunk = \(audioBase64, sentenceIdx, totalSentences, isLast, sentenceText\)/g)])
            .toHaveLength(2);
    });

    it('emits the complete canonical chunk identity and sent-side denominator', () => {
        const helper = serverSource.slice(
            serverSource.indexOf('function broadcastProgressiveTtsChunk'),
            serverSource.indexOf('// ============================================================\n// Configuration'),
        );
        expect(helper).toContain('buildTtsChunkIdentity');
        expect(helper).toContain("stage: 'tts_chunk_sent'");
        expect(helper).toContain('listeners_served: listenersServed');
        expect(helper).toContain('...identity');
        expect(helper).toContain('...revisionAdmissionTelemetry(releaseMeta)');
        expect(helper).toContain('audioBase64: audioBase64 || null');
    });

    it('wires request-start telemetry into every Azure TTS call path', () => {
        expect(serverSource).toContain("stage: 'tts_request_started'");
        expect([...serverSource.matchAll(/ttsRequestTelemetry\(\{ churchId, emissionId: _emissionId, releaseMeta \}\)/g)])
            .toHaveLength(5);
    });

    it('wires provider request telemetry into both GPT translation paths', () => {
        expect(serverSource).toContain("import { createTranslationRequestTelemetry } from './translationProviderTelemetry.js'");
        expect(serverSource).toContain('return createTranslationRequestTelemetry({');
        expect([...serverSource.matchAll(/emissionId: _emissionId,\s+releaseMeta,\s+queuedAt,/g)])
            .toHaveLength(2);
    });

    it('stamps emitted_source_hash only after source filters at the true queue point', () => {
        // Scoped to the function body, ending at the next top-level declaration.
        // It used to end at start + 30000 characters, and the function outgrew that:
        // the queue point moved to offset 32788, indexOf returned -1, and the failure
        // read "expected 28219 to be less than -1" - which says nothing about a magic
        // number being too small. Anchors are now asserted by name before being ordered.
        const start = serverSource.indexOf('async function processCompleteSentence');
    const after = serverSource.slice(start + 10).search(/\n(?:async )?function [A-Za-z_]/);
        const process = serverSource.slice(start, after < 0 ? undefined : start + 10 + after);

        const stampAt = process.indexOf('stampEmittedSourceIdentity(releaseMeta, text)');
        const enqueueAt = process.indexOf('queue.enqueue(queueItem)');
        const revisionAt = process.indexOf('revisionAdmissionShadow.registerAccepted({');
        for (const [name, at] of [['stampEmittedSourceIdentity', stampAt], ['queue.enqueue', enqueueAt], ['registerAccepted', revisionAt]]) {
            expect(at, `anchor "${name}" not found in processCompleteSentence - it moved or was renamed`).toBeGreaterThan(-1);
        }
        expect(stampAt).toBeGreaterThan(0);
        expect(stampAt).toBeLessThan(enqueueAt);
        expect(revisionAt).toBeGreaterThan(enqueueAt);
        expect(process.slice(0, stampAt)).toContain('jaccardOverlapGuard');
    });
});
