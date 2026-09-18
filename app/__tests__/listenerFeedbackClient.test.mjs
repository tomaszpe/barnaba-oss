import assert from 'node:assert/strict';
import { test } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

const source = fs.readFileSync(new URL('../public/feedback.js', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(language = 'en') {
    const elements = new Map();
    const timers = new Map();
    const requests = [];
    let sequence = 0;
    let fail = false;
    let responseCode = null;
    let responseGate = null;
    let context = { sessionId: 'session', churchId: 'church', lang: 'en', context: { releaseSeq: 17 } };
    const element = id => {
        if (!elements.has(id)) {
            const classes = new Set();
            const listeners = {};
            elements.set(id, { id, listeners, value: '', hidden: false, disabled: false, valid: true,
                style: { setProperty(name, value) { this[name] = value; } },
                classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name),
                    toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } },
                addEventListener: (name, handler) => { listeners[name] = handler; },
                setAttribute() {}, focus() {}, checkValidity() { return this.valid; }, getClientRects: () => [{}],
                reset() { element('feedbackNote').value = ''; element('feedbackEmail').value = ''; },
                querySelector: () => element('firstOption'),
                querySelectorAll: () => ['firstOption', 'feedbackNote', 'feedbackEmail', 'feedbackOk'].map(element),
            });
        }
        return elements.get(id);
    };
    const window = { innerHeight: 844, addEventListener() {}, visualViewport: { height: 500, offsetTop: 0, addEventListener() {} } };
    vm.runInNewContext(source, {
        window, document: { getElementById: element, body: { style: {} } }, crypto: { randomUUID }, AbortController,
        setTimeout: (handler, ms) => { const id = ++sequence; timers.set(id, { handler, ms }); return id; },
        clearTimeout: id => timers.delete(id),
        fetch: async (url, options) => {
            const body = JSON.parse(options.body);
            requests.push({ url, options, body });
            if (responseGate) await responseGate;
            if (fail) throw new Error('offline');
            if (responseCode) return { ok: false, json: async () => ({ code: responseCode }) };
            return { ok: true, json: async () => ({ success: true, reportId: body.reportId }) };
        },
    });
    const ui = window.createListenerFeedback({
        getContext: () => structuredClone(context), getConfig: () => ({ url: 'https://control.example/api/feedback' }),
        getLanguage: () => language, getIssueTitle: () => 'Report an issue',
    });
    const submit = async () => { element('feedbackForm').listeners.submit({ preventDefault() {} }); await flush(); };
    return { ui, element, requests, timers, submit, window,
        setFail: value => { fail = value; }, setContext: value => { context = value; },
        setGate: value => { responseGate = value; },
        setResponseCode: value => { responseCode = value; },
    };
}

