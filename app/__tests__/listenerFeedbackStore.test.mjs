// Durable listener feedback: validation, JSONL storage, recovery after interrupted writes,
// the shared per-translation-session limit and the HTTP route served by control-plane.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { afterAll, onTestFinished, test, vi } from 'vitest';
import { createFeedbackStore, normalizeFeedback, FeedbackLimitError } from '../feedbackStore.mjs';
import { registerFeedbackRoutes } from '../feedbackRoutes.mjs';

const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'barnaba-feedback-'));
afterAll(() => fs.rm(dataRoot, { recursive: true, force: true }));

const report = (changes = {}) => ({
    reportId: randomUUID(), kind: 'issue', reason: 'other', occurredAt: '2026-09-16T10:00:00Z',
    sessionId: 'offline-session', churchId: 'offline-church', lang: 'en', uiLang: 'en',
    voice: 'male', clientVersion: 'listener-feedback-v1', context: { releaseSeq: 17, queueDepth: 2 }, ...changes,
});
async function storeOptions(environment = 'main-site') {
    return { storageRoot: await fs.mkdtemp(path.join(dataRoot, 'run-')), environment, version: 'test', requireMount: false };
}
async function records(store) {
    const names = (await fs.readdir(store.directory)).filter(name => /^feedback-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name));
    const contents = await Promise.all(names.map(name => fs.readFile(path.join(store.directory, name), 'utf8')));
    return contents.join('').split('\n').filter(Boolean).map(JSON.parse);
}

test('Other accepts empty text and exactly 200 characters; rejects 201', () => {
    assert.equal(normalizeFeedback(report()).note, null);
    assert.equal(normalizeFeedback(report({ note: 'a'.repeat(200) })).note.length, 200);
    assert.throws(() => normalizeFeedback(report({ note: 'a'.repeat(201) })), /note/);
});
test('general feedback allows no church or language and 3000 characters', () => {
    const general = report({ kind: 'general_feedback', churchId: null, lang: null, note: 'a'.repeat(3000) });
    assert.equal(normalizeFeedback(general).note.length, 3000);
    assert.throws(() => normalizeFeedback({ ...general, note: 'a'.repeat(3001) }), /note/);
    assert.throws(() => normalizeFeedback({ ...general, note: '' }), /empty feedback/);
});
test('optional email is validated and is only accepted with general feedback', () => {
    const general = report({ kind: 'general_feedback', email: 'listener@example.test' });
    assert.equal(normalizeFeedback(general).email, general.email);
    assert.throws(() => normalizeFeedback({ ...general, email: 'not-an-email' }), /email/);
    assert.throws(() => normalizeFeedback(report({ email: general.email })), /email/);
});
test('categories preserve their names; unknown categories and invalid metadata are rejected', () => {
    for (const reason of ['wrong_word', 'long_pause', 'translation_lag', 'other']) {
        assert.equal(normalizeFeedback(report({ reason })).reason, reason);
    }
    for (const changed of [{ reason: 'anything' }, { reportId: '../outside' }, { sessionId: '' },
        { occurredAt: 'yesterday' }, { context: { queueDepth: -1 } }, { churchId: null }]) {
        assert.throws(() => normalizeFeedback(report(changed)));
    }
});
test('unknown fields, tokens and IP are never copied to stored metadata', () => {
    const normalized = normalizeFeedback(report({ token: 'do-not-save', ip: '192.0.2.1', context: { secret: 'do-not-save' } }));
    assert.ok(!JSON.stringify(normalized).includes('do-not-save'));
    assert.ok(!JSON.stringify(normalized).includes('192.0.2.1'));
});
test('stores valid daily JSONL, authoritative environment/time and escaped user text', async () => {
    const store = createFeedbackStore(await storeOptions());
    await store.save(report({ note: '<script>bad()</script>\nsecond line', environment: 'another-site' }));
    const [saved] = await records(store);
    assert.equal(saved.environment, 'main-site');
    assert.equal(saved.note, '<script>bad()</script>\nsecond line');
    assert.equal(saved.occurredAt, '2026-09-16T10:00:00.000Z');
    assert.ok(Date.now() - Date.parse(saved.receivedAt) < 5000);
    assert.equal(saved.context.releaseSeq, 17);
});
test('simultaneous submissions produce complete separate lines', async () => {
    const store = createFeedbackStore(await storeOptions());
    await Promise.all(Array.from({ length: 25 }, () => store.save(report())));
    assert.equal((await records(store)).length, 25);
});
test('retries and double submissions produce one record, including after a process restart', async () => {
    const options = await storeOptions();
    const store = createFeedbackStore(options);
    const input = report({ note: 'Retry this report' });
    const receipts = await Promise.all([store.save(input), store.save(input)]);
    assert.deepEqual(receipts.map(item => item.duplicate), [false, true]);
    const reopened = createFeedbackStore(options);
    assert.equal((await reopened.save(input)).duplicate, true);
    assert.equal((await records(reopened)).length, 1);
    await assert.rejects(reopened.save({ ...input, note: 'Different data' }), /reportId already used/);
});
test('environments use separate directories and server config is mandatory', async () => {
    const options = await storeOptions();
    const first = createFeedbackStore(options);
    const second = createFeedbackStore({ ...options, environment: 'another-site' });
    await first.save(report());
    await second.save(report());
    assert.notEqual(first.directory, second.directory);
    assert.equal((await records(second))[0].environment, 'another-site');
    for (const environment of ['../../outside', 'Upper', '', undefined, 'a'.repeat(33)]) {
        assert.throws(() => createFeedbackStore({ ...options, environment }));
    }
    assert.throws(() => createFeedbackStore({ ...options, storageRoot: null }));
});
test('production rejects ephemeral storage instead of silently saving into a container', async () => {
    const store = createFeedbackStore({ ...await storeOptions(), requireMount: true });
    await assert.rejects(store.save(report()));
});

