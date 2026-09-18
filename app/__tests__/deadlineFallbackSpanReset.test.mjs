// A confirmed Whisper response closes the cached partial span, so a stale partial cannot be
// replayed by every later deadline fallback (in a ten-minute run it used to repeat once a minute).
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { gatewayHarness, normWords } from './helpers/deadlineFallbackHarness.mjs';

const stale = 'Es ist witzig zu schauen, oder? Aber der letzte Satz geht mir.';
const fresh = 'Gott schenkt uns heute neue Hoffnung.';
const other = 'Heute lesen wir gemeinsam aus dem Evangelium.';
const confirmed = text => ({ confirmed: text, hasNew: true });
const texts = h => h.deliveries.map(delivery => delivery.text);

test('actual confirmed ingress and ten-minute deadline sequence', async () => {
    const h = gatewayHarness();
    await h.receive({ partial: stale });
    await h.fire(7000);
    for (let minute = 1; minute <= 10; minute++) {
        await h.receive(confirmed(fresh), minute * 60000);
        await h.flush();
        await h.fire(minute * 60000 + 7000);
    }
    const repeats = texts(h).filter(text => text.includes('der letzte Satz geht mir')).length - 1;
    assert.equal(repeats, 0);
    assert.equal(texts(h).filter(text => text.includes(fresh)).length, 10);
});

test('completed old deadline still suppresses its delayed confirmed copy', async () => {
    const h = gatewayHarness();
    await h.receive({ partial: fresh });
    const dispatch = h.holdDispatch();
    const pending = h.fire(7000);
    await h.receive(confirmed(fresh), 8000);
    dispatch.resolve();
    assert.equal(await pending, true);
    assert.equal(h.fb.deadlineLedger.length, 1);
    await h.flush();
    assert.deepEqual(texts(h), [fresh]);
});

test('confirmed prefix plus tentative tail keeps original next-response scheduling', async () => {
    const h = gatewayHarness();
    await h.receive({ ...confirmed(fresh), partial: other, stable: fresh }, 1000);
    assert.equal(h.fb.latestPartial, '');
    await h.flush();
    await h.receive({ partial: other }, 2000);
    await h.fire(9000);
    assert.deepEqual(texts(h), [fresh, other]);
});

test('overlapping partial on confirmed response is not newly scheduled', async () => {
    const h = gatewayHarness();
    await h.receive({ ...confirmed(`${fresh} ${other}`), partial: other, stable: fresh }, 1000);
    await h.flush();
    assert.equal(await h.fire(9000), false);
    assert.deepEqual(texts(h), [`${fresh} ${other}`]);
});

test('no subsequent partial update means no new tentative-tail scheduling', async () => {
    const h = gatewayHarness();
    await h.receive({ ...confirmed(fresh), partial: other }, 1000);
    await h.flush();
    assert.equal(await h.fire(9000), false);
    assert.deepEqual(texts(h), [fresh]);
    // Scope limit: this cache repair does not add a new path for same-response tails.
});

test('closing a span retains buffered confirmed text and removes all cached metadata', async () => {
    const h = gatewayHarness();
    await h.receive({ partial: stale, stable: stale, partialProvenance: { decodeId: 1 }, stableProvenance: { decodeId: 1 } });
    await h.receive(confirmed(fresh), 1000);
    assert.equal(h.fb.latestPartial, '');
    assert.equal(h.fb.latestStable, '');
    for (const key of ['latestPartialAt', 'latestPartialProvenance', 'latestStableProvenance', 'latestLatencyTxId']) {
        assert.equal(h.fb[key], null, key);
    }
    assert.equal(h.fb.fallbackSpanVersion, 1);
    assert.equal(await h.fire(8000), false);
    await h.flush();
    assert.deepEqual(texts(h), [fresh]);
});

test('late completion keeps per-entry history without touching newer-span state', async () => {
    const h = gatewayHarness();
    await h.receive({ partial: stale });
    const dispatch = h.holdDispatch();
    const pending = h.fire(7000);
    await h.receive(confirmed(other), 8000);
    await h.flush();
    await h.receive({ partial: fresh }, 9000);
    const before = JSON.stringify({ ...h.fb, deadlineLedger: [] });
    dispatch.resolve();
    assert.equal(await pending, true);
    assert.equal(JSON.stringify({ ...h.fb, deadlineLedger: [] }), before);
    assert.equal(h.fb.deadlineLedger[0].text, stale);
    assert.equal(await h.fire(16000), true);
    assert.equal(texts(h).at(-1), fresh);
});

