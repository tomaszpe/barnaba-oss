// N3 — per-language independent translation dispatch (TDD).
// Verifies that each language runs its full pipeline + emits as soon as ITS OWN
// translation resolves, with no barrier on the slowest language.
import { describe, it, expect, vi } from 'vitest';
import { dispatchPerLanguage } from '../translationDispatch.js';
import { TranslationProviderError } from '../translationProviderError.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Build a translate() fn with per-lang latency + outcome overrides.
function makeTranslate(spec) {
  return async (lang) => {
    await delay(spec[lang].ms);
    const o = spec[lang];
    if (o.throw) throw new Error(`boom-${lang}`);
    return {
      language: lang,
      text: o.text ?? `T-${lang}`,
      success: o.success ?? true,
      error: o.error,
      dupCounts: o.dupCounts ?? null,
      promptTokens: 11,
      cachedTokens: 7,
    };
  };
}

function makeDeps(overrides = {}) {
  return {
    postTranslationDedup: vi.fn(() => ({ action: 'emit' })),
    decideAgeBudget: vi.fn(() => ({ action: 'normal_tts', reason: 'ok', ageMs: 0, queueDepth: 0 })),
    ageBudgetConfig: {},
    commitTranslation: vi.fn(),
    trackEmission: vi.fn(),
    trackFilterAction: vi.fn(),
    evalLog: vi.fn(),
    logEmissionDecision: vi.fn(),
    logEmissionControllerDecision: vi.fn(),
    decideRuntimeEmission: vi.fn(() => null),
    commitDedupHistories: vi.fn(),
    resolveTtsTargets: vi.fn(() => ['male']),
    observeRevisionAdmission: vi.fn(),
    observeRevisionAdmission: vi.fn(),
    now: () => Date.now(),
    ...overrides,
  };
}

function baseArgs(extra = {}) {
  return {
    text: 'Quelltext',
    languages: ['pl', 'en', 'de'],
    churchId: 'c1',
    emissionId: 42,
    ttsEnabled: true,
    deps: makeDeps(),
    ...extra,
  };
}

