import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

describe('listener gateway connection and session persistence', () => {
    it('resolves the gateway URL before opening the listener WebSocket', () => {
        const initOrder = indexHtml.slice(
            indexHtml.indexOf('localizeUI(uiLang);'),
            indexHtml.indexOf('const savedSession = loadSession();')
        );

        expect(initOrder).toContain('resolveGatewayUrl().finally(connect);');
        expect(initOrder).not.toContain('connect();\n        resolveGatewayUrl();');
    });

    it('restores saved listener sessions through WebSocket token authentication', () => {
        expect(indexHtml).toContain('function saveSession(cId, cName, sessionToken = listenerSessionToken)');
        expect(indexHtml).toContain('sessionToken,');
        expect(indexHtml).toContain('listenerSessionToken = savedSession.sessionToken;');
        expect(indexHtml).toContain('authenticateListenerSocket();');
        expect(indexHtml).toContain('restored from session token');
    });
});
