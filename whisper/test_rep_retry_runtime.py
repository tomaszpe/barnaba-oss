import asyncio
import hashlib

import numpy as np
import pytest

from rep_retry_budget import RetrySkipped
from rep_retry_executor import RetryExecutor
from rep_retry_policy import choose_region
from rep_retry_runtime import RepRetrySession
from rep_shadow import RepShadowSession
from provenance import align_text_to_spans
from ring_buffer import DecodeInputSnapshot


def fixture():
    echo = "Alpha Beta Gamma Delta Epsilon Zeta Eta Theta"
    words = ("Heute berichtet " + echo + " danach endet").split()
    original = {"text": " ".join(words), "chunks": [
        {"text": word, "timestamp": (i * .25, (i + 1) * .25)} for i, word in enumerate(words)]}
    snapshot = DecodeInputSnapshot(np.zeros(48000, dtype=np.float32), 160000, 208000)
    observer = RepShadowSession("live", mode="shadow")
    observer.classify_and_record(echo, [
        {"start_sample": i * 4000, "end_sample": (i + 1) * 4000} for i in range(8)], decode_id=1)
    candidate = {"text": "berichtet danach endet", "chunks": [
        {"text": word, "timestamp": (i * .25, (i + 1) * .25)}
        for i, word in enumerate("berichtet danach endet".split())],
        "rep_quality": {"validated_measurement": True, "avg_logprob": -.2}}
    return original, snapshot, observer, candidate


def run(mode="apply", gate=True, candidate_change=None, original_change=None,
        close=False, emit=None, headroom=100):
    original, snapshot, observer, candidate = fixture()
    if original_change:
        original_change(original)
    if candidate_change:
        candidate_change(candidate)
    runtime = RepRetrySession("live", max_snapshot_samples=48000, mode=mode,
                               quality_gate=gate, measured_headroom_ms=headroom)
    executor = RetryExecutor(max_workers=1, max_retry_parents=10)
    events, calls = [], []
    def decode(audio):
        calls.append(audio.copy())
        if close:
            runtime.close()
        return candidate
    async def invoke():
        return await runtime.consider(original, snapshot=snapshot,
            pcm_sha256=hashlib.sha256(snapshot.audio.tobytes()).hexdigest(),
            decode_id=2, observer=observer, committed_end_sample=32000,
            executor=executor, decode=decode, emit=emit or events.append,
            session_current=lambda: not runtime.closed)
    try:
        value, event = asyncio.run(invoke())
        return value, original, event, runtime, calls
    finally:
        executor.shutdown()


def test_exact_safe_composition_before_release():
    value, original, event, runtime, calls = run()
    assert value["text"] == "Heute berichtet danach endet"
    assert event["policy_applied"] is True
    assert event["parent_decode_id"] == 2 and event["retry_decode_id"] == "2:retry:1"
    assert len(calls) == 1 and len(calls[0]) == 44000
    assert runtime.leases.retained_bytes == 0
    assert original["text"].startswith("Heute berichtet Alpha")


@pytest.mark.parametrize("mode,gate,reason", [
    ("shadow", True, "shadow_validated"), ("apply", False, "quality_gate_unproven")])
def test_shadow_and_unaccepted_quality_keep_same_original(mode, gate, reason):
    value, original, event, runtime, calls = run(mode=mode, gate=gate)
    assert value is original and event["policy_applied"] is False
    assert event["reason"] == reason
    assert len(calls) == 1 and runtime.leases.retained_bytes == 0


@pytest.mark.parametrize("change", [
    lambda c: c.pop("rep_quality"),
    lambda c: c["rep_quality"].update(avg_logprob=float("nan")),
    lambda c: c["rep_quality"].update(avg_logprob=-1.1),
    lambda c: c.update(text="berichtet endet"),
    lambda c: c.update(text="berichtet danach endet zusätzlich"),
    lambda c: c["chunks"][1].update(timestamp=(.5, .5)),
    lambda c: c.update(text="berichtet Alpha Beta Gamma Delta Epsilon Zeta Eta Theta danach endet"),
])
def test_uncertain_or_content_loss_keeps_original(change):
    value, original, event, runtime, calls = run(candidate_change=change)
    assert value is original and event["reason"] == "uncertain_result"
    assert runtime.leases.retained_bytes == 0 and len(calls) == 1


def test_close_while_decoding_discards_candidate():
    value, original, event, runtime, calls = run(close=True)
    assert value is original and not event["policy_applied"]
    assert runtime.closed and runtime.leases.retained_bytes == 0


def test_missing_headroom_does_not_submit_or_retain_pcm():
    value, original, event, runtime, calls = run(headroom=None)
    assert value is original and event["reason"] == "headroom_unproven"
    assert calls == [] and runtime.leases.retained_bytes == 0


def test_invalid_timestamp_in_replaced_suffix_does_not_block_proven_candidate():
    def invalidate_replaced_suffix(original):
        original["chunks"][-1]["timestamp"] = (3.0, 3.0)

    value, original, event, runtime, calls = run(original_change=invalidate_replaced_suffix)

    assert not align_text_to_spans(
        original["text"], original["chunks"], 160_000, input_end_sample=208_000,
    ).is_exact
    assert value["text"] == "Heute berichtet danach endet"
    assert event["policy_applied"] is True
    assert len(calls) == 1 and runtime.leases.retained_bytes == 0