for (const suffix of ['', ` ${other}`]) {
    test(`same-span update during await preserves accepted prefix (${suffix ? 'extension' : 'identical'})`, async () => {
        const h = gatewayHarness();
        await h.receive({ partial: fresh });
        const dispatch = h.holdDispatch();
        const pending = h.fire(7000);
        await h.receive({ partial: fresh + suffix }, 8000);
        dispatch.resolve();
        await pending;
        assert.equal(await h.fire(16000), Boolean(suffix));
        assert.deepEqual(texts(h), suffix ? [fresh, other] : [fresh]);
    });
}

for (const origin of ['smooth_release', 'smooth_timeout', 'pause_flush', 'holdn_final_flush', 'disconnect_drain']) {
    test(`${origin} cannot reset a newer partial's consumed prefix`, async () => {
        const h = gatewayHarness();
        await h.receive(confirmed(other), 1000);
        await h.receive({ partial: fresh }, 2000);
        await h.fire(9000);
        await h.release(other, origin);
        assert.deepEqual(Array.from(h.fb.emittedSourceNorm), normWords(fresh));
        assert.equal(await h.fire(17000), false);
    });
}

test('superseded-final early return leaves a newer consumed partial closed', async () => {
    const h = gatewayHarness();
    await h.receive({ partial: stale });
    await h.fire(7000);
    await h.receive(confirmed(stale), 8000);
    await h.flush();
    await h.receive({ partial: fresh }, 9000);
    await h.fire(16000);
    await h.release(fresh);
    assert.equal(await h.fire(24000), false);
    assert.deepEqual(texts(h), [stale, fresh]);
});

test('real partial fallback still operates and does not close the cached span', async () => {
    const h = gatewayHarness({ partialFallback: { timeoutMs: 1000 } });
    await h.receive({ partial: fresh }, 2000);
    assert.deepEqual(texts(h), [fresh]);
    assert.equal(h.deliveries[0].origin, 'partial_fallback');
    assert.equal(h.fb.latestPartial, fresh);
    assert.equal(h.fb.fallbackSpanVersion, 0);
});

test('ordinary partial fallback still permits a different partial and its new tail', async () => {
    const h = gatewayHarness({ partialFallback: { timeoutMs: 10000 } });
    await h.receive({ partial: stale });
    await h.fire(7000);
    await h.receive({ partial: fresh }, 18000);
    assert.equal(h.deliveries.at(-1).origin, 'partial_fallback');
    await h.receive({ partial: `${fresh} ${other}` }, 20000);
    assert.equal(await h.fire(27000), true);
    assert.deepEqual(texts(h), [stale, fresh, `${fresh} ${other}`]);
    // Downstream deduplication is unchanged; there is no new partial ledger.
});

test('real pause-flush path preserves confirmed text after retiring stale cache', async () => {
    const h = gatewayHarness();
    await h.receive({ partial: stale });
    await h.receive(confirmed(fresh), 1000);
    await h.receive({ isSpeech: false }, 2000);
    await h.receive({ isSpeech: false }, 4000);
    assert.deepEqual(texts(h), [fresh]);
    assert.equal(h.deliveries[0].origin, 'pause_flush');
    assert.equal(await h.fire(12000), false);
});

test('repeated words in a later cycle remain eligible without timestamps', async () => {
    const h = gatewayHarness();
    await h.receive({ partial: fresh });
    await h.fire(7000);
    await h.receive(confirmed(other), 60000);
    await h.flush();
    await h.receive({ partial: fresh }, 61000);
    await h.fire(68000);
    assert.deepEqual(texts(h), [fresh, other, fresh]);
});

test('rejected downstream operation does not write a success ledger', async () => {
    const h = gatewayHarness();
    await h.receive({ partial: fresh });
    const dispatch = h.holdDispatch();
    const pending = h.fire(7000);
    dispatch.reject(new Error('offline_dispatch_failure'));
    await assert.rejects(pending, /offline_dispatch_failure/);
    assert.equal(h.fb.deadlineLedger.length, 0);
    assert.equal(h.fb.emittedSourceNorm.length, 0);
});

for (const deadlineFallback of [{ reviewFixesEnabled: true }, { provisionalEnabled: false }]) {
    test(`other feature arm is unchanged ${JSON.stringify(deadlineFallback)}`, async () => {
        const h = gatewayHarness({ deadlineFallback });
        await h.receive({ partial: stale });
        await h.receive(confirmed(fresh), 1000);
        assert.equal(h.fb.latestPartial, stale);
        assert.equal(h.fb.fallbackSpanVersion || 0, 0);
        await h.flush();
        assert.deepEqual(texts(h), [fresh]);
    });
}
