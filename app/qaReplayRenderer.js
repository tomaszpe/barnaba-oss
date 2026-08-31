import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_ENTRIES = 1000;
const MAX_DURATION_MS = 4 * 60 * 60 * 1000;

const finite = (value, name) => {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`${name} must be finite`);
    return number;
};

export function decodeQaChunkKey(filename) {
    try {
        const chunkKey = decodeURIComponent(path.basename(String(filename || ''), path.extname(String(filename || ''))));
        if (!chunkKey) throw new Error('empty');
        return chunkKey;
    } catch {
        const error = new Error('Invalid encoded chunk key');
        error.statusCode = 400;
        throw error;
    }
}
export function normalizeQaReplayManifest(input, availableChunkKeys) {
    if (!input || !Array.isArray(input.plays) || input.plays.length === 0) {
        throw new Error('plays must be a non-empty array');
    }
    if (input.plays.length > MAX_ENTRIES) throw new Error(`plays exceeds ${MAX_ENTRIES}`);
    const known = new Set(availableChunkKeys);
    const plays = input.plays.map((play, index) => {
        const chunkKey = String(play.chunkKey || '');
        if (!known.has(chunkKey)) throw new Error(`missing audio for ${chunkKey || `play ${index}`}`);
        const playStartAt = finite(play.playStartAt, 'playStartAt');
        const playEndAt = finite(play.playEndAt, 'playEndAt');
        if (playEndAt <= playStartAt) throw new Error('playEndAt must be after playStartAt');
        return {
            ...play,
            chunkKey,
            playStartAt,
            playEndAt,
            durationMs: playEndAt - playStartAt,
            effectivePlaybackRate: Math.min(2, Math.max(0.5, finite(play.effectivePlaybackRate ?? 1, 'effectivePlaybackRate'))),
            playbackEngine: play.playbackEngine === 'web_audio' ? 'web_audio' : 'html_audio',
            preservesPitch: play.preservesPitch !== false,
        };
    }).sort((a, b) => a.playStartAt - b.playStartAt);
    for (let index = 1; index < plays.length; index++) {
        if (plays[index].playStartAt < plays[index - 1].playEndAt) throw new Error('playback windows must not overlap');
    }
    const origin = plays[0].playStartAt;
    const end = Math.max(...plays.map(play => play.playEndAt));
    if (end - origin > MAX_DURATION_MS) throw new Error('trace duration exceeds limit');
    return { recordingId: String(input.recordingId || ''), partial: input.partial === true, plays, origin, durationMs: end - origin };
}

export function buildQaReplayReport(manifest, rawManifest = {}) {
    const requestedRates = manifest.plays.map(play => Number(play.requestedPlaybackRate)).filter(Number.isFinite);
    const effectiveRates = manifest.plays.map(play => play.effectivePlaybackRate).filter(Number.isFinite);
    const silences = manifest.plays.map((play, index) => index === 0 ? 0 : Math.max(0, play.playStartAt - manifest.plays[index - 1].playEndAt));
    const droppedByReason = {};
    for (const drop of Array.isArray(rawManifest.drops) ? rawManifest.drops : []) {
        const reason = String(drop?.reason || 'unknown').slice(0, 64);
        droppedByReason[reason] = (droppedByReason[reason] || 0) + 1;
    }
    const average = values => values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3)) : null;
    return {
        receivedAudioChunks: Number(rawManifest.receivedAudioChunks) || new Set(manifest.plays.map(play => play.chunkKey)).size,
        playedWindows: manifest.plays.length,
        incompletePlayWindows: Math.max(0, Number(rawManifest.incompletePlayWindows) || 0),
        droppedByReason,
        requestedRateAvg: average(requestedRates),
        requestedRateMax: requestedRates.length ? Math.max(...requestedRates) : null,
        effectiveRateAvg: average(effectiveRates),
        effectiveRateMax: effectiveRates.length ? Math.max(...effectiveRates) : null,
        maxAudibleSilenceMs: Math.max(...silences),
        traceDurationMs: manifest.durationMs,
        partial: manifest.partial,
    };
}
export function buildQaReplayFilter(manifest, inputPaths) {
    const filters = [];
    const labels = [];
    manifest.plays.forEach((play, index) => {
        const durationSec = (play.durationMs / 1000).toFixed(3);
        const delayMs = Math.max(0, Math.round(play.playStartAt - manifest.origin));
        const rate = play.effectivePlaybackRate.toFixed(6);
        const normalized = 'aresample=16000,aformat=sample_fmts=fltp:sample_rates=16000:channel_layouts=mono';
        const speed = play.preservesPitch
            ? `atempo=${rate}`
            : `asetrate=16000*${rate},aresample=16000`;
        filters.push(`[${index}:a]${normalized},${speed},aformat=sample_fmts=fltp:sample_rates=16000:channel_layouts=mono,atrim=duration=${durationSec},asetpts=PTS-STARTPTS,adelay=${delayMs}|${delayMs}[a${index}]`);
        labels.push(`[a${index}]`);
    });
    filters.push(`${labels.join('')}amix=inputs=${labels.length}:duration=longest:normalize=0[out]`);
    return { args: inputPaths.flatMap(file => ['-i', file]), filter: filters.join(';') };
}

export async function renderQaReplay({ manifest: rawManifest, chunks, ffmpegPath = 'ffmpeg' }) {
    const manifest = normalizeQaReplayManifest(rawManifest, chunks.keys());
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'barnaba-qa-'));
    const outputPath = path.join(tempDir, 'listener-qa-replay.mp3');
    try {
        const inputPaths = [];
        for (const [index, play] of manifest.plays.entries()) {
            const inputPath = path.join(tempDir, `chunk-${index}.mp3`);
            await writeFile(inputPath, chunks.get(play.chunkKey));
            inputPaths.push(inputPath);
        }
        const command = buildQaReplayFilter(manifest, inputPaths);
        await execFileAsync(ffmpegPath, [
            '-hide_banner', '-loglevel', 'error', '-y', ...command.args,
            '-filter_complex', command.filter, '-map', '[out]', '-ar', '16000', '-ac', '1', '-b:a', '32k', outputPath,
        ], { timeout: 120000, maxBuffer: 1024 * 1024 });
        return { outputPath, tempDir, manifest, report: buildQaReplayReport(manifest, rawManifest) };
    } catch (error) {
        await rm(tempDir, { recursive: true, force: true });
        throw error;
    }
}

export async function cleanupQaReplay(tempDir) {
    await rm(tempDir, { recursive: true, force: true });
}
