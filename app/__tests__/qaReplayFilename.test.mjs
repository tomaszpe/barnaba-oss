import { describe, expect, it } from 'vitest';
import { decodeQaChunkKey } from '../qaReplayRenderer.js';

describe('QA replay chunk filename validation', () => {
    it('decodes valid keys and maps malformed percent encoding to 400', () => {
        expect(decodeQaChunkKey('12%3Ade%3A0.mp3')).toBe('12:de:0');
        try {
            decodeQaChunkKey('%ZZ.mp3');
            throw new Error('expected validation error');
        } catch (error) {
            expect(error.message).toBe('Invalid encoded chunk key');
            expect(error.statusCode).toBe(400);
        }
    });
});
