import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const REASONS = new Set(['wrong_word', 'long_pause', 'translation_lag', 'other']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Server-configured name that separates the storage directory of each installation.
// A plain lowercase name, so it can never step outside that directory.
const ENVIRONMENT = /^[a-z0-9][a-z0-9-]{0,31}$/;

export const SESSION_REPORT_LIMIT = 500;

export class FeedbackInputError extends Error {
    constructor(field) { super(`Invalid ${field}`); this.field = field; }
}
export class FeedbackLimitError extends Error {}

function invalid(field) {
    throw new FeedbackInputError(field);
}

function text(value, field, max, required = false) {
    if (value == null && !required) return null;
    if (typeof value !== 'string' || value.length > max) invalid(field);
    const cleaned = value.trim();
    if (required && !cleaned) invalid(field);
    return cleaned || null;
}

function number(value, field, max) {
    if (value == null) return null;
    if (!Number.isFinite(value) || value < 0 || value > max) invalid(field);
    return value;
}

function diagnosticContext(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('context');
    return {
        screen: number(input.screen, 'screen', 4),
        connection: text(input.connection, 'connection', 20),
        queueDepth: number(input.queueDepth, 'queueDepth', 100000),
        playbackRate: number(input.playbackRate, 'playbackRate', 10),
        audibleDriftMs: number(input.audibleDriftMs, 'audibleDriftMs', 86400000),
        sourceCoverageLagMs: number(input.sourceCoverageLagMs, 'sourceCoverageLagMs', 86400000),
        releaseSeq: number(input.releaseSeq, 'releaseSeq', Number.MAX_SAFE_INTEGER),
        sourceHash: text(input.sourceHash, 'sourceHash', 128),
        userAgent: text(input.userAgent, 'userAgent', 512),
        displayMode: text(input.displayMode, 'displayMode', 20),
    };
}

export function normalizeFeedback(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('report');
    if (!UUID.test(input.reportId)) invalid('reportId');
    if (!['issue', 'general_feedback'].includes(input.kind)) invalid('kind');
    const general = input.kind === 'general_feedback';
    if (!general && !REASONS.has(input.reason)) invalid('reason');
    const note = text(input.note, 'note', general ? 3000 : 200);
    const email = text(input.email, 'email', 254);
    if (email && (!general || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) invalid('email');
    if (general && !note && !email) invalid('empty feedback');
    if (!general && input.reason !== 'other' && note) invalid('note');
    const occurredAt = text(input.occurredAt, 'occurredAt', 30, true);
    if (!Number.isFinite(Date.parse(occurredAt))) invalid('occurredAt');
    return {
        reportId: input.reportId.toLowerCase(),
        kind: input.kind,
        reason: general ? null : input.reason,
        note,
        email,
        occurredAt: new Date(occurredAt).toISOString(),
        sessionId: text(input.sessionId, 'sessionId', 128, true),
        churchId: text(input.churchId, 'churchId', 128, !general),
        lang: text(input.lang, 'lang', 12, !general),
        uiLang: text(input.uiLang, 'uiLang', 12),
        voice: text(input.voice, 'voice', 30),
        clientVersion: text(input.clientVersion, 'clientVersion', 100),
        context: diagnosticContext(input.context),
    };
}

const fingerprint = report => createHash('sha256').update(JSON.stringify(report)).digest('hex');

async function appendRecord(filename, record) {
    const file = await fs.open(filename, 'a', 0o600);
    try { await file.writeFile(`${JSON.stringify(record)}\n`, 'utf8'); await file.sync(); }
    finally { await file.close(); }
}

async function preserveIncompleteTail(filename, tail) {
    const directory = path.join(path.dirname(filename), 'recovery');
    await fs.mkdir(directory, { recursive: true });
    const digest = createHash('sha256').update(tail).digest('hex');
    const backup = await fs.open(path.join(directory, `${path.basename(filename)}.${digest}.partial`), 'w', 0o600);
    try { await backup.writeFile(tail); await backup.sync(); } finally { await backup.close(); }
}

async function recoverIncompleteTail(filename) {
    const contents = await fs.readFile(filename);
    if (!contents.length || contents.at(-1) === 10) return contents.toString('utf8');
    const completeLength = contents.lastIndexOf(10) + 1;
    const tail = contents.subarray(completeLength);
    let completeRecord = false;
    try { JSON.parse(tail.toString('utf8')); completeRecord = true; } catch {}
    if (!completeRecord) await preserveIncompleteTail(filename, tail);
    const file = await fs.open(filename, 'r+');
    try {
        if (completeRecord) await file.write(Buffer.from('\n'), 0, 1, contents.length);
        else await file.truncate(completeLength);
        await file.sync();
    } finally { await file.close(); }
    return completeRecord ? contents.toString('utf8') + '\n' : contents.subarray(0, completeLength).toString('utf8');
}

async function readRecords(filename) {
    const contents = await recoverIncompleteTail(filename);
    const records = contents.split('\n').filter(Boolean).map(line => JSON.parse(line));
    // A prior write may have reached the file but failed during sync.
    const file = await fs.open(filename, 'r+');
    try { await file.sync(); } finally { await file.close(); }
    return records;
}

export async function assertPersistentMount(storageRoot) {
    const mountInfo = await fs.readFile('/proc/self/mountinfo', 'utf8');
    const mounted = mountInfo.split('\n').some(line => {
        const [fields, filesystem = ''] = line.split(' - ');
        const mountPath = fields.split(' ')[4]?.replace(/\\040/g, ' ');
        return mountPath === storageRoot && /^(cifs|nfs|nfs4) /.test(filesystem);
    });
    if (!mounted) throw new Error('Feedback requires its persistent Azure Files mount');
}

export function createFeedbackStore({ storageRoot, environment, version, requireMount = true }) {
    if (typeof environment !== 'string' || !ENVIRONMENT.test(environment)) {
        throw new Error('FEEDBACK_ENVIRONMENT must be a lowercase name: letters, digits and hyphens');
    }
    if (!storageRoot || !path.isAbsolute(storageRoot)) throw new Error('An absolute feedback storage root is required');
    const directory = path.join(storageRoot, 'feedback', environment);
    const sessionFile = path.join(directory, 'sessions.jsonl');
    let index;
    let currentSession;
    let sessionCounts;
    let queue = Promise.resolve();

    async function loadIndex() {
        if (index) return;
        if (requireMount) await assertPersistentMount(storageRoot);
        await fs.mkdir(directory, { recursive: true });
        const loaded = new Map();
        const counts = new Map();
        for (const name of await fs.readdir(directory)) {
            if (!/^feedback-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue;
            for (const record of await readRecords(path.join(directory, name))) {
                if (!record || !UUID.test(record.reportId) || typeof record.payloadHash !== 'string') {
                    throw new Error('Invalid stored feedback record');
                }
                if (!loaded.has(record.reportId) && record.translationSessionId) {
                    counts.set(record.translationSessionId, (counts.get(record.translationSessionId) || 0) + 1);
                }
                loaded.set(record.reportId, { hash: record.payloadHash, receivedAt: record.receivedAt,
                    translationSessionId: record.translationSessionId });
            }
        }
        let sessions = [];
        try { sessions = await readRecords(sessionFile); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        currentSession = sessions.at(-1) || null;
        if (currentSession && (!UUID.test(currentSession.id) || typeof currentSession.active !== 'boolean')) {
            throw new Error('Invalid stored translation session');
        }
        sessionCounts = counts;
        index = loaded;
    }

    async function ensureSession(active = false) {
        await loadIndex();
        if (currentSession && (!active || currentSession.active)) return currentSession;
        const session = { id: randomUUID(), active, startedAt: new Date().toISOString() };
        await appendRecord(sessionFile, session);
        currentSession = session;
        return session;
    }

    async function persist(report) {
        await loadIndex();
        const hash = fingerprint(report);
        const existing = index.get(report.reportId);
        if (existing && existing.hash !== hash) invalid('reportId already used');
        if (existing) return { reportId: report.reportId, receivedAt: existing.receivedAt, duplicate: true };
        const session = await ensureSession();
        const count = sessionCounts.get(session.id) || 0;
        if (count >= SESSION_REPORT_LIMIT) throw new FeedbackLimitError('Translation session feedback limit reached');
        const receivedAt = new Date().toISOString();
        const record = { schemaVersion: 2, ...report, translationSessionId: session.id, receivedAt,
            environment, serverVersion: version, payloadHash: hash };
        const filename = path.join(directory, `feedback-${receivedAt.slice(0, 10)}.jsonl`);
        await appendRecord(filename, record);
        index.set(report.reportId, { hash, receivedAt, translationSessionId: session.id });
        sessionCounts.set(session.id, count + 1);
        return { reportId: report.reportId, receivedAt, duplicate: false };
    }

    function enqueue(action) {
        const result = queue.then(action).catch(error => {
            if (!(error instanceof FeedbackInputError) && !(error instanceof FeedbackLimitError)) index = null;
            throw error;
        });
        queue = result.catch(() => {});
        return result;
    }

    return {
        directory,
        save(input) {
            const report = normalizeFeedback(input);
            return enqueue(() => persist(report));
        },
        startSession() { return enqueue(() => ensureSession(true)); },
        endSession() {
            return enqueue(async () => {
                await loadIndex();
                if (!currentSession?.active) return;
                const ended = { ...currentSession, active: false, endedAt: new Date().toISOString() };
                await appendRecord(sessionFile, ended);
                currentSession = ended;
            });
        },
    };
}
