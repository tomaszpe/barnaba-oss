import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const indexSource = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

/**
 * Early Catch-up automaton.
 *
 * The REAL object is lifted out of index.html and executed in a vm, not reimplemented here:
 * a reimplementation copies the code under test and stays green on both sides of a mutation,
 * which is the lesson from 01.08 (`intraTrimTelemetry.test.mjs`). Everything the object
 * touches from the page — the rate ladder and the five config values — is stubbed, so a
 * behaviour change in the automaton is the only thing that can turn these red.
 */
const extract = (marker) => {
    const start = indexSource.indexOf(marker);
    expect(start, `no ${marker} in index.html`).toBeGreaterThan(-1);
    const end = indexSource.indexOf('\n        };', start);
    expect(end, `no terminator for ${marker}`).toBeGreaterThan(start);
    return indexSource.slice(start, end + '\n        };'.length);
};

const ENTER = 2500;
const EXIT = 1200;
const DWELL = 15000;
const RATE = 1.25;

function makeAutomaton({ cap = 1.3, rate = RATE } = {}) {
    const ladderCalls = [];
    const context = {
        listenerCatchupMaxRate: cap,
        listenerEarlyCatchupRate: rate,
        listenerEarlyCatchupEnterMs: ENTER,
        listenerEarlyCatchupExitMs: EXIT,
        listenerEarlyCatchupDwellMs: DWELL,
        // Stub of the existing ladder: records that it was consulted and returns a value the
        // automaton's own constants can never produce, so delegation is unambiguous.
        playbackPolicy: {
            currentRate: 1.0,
            choose(queueDepth, ageMs) {
                ladderCalls.push({ queueDepth, ageMs });
                this.currentRate = 1.08;
                return 1.08;
            },
        },
    };
    vm.createContext(context);
    vm.runInContext(`${extract('const earlyCatchup = {')}\nthis.earlyCatchup = earlyCatchup;`, context);
    return { automaton: context.earlyCatchup, ladderCalls, policy: context.playbackPolicy };
}

describe('Early Catch-up automaton — entry', () => {
    it('stays INACTIVE below the entry threshold and lets the ladder own the rate', () => {
        const { automaton, ladderCalls } = makeAutomaton();

        const decision = automaton.choose(0, ENTER - 1, 1_000);

        expect(decision).toEqual({ rate: 1.08, active: false });
        expect(automaton.active).toBe(false);
        // Delegation must pass the SAME inputs through, otherwise the control arm and the
        // sub-threshold band of the candidate arm stop being comparable.
        expect(ladderCalls).toEqual([{ queueDepth: 0, ageMs: ENTER - 1 }]);
    });

    it('enters at exactly the entry threshold and takes the rate over from the ladder', () => {
        const { automaton, ladderCalls } = makeAutomaton();

        const decision = automaton.choose(0, ENTER, 1_000);

        expect(decision).toEqual({ rate: RATE, active: true });
        expect(automaton.active).toBe(true);
        expect(automaton.activeSince).toBe(1_000);
        expect(ladderCalls).toEqual([]);
    });

    it('enters well before the ladder would reach 1.15x (age 6000 ms)', () => {
        // The whole point of the spec: the 0-10 s band belongs to the drop budget, so the
        // acceleration has to start inside it rather than after it.
        const { automaton } = makeAutomaton();
        expect(automaton.choose(0, 3_000, 0)).toEqual({ rate: RATE, active: true });
    });
});

