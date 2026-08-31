import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const serverSource = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const telemetryContractSource = readFileSync(new URL('../listenerTelemetryContract.js', import.meta.url), 'utf8');

/**
 * P0.1 (17.07) — server.js wiring of LISTENER_DEADLINE_REVIEW_FIXES_ENABLED.
 *
 * SAFETY NET, NOT THE GATE. The real gate is the behavioral suite in
 * deadlineProvisional.test.mjs (baseline vectors + supersedeDecisionFor routing).
 * These assertions only prove the flag is threaded through server.js the way the spec
 * requires — they cannot prove runtime behavior, because server.js calls
 * server.listen() at top level with no import guard (:6340), so it cannot be imported
 * and exercised. Extracting the supersede block into a testable unit is deliberately
 * OUT of P0.1's scope (11.07 lesson: never bundle a refactor with a behavior change).
 * The known gap is described in the module docstring.
 *
 * Why this matters: DEV is pinned to the baseline image (listening review 4.52). Earlier, the
 * review-fix findings rode on provisionalEnabled itself, so a rebuild from master
 * with the 4.52 env reproduced the alternative arm (listening review 3.6). The whole point of the
 * flag is that master + 4.52 env == pinned baseline behaviour.
 */
describe('P0.1 — review-fixes flag wiring in server.js', () => {
  it('defines reviewFixesEnabled as its own opt-in env flag (default OFF)', () => {
    expect(serverSource).toContain(
      "reviewFixesEnabled: process.env.LISTENER_DEADLINE_REVIEW_FIXES_ENABLED === 'true'"
    );
  });

  it('routes supersede through the dispatcher, never a bare algorithm', () => {
    // Importing an arm directly would bypass the one place the flag decides semantics.
    expect(serverSource).toContain('supersedeDecisionFor');
    expect(serverSource).not.toMatch(/import\s*{[^}]*\bsupersedeDecision\b\s*[,}]/);
    expect(serverSource).not.toContain('supersedeDecisionBaseline(');
    expect(serverSource).not.toContain('supersedeDecisionReviewFixes(');
  });

  it('passes the config flag into the dispatcher', () => {
    const call = serverSource.slice(
      serverSource.indexOf('supersedeDecisionFor({'),
      serverSource.indexOf('supersedeDecisionFor({') + 600
    );
    expect(call).toContain('reviewFixes');
    // Both arms' inputs are handed over; each reads only what it needs.
    expect(call).toContain('ledger:');
    expect(call).toContain('emittedNorm:');
  });

  it('never lets reviewFixesEnabled replace provisionalEnabled (both stay explicit)', () => {
    // The queued-ledger write is the one site where a missing provisionalEnabled would
    // silently re-arm the review-fixes behavior under the 4.52 config.
    expect(serverSource).toContain(
      'config.deadlineFallback.provisionalEnabled && config.deadlineFallback.reviewFixesEnabled'
    );
  });

  it('gates the queued-point ledger write on reviewFixes (4.52 writes it at emit time)', () => {
    const queuedBlock = serverSource.slice(
      serverSource.indexOf('config.deadlineFallback.provisionalEnabled && config.deadlineFallback.reviewFixesEnabled'),
      serverSource.indexOf('fbLedger.lastDeadlineEmitAt = nowLedger;')
    );
    expect(queuedBlock).toContain("options.origin === 'deadline_fallback'");
    expect(queuedBlock).toContain('fbLedger.emittedSourceNorm = [...');
  });

  it('restores the 4.52 emit-time ledger append behind !reviewFixes', () => {
    expect(serverSource).toContain('if (!config.deadlineFallback.reviewFixesEnabled) {');
    const emitBlock = serverSource.slice(
      serverSource.indexOf('if (!config.deadlineFallback.reviewFixesEnabled) {'),
      serverSource.indexOf('fb.lastFallbackText = payload.text;')
    );
    // 4.52 appends the PAYLOAD text, filters the ledger by TTL, and pushes an entry
    // carrying `superseded: false` — the per-entry state the cumulative arm lacks.
    expect(emitBlock).toContain('dpNormWords(payload.text)');
    expect(emitBlock).toContain('superseded: false');
    expect(emitBlock).toContain('supersedeTtlMs');
  });

  it('keeps the whole-span stale-clear reviewFixes-only (4.52 expires per entry)', () => {
    // lastDeadlineEmitAt does not exist in the pinned baseline at all; if this clear ran under the
    // 4.52 config it would wipe a span the baseline arm still needs.
    const supBlock = serverSource.slice(
      serverSource.indexOf('const reviewFixes = config.deadlineFallback.reviewFixesEnabled;'),
      serverSource.indexOf('const hasBaselineToMatch')
    );
    expect(supBlock).toContain('if (reviewFixes) {');
    expect(supBlock).toContain('fbSup.lastDeadlineEmitAt');
  });

  it('wipes deadlineLedger only under reviewFixes (4.52 lets it age out by TTL)', () => {
    // Structural, not textual: one clear lives inside the `if (reviewFixes) {` stale-clear
    // block (asserted above) and is legitimately un-prefixed; the span-end clears must carry
    // their own inline guard. A flat regex over the file cannot tell those apart.
    const spanEnd = serverSource.slice(
      serverSource.indexOf('const hasBaselineToMatch'),
      serverSource.indexOf('// ---- End of refined A2.7 supersede ----') > -1
        ? serverSource.indexOf('// ---- End of refined A2.7 supersede ----')
        : serverSource.indexOf('const hasBaselineToMatch') + 3000
    );
    const clears = [...spanEnd.matchAll(/fbSup\.deadlineLedger = \[\];/g)];
    const guarded = [...spanEnd.matchAll(/if \(reviewFixes\) fbSup\.deadlineLedger = \[\];/g)];
    expect(clears.length).toBeGreaterThan(0);
    expect(guarded.length).toBe(clears.length);
  });

  it('marks the winning ledger entry superseded (baseline-only per-entry state)', () => {
    expect(serverSource).toContain('if (decision.entry) decision.entry.superseded = true;');
  });

  it('leaves finding #6 telemetry whitelist ungated (equivalence = user-observable)', () => {
    // Deliberate deviation from byte-equality with the pinned baseline: the whitelist changes what the
    // server RECORDS from beacons, not what a listener hears. Gating it would drop
    // superseded_emission from metrics under the 4.52 config for zero audible benefit.
    expect(serverSource).toContain("from './listenerTelemetryContract.js'");
    expect(telemetryContractSource).toContain("'superseded_emission'");
    expect(telemetryContractSource).not.toContain('reviewFixesEnabled');
  });
});

