import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const serverSource = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const listenerSource = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

describe('listener language switch routing', () => {
  it('removes a listener socket from stale gateway language subscriptions before subscribing', () => {
    expect(serverSource).toContain('function removeClientFromChurchSubscriptions(ws, churchId)');
    expect(serverSource).toContain('removeClientFromChurchSubscriptions(ws, clientState.churchId)');
    expect(serverSource).toContain('removeClientFromChurchSubscriptions(ws, churchId)');
  });

  it('drops stale listener messages and clears queued playback when the phone changes language', () => {
    expect(listenerSource).toContain('function isCurrentLanguageMessage(msg)');
    expect(listenerSource).toContain("console.log(`[WS] Ignoring stale translation for ${msg.language}; current=${language}`)");
    expect(listenerSource).toContain("console.log(`[WS] Ignoring stale tts_chunk for ${msg.language}; current=${language}`)");
    expect(listenerSource).toContain('function resetLanguagePlayback()');
    expect(listenerSource).toContain('resetLanguagePlayback();');
  });

  it('does not keep the old 30-second language switch UI fallback', () => {
    expect(listenerSource).not.toContain('30-45');
    expect(listenerSource).not.toContain('switchingBanner');
    expect(listenerSource).not.toContain('langSwitchTimeoutId');
  });

  it('localizes the new language-switch guidance instead of showing English for every language', () => {
    const titleMatches = listenerSource.match(/You can change language anytime/g) || [];
    const subMatches = listenerSource.match(/Changes apply from the next translated segment\./g) || [];

    expect(titleMatches).toHaveLength(2); // static default + en locale
    expect(subMatches).toHaveLength(2);
    expect(listenerSource).toContain('Możesz zmienić język w dowolnym momencie');
    expect(listenerSource).toContain('Du kannst die Sprache jederzeit ändern');
    expect(listenerSource).toContain('Puedes cambiar el idioma en cualquier momento');
    expect(listenerSource).toContain('Ви можете змінити мову будь-коли');
    expect(listenerSource).toContain('يمكنك تغيير اللغة في أي وقت');
  });
});