test('opening the issue menu keeps categories visible and sends nothing', () => {
    const f = fixture(); f.ui.open('issue');
    assert.equal(f.element('feedbackOptions').style.display, 'block');
    assert.equal(f.element('feedbackForm').hidden, true);
    assert.equal(f.requests.length, 0);
});
test('Other alone opens the 200-character editor and hides email', () => {
    const f = fixture(); f.ui.open('issue'); f.ui.choose('other');
    assert.equal(f.element('feedbackForm').hidden, false);
    assert.equal(f.element('feedbackContact').hidden, true);
    assert.equal(f.element('feedbackNote').maxLength, 200);
    assert.equal(f.requests.length, 0);
});
test('paste is limited even when an input method bypasses native maxlength', () => {
    const f = fixture(); f.ui.open('issue'); f.ui.choose('other');
    const note = f.element('feedbackNote');
    note.value = 'x'.repeat(201); note.listeners.input();
    assert.equal(note.value.length, 200);
    assert.equal(f.element('feedbackCount').textContent, '200 / 200');
    note.value = 'x'.repeat(199) + '😀'; note.listeners.input();
    assert.equal(note.value.length, 199);
});
test('empty Other submits category and closes the whole overlay', async () => {
    const f = fixture(); f.ui.open('issue'); f.ui.choose('other'); await f.submit();
    assert.equal(f.requests[0].body.reason, 'other');
    assert.equal(f.requests[0].body.note, null);
    assert.equal(f.requests[0].url, 'https://control.example/api/feedback');
    assert.equal(f.element('feedbackOverlay').classList.contains('open'), false);
});
test('all three existing categories retain immediate submission and 1.2-second thanks', async () => {
    for (const reason of ['wrong_word', 'long_pause', 'translation_lag']) {
        const f = fixture(); f.ui.open('issue'); f.ui.choose(reason); await flush();
        assert.equal(f.requests[0].body.reason, reason);
        assert.equal(f.element('feedbackThanks').style.display, 'block');
        const timer = [...f.timers.values()].find(item => item.ms === 1200);
        assert.ok(timer); timer.handler();
        assert.equal(f.element('feedbackOverlay').classList.contains('open'), false);
    }
});
test('Other preserves the incident context captured before typing', async () => {
    const f = fixture(); f.ui.open('issue'); f.ui.choose('other');
    f.setContext({ sessionId: 'different-session', context: { releaseSeq: 99 } });
    f.element('feedbackNote').value = 'The sound stopped'; await f.submit();
    assert.equal(f.requests[0].body.context.releaseSeq, 17);
    assert.equal(f.requests[0].body.sessionId, 'session');
    assert.equal(f.requests[0].body.note, 'The sound stopped');
});
test('failure keeps the text and retry reuses the id to prevent duplicates', async () => {
    const f = fixture(); f.ui.open('issue'); f.ui.choose('other'); f.setFail(true);
    f.element('feedbackNote').value = 'Keep this text'; await f.submit();
    assert.equal(f.element('feedbackNote').value, 'Keep this text');
    assert.equal(f.element('feedbackError').hidden, false);
    assert.equal(f.element('feedbackOverlay').classList.contains('open'), true);
    f.setFail(false); await f.submit();
    assert.equal(f.requests[0].body.reportId, f.requests[1].body.reportId);
    assert.equal(f.element('feedbackOverlay').classList.contains('open'), false);
});
test('double click during save sends once; closing waits for the receipt', async () => {
    const f = fixture(); f.ui.open('issue'); f.ui.choose('other');
    let complete; f.setGate(new Promise(resolve => { complete = resolve; }));
    await f.submit(); await f.submit(); f.ui.close();
    assert.equal(f.requests.length, 1);
    assert.equal(f.element('feedbackOverlay').classList.contains('open'), true);
    complete(); await flush();
    assert.equal(f.element('feedbackOverlay').classList.contains('open'), false);
});
test('general feedback opens a larger editor and optional email; blank OK only closes', async () => {
    const f = fixture(); f.ui.open('general_feedback');
    assert.equal(f.element('feedbackNote').maxLength, 3000);
    assert.equal(f.element('feedbackContact').hidden, false);
    await f.submit(); assert.equal(f.requests.length, 0);
    assert.equal(f.element('feedbackOverlay').classList.contains('open'), false);
});
test('general feedback accepts text without email and rejects invalid email before sending', async () => {
    const f = fixture(); f.ui.open('general_feedback');
    f.element('feedbackNote').value = 'Please add larger text';
    f.element('feedbackEmail').valid = false; await f.submit(); assert.equal(f.requests.length, 0);
    f.element('feedbackEmail').valid = true; await f.submit();
    assert.equal(f.requests[0].body.kind, 'general_feedback'); assert.equal(f.requests[0].body.email, null);
});
test('general feedback accepts contact details without an active church session', async () => {
    const f = fixture(); f.setContext({ sessionId: 'session', churchId: null, lang: null });
    f.ui.open('general_feedback'); f.element('feedbackEmail').value = 'listener@example.test'; await f.submit();
    assert.equal(f.requests[0].body.churchId, null); assert.equal(f.requests[0].body.email, 'listener@example.test');
});
test('viewport follows the visible phone area and never calls playback functions', () => {
    const f = fixture(); f.ui.open('issue'); f.ui.choose('other');
    assert.equal(f.element('feedbackOverlay').style.height, '500px');
    assert.doesNotMatch(source, /\.pause\(|\.play\(|resetLanguagePlayback|stopLocalTranslationPlayback/);
});

const languages = {
    en: 'Send feedback', pl: 'Wyślij opinię', de: 'Feedback senden', fr: 'Envoyer un avis',
    es: 'Enviar comentarios', it: 'Invia un commento', pt: 'Enviar comentário',
    ru: 'Отправить отзыв', uk: 'Надіслати відгук', tr: 'Geri bildirim gönder', sw: 'Tuma maoni', ar: 'إرسال ملاحظات',
};
for (const [language, menu] of Object.entries(languages)) {
    test(`${language}: all form labels and each failure path use translated text`, async () => {
        const f = fixture(language);
        const english = fixture('en');
        f.ui.open('general_feedback'); english.ui.open('general_feedback');
        assert.equal(f.window.feedbackMenuLabel(language), menu);
        assert.equal(f.element('feedbackTitle').textContent, menu);
        for (const id of ['feedbackNoteLabel', 'feedbackEmailLabel', 'feedbackEmailHelp']) {
            assert.ok(f.element(id).textContent);
            if (language !== 'en') assert.notEqual(f.element(id).textContent, english.element(id).textContent);
        }
        f.ui.close(); f.ui.open('issue'); f.setFail(true); f.ui.choose('wrong_word'); await flush();
        const categoryError = f.element('feedbackError').textContent;
        assert.ok(categoryError); assert.doesNotMatch(categoryError, /\bOK\b/);
        if (language !== 'en') assert.doesNotMatch(categoryError, /Could not save/);
        f.ui.choose('other'); f.element('feedbackNote').value = 'Preserve this text'; await f.submit();
        const saveError = f.element('feedbackError').textContent;
        assert.match(saveError, /\bOK\b/); assert.notEqual(saveError, categoryError);
        if (language !== 'en') assert.doesNotMatch(saveError, /Could not save/);
        f.setFail(false); f.setResponseCode('session_limit'); await f.submit();
        const sessionError = f.element('feedbackError').textContent;
        assert.match(sessionError, /500/); assert.notEqual(sessionError, saveError);
        if (language !== 'en') assert.doesNotMatch(sessionError, /This translation session/);
        assert.equal(f.element('feedbackNote').value, 'Preserve this text');
        assert.equal(f.element('feedbackOverlay').classList.contains('open'), true);
        f.ui.close(); f.ui.open('general_feedback');
        f.element('feedbackNote').value = 'Email validation';
        f.element('feedbackEmail').valid = false; await f.submit();
        const invalidEmail = f.element('feedbackError').textContent;
        assert.ok(invalidEmail); assert.notEqual(invalidEmail, saveError);
        if (language !== 'en') assert.doesNotMatch(invalidEmail, /Please enter/);
        f.element('feedbackEmail').valid = true; f.setResponseCode('invalid_email'); await f.submit();
        assert.equal(f.element('feedbackError').textContent, invalidEmail);
    });
}