async function dailyFile(store) {
    const name = (await fs.readdir(store.directory)).find(name => /^feedback-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name));
    return path.join(store.directory, name);
}
test('interrupted append preserves exact partial bytes, then accepts retry once and survives restart', async () => {
    const options = await storeOptions();
    const store = createFeedbackStore(options);
    await store.save(report());
    const input = report({ note: 'Zażółć gęślą jaźń 😀' });
    const open = fs.open;
    let partial;
    const fault = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const file = await open(...args);
        if (args[1] === 'a' && /feedback-\d{4}-\d{2}-\d{2}\.jsonl$/.test(args[0])) {
            file.writeFile = async value => {
                const bytes = Buffer.from(value);
                partial = bytes.subarray(0, bytes.indexOf(Buffer.from('ż')) + 1);
                await file.write(partial);
                throw Object.assign(new Error('Interrupted write'), { code: 'EIO' });
            };
        }
        return file;
    });
    await assert.rejects(store.save(input), /Interrupted write/);
    fault.mockRestore();
    assert.equal((await store.save(input)).duplicate, false);
    assert.equal((await createFeedbackStore(options).save(input)).duplicate, true);
    assert.equal((await records(store)).length, 2);
    const recovery = path.join(store.directory, 'recovery');
    const backups = await fs.readdir(recovery);
    assert.equal(backups.length, 1);
    assert.deepEqual(await fs.readFile(path.join(recovery, backups[0])), partial);
});
test('restart repairs a complete final record missing its newline without duplicating it', async () => {
    const options = await storeOptions();
    const store = createFeedbackStore(options);
    const input = report();
    await store.save(input);
    const filename = await dailyFile(store);
    const contents = await fs.readFile(filename);
    await fs.writeFile(filename, contents.subarray(0, -1));
    assert.equal((await createFeedbackStore(options).save(input)).duplicate, true);
    assert.deepEqual(await fs.readFile(filename), contents);
});
test('failed recovery backup leaves the original file intact and returns failure', async () => {
    const options = await storeOptions();
    const store = createFeedbackStore(options);
    await store.save(report());
    const filename = await dailyFile(store);
    await fs.appendFile(filename, '{"unfinished":');
    const original = await fs.readFile(filename);
    const open = fs.open;
    const fault = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        if (args[0].endsWith('.partial')) throw new Error('Backup unavailable');
        return open(...args);
    });
    const reopened = createFeedbackStore(options);
    await assert.rejects(reopened.save(report()), /Backup unavailable/);
    assert.deepEqual(await fs.readFile(filename), original);
    fault.mockRestore();
    await reopened.save(report());
    assert.equal((await records(reopened)).length, 2);
});
test('a malformed complete line fails closed rather than discarding historical data', async () => {
    const options = await storeOptions();
    const store = createFeedbackStore(options);
    await store.save(report());
    const filename = await dailyFile(store);
    await fs.appendFile(filename, '{broken}\n');
    const original = await fs.readFile(filename);
    await assert.rejects(createFeedbackStore(options).save(report()), SyntaxError);
    assert.deepEqual(await fs.readFile(filename), original);
});
test('interrupted session journal keeps the last complete session and its identity', async () => {
    const options = await storeOptions();
    const store = createFeedbackStore(options);
    const session = await store.startSession();
    await fs.appendFile(path.join(store.directory, 'sessions.jsonl'), '{"id":"interrupted');
    const reopened = createFeedbackStore(options);
    assert.equal((await reopened.startSession()).id, session.id);
    await reopened.save(report());
    assert.equal((await records(reopened))[0].translationSessionId, session.id);
});
test('a full write with failed sync is flushed on retry and receives only one receipt', async () => {
    const options = await storeOptions();
    const store = createFeedbackStore(options);
    await store.startSession();
    const input = report();
    const open = fs.open;
    const fault = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const file = await open(...args);
        if (args[1] === 'a' && /feedback-\d{4}-\d{2}-\d{2}\.jsonl$/.test(args[0])) {
            file.sync = async () => { throw new Error('Sync unavailable'); };
        }
        return file;
    });
    await assert.rejects(store.save(input), /Sync unavailable/);
    fault.mockRestore();
    assert.equal((await store.save(input)).duplicate, true);
    assert.equal((await records(store)).length, 1);
});

