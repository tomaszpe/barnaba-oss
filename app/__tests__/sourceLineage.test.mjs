import { describe, expect, it } from 'vitest';
import {
    composeSourceLineages,
    projectSourceLineage,
    sliceSourceLineage,
    sourceLineageFromWhisper,
    sourceLineageTelemetry,
} from '../sourceLineage.js';

function provenance(overrides = {}) {
    return {
        whisperSessionId: '7f8164eb-960d-4cfe-982b-3738d87cf0b9',
        decodeId: 'decode-7',
        inputPcmSha256: 'a'.repeat(64),
        inputStartSample: 0,
        inputEndSample: 1000,
        provenanceStatus: 'complete',
        alignmentStatus: 'exact',
        confirmedWordSpans: [
            { text: 'Hiob', start_sample: 100, end_sample: 200 },
            { text: 'sprach', start_sample: 210, end_sample: 320 },
        ],
        ...overrides,
    };
}

describe('FQF-4B source lineage contract', () => {
    it('creates deterministic, text-free complete lineage from exact Whisper spans', () => {
        const first = sourceLineageFromWhisper('Hiob sprach.', provenance());
        const retry = sourceLineageFromWhisper('Hiob sprach.', provenance({ decodeId: 'decode-retry' }));

        expect(first.status).toBe('complete');
        expect(first.logicalChunkIds).toEqual(retry.logicalChunkIds);
        expect(first.wordSpans).toHaveLength(2);
        expect(JSON.stringify(first)).not.toContain('Hiob');
        expect(Object.isFrozen(first)).toBe(true);
        expect(Object.isFrozen(first.wordSpans)).toBe(true);
    });

    it('keeps one absolute coordinate space across growing snapshots and separates sessions', () => {
        const first = sourceLineageFromWhisper('Hiob sprach.', provenance());
        const grown = sourceLineageFromWhisper('Hiob sprach.', provenance({
            decodeId: 'decode-grown',
            inputPcmSha256: 'b'.repeat(64),
            inputEndSample: 2000,
        }));
        const nextSession = sourceLineageFromWhisper('Hiob sprach.', provenance({
            whisperSessionId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
        }));

        expect(grown.logicalChunkIds).toEqual(first.logicalChunkIds);
        expect(nextSession.logicalChunkIds).not.toEqual(first.logicalChunkIds);
    });

    it('fails closed when Whisper text and spans do not align', () => {
        const result = sourceLineageFromWhisper('Hiob schwieg.', provenance());
        expect(result).toMatchObject({
            status: 'ambiguous',
            reason: 'word_alignment_mismatch',
            wordSpans: [],
        });
    });

    it('fails closed on spans outside the decoder input or in reversed order', () => {
        const outside = sourceLineageFromWhisper('Hiob sprach.', provenance({ inputEndSample: 250 }));
        const reversed = sourceLineageFromWhisper('Hiob sprach.', provenance({
            confirmedWordSpans: [
                { text: 'Hiob', start_sample: 300, end_sample: 400 },
                { text: 'sprach', start_sample: 200, end_sample: 250 },
            ],
        }));
        expect(outside).toMatchObject({ status: 'ambiguous', reason: 'span_outside_input' });
        expect(reversed).toMatchObject({ status: 'ambiguous', reason: 'non_monotonic_span' });
    });

    it('never coerces missing or string sample coordinates into proof', () => {
        const missingStart = sourceLineageFromWhisper('Hiob sprach.', provenance({
            inputStartSample: null,
            confirmedWordSpans: [
                { text: 'Hiob', start_sample: null, end_sample: 200 },
                { text: 'sprach', start_sample: 210, end_sample: 320 },
            ],
        }));
        const stringRange = sourceLineageFromWhisper('Hiob sprach.', provenance({
            confirmedWordSpans: [
                { text: 'Hiob', start_sample: '100', end_sample: 200 },
                { text: 'sprach', start_sample: 210, end_sample: 320 },
            ],
        }));

        expect(missingStart).toMatchObject({ status: 'ambiguous', reason: 'invalid_sample_range' });
        expect(stringRange).toMatchObject({ status: 'ambiguous', reason: 'invalid_sample_range' });
    });

    it('requires one exact source word and a valid PCM digest per span', () => {
        const multiWordSpan = sourceLineageFromWhisper('Hiob sprach.', provenance({
            confirmedWordSpans: [
                { text: 'Hiob extra', start_sample: 100, end_sample: 200 },
                { text: 'sprach', start_sample: 210, end_sample: 320 },
            ],
        }));
        const invalidDigest = sourceLineageFromWhisper('Hiob sprach.', provenance({
            inputPcmSha256: 'not-a-digest',
        }));
        const missingSession = sourceLineageFromWhisper('Hiob sprach.', provenance({
            whisperSessionId: null,
        }));

        expect(multiWordSpan).toMatchObject({ status: 'ambiguous', reason: 'word_alignment_mismatch' });
        expect(invalidDigest).toMatchObject({ status: 'ambiguous', reason: 'missing_logical_identity' });
        expect(missingSession).toMatchObject({ status: 'ambiguous', reason: 'missing_logical_identity' });
    });

    it('slices and composes only provable word spans', () => {
        const full = sourceLineageFromWhisper('Hiob sprach.', provenance());
        const first = sliceSourceLineage(full, 0, 1);
        const second = sliceSourceLineage(full, 1, 1);
        const recomposed = composeSourceLineages([first, second]);

        expect(recomposed.status).toBe('complete');
        expect(recomposed.wordSpans.map((span) => span.startSample)).toEqual([100, 210]);
        expect(sourceLineageTelemetry(recomposed)).toEqual({
            source_lineage_status: 'complete',
            source_lineage_reason: null,
            logical_chunk_count: 1,
            logical_chunk_ids: recomposed.logicalChunkIds,
            source_spans: [
                { logical_chunk_id: recomposed.logicalChunkIds[0], start_sample: 100, end_sample: 200 },
                { logical_chunk_id: recomposed.logicalChunkIds[0], start_sample: 210, end_sample: 320 },
            ],
            source_span_word_count: 2,
            source_span_start_sample: 100,
            source_span_end_sample: 320,
        });
    });

    it('projects a unique post-filter tail without inventing a span', () => {
        const full = sourceLineageFromWhisper('Hiob sprach.', provenance());
        const tail = projectSourceLineage('Hiob sprach.', 'sprach.', full);
        const reordered = projectSourceLineage('Hiob sprach.', 'sprach Hiob.', full);

        expect(tail).toMatchObject({ status: 'complete', wordCount: 1 });
        expect(tail.wordSpans[0].startSample).toBe(210);
        expect(reordered).toMatchObject({ status: 'ambiguous', reason: 'emitted_text_not_contiguous' });
    });

    it('preserves known spans as partial when a composed neighbour is unscoped', () => {
        const complete = sourceLineageFromWhisper('Hiob sprach.', provenance());
        const partial = composeSourceLineages([
            complete,
            sourceLineageFromWhisper('Dalej.', null),
        ]);

        expect(partial.status).toBe('partial');
        expect(partial.wordCount).toBe(3);
        expect(partial.wordSpans).toHaveLength(2);
    });

    it('fails closed when composed source word order moves backwards in one audio session', () => {
        const later = sourceLineageFromWhisper('Hiob sprach.', provenance());
        const earlier = sourceLineageFromWhisper('Er schwieg.', provenance({
            confirmedWordSpans: [
                { text: 'Er', start_sample: 10, end_sample: 50 },
                { text: 'schwieg', start_sample: 60, end_sample: 90 },
            ],
        }));

        expect(composeSourceLineages([later, earlier])).toMatchObject({
            status: 'ambiguous',
            reason: 'non_monotonic_composition',
            wordSpans: [],
        });
    });

    it('does not call a composition complete when explicit word indexes are out of range', () => {
        const malformed = {
            ...sourceLineageFromWhisper('Hiob sprach.', provenance()),
            wordSpans: sourceLineageFromWhisper('Hiob sprach.', provenance()).wordSpans
                .map((span, index) => ({ ...span, wordIndex: index + 10 })),
        };
        expect(composeSourceLineages([malformed])).toMatchObject({
            status: 'ambiguous', reason: 'invalid_lineage_part',
        });
    });

    it('fails closed across interleaved coordinate spaces and absent composition parts', () => {
        const sessionA = provenance({
            confirmedWordSpans: [{ text: 'First', start_sample: 100, end_sample: 180 }],
        });
        const sessionB = provenance({
            whisperSessionId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
            confirmedWordSpans: [{ text: 'Second', start_sample: 500, end_sample: 580 }],
        });
        const sessionABackwards = provenance({
            confirmedWordSpans: [{ text: 'Backwards', start_sample: 10, end_sample: 80 }],
        });

        expect(composeSourceLineages([
            sourceLineageFromWhisper('First', sessionA),
            sourceLineageFromWhisper('Second', sessionB),
            sourceLineageFromWhisper('Backwards', sessionABackwards),
        ])).toMatchObject({ status: 'ambiguous', reason: 'non_monotonic_composition' });
        expect(composeSourceLineages([
            sourceLineageFromWhisper('First', sessionA), null,
        ])).toMatchObject({ status: 'ambiguous', reason: 'invalid_lineage_part' });
    });

    it('sanitizes malformed lineage telemetry without leaking free-form values', () => {
        const telemetry = sourceLineageTelemetry({
            status: 'complete',
            reason: 'a sermon fragment must not reach telemetry',
            logicalChunkIds: ['sermon-fragment'],
            wordSpans: [{
                logicalChunkId: 'sermon-fragment', startSample: 0, endSample: 10,
            }],
            wordCount: 1,
        });

        expect(telemetry).toMatchObject({
            source_lineage_status: 'ambiguous',
            source_lineage_reason: 'invalid_lineage_structure',
            logical_chunk_ids: [],
            source_spans: [],
        });
        expect(JSON.stringify(telemetry)).not.toContain('sermon-fragment');
    });
});