describe('Early Catch-up automaton — holding and leaving', () => {
    it('holds ACTIVE while the queue is still late, however long it has been in state', () => {
        const { automaton } = makeAutomaton();
        automaton.choose(0, ENTER, 0);

        expect(automaton.choose(0, EXIT + 1, DWELL * 10)).toEqual({ rate: RATE, active: true });
        expect(automaton.active).toBe(true);
    });

    it('does NOT leave on a drained queue before the dwell time has passed', () => {
        // Dwell is counted in TIME, not chunks (decision 01.08): one quickly played chunk
        // must not be able to flip the mode back and forth.
        const { automaton } = makeAutomaton();
        automaton.choose(0, ENTER, 0);

        expect(automaton.choose(0, 0, DWELL - 1)).toEqual({ rate: RATE, active: true });
        expect(automaton.active).toBe(true);
    });

    it('leaves only when the queue is drained AND the dwell has elapsed', () => {
        const { automaton } = makeAutomaton();
        automaton.choose(0, ENTER, 0);

        expect(automaton.choose(0, EXIT - 1, DWELL)).toEqual({ rate: 1.0, active: false });
        expect(automaton.active).toBe(false);
    });

    it('zeroes the ladder rate on exit (§3.4) so it cannot inherit a step it has no rung for', () => {
        // The ladder's hysteresis knows {maxRate, 1.15, 1.08}. Leaving 1.25x — which is below
        // maxRate 1.3 — matches none of its conditions, so without this it would fall to 1.0x
        // in one step and the blind listening test would be measuring flutter, not catch-up.
        const { automaton, policy } = makeAutomaton();
        automaton.choose(0, ENTER, 0);
        policy.currentRate = 1.25;

        automaton.choose(0, EXIT - 1, DWELL);

        expect(policy.currentRate).toBe(1.0);
    });
});

describe('Early Catch-up automaton — cap and reset', () => {
    it('never exceeds listenerCatchupMaxRate even if the early rate is configured above it', () => {
        const { automaton } = makeAutomaton({ cap: 1.15, rate: 1.25 });
        expect(automaton.choose(0, ENTER, 0)).toEqual({ rate: 1.15, active: true });
    });

    it('reset() clears the state and zeroes the ladder rate', () => {
        const { automaton, policy } = makeAutomaton();
        automaton.choose(0, ENTER, 0);
        policy.currentRate = 1.25;

        automaton.reset();

        expect(automaton.active).toBe(false);
        expect(automaton.activeSince).toBe(0);
        expect(policy.currentRate).toBe(1.0);
    });

    it('after a reset the next chunk is judged on its own age, not the previous session', () => {
        // Without this a reconnect would open ACTIVE on the strength of a backlog that no
        // longer exists, accelerating audio that was never late.
        const { automaton, ladderCalls } = makeAutomaton();
        automaton.choose(0, 9_000, 0);
        automaton.reset();

        expect(automaton.choose(0, 100, 1_000)).toEqual({ rate: 1.08, active: false });
        expect(ladderCalls).toHaveLength(1);
    });

    it('reset() on an already inactive automaton does not touch the ladder rate', () => {
        // _reset() runs on every playback reset, including ones where catch-up never engaged;
        // clobbering the ladder's hysteresis there would be a behaviour change in the OFF arm.
        const { automaton, policy } = makeAutomaton();
        policy.currentRate = 1.08;

        automaton.reset();

        expect(policy.currentRate).toBe(1.08);
    });
});

describe('Early Catch-up wiring in index.html', () => {
    it('is bypassed entirely when the flag is off', () => {
        // The OFF arm must be today's code path byte for byte, so the automaton is not merely
        // configured to return 1.0 — it is never consulted.
        expect(indexSource).toContain('if (listenerEarlyCatchupEnabled) {');
        const guard = indexSource.indexOf('if (listenerEarlyCatchupEnabled) {');
        const elseBranch = indexSource.indexOf('adaptiveRate = playbackPolicy.choose(queueDepthAtPlayStart, playStartAgeMs);', guard);
        expect(elseBranch).toBeGreaterThan(guard);
    });

    it('records early_catchup_active on play_started', () => {
        // Source for `early_catchup_active_pct` (spec §5). The flag says what was ALLOWED;
        // only this says what actually ran, which is what the arm has to be described by.
        expect(indexSource).toContain('early_catchup_active: earlyCatchupActive === true,');
    });

    it('resets inside the queue reset helper', () => {
        // The server-epoch reset is asserted in the REAL runtime by
        // `progressiveQueueRuntime.test.mjs` ("resets the automaton when the server epoch
        // changes"); `_reset()` has no runtime entry point in that harness, so it is checked
        // where it lives.
        const resetBody = indexSource.slice(indexSource.indexOf('_reset(dropReason = '));
        expect(resetBody.slice(0, resetBody.indexOf('\n            },'))).toContain('earlyCatchup.reset();');
    });
});

