import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const indexSource = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

/**
 * 01.08.2026: both media elements sat at the END of <body> while the inline <script> that
 * binds them with `const ... = document.getElementById(...)` runs DURING parsing. Both consts
 * were therefore `null` for the page's whole lifetime — silently, because every use site is
 * null-guarded. The HTMLAudio playback path, the pitch policy, the autoplay unlock and the
 * background keep-alive were all dead code, and playback fell through to WebAudio, which
 * forces 1.0x whenever pitch preservation is on (measured: web_audio 139/139, effective rate
 * 1.0 in all of them). Nothing threw; only telemetry that measured the EFFECT caught it.
 */
const bindingOf = (id) => {
    const binding = indexSource.indexOf(`document.getElementById('${id}')`);
    expect(binding, `no getElementById('${id}') binding`).toBeGreaterThan(-1);
    const element = indexSource.indexOf(`<audio id="${id}"`);
    expect(element, `no <audio id="${id}"> element`).toBeGreaterThan(-1);
    // The whole script block is executed at its own position, so the element has to precede
    // the opening <script> tag — not merely the binding line inside it.
    const enclosingScript = indexSource.lastIndexOf('<script', binding);
    return { element, binding, enclosingScript };
};

describe('media elements are parsed before the script that binds them', () => {
    it.each(['ttsAudio', 'silentAudio'])('<audio id="%s"> precedes its binding script', (id) => {
        const { element, binding, enclosingScript } = bindingOf(id);

        expect(enclosingScript).toBeGreaterThan(-1);
        expect(element).toBeLessThan(enclosingScript);
        expect(element).toBeLessThan(binding);
    });

    it('keeps the plain const binding instead of scattering lazy lookups', () => {
        // The fix is document order, deliberately NOT a lazy getter in every call site: one
        // ordering rule is checkable here, N lazy lookups are not.
        expect(indexSource).toContain("const silentAudio = document.getElementById('silentAudio');");
        expect(indexSource).toContain("const ttsAudio = document.getElementById('ttsAudio');");
    });

    it('keeps both elements inside <body>, where a media element belongs', () => {
        const body = indexSource.indexOf('<body>');
        expect(body).toBeGreaterThan(-1);
        for (const id of ['ttsAudio', 'silentAudio']) {
            expect(indexSource.indexOf(`<audio id="${id}"`)).toBeGreaterThan(body);
        }
    });
});