async function serverFixture(overrides = {}) {
    const app = express();
    const store = registerFeedbackRoutes(app, {
        ...await storeOptions(), allowedOrigins: ['http://listener.test', 'http://control.test'],
        instantEnabled: true, ...overrides,
    }, express.json({ limit: '16kb' }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    onTestFinished(() => new Promise(resolve => server.close(resolve)));
    const url = `http://127.0.0.1:${server.address().port}/api/feedback`;
    const post = (body, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { url, post, store };
}
test('HTTP saves with no gateway and returns a matching durable receipt', async () => {
    const { post, store } = await serverFixture();
    const input = report();
    const response = await post(input);
    assert.equal(response.status, 201);
    assert.equal((await response.json()).reportId, input.reportId);
    assert.equal((await records(store)).length, 1);
    assert.equal((await post(input)).status, 200);
});
test('CORS allows only named listener/control origins; accepts preflight', async () => {
    const { post, url } = await serverFixture();
    const allowed = await post(report(), { Origin: 'http://listener.test' });
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://listener.test');
    assert.equal((await post(report(), { Origin: 'https://untrusted.test' })).status, 403);
    const preflight = await fetch(url, { method: 'OPTIONS', headers: { Origin: 'http://listener.test' } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-methods'), 'POST');
});
test('HTTP rejects invalid, oversized and non-JSON bodies without writing', async () => {
    const { post, url } = await serverFixture();
    assert.equal((await post(report({ note: 'x'.repeat(201) }))).status, 400);
    assert.equal((await post(report({ note: 'x'.repeat(20000) }))).status, 413);
    assert.equal((await fetch(url, { method: 'POST', body: 'text' })).status, 415);
    assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
});
test('HTTP storage failure returns 503, with no false success', async () => {
    const store = { save: async () => { throw new Error('unavailable'); } };
    const { post } = await serverFixture({ store });
    assert.equal((await post(report())).status, 503);
});
test('500 accepted reports share one durable translation-session limit across listeners and languages', async () => {
    const options = await storeOptions();
    const { post, store } = await serverFixture(options);
    const session = await store.startSession();
    const input = report();
    assert.equal((await post(input)).status, 201);
    assert.equal((await post(report({ note: 'x'.repeat(201) }))).status, 400);
    await Promise.all(Array.from({ length: 498 }, (_, index) => store.save(report({
        sessionId: `listener-${index}`, lang: index % 2 ? 'pl' : 'de', translationSessionId: randomUUID(),
        ...(index % 3 ? {} : { kind: 'general_feedback', note: 'A suggestion' }),
    }))));
    const boundary = await Promise.all([post(report({ lang: 'uk' })), post(report({ lang: 'ar' }))]);
    assert.deepEqual(boundary.map(item => item.status).sort(), [201, 429]);
    assert.equal((await boundary.find(item => item.status === 429).json()).code, 'session_limit');
    assert.equal((await post(input)).status, 200, 'retry does not consume quota');
    const reopened = createFeedbackStore(options);
    assert.equal((await reopened.startSession()).id, session.id, 'repeated start and restart retain session');
    await assert.rejects(reopened.save(report({ sessionId: 'new-browser' })), FeedbackLimitError);
    await reopened.endSession();
    await assert.rejects(reopened.save(report()), FeedbackLimitError, 'closing alone does not reset quota');
    const next = await reopened.startSession();
    assert.notEqual(next.id, session.id);
    await reopened.save(report());
    const saved = await records(reopened);
    assert.equal(saved.filter(item => item.translationSessionId === session.id).length, 500);
    assert.equal(saved.filter(item => item.translationSessionId === next.id).length, 1);
});
test('HTTP distinguishes invalid email from other input errors', async () => {
    const { post } = await serverFixture();
    const response = await post(report({ kind: 'general_feedback', email: 'bad-address' }));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'invalid_email');
});
test('general feedback works even if instant-feedback categories are disabled', async () => {
    const { post } = await serverFixture({ instantEnabled: false });
    assert.equal((await post(report())).status, 404);
    assert.equal((await post(report({ kind: 'general_feedback', churchId: null, lang: null, note: 'A suggestion' }))).status, 201);
});
