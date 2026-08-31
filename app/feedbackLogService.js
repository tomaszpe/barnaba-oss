/**
 * Persist listener instant-feedback reports as JSONL on the existing /app/logs mount.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const feedbackLogDir = path.join(__dirname, 'logs');
const ALLOWED_REASONS = new Set(['wrong_word', 'long_pause', 'translation_lag', 'other']);
const MAX_NOTE_LENGTH = 500;

function cleanRequiredString(value, field, maxLength = 128) {
    if (typeof value !== 'string') throw new Error(`${field} is required`);
    const cleaned = value.trim();
    if (!cleaned || cleaned.length > maxLength) throw new Error(`${field} is invalid`);
    return cleaned;
}

function normalizeFeedback(input = {}) {
    const reason = cleanRequiredString(input.reason, 'reason', 40);
    if (!ALLOWED_REASONS.has(reason)) throw new Error('reason is invalid');

    const record = {
        ts: new Date().toISOString(),
        sessionId: cleanRequiredString(input.sessionId, 'sessionId'),
        churchId: cleanRequiredString(input.churchId, 'churchId'),
        lang: cleanRequiredString(input.lang, 'lang', 12),
        reason,
    };

    if (input.note !== undefined && input.note !== null && input.note !== '') {
        if (typeof input.note !== 'string') throw new Error('note is invalid');
        record.note = input.note.trim().slice(0, MAX_NOTE_LENGTH);
        if (!record.note) delete record.note;
    }
    return record;
}

async function appendFeedback(input, { logDir = feedbackLogDir, now = new Date() } = {}) {
    const record = normalizeFeedback(input);
    record.ts = now.toISOString();
    const date = record.ts.slice(0, 10);
    await fs.mkdir(logDir, { recursive: true });
    await fs.appendFile(path.join(logDir, `feedback-${date}.jsonl`), `${JSON.stringify(record)}\n`, 'utf8');
    return record;
}

function getFeedbackLogDir() {
    return feedbackLogDir;
}

export { ALLOWED_REASONS, MAX_NOTE_LENGTH, appendFeedback, getFeedbackLogDir, normalizeFeedback };
