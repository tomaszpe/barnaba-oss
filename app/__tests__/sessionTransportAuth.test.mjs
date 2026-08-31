import { describe, expect, it } from 'vitest';
import { bearerSessionToken } from '../sessionTransportAuth.js';

describe('session transport authorization', () => {
    it('extracts a bounded bearer token used by restored listener sessions', () => {
        expect(bearerSessionToken('Bearer payload.signature')).toBe('payload.signature');
        expect(bearerSessionToken('  bearer payload.signature  ')).toBe('payload.signature');
    });

    it('rejects missing, malformed and oversized authorization headers', () => {
        expect(bearerSessionToken(undefined)).toBeNull();
        expect(bearerSessionToken('Basic abc')).toBeNull();
        expect(bearerSessionToken('Bearer token with spaces')).toBeNull();
        expect(bearerSessionToken(`Bearer ${'x'.repeat(2049)}`)).toBeNull();
    });
});
