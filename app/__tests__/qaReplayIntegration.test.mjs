import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const admin = readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
const index = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

describe('admin recorder single-MP3 render integration', () => {
    it('admin recorder renders ONE MP3 via the server and drops the JSON sidecar', () => {
        expect(admin).toContain('recordBuildPlayWindows');
        expect(admin).toContain("fetch('/api/recording-render'");
        expect(admin).toContain("headers: { 'X-Session-Token': sessionToken }");
        expect(admin).toContain('barnaba_${lang}_${ts}.mp3');
        expect(admin).not.toContain('.timeline.json');
        expect(admin).not.toContain('recordBuildAudioTimeline');
    });

    it('server exposes a broadcaster-authenticated, size-bounded render endpoint', () => {
        expect(server).toContain("app.post('/api/recording-render', requireBroadcasterSession, parseQaReplayUpload");
        expect(server).toContain("validateRoleSession(getRecordingRenderToken(req), 'broadcaster', manifest.churchId)");
        expect(server).toContain('fields: 1');
        expect(server).toContain('QA_REPLAY_MAX_TOTAL_BYTES = 32 * 1024 * 1024');
        expect(server).toContain('cleanupQaReplay(rendered.tempDir)');
    });

    it('the listener PWA and server no longer carry the old listener-QA path', () => {
        expect(index).not.toContain('qaReplayCapture');
        expect(server).not.toContain('/api/listener-qa-replay');
        expect(server).not.toContain('requireQaListenerSession');
    });
});