def test_invalid_timestamp_inside_candidate_window_remains_fail_open():
    def invalidate_candidate(original):
        original["chunks"][4]["timestamp"] = (1.0, 1.0)

    value, original, event, runtime, calls = run(original_change=invalidate_candidate)

    assert value is original
    assert event["reason"] == "no_eligible_echo"
    assert calls == [] and runtime.leases.retained_bytes == 0


def test_invalid_timestamp_in_retained_prefix_remains_fail_closed():
    def invalidate_prefix(original):
        original["chunks"][0]["timestamp"] = (0.0, 0.0)

    value, original, event, runtime, calls = run(original_change=invalidate_prefix)

    assert value is original
    assert event["reason"] == "retry_boundary_unproven"
    assert calls == [] and runtime.leases.retained_bytes == 0


def test_expiring_dev_authorization_is_not_a_permanent_quality_receipt(monkeypatch):
    from rep_dev_experiment import DevExperiment
    import rep_retry_runtime as module
    clock = [1000]
    gate = DevExperiment("rep-live-test", 1100, clock=lambda: clock[0])
    gate.headroom_ms, gate.budget_ms = 100, 2800
    monkeypatch.setattr(module, "current_experiment", lambda: gate)
    monkeypatch.setenv("ASR_REP_RETRY_MODE", "apply")
    monkeypatch.delenv("ASR_REP_RETRY_ACCEPTANCE_PATH", raising=False)
    runtime = RepRetrySession.from_env("live", max_snapshot_samples=48000)
    assert runtime.quality_gate is False and runtime.budget_ms == 2800
    original, snapshot, observer, candidate = fixture()
    executor = RetryExecutor(max_workers=1, max_retry_parents=10)
    calls = []
    def decode(audio):
        calls.append(1)
        return candidate
    async def invoke(decode_id):
        return await runtime.consider(original, snapshot=snapshot,
            pcm_sha256=hashlib.sha256(snapshot.audio.tobytes()).hexdigest(),
            decode_id=decode_id, observer=observer, committed_end_sample=32000,
            executor=executor, decode=decode, emit=lambda _: None, session_current=lambda: True)
    try:
        selected, event = asyncio.run(invoke(2))
        assert selected is not original and event["experimental"] is True
        assert event["human_gate"] == "PENDING_FINAL_LISTENING"
        clock[0] = 1100
        selected, event = asyncio.run(invoke(3))
        assert selected is original and event["reason"] == "dev_experiment_expired"
        assert calls == [1]
    finally:
        executor.shutdown()


def test_observer_failure_cannot_change_output():
    def fail(_):
        raise RuntimeError("bad logger")
    value, _, event, _, _ = run(emit=fail)
    assert value["text"] == "Heute berichtet danach endet"


def test_preview_is_read_only_and_protects_fuzzy_taint():
    original, snapshot, observer, _ = fixture()
    spans = [word.to_dict() for word in align_text_to_spans(original["text"], original["chunks"],
                                                          snapshot.start_sample).word_spans]
    before = dict(observer._ledger), observer.candidate_count, observer._event_seq
    events = observer.preview_candidates(original["text"], spans, decode_id=2)
    assert len(events) == 1 and events[0]["stage"] == "asr_decode_raw"
    assert before == (observer._ledger, observer.candidate_count, observer._event_seq)
    observer._mark_existing_taints([(0, 4000)])
    assert observer.preview_candidates(original["text"], spans, decode_id=2)[0]["fuzzy_tainted"]


def test_second_consider_for_same_parent_never_decodes_twice():
    original, snapshot, observer, candidate = fixture()
    runtime = RepRetrySession("live", max_snapshot_samples=48000, mode="shadow",
                               measured_headroom_ms=100)
    executor = RetryExecutor(max_workers=1, max_retry_parents=10)
    calls = []
    def decode(audio):
        calls.append(1)
        return candidate
    async def invoke():
        results = []
        for _ in range(2):
            results.append(await runtime.consider(original, snapshot=snapshot,
                pcm_sha256=hashlib.sha256(snapshot.audio.tobytes()).hexdigest(),
                decode_id=2, observer=observer, committed_end_sample=32000, executor=executor,
                decode=decode, emit=lambda _: None, session_current=lambda: True))
        return results
    try:
        results = asyncio.run(invoke())
        assert calls == [1]
        assert all(value is original for value, _ in results)
        assert results[1][1]["reason"] == "parent_already_attempted"
        assert runtime.leases.retained_bytes == 0
    finally:
        executor.shutdown()


@pytest.mark.parametrize("protected", ["42", "nicht", '"Zitat"'])
def test_protected_parent_never_retries(protected):
    original, snapshot, observer, _ = fixture()
    with pytest.raises(RetrySkipped, match="protected_content"):
        choose_region(original["text"] + " " + protected,
            original["chunks"] + [{"text": protected, "timestamp": (3, 3.25)}],
            DecodeInputSnapshot(np.zeros(52000, dtype=np.float32), 160000, 212000), [], 0)
