import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendFeedback, normalizeFeedback } from '../feedbackLogService.js';

const tempDirs = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe('instant feedback JSONL persistence', () => {
  it('appends the allowed listener report shape to the daily file', async () => {
    const logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'barnaba-feedback-'));
    tempDirs.push(logDir);
    const now = new Date('2026-06-02T12:34:56.000Z');

    await appendFeedback({ sessionId: 'session-1', churchId: 'example-church', lang: 'pl', reason: 'wrong_word' }, { logDir, now });
    await appendFeedback({ sessionId: 'session-1', churchId: 'example-church', lang: 'pl', reason: 'other', note: '  details  ' }, { logDir, now });

    const lines = (await fs.readFile(path.join(logDir, 'feedback-2026-06-02.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    expect(lines).toEqual([
      { ts: now.toISOString(), sessionId: 'session-1', churchId: 'example-church', lang: 'pl', reason: 'wrong_word' },
      { ts: now.toISOString(), sessionId: 'session-1', churchId: 'example-church', lang: 'pl', reason: 'other', note: 'details' },
    ]);
  });

  it('rejects unknown reasons and invalid required fields', () => {
    expect(() => normalizeFeedback({ sessionId: 's', churchId: 'c', lang: 'pl', reason: 'custom' })).toThrow('reason is invalid');
    expect(() => normalizeFeedback({ churchId: 'c', lang: 'pl', reason: 'other' })).toThrow('sessionId is required');
  });

  it('limits optional notes to 500 characters', () => {
    expect(normalizeFeedback({ sessionId: 's', churchId: 'c', lang: 'en', reason: 'other', note: 'x'.repeat(800) }).note).toHaveLength(500);
  });
});