/**
 * Finding #6 is exempt from the P0.1 flag ONLY because it is observation-only: the drop
 * reasons it admits reach evalLog (a JSONL file) and nothing else. This contract pins that
 * premise. If someone later feeds dropped_by_reason into listenerMetric / the live-quality
 * state, finding #6 silently becomes a BEHAVIOR change under the 4.52 config - the autopilot
 * can apply a text_only profile (server.js `liveQualityAutopilot.applyEnabled`) - and it would
 * ship without the A/B such a change requires.
 *
 * Verified at the time of writing: the handler builds `listenerMetric` from queueDepth /
 * audibleDrift / realSilence / last_release_seq_played / chunkAgeAtPlay only, hands THAT to
 * recordLiveQualityMetric, and passes droppedByReason to evalLog separately. The three
 * recordLiveQualityFromEvalEntry call sites are TTS/translation, never listener_telemetry.
 */
describe('finding #6 — telemetry stays observation-only (autopilot contract)', () => {
  const handler = serverSource.slice(
    serverSource.indexOf("app.post('/api/listener-telemetry'"),
    serverSource.indexOf("app.post('/api/listener-telemetry'") + 6000
  );

  it('locates the telemetry handler and its live-quality call', () => {
    // Anti-vacuous: every assertion below is a `not.toContain` over this slice, which would
    // pass trivially if the slice were empty or wrong.
    expect(handler).toContain('const listenerMetric = {');
    expect(handler).toContain('recordLiveQualityMetric(churchId, listenerMetric)');
    expect(handler).toContain('allowedDropReasons');
  });

  it('keeps drop reasons out of listenerMetric (the autopilot input)', () => {
    const listenerMetric = handler.slice(
      handler.indexOf('const listenerMetric = {'),
      handler.indexOf('recordLiveQualityMetric(churchId, listenerMetric)')
    );
    expect(listenerMetric).not.toContain('dropped');
    expect(listenerMetric).not.toContain('Dropped');
    expect(listenerMetric).not.toContain('allowedDropReasons');
  });

  it('feeds the live-quality state only via the curated listenerMetric', () => {
    // A second, unfiltered live-quality call in this handler would be the loophole.
    expect([...handler.matchAll(/recordLiveQuality\w*\(/g)].map(m => m[0]))
      .toEqual(['recordLiveQualityMetric(']);
    expect(handler).not.toContain('recordLiveQualityFromEvalEntry');
  });
});
