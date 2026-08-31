import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';

describe('evalLogService queue', () => {
    beforeEach(() => {
        vi.resetModules();
        process.env.EVAL_LOGGING_ENABLED = 'true';
        process.env.EVAL_LOG_QUEUE_MAX = '2';
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
        vi.spyOn(fs, 'appendFile').mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        delete process.env.EVAL_LOGGING_ENABLED;
        delete process.env.EVAL_LOG_QUEUE_MAX;
    });

    it('queues records and drains them in FIFO order', async () => {
        const { evalLog, flushEvalLog, getEvalLogDir, getEvalLogStats, isEvalLoggingEnabled } = await import('../evalLogService.js');

        expect(isEvalLoggingEnabled()).toBe(true);
        expect(path.isAbsolute(getEvalLogDir())).toBe(true);
        expect(evalLog({ stage: 'first', churchId: 'c1' })).toBe(true);
        expect(evalLog({ stage: 'second', churchId: 'c1' })).toBe(true);

        const stats = await flushEvalLog();
        expect(stats).toMatchObject({ enqueued: 2, written: 2, dropped: 0, queueDepth: 0 });

        const writes = fs.appendFile.mock.calls.map(call => JSON.parse(call[1].trim()));
        expect(writes.map(item => item.stage)).toEqual(['first', 'second']);
        expect(writes[0].seq).toBeLessThan(writes[1].seq);
        expect(getEvalLogStats().maxObservedQueue).toBeGreaterThan(0);
    });

    it('drops records when the queue is full', async () => {
        fs.appendFile.mockImplementation(() => new Promise(() => {}));
        const { evalLog, getEvalLogStats } = await import('../evalLogService.js');

        expect(evalLog({ stage: 'one' })).toBe(true);
        expect(evalLog({ stage: 'two' })).toBe(true);
        expect(evalLog({ stage: 'three' })).toBe(false);

        expect(getEvalLogStats()).toMatchObject({
            enqueued: 2,
            dropped: 1,
            queueDepth: 2,
            maxQueueDepth: 2,
        });
    });
});

describe('evalLogService disabled path', () => {
    it('is a no-op when EVAL_LOGGING_ENABLED is unset', async () => {
        vi.resetModules();
        delete process.env.EVAL_LOGGING_ENABLED;
        const appendSpy = vi.spyOn(fs, 'appendFile').mockResolvedValue(undefined);

        const mod = await import('../evalLogService.js');
        expect(mod.isEvalLoggingEnabled()).toBe(false);
        expect(mod.evalLog({ stage: 'disabled' })).toBe(false);
        await mod.flushEvalLog();
        expect(appendSpy).not.toHaveBeenCalled();

        vi.restoreAllMocks();
    });
});
