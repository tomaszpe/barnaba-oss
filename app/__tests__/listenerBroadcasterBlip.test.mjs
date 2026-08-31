import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const indexSource = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const gatewaySource = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

describe('listener survives a short broadcaster blip (no full-room kick)', () => {
  it('gateway still preserves listener subscriptions across broadcaster re-auth', () => {
    // The fix relies on this invariant: a broadcaster blip must NOT drop listener subs.
    expect(gatewaySource).toContain('HOTFIX 7.1: Guard against wiping existing subscriptions on re-auth');
    expect(gatewaySource).toContain("preserving ${existing.size} language(s) with ${listenerCount} listener(s)");
    // And the broadcaster re-auth re-announces the church to listeners.
    expect(gatewaySource).toContain("broadcastToAll({ type: 'church_online', churchId, name: churchName })");
  });

  it('church_offline for the CURRENT church pauses with a grace window instead of tearing down', () => {
    expect(indexSource).toContain('const CHURCH_RESUME_GRACE_MS = 45000;');
    expect(indexSource).toContain('function pauseCurrentChurch(id)');
    // removeChurch routes the current church to pause, not to an immediate teardown.
    expect(indexSource).toMatch(/function removeChurch\(id\)\s*\{[\s\S]*?if \(churchId === id\)\s*\{[\s\S]*?pauseCurrentChurch\(id\);/);
  });

  it('pause keeps the session and arms a teardown only after the grace window', () => {
    // Pause must NOT null the session — it only stops playback and shows the overlay.
    expect(indexSource).toMatch(/function pauseCurrentChurch\(id\)\s*\{[\s\S]*?resetLanguagePlayback\(\);[\s\S]*?showOfflineOverlay\(\);/);
    expect(indexSource).toMatch(/churchResumeTimer = setTimeout\([\s\S]*?teardownCurrentChurch\(id\);[\s\S]*?CHURCH_RESUME_GRACE_MS\)/);
    // The full teardown (the old church_offline behaviour) now lives behind the grace timer.
    expect(indexSource).toMatch(/function teardownCurrentChurch\(id\)\s*\{[\s\S]*?stopLocalTranslationPlayback\(\);[\s\S]*?goToScreen\(3\);/);
  });

  it('auto-resumes on church_online while paused, re-subscribing defensively', () => {
    expect(indexSource).toMatch(/case 'church_online':[\s\S]*?if \(churchId === msg\.churchId && churchPaused\)\s*\{[\s\S]*?resumeCurrentChurch\(\);/);
    expect(indexSource).toMatch(/function resumeCurrentChurch\(\)\s*\{[\s\S]*?authenticateListenerSocket\(\);[\s\S]*?subscribeCurrentLanguage\(language\);/);
    // resume clears the grace timer so a later expiry cannot tear a live session down.
    expect(indexSource).toMatch(/function resumeCurrentChurch\(\)\s*\{[\s\S]*?clearTimeout\(churchResumeTimer\)/);
  });

  it('also resumes as soon as audio flows again, even if church_online was missed', () => {
    expect(indexSource).toMatch(/case 'translation':[\s\S]*?if \(churchPaused\) resumeCurrentChurch\(\);/);
  });

  it('no longer tears the listener down synchronously inside removeChurch', () => {
    // Guard against regressing to the old behaviour where church_offline immediately
    // nulled churchId/language and bounced the user to screen 3.
    const removeChurchBlock = indexSource.match(/function removeChurch\(id\)\s*\{[\s\S]*?\n        \}/)[0];
    expect(removeChurchBlock).not.toContain('goToScreen(3)');
    expect(removeChurchBlock).not.toContain('language = null');
  });
});
