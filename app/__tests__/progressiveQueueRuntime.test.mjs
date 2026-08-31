import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const indexSource = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const deliverySource = readFileSync(new URL('../public/listenerDelivery.js', import.meta.url), 'utf8');
const queueStart = indexSource.indexOf('        const progressiveQueue = {');
const queueEnd = indexSource.indexOf('        /**\n         * Initialize AudioContext', queueStart);
const progressiveQueueSource = indexSource.slice(queueStart, queueEnd);

// Facts the real playServerAudio resolves with (index.html html_audio path).
const PLAYBACK_FACTS = {
    playbackEngine: 'html_audio',
    effectivePlaybackRate: 1.15,
    preservesPitch: true,
    decoderDurationMs: 5750,
};

const loadQueue = ({
    boundedScheduler,
    earlyCatchup = false,
    t2Shadow = false,
    t2Apply = false,
    deferPlaybackStart = false,
}) => {
    const storageData = new Map();
    const dropped = [];
    const received = [];
    const played = [];
    const policyCalls = [];
    const playStarts = [];
    const completions = [];
    const earlyCatchupResets = [];
    const earlyCatchupCalls = [];
    const supersessionShadow = [];
    const superseded = [];
    const playbackRequests = [];
    const context = {
        console: { log() {}, warn() {}, error() {} },
        localStorage: {
            getItem: key => storageData.get(key) || null,
            setItem: (key, value) => storageData.set(key, value),
        },
    };
    context.window = context;
    vm.runInNewContext(deliverySource, context);

    context.boundedScheduler = boundedScheduler;
    context.dropped = dropped;
    context.received = received;
    context.played = played;
    context.policyCalls = policyCalls;
    context.playStarts = playStarts;
    context.completions = completions;
    context.playbackFacts = PLAYBACK_FACTS;
    context.earlyCatchupFlag = earlyCatchup;
    context.earlyCatchupResets = earlyCatchupResets;
    context.earlyCatchupCalls = earlyCatchupCalls;
    context.t2ShadowFlag = t2Shadow;
    context.supersessionShadow = supersessionShadow;
    context.t2ApplyFlag = t2Apply;
    context.superseded = superseded;
    context.deferPlaybackStartFlag = deferPlaybackStart;
    context.playbackRequests = playbackRequests;
    const script = `
        (() => {
            const listenerDelivery = window.BarnabaListenerDelivery;
            let language = 'pl';
            let listenerPlaybackPolicyV2Enabled = false;
            let listenerBoundedSchedulerEnabled = boundedScheduler;
            let listenerCatchupChunkAgeMs = 10000;
            let listenerBacklogBudgetMs = 15000;
            const telemetry = { plays: [] };
            const qaReplayCapture = null;
            const playbackPolicy = { choose: (queueDepth, ageMs) => { policyCalls.push({ queueDepth, ageMs }); return 1.0; } };
            let listenerEarlyCatchupEnabled = earlyCatchupFlag;
            let fqfT2SupersessionShadowEnabled = t2ShadowFlag;
            let fqfT2SupersessionApplyEnabled = t2ApplyFlag;
            const earlyCatchup = {
                reset: () => earlyCatchupResets.push(true),
                choose: (queueDepth, ageMs) => { earlyCatchupCalls.push({ queueDepth, ageMs }); return { rate: 1.25, active: true }; },
            };
            const playServerAudio = (
                audio, rate, onPlaybackStarted, onPlaybackStarting = () => {},
                isPlaybackCancelled = () => false,
            ) => {
                if (deferPlaybackStartFlag) {
                    return new Promise((resolve, reject) => playbackRequests.push({
                        start: () => {
                            if (isPlaybackCancelled()) {
                                const error = new Error('cancelled');
                                error.name = 'AbortError';
                                reject(error);
                                return;
                            }
                            onPlaybackStarting(true);
                            onPlaybackStarted();
                            resolve(playbackFacts);
                        },
                    }));
                }
                onPlaybackStarting(true);
                onPlaybackStarted();
                return Promise.resolve(playbackFacts);
            };
            const _telemetryRecordReceived = chunk => received.push(chunk);
            const _telemetryRecordPendingDrop = (chunk, reason) => dropped.push({ chunk, reason });
            const _telemetryRecordSupersessionShadow = (candidate, incoming, queueDepth) =>
                supersessionShadow.push({ candidate, incoming, queueDepth });
            const _telemetryRecordSuperseded = (candidate, incoming, queueDepth) =>
                superseded.push({ candidate, incoming, queueDepth });
            const _telemetryRecordSkipped = () => {};
            const _telemetryRecordPlayStart = (sentenceIndex, receivedAt, playbackRate, audioCapturedAtSrv, releaseSeq, sourceHash, chunk, queueDepthAtPlayStart, earlyCatchupActive) => {
                played.push(releaseSeq);
                playStarts.push({ releaseSeq, queueDepthAtPlayStart, playbackRate, earlyCatchupActive });
                return { playStartAt: Date.now(), playbackRate: 1.0 };
            };
            const _telemetryRecordCompleted = (chunk, playRecord, facts) => completions.push({ releaseSeq: chunk.release_seq, facts });
            const _telemetryRecordPlaybackError = () => {};
            ${progressiveQueueSource}
            return progressiveQueue;
        })()
    `;
    return {
        queue: vm.runInNewContext(script, context),
        dropped,
        received,
        played,
        policyCalls,
        playStarts,
        completions,
        earlyCatchupResets,
        earlyCatchupCalls,
        supersessionShadow,
        superseded,
        playbackRequests,
    };
};