describe('Early Catch-up config parsing', () => {
    /**
     * The server clamps allow 0 for enter/exit/dwell, so 0 is a REACHABLE configuration —
     * enter=0 means "always accelerate", dwell=0 means "no minimum time in state". Both are
     * legitimate experiment settings. `Number(x) || default` would silently replace them,
     * and the A/B would then run parameters nobody chose.
     */
    const parseConfig = (cfg) => {
        const start = indexSource.indexOf('listenerEarlyCatchupEnabled = cfg.listenerEarlyCatchup === true;');
        expect(start).toBeGreaterThan(-1);
        const end = indexSource.indexOf('updateInstantFeedbackVisibility();', start);
        expect(end).toBeGreaterThan(start);
        const snippet = indexSource.slice(start, end);

        const context = {
            cfg,
            listenerEarlyCatchupEnabled: false,
            listenerEarlyCatchupEnterMs: null,
            listenerEarlyCatchupExitMs: null,
            listenerEarlyCatchupDwellMs: null,
            listenerEarlyCatchupRate: null,
        };
        vm.createContext(context);
        vm.runInContext(`(() => { ${snippet} \n
            this.out = { listenerEarlyCatchupEnabled, listenerEarlyCatchupEnterMs,
                listenerEarlyCatchupExitMs, listenerEarlyCatchupDwellMs, listenerEarlyCatchupRate }; })()`,
            context);
        return context.out;
    };

    it('keeps a configured zero instead of substituting the default', () => {
        const parsed = parseConfig({
            listenerEarlyCatchup: true,
            listenerEarlyCatchupEnterMs: 0,
            listenerEarlyCatchupExitMs: 0,
            listenerEarlyCatchupDwellMs: 0,
            listenerEarlyCatchupRate: 1.25,
        });

        expect(parsed.listenerEarlyCatchupEnterMs).toBe(0);
        expect(parsed.listenerEarlyCatchupExitMs).toBe(0);
        expect(parsed.listenerEarlyCatchupDwellMs).toBe(0);
    });

    it('falls back to the spec defaults when a value is absent or unusable', () => {
        const parsed = parseConfig({ listenerEarlyCatchup: true });

        expect(parsed.listenerEarlyCatchupEnterMs).toBe(2500);
        expect(parsed.listenerEarlyCatchupExitMs).toBe(1200);
        expect(parsed.listenerEarlyCatchupDwellMs).toBe(15000);
        expect(parsed.listenerEarlyCatchupRate).toBe(1.25);
    });

    it('does not read null as zero', () => {
        // `Number(null) === 0`: without the explicit null check, "not configured" would arrive
        // as "configured to zero" — the same trap the telemetry sanitizer guards against.
        const parsed = parseConfig({
            listenerEarlyCatchup: true,
            listenerEarlyCatchupEnterMs: null,
            listenerEarlyCatchupDwellMs: null,
            listenerEarlyCatchupRate: null,
        });

        expect(parsed.listenerEarlyCatchupEnterMs).toBe(2500);
        expect(parsed.listenerEarlyCatchupDwellMs).toBe(15000);
        expect(parsed.listenerEarlyCatchupRate).toBe(1.25);
    });

    it('clamps the rate into the allowed band', () => {
        expect(parseConfig({ listenerEarlyCatchupRate: 9 }).listenerEarlyCatchupRate).toBe(1.5);
        expect(parseConfig({ listenerEarlyCatchupRate: 0.5 }).listenerEarlyCatchupRate).toBe(1.0);
    });
});
