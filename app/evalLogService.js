/**
 * Eval JSONL logging service.
 *
 * Writes are queued and serialized so the live pipeline does not block on disk I/O,
 * while shutdown can explicitly drain pending records.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const evalLoggingEnabled = process.env.EVAL_LOGGING_ENABLED === 'true';
const evalLogDir = path.join(__dirname, 'logs');
const maxQueueDepth = Math.max(1, Number.parseInt(process.env.EVAL_LOG_QUEUE_MAX || '5000', 10) || 5000);

let sequence = 0;
let processing = false;
let dirReady = false;
let dirPromise = null;
const queue = [];
const stats = {
    enqueued: 0,
    written: 0,
    dropped: 0,
    failed: 0,
    maxObservedQueue: 0,
};

function evalLog(entry) {
    if (!evalLoggingEnabled) return false;

    if (queue.length >= maxQueueDepth) {
        stats.dropped++;
        return false;
    }

    const date = new Date().toISOString().slice(0, 10);
    const logFile = path.join(evalLogDir, `eval-${date}.jsonl`);
    const line = JSON.stringify({
        ts: new Date().toISOString(),
        seq: ++sequence,
        ...entry,
    }) + '\n';

    queue.push({ logFile, line });
    stats.enqueued++;
    if (queue.length > stats.maxObservedQueue) {
        stats.maxObservedQueue = queue.length;
    }

    void processQueue();
    return true;
}

async function ensureLogDir() {
    if (dirReady) return;
    if (!dirPromise) {
        dirPromise = fs.mkdir(evalLogDir, { recursive: true })
            .then(() => {
                dirReady = true;
            })
            .catch((err) => {
                dirPromise = null;
                throw err;
            });
    }
    await dirPromise;
}

async function processQueue() {
    if (!evalLoggingEnabled || processing) return;
    processing = true;
    try {
        await ensureLogDir();
        while (queue.length > 0) {
            const item = queue.shift();
            try {
                await fs.appendFile(item.logFile, item.line, 'utf8');
                stats.written++;
            } catch (err) {
                stats.failed++;
                stats.dropped++;
                console.error('[EvalLog] Write error:', err.message);
            }
        }
    } catch (err) {
        stats.failed++;
        stats.dropped += queue.length;
        queue.length = 0;
        console.error('[EvalLog] Queue error:', err.message);
    } finally {
        processing = false;
        if (queue.length > 0) {
            void processQueue();
        }
    }
}

async function flushEvalLog() {
    if (!evalLoggingEnabled) return getEvalLogStats();
    while (processing || queue.length > 0) {
        await processQueue();
        if (processing) {
            await new Promise(resolve => setTimeout(resolve, 5));
        }
    }
    return getEvalLogStats();
}

function getEvalLogDir() {
    return evalLogDir;
}

function getEvalLogStats() {
    return {
        enabled: evalLoggingEnabled,
        queueDepth: queue.length,
        maxQueueDepth,
        ...stats,
    };
}

function isEvalLoggingEnabled() {
    return evalLoggingEnabled;
}

if (evalLoggingEnabled) {
    console.log(`[EvalLog] Evaluation logging ENABLED -> ${evalLogDir}/eval-*.jsonl`);
}

export {
    evalLog,
    flushEvalLog,
    getEvalLogDir,
    getEvalLogStats,
    isEvalLoggingEnabled,
};