describe('dispatchPerLanguage — independence + per-lang pipeline', () => {
  it('emits a fast language BEFORE a slow language resolves (no max-barrier)', async () => {
    let plResolvedAt = null;
    const translate = async (lang) => {
      const ms = { en: 5, de: 20, pl: 80 }[lang];
      await delay(ms);
      if (lang === 'pl') plResolvedAt = Date.now();
      return { language: lang, text: `T-${lang}`, success: true, promptTokens: 1, cachedTokens: 0 };
    };
    const emitTimes = {};
    const emitOrder = [];
    const emit = vi.fn(async ({ lang }) => { emitTimes[lang] = Date.now(); emitOrder.push(lang); });

    await dispatchPerLanguage(baseArgs({ translate, emit }));

    expect(emitOrder[0]).toBe('en');               // fastest first regardless of input order
    expect(emitTimes.en).toBeLessThan(plResolvedAt); // EN emitted while PL still pending → independent
    expect(new Set(emitOrder)).toEqual(new Set(['en', 'de', 'pl']));
  });

  it('emits each language exactly once', async () => {
    const emit = vi.fn(async () => {});
    await dispatchPerLanguage(baseArgs({
      translate: makeTranslate({ pl: { ms: 10 }, en: { ms: 5 }, de: { ms: 8 } }),
      emit,
    }));
    expect(emit).toHaveBeenCalledTimes(3);
  });

  it('logs REAL per-language latency (not a shared MAX)', async () => {
    const deps = makeDeps();
    await dispatchPerLanguage(baseArgs({
      deps,
      translate: makeTranslate({ pl: { ms: 80 }, en: { ms: 5 }, de: { ms: 8 } }),
      emit: vi.fn(async () => {}),
    }));
    const byLang = Object.fromEntries(
      deps.evalLog.mock.calls
        .map((c) => c[0])
        .filter((e) => e.stage === 'translation')
        .map((e) => [e.lang, e.latency_ms]),
    );
    expect(byLang.en).toBeLessThan(40);   // fast lang logs its own small latency
    expect(byLang.pl).toBeGreaterThan(60); // slow lang logs its own large latency
    expect(byLang.en).toBeLessThan(byLang.pl);
  });

  it('passes shared emissionId + src to every translation eval entry', async () => {
    const deps = makeDeps();
    await dispatchPerLanguage(baseArgs({
      deps,
      translate: makeTranslate({ pl: { ms: 5 }, en: { ms: 5 }, de: { ms: 5 } }),
      emit: vi.fn(async () => {}),
    }));
    const entries = deps.evalLog.mock.calls.map((c) => c[0]).filter((e) => e.stage === 'translation');
    expect(entries).toHaveLength(3);
    for (const e of entries) {
      expect(e.emissionId).toBe(42);
      expect(e.src).toBe('Quelltext');
    }
  });

  it('logs normal fallback age decisions and carries origin into runtime control', async () => {
    const deps = makeDeps();
    await dispatchPerLanguage(baseArgs({
      origin: 'partial_fallback',
      sessionEpoch: 'epoch-a',
      releaseMeta: { releaseSeq: 17, sessionEpoch: 'epoch-a' },
      deps,
      translate: makeTranslate({ pl: { ms: 1 }, en: { ms: 1 }, de: { ms: 1 } }),
      emit: vi.fn(async () => {}),
    }));

    const ageRows = deps.evalLog.mock.calls
      .map((call) => call[0])
      .filter((entry) => entry.stage === 'age_budget');
    expect(ageRows).toHaveLength(3);
    expect(ageRows[0]).toMatchObject({
      action: 'normal_tts',
      origin: 'partial_fallback',
      session_epoch: 'epoch-a',
      release_seq: 17,
    });
    expect(deps.decideRuntimeEmission).toHaveBeenCalledWith(expect.objectContaining({
      origin: 'partial_fallback',
      sessionEpoch: 'epoch-a',
      releaseSeq: 17,
    }));
  });

  it('reads the T1 ticket at accepted-output without changing emit', async () => {
    const observeRevisionAdmission = vi.fn(() => ({ shadow_decision: 'would_drop_whole' }));
    const deps = makeDeps({ observeRevisionAdmission });
    const emit = vi.fn(async () => {});
    const revisionTicket = { kind: 'single', ticketId: 'ticket-1', familyId: 'family-1', generation: 1 };

    await dispatchPerLanguage(baseArgs({
      languages: ['pl'],
      deps,
      releaseMeta: { sessionEpoch: 'epoch', releaseSeq: 1, revisionTicket },
      translate: makeTranslate({ pl: { ms: 1 } }),
      emit,
    }));

    expect(observeRevisionAdmission).toHaveBeenCalledWith({
      churchId: 'c1',
      ticket: revisionTicket,
      language: 'pl',
      emissionId: 42,
      checkpoint: 'accepted_output_pre_tts',
    });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('does not call the pre-TTS checkpoint for text-only output', async () => {
    const deps = makeDeps({
      decideAgeBudget: vi.fn(() => ({ action: 'text_only_stale', reason: 'old', ageMs: 9000, queueDepth: 2 })),
    });
    await dispatchPerLanguage(baseArgs({
      languages: ['pl'],
      deps,
      translate: makeTranslate({ pl: { ms: 1 } }),
      emit: vi.fn(async () => {}),
    }));
    expect(deps.observeRevisionAdmission).not.toHaveBeenCalled();
  });
});

describe('dispatchPerLanguage — skip paths (no emit)', () => {
  it('preserves typed provider failure in the ledger without logging provider text', async () => {
    const deps = makeDeps();
    const result = await dispatchPerLanguage(baseArgs({
      languages: ['pl'],
      releaseMeta: { releaseSeq: 17, sourceHash: 'source-hash' },
      deps,
      translate: async () => {
        throw new TranslationProviderError({
          kind: 'content_filter',
          status: 400,
          code: 'content_filter',
          filterSource: 'prompt',
          attempts: 2,
          contextMode: 'source_only',
          recoveredFromContentFilter: true,
        });
      },
      emit: vi.fn(async () => {}),
    }));

    expect(result[0]).toMatchObject({ emitted: false, skipReason: 'failed' });
    const ledger = deps.evalLog.mock.calls.map((call) => call[0]).find(
      (entry) => entry.stage === 'source_release_outcome',
    );
    expect(ledger).toMatchObject({
      block_stage: 'CONTENT_FILTER',
      failure_kind: 'content_filter',
      attempts: 2,
      context_mode: 'source_only',
      recovered_from_content_filter: true,
      filter_source: 'prompt',
      lang: 'pl',
      release_seq: 17,
      source_hash: 'source-hash',
    });
    expect(JSON.stringify(ledger)).not.toContain('Translation blocked');
  });

  it('counterfactual: age-drop does not poison T5/BCL before the same text is accepted', async () => {
    const t5History = [];
    const bclHistory = [];
    const p2History = [];
    const b4History = [];
    const seenAtEvaluation = [];
    let shouldDrop = true;
    const deps = makeDeps({
      deferDedupHistoryCommit: true,
      postTranslationDedup: vi.fn((value) => {
        seenAtEvaluation.push({ owner: 'T5', history: [...t5History] });
        return t5History.includes(value) ? { action: 'skip', reason: 'dup' } : { action: 'emit' };
      }),
      processBoundaryCommit: vi.fn(({ text: value }) => {
        seenAtEvaluation.push({ owner: 'BCL', history: [...bclHistory] });
        return { action: 'emit', changed: false, text: value, metrics: [] };
      }),
      decideAgeBudget: vi.fn(() => shouldDrop
        ? { action: 'drop_stale', reason: 'too_old', ageMs: 9000, queueDepth: 4 }
        : { action: 'normal_tts', reason: 'ok', ageMs: 0, queueDepth: 0 }),
      commitDedupHistories: vi.fn(({ t5Text: value }) => {
        if (p2History.length === 0) p2History.push('Quelltext');
        if (b4History.length === 0) b4History.push('Quelltext');
        t5History.push(value);
        bclHistory.push(value);
      }),
    });
    const args = baseArgs({
      deps,
      languages: ['pl'],
      translate: makeTranslate({ pl: { ms: 1, text: 'Ten sam przyjęty prefiks.' } }),
      emit: vi.fn(async () => {}),
    });

    const dropped = await dispatchPerLanguage(args);
    expect(dropped[0]).toMatchObject({ emitted: false, skipReason: 'drop_stale' });
    expect(t5History).toEqual([]);
    expect(bclHistory).toEqual([]);
    expect(p2History).toEqual([]);
    expect(b4History).toEqual([]);

    shouldDrop = false;
    const accepted = await dispatchPerLanguage(args);
    expect(accepted[0]).toMatchObject({ emitted: true });
    expect(seenAtEvaluation).toEqual([
      { owner: 'T5', history: [] },
      { owner: 'BCL', history: [] },
      { owner: 'T5', history: [] },
      { owner: 'BCL', history: [] },
    ]);
    expect(t5History).toEqual(['Ten sam przyjęty prefiks.']);
    expect(bclHistory).toEqual(['Ten sam przyjęty prefiks.']);
    expect(p2History).toEqual(['Quelltext']);
    expect(b4History).toEqual(['Quelltext']);
  });

  it('skips failed translations and empty text', async () => {
    const emit = vi.fn(async () => {});
    const r = await dispatchPerLanguage(baseArgs({
      translate: makeTranslate({
        pl: { ms: 5, success: false, error: 'x', text: null },
        en: { ms: 5, text: '   ' },     // whitespace-only = empty
        de: { ms: 5, text: 'T-de' },
      }),
      emit,
    }));
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0].lang).toBe('de');
    expect(r.filter((o) => o.emitted).map((o) => o.lang)).toEqual(['de']);
  });

  it('skips when T5 dedup returns skip', async () => {
    const deps = makeDeps({
      postTranslationDedup: vi.fn((text, lang) => ({ action: lang === 'pl' ? 'skip' : 'emit', reason: 'dup' })),
    });
    const emit = vi.fn(async () => {});
    await dispatchPerLanguage(baseArgs({
      deps, emit,
      translate: makeTranslate({ pl: { ms: 5 }, en: { ms: 5 }, de: { ms: 5 } }),
    }));
    const langs = emit.mock.calls.map((c) => c[0].lang).sort();
    expect(langs).toEqual(['de', 'en']);
    expect(deps.trackFilterAction).toHaveBeenCalledWith('c1', 'T5', 'skip');
  });

  it('skips + logs age_budget when decision is drop_stale', async () => {
    const deps = makeDeps({
      decideAgeBudget: vi.fn(() => ({ action: 'drop_stale', reason: 'too_old', ageMs: 9000, queueDepth: 4 })),
    });
    const emit = vi.fn(async () => {});
    await dispatchPerLanguage(baseArgs({
      deps,
      emit,
      origin: 'partial_fallback',
      sessionEpoch: 'epoch-stale',
      releaseMeta: { sessionEpoch: 'epoch-stale', releaseSeq: 29 },
      translate: makeTranslate({ pl: { ms: 5 }, en: { ms: 5 }, de: { ms: 5 } }),
    }));
    expect(emit).not.toHaveBeenCalled();
    const ab = deps.evalLog.mock.calls.map((c) => c[0]).filter((e) => e.stage === 'age_budget');
    expect(ab).toHaveLength(3);
    expect(ab[0]).toMatchObject({
      action: 'drop_stale',
      age_ms: 9000,
      queue_depth: 4,
      emissionId: 42,
      origin: 'partial_fallback',
      session_epoch: 'epoch-stale',
      release_seq: 29,
    });
    const runtime = deps.evalLog.mock.calls
      .map((c) => c[0])
      .filter((e) => e.stage === 'emission_controller_runtime');
    expect(runtime).toHaveLength(3);
    expect(runtime[0]).toMatchObject({
      runtime_action: 'not_run',
      runtime_reason: 'age_budget_drop_stale',
      runtime_evaluated: false,
      terminal_disposition: 'drop',
      origin: 'partial_fallback',
      session_epoch: 'epoch-stale',
      release_seq: 29,
    });
    expect(deps.decideRuntimeEmission).not.toHaveBeenCalled();
    expect(deps.logEmissionDecision).toHaveBeenCalledTimes(3);
    expect(deps.logEmissionDecision.mock.calls[0][0]).toMatchObject({
      decision: 'drop',
      reason: 'too_old',
      ageDecision: { action: 'drop_stale' },
      source: 'dispatch_per_language',
    });
    expect(deps.logEmissionControllerDecision).toHaveBeenCalledTimes(3);
    expect(deps.logEmissionControllerDecision.mock.calls[0][0]).toMatchObject({
      runtimeDecision: 'drop',
      signals: {
        ageMs: 9000,
        queueDepth: 4,
        ttsEnabled: true,
      },
    });
  });

  it('passes source text to quality tracking so rhetorical repetitions can be classified', async () => {
    const deps = makeDeps();
    await dispatchPerLanguage(baseArgs({
      text: 'Warum, warum, warum?',
      deps,
      translate: makeTranslate({ pl: { ms: 5 }, en: { ms: 5 }, de: { ms: 5 } }),
      emit: vi.fn(async () => {}),
    }));

    expect(deps.trackEmission).toHaveBeenCalledTimes(3);
    for (const call of deps.trackEmission.mock.calls) {
      expect(call[2]).toMatchObject({ sourceText: 'Warum, warum, warum?' });
    }
  });
});