const chunk = (releaseSeq, emissionId, sessionEpoch = 'epoch-1') => ({
    type: 'tts_chunk',
    session_epoch: sessionEpoch,
    release_seq: releaseSeq,
    language: 'pl',
    sentence_index: 0,
    total_sentences: 1,
    emissionId,
    audioBase64: 'audio',
    is_last: true,
    chunk_word_count: 4,
});

const settlePlayback = () => new Promise(resolve => setTimeout(resolve, 0));

describe('real progressiveQueue runtime', () => {
    it('preserves unique pending chunks across emission changes in the bounded arm', () => {
        const { queue, dropped, received } = loadQueue({ boundedScheduler: true });
        queue.playing = true;

        queue.addChunk(chunk(93, 1));
        queue.addChunk(chunk(94, 2));

        expect(queue.pending.size).toBe(2);
        expect(received).toHaveLength(2);
        expect(dropped).toHaveLength(0);
    });

    it('observes a pending older generation without removing it in T2 shadow', () => {
        const { queue, supersessionShadow } = loadQueue({ boundedScheduler: true, t2Shadow: true });
        queue.playing = true;
        const older = {
            ...chunk(93, 1), revision_family_id: 'family-a', revision_generation: 1,
            revision_apply_eligible: true,
        };
        const newer = {
            ...chunk(94, 2), revision_family_id: 'family-a', revision_generation: 2,
            revision_apply_eligible: true,
        };

        queue.addChunk(older);
        queue.addChunk(newer);
        queue.addChunk({ ...newer, sentence_index: 1, is_last: true });

        expect(queue.pending.size).toBe(3);
        expect(supersessionShadow).toHaveLength(1);
        expect(supersessionShadow[0]).toMatchObject({
            candidate: { release_seq: 93, revision_generation: 1 },
            incoming: { release_seq: 94, revision_generation: 2 },
            queueDepth: 1,
        });
    });

    it('does not observe a chunk that already left pending for playback', () => {
        const { queue, supersessionShadow } = loadQueue({ boundedScheduler: true, t2Shadow: true });
        queue.addChunk({
            ...chunk(93, 1), revision_family_id: 'family-a', revision_generation: 1,
        });
        expect(queue.playing).toBe(true);

        queue.addChunk({
            ...chunk(94, 2), revision_family_id: 'family-a', revision_generation: 2,
        });

        expect(supersessionShadow).toHaveLength(0);
    });

    it('removes a whole pending older generation in T2 apply', () => {
        const { queue, supersessionShadow, superseded } = loadQueue({
            boundedScheduler: true, t2Shadow: true, t2Apply: true,
        });
        queue.playing = true;
        const older = {
            ...chunk(93, 1), revision_family_id: 'family-a', revision_generation: 1,
            revision_apply_eligible: true,
        };
        const newer = {
            ...chunk(94, 2), revision_family_id: 'family-a', revision_generation: 2,
            revision_apply_eligible: true,
        };

        queue.addChunk(older);
        queue.addChunk(newer);

        expect(queue.pending.size).toBe(1);
        expect([...queue.pending.values()]).toEqual(expect.arrayContaining([
            expect.objectContaining({ release_seq: 94, revision_generation: 2 }),
        ]));
        expect(supersessionShadow).toHaveLength(1);
        expect(superseded).toHaveLength(1);
        expect(superseded[0]).toMatchObject({
            candidate: { release_seq: 93, revision_generation: 1 },
            incoming: { release_seq: 94, revision_generation: 2 },
            queueDepth: 1,
        });
    });

    it('reports lexical-only supersession in shadow but never applies it', () => {
        const { queue, supersessionShadow, superseded } = loadQueue({
            boundedScheduler: true, t2Shadow: true, t2Apply: true,
        });
        queue.playing = true;
        queue.addChunk({
            ...chunk(93, 1), revision_family_id: 'family-a', revision_generation: 1,
            revision_evidence: 'lexical_shadow_only', revision_apply_eligible: false,
        });
        queue.addChunk({
            ...chunk(94, 2), revision_family_id: 'family-a', revision_generation: 2,
            revision_evidence: 'lexical_shadow_only', revision_apply_eligible: false,
        });

        expect(queue.pending.size).toBe(2);
        expect(supersessionShadow).toHaveLength(1);
        expect(superseded).toHaveLength(0);
    });

    it('never supersedes a chunk that already left pending for playback', () => {
        const { queue, superseded } = loadQueue({ boundedScheduler: true, t2Apply: true });
        queue.addChunk({
            ...chunk(93, 1), revision_family_id: 'family-a', revision_generation: 1,
        });
        expect(queue.playing).toBe(true);

        queue.addChunk({
            ...chunk(94, 2), revision_family_id: 'family-a', revision_generation: 2,
        });

        expect(superseded).toHaveLength(0);
    });

    it('supersedes a dequeued generation while playback has not started yet', async () => {
        const { queue, superseded, played, playbackRequests } = loadQueue({
            boundedScheduler: true,
            t2Apply: true,
            deferPlaybackStart: true,
        });
        queue.addChunk({
            ...chunk(93, 1), revision_family_id: 'family-a', revision_generation: 1,
            revision_apply_eligible: true,
        });
        expect(queue.startingPlayback?.chunk.release_seq).toBe(93);
        expect(queue.lastPlayedKey).toBeNull();

        queue.addChunk({
            ...chunk(94, 2), revision_family_id: 'family-a', revision_generation: 2,
            revision_apply_eligible: true,
        });
        expect(superseded).toHaveLength(1);
        expect(queue.startingPlayback?.cancelled).toBe(true);

        playbackRequests[0].start();
        await settlePlayback();
        expect(played).toEqual([]);
        expect(queue.lastPlayedKey).toBeNull();
        expect(queue.pending.size).toBe(0);
        expect(queue.startingPlayback?.chunk.release_seq).toBe(94);
    });

    it('keeps T2 shadow completely silent when its flag is off', () => {
        const { queue, supersessionShadow } = loadQueue({ boundedScheduler: true, t2Shadow: false });
        queue.playing = true;
        queue.addChunk({
            ...chunk(93, 1), revision_family_id: 'family-a', revision_generation: 1,
        });
        queue.addChunk({
            ...chunk(94, 2), revision_family_id: 'family-a', revision_generation: 2,
        });

        expect(queue.pending.size).toBe(2);
        expect(supersessionShadow).toHaveLength(0);
    });

    it('drops a late bounded arrival after a newer chunk has been consumed', async () => {
        const { queue, dropped, played } = loadQueue({ boundedScheduler: true });
        queue.addChunk(chunk(94, 2));
        await settlePlayback();

        queue.addChunk(chunk(93, 1));

        expect(played).toEqual([94]);
        expect(queue.lastPlayedKey).toMatchObject({ releaseKey: 94, sentenceIndex: 0 });
        expect(queue.pending.size).toBe(0);
        expect(dropped).toHaveLength(1);
        expect(dropped[0]).toMatchObject({ reason: 'late_arrival' });
        expect(dropped[0].chunk.release_seq).toBe(93);
    });

    it('accepts a new server epoch even when its release sequence restarts lower', async () => {
        const { queue, dropped, played } = loadQueue({ boundedScheduler: true });
        queue.addChunk(chunk(94, 2, 'epoch-1'));
        await settlePlayback();
        queue.addChunk(chunk(1, 1, 'epoch-2'));
        await settlePlayback();

        expect(played).toEqual([94, 1]);
        expect(dropped).toHaveLength(0);
        expect(queue.lastPlayedKey).toMatchObject({ releaseKey: 1, sentenceIndex: 0 });
    });

    it('keeps D0 behavior unchanged while instrumenting the legacy replacement', () => {
        const { queue, dropped } = loadQueue({ boundedScheduler: false });
        queue.playing = true;

        queue.addChunk(chunk(93, 1));
        queue.addChunk(chunk(94, 2));

        expect(queue.pending.size).toBe(1);
        expect(dropped).toHaveLength(1);
        expect(dropped[0].reason).toBe('superseded_emission');
    });

    it('records the queue depth the playback policy actually saw', async () => {
        // Beacon snapshots sample every ~10 s, so they cannot distinguish "q>=4 never
        // happened" from "q>=4 was never sampled". The ledger value must therefore be the
        // policy's own input, not a later re-read of pending.
        const { queue, policyCalls, playStarts } = loadQueue({ boundedScheduler: true });
        queue.playing = true;
        queue.addChunk(chunk(90, 1));
        queue.addChunk(chunk(91, 2));
        queue.addChunk(chunk(92, 3));
        expect(queue.pending.size).toBe(3);

        queue.playing = false;
        queue._tryPlayNext();
        await settlePlayback();

        expect(policyCalls[0].queueDepth).toBe(2);   // the played chunk already left pending
        expect(playStarts[0]).toMatchObject({ releaseSeq: 90, queueDepthAtPlayStart: 2 });
        expect(playStarts[0].queueDepthAtPlayStart).toBe(policyCalls[0].queueDepth);
    });

    it('hands the playback facts to the persistent ledger, not only to the QA capture', async () => {
        // The WebAudio fallback forces 1.0x while the requested rate still reads 1.25x.
        // If these facts stop reaching _telemetryRecordCompleted, the gate goes blind to it.
        const { queue, completions } = loadQueue({ boundedScheduler: true });
        queue.addChunk(chunk(95, 4));
        await settlePlayback();

        expect(completions).toHaveLength(1);
        expect(completions[0].facts).toMatchObject({
            playbackEngine: 'html_audio',
            effectivePlaybackRate: 1.15,
            preservesPitch: true,
            decoderDurationMs: 5750,
        });
    });

    it('leaves the rate to the ladder when Early Catch-up is off', async () => {
        // The OFF arm of the A/B must be today's code path: the automaton is not merely
        // configured to return 1.0, it is never consulted at all.
        const { queue, policyCalls, earlyCatchupCalls, playStarts } =
            loadQueue({ boundedScheduler: true, earlyCatchup: false });
        queue.addChunk(chunk(10, 1));
        await settlePlayback();

        expect(earlyCatchupCalls).toHaveLength(0);
        expect(policyCalls).toHaveLength(1);
        expect(playStarts[0]).toMatchObject({ playbackRate: 1.0, earlyCatchupActive: false });
    });

    it('hands the rate to the automaton when Early Catch-up is on', async () => {
        const { queue, policyCalls, earlyCatchupCalls, playStarts } =
            loadQueue({ boundedScheduler: true, earlyCatchup: true });
        queue.addChunk(chunk(10, 1));
        await settlePlayback();

        expect(earlyCatchupCalls).toHaveLength(1);
        // The ladder is consulted by the automaton itself below its entry threshold, never by
        // the queue directly — otherwise two owners would be setting the rate.
        expect(policyCalls).toHaveLength(0);
        expect(playStarts[0]).toMatchObject({ playbackRate: 1.25, earlyCatchupActive: true });
    });

    it('resets the automaton when the server epoch changes', async () => {
        // Real runtime, not a source grep: carrying ACTIVE into a new broadcaster session
        // would accelerate chunks that have no backlog behind them.
        const { queue, earlyCatchupResets } = loadQueue({ boundedScheduler: true, earlyCatchup: true });
        queue.addChunk(chunk(10, 1, 'epoch-1'));
        await settlePlayback();
        const before = earlyCatchupResets.length;

        queue.addChunk(chunk(1, 2, 'epoch-2'));
        await settlePlayback();

        expect(earlyCatchupResets.length).toBeGreaterThan(before);
    });

    it('has no uninstrumented pending clear outside the reset helper', () => {
        expect(progressiveQueueSource.match(/pending\.clear\(\)/g)).toHaveLength(1);
        const reset = progressiveQueueSource.slice(
            progressiveQueueSource.indexOf('_reset('),
            progressiveQueueSource.indexOf('resetForNewEpoch'),
        );
        expect(reset).toContain('this._dropAllPending(dropReason)');
        expect(reset).toContain('this.pending.clear()');
    });
});