describe('dispatchPerLanguage — emit decision', () => {
  it('commits T5/BCL histories only at the accepted emit boundary', async () => {
    const order = [];
    const deps = makeDeps({
      deferDedupHistoryCommit: true,
      commitDedupHistories: vi.fn(() => order.push('commit')),
    });
    const emit = vi.fn(async () => { order.push('emit'); });

    await dispatchPerLanguage(baseArgs({
      deps,
      languages: ['pl'],
      translate: makeTranslate({ pl: { ms: 1, text: 'Przyjęte tłumaczenie.' } }),
      emit,
    }));

    expect(order).toEqual(['commit', 'emit']);
    expect(deps.commitDedupHistories).toHaveBeenCalledWith(expect.objectContaining({
      lang: 'pl',
      t5Text: 'Przyjęte tłumaczenie.',
      bclText: 'Przyjęte tłumaczenie.',
    }));
  });

  it('does not commit or emit TTS when no active gender target remains', async () => {
    const deps = makeDeps({
      deferDedupHistoryCommit: true,
      resolveTtsTargets: vi.fn(() => []),
    });
    const emit = vi.fn(async () => {});

    const result = await dispatchPerLanguage(baseArgs({
      deps,
      languages: ['pl'],
      translate: makeTranslate({ pl: { ms: 1, text: 'Brak aktywnego celu.' } }),
      emit,
    }));

    expect(result[0]).toMatchObject({ emitted: false, skipReason: 'no_tts_targets' });
    expect(deps.commitDedupHistories).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('resolves targets for shadow independently of history commit while the flag is OFF', async () => {
    const deps = makeDeps({
      deferDedupHistoryCommit: false,
      resolveTtsTargets: vi.fn(() => []),
    });
    const emit = vi.fn(async (payload) => {
      expect(payload.ttsTargets).toEqual([]);
    });

    const result = await dispatchPerLanguage(baseArgs({
      deps,
      languages: ['pl'],
      translate: makeTranslate({ pl: { ms: 1, text: 'Stara ścieżka emisji.' } }),
      emit,
    }));

    expect(result[0]).toMatchObject({ emitted: true, decision: 'tts' });
    expect(deps.resolveTtsTargets).toHaveBeenCalledWith('pl');
    expect(deps.observeRevisionAdmission).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledOnce();
  });

  it('commits the T5 input separately from the BCL-trimmed output', async () => {
    const deps = makeDeps({
      deferDedupHistoryCommit: true,
      processBoundaryCommit: vi.fn(() => ({
        action: 'trim',
        changed: true,
        text: 'nowa treść.',
        metrics: [],
      })),
    });

    await dispatchPerLanguage(baseArgs({
      deps,
      languages: ['pl'],
      translate: makeTranslate({ pl: { ms: 1, text: 'stary prefiks nowa treść.' } }),
      emit: vi.fn(async () => {}),
    }));

    expect(deps.commitDedupHistories).toHaveBeenCalledWith(expect.objectContaining({
      lang: 'pl',
      t5Text: 'stary prefiks nowa treść.',
      bclText: 'nowa treść.',
    }));
  });

  it('applies Boundary Commit Ledger trim before commit, eval log, and emit', async () => {
    const deps = makeDeps({
      processBoundaryCommit: vi.fn(({ text: value }) => ({
        action: 'trim',
        changed: true,
        text: value.replace(/^Jezusa Chrystusa\s+/u, ''),
        metrics: [{ stage: 'boundary_commit_ledger', action: 'exact_trim', overlap_tokens: 2 }],
      })),
    });
    const emit = vi.fn(async () => {});

    await dispatchPerLanguage(baseArgs({
      deps,
      languages: ['pl'],
      translate: makeTranslate({ pl: { ms: 5, text: 'Jezusa Chrystusa widzimy teraz.' } }),
      emit,
    }));

    expect(deps.processBoundaryCommit).toHaveBeenCalledWith(expect.objectContaining({
      churchId: 'c1',
      lang: 'pl',
      text: 'Jezusa Chrystusa widzimy teraz.',
      sourceText: 'Quelltext',
      emissionId: 42,
    }));
    expect(deps.trackFilterAction).toHaveBeenCalledWith('c1', 'BCL', 'trim');
    expect(deps.commitTranslation).toHaveBeenCalledWith('c1', 'pl', 'widzimy teraz.');
    expect(emit.mock.calls[0][0].result.text).toBe('widzimy teraz.');
    const translationEntry = deps.evalLog.mock.calls.map(c => c[0]).find(e => e.stage === 'translation');
    expect(translationEntry.translation).toBe('widzimy teraz.');
    expect(deps.evalLog.mock.calls.map(c => c[0]).some(e => e.stage === 'boundary_commit_ledger')).toBe(true);
  });

  it('decision=tts when ttsEnabled and normal_tts', async () => {
    const emit = vi.fn(async () => {});
    await dispatchPerLanguage(baseArgs({
      ttsEnabled: true, emit,
      translate: makeTranslate({ pl: { ms: 5 }, en: { ms: 5 }, de: { ms: 5 } }),
    }));
    for (const c of emit.mock.calls) expect(c[0].decision).toBe('tts');
  });

  it('decision=text_only when ttsEnabled=false', async () => {
    const emit = vi.fn(async () => {});
    await dispatchPerLanguage(baseArgs({
      ttsEnabled: false, emit,
      translate: makeTranslate({ pl: { ms: 5 }, en: { ms: 5 }, de: { ms: 5 } }),
    }));
    for (const c of emit.mock.calls) expect(c[0].decision).toBe('text_only');
  });

  it('decision=text_only (textOnly flag) when age budget says text_only_stale', async () => {
    const deps = makeDeps({
      decideAgeBudget: vi.fn(() => ({ action: 'text_only_stale', reason: 'stale', ageMs: 5000, queueDepth: 2 })),
    });
    const emit = vi.fn(async () => {});
    await dispatchPerLanguage(baseArgs({
      deps, ttsEnabled: true, emit,
      translate: makeTranslate({ pl: { ms: 5 }, en: { ms: 5 }, de: { ms: 5 } }),
    }));
    for (const c of emit.mock.calls) {
      expect(c[0].decision).toBe('text_only');
      expect(c[0].textOnly).toBe(true);
    }
    expect(deps.logEmissionDecision).toHaveBeenCalledTimes(3);
    expect(deps.logEmissionDecision.mock.calls[0][0]).toMatchObject({
      decision: 'text_only',
      reason: 'stale',
      ageDecision: { action: 'text_only_stale' },
      source: 'dispatch_per_language',
    });
    expect(deps.logEmissionControllerDecision).toHaveBeenCalledTimes(3);
    expect(deps.logEmissionControllerDecision.mock.calls[0][0]).toMatchObject({
      runtimeDecision: 'text_only',
      signals: {
        ageMs: 5000,
        queueDepth: 2,
        ttsEnabled: true,
      },
    });
  });
});

describe('dispatchPerLanguage — emission modes', () => {
  it('passes quality mode for fresh TTS emissions', async () => {
    const deps = makeDeps({
      decideAgeBudget: vi.fn(() => ({ action: 'normal_tts', reason: 'fresh_enough', ageMs: 1200, queueDepth: 0 })),
    });
    const emit = vi.fn(async () => {});

    await dispatchPerLanguage(baseArgs({
      deps,
      emit,
      translate: makeTranslate({ pl: { ms: 5 }, en: { ms: 5 }, de: { ms: 5 } }),
    }));

    expect(emit.mock.calls[0][0]).toMatchObject({
      decision: 'tts',
      emissionMode: 'quality',
      emissionReason: 'fresh_enough',
    });
  });

  it('passes fast and catchup modes based on segment age', async () => {
    const fastDeps = makeDeps({
      decideAgeBudget: vi.fn(() => ({ action: 'normal_tts', reason: 'segment_getting_old', ageMs: 5000, queueDepth: 0 })),
    });
    const catchupDeps = makeDeps({
      decideAgeBudget: vi.fn(() => ({ action: 'normal_tts', reason: 'catchup_age_budget', ageMs: 9000, queueDepth: 0 })),
    });
    const fastEmit = vi.fn(async () => {});
    const catchupEmit = vi.fn(async () => {});

    await dispatchPerLanguage(baseArgs({
      deps: fastDeps,
      emit: fastEmit,
      translate: makeTranslate({ pl: { ms: 5 }, en: { ms: 5 }, de: { ms: 5 } }),
    }));
    await dispatchPerLanguage(baseArgs({
      deps: catchupDeps,
      emit: catchupEmit,
      translate: makeTranslate({ pl: { ms: 5 }, en: { ms: 5 }, de: { ms: 5 } }),
    }));

    expect(fastEmit.mock.calls[0][0].emissionMode).toBe('fast');
    expect(catchupEmit.mock.calls[0][0].emissionMode).toBe('catchup');
  });

  it('passes audio_skip mode when runtime controller skips audio', async () => {
    const deps = makeDeps({
      decideRuntimeEmission: vi.fn(() => ({ action: 'audio_skip', mode: 'audio_skip', reason: 'age_and_queue_unhealthy', ageMs: 13000, queueDepth: 4 })),
    });
    const emit = vi.fn(async () => {});

    await dispatchPerLanguage(baseArgs({
      deps,
      emit,
      ttsEnabled: true,
      translate: makeTranslate({ pl: { ms: 5 }, en: { ms: 5 }, de: { ms: 5 } }),
    }));

    expect(emit.mock.calls[0][0]).toMatchObject({
      decision: 'text_only',
      textOnly: true,
      emissionMode: 'audio_skip',
      emissionReason: 'age_and_queue_unhealthy',
    });
  });
});

describe('dispatchPerLanguage — runtime EmissionController override', () => {
  it('drops a language when runtime controller returns drop', async () => {
    const deps = makeDeps({
      deferDedupHistoryCommit: true,
      decideRuntimeEmission: vi.fn(() => ({ action: 'drop', reason: 'age_over_drop_threshold', ageMs: 21000, queueDepth: 5 })),
    });
    const emit = vi.fn(async () => {});

    const result = await dispatchPerLanguage(baseArgs({
      deps,
      emit,
      translate: makeTranslate({ pl: { ms: 5 }, en: { ms: 5 }, de: { ms: 5 } }),
    }));

    expect(emit).not.toHaveBeenCalled();
    expect(result.every((r) => r.skipReason === 'emission_controller_drop')).toBe(true);
    expect(result.every((r) => r.emissionMode === 'drop')).toBe(true);
    expect(deps.trackFilterAction).toHaveBeenCalledWith('c1', 'EMISSION_CONTROLLER', 'drop');
    expect(deps.commitDedupHistories).not.toHaveBeenCalled();
    expect(deps.logEmissionDecision.mock.calls[0][0]).toMatchObject({
      decision: 'drop',
      reason: 'age_over_drop_threshold',
      source: 'dispatch_per_language_runtime',
    });
  });

  it('uses text-only emit when runtime controller returns audio_skip', async () => {
    const deps = makeDeps({
      decideRuntimeEmission: vi.fn(() => ({ action: 'audio_skip', reason: 'age_and_queue_unhealthy', ageMs: 13000, queueDepth: 4 })),
    });
    const emit = vi.fn(async () => {});

    await dispatchPerLanguage(baseArgs({
      deps,
      emit,
      ttsEnabled: true,
      translate: makeTranslate({ pl: { ms: 5 }, en: { ms: 5 }, de: { ms: 5 } }),
    }));

    expect(emit).toHaveBeenCalledTimes(3);
    for (const call of emit.mock.calls) {
      expect(call[0]).toMatchObject({ decision: 'text_only', textOnly: true });
    }
    expect(deps.trackFilterAction).toHaveBeenCalledWith('c1', 'EMISSION_CONTROLLER', 'audio_skip');
    expect(deps.logEmissionDecision.mock.calls[0][0]).toMatchObject({
      decision: 'text_only',
      reason: 'age_and_queue_unhealthy',
    });
  });
});

describe('dispatchPerLanguage — onTranslated hook (latency_done parity)', () => {
  it('calls onTranslated once per language, before that language emits', async () => {
    const order = [];
    const emit = vi.fn(async ({ lang }) => { order.push(`emit:${lang}`); });
    const onTranslated = vi.fn((lang) => { order.push(`tr:${lang}`); });
    await dispatchPerLanguage(baseArgs({
      translate: makeTranslate({ pl: { ms: 5 }, en: { ms: 5 }, de: { ms: 5 } }),
      emit, onTranslated,
    }));
    expect(onTranslated).toHaveBeenCalledTimes(3);
    for (const lang of ['pl', 'en', 'de']) {
      expect(order.indexOf(`tr:${lang}`)).toBeGreaterThanOrEqual(0);
      expect(order.indexOf(`tr:${lang}`)).toBeLessThan(order.indexOf(`emit:${lang}`));
    }
  });

  it('fires onTranslated for skipped (failed/empty) languages too — timing stage is per-completion', async () => {
    const onTranslated = vi.fn();
    await dispatchPerLanguage(baseArgs({
      translate: makeTranslate({
        pl: { ms: 5, success: false, error: 'x', text: null },
        en: { ms: 5, text: '   ' },
        de: { ms: 5 },
      }),
      emit: vi.fn(async () => {}),
      onTranslated,
    }));
    expect(onTranslated).toHaveBeenCalledTimes(3);
  });
});
