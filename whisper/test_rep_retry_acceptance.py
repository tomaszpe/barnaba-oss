import hashlib
import json

import pytest

from rep_retry_acceptance import load_acceptance
from rep_retry_runtime import RepRetrySession


def receipt(tmp_path):
    # A synthetic attestation tests ONLY the loader, never real quality acceptance.
    evidence = {}
    for name in ("timing", "contention", "r1_shadow", "human_oracle"):
        file = tmp_path / (name + ".json")
        file.write_text('{"test_fixture_only": true}', encoding="utf-8")
        evidence[name] = {"file": file.name, "sha256": hashlib.sha256(file.read_bytes()).hexdigest(),
                          "verdict": "PASS"}
    evidence["human_oracle"]["kind"] = "human_adjudicated_retry_content"
    record = {"schema": "rep-retry-acceptance/1", "runtime": {"test": "fixture"},
              "evidence": evidence, "critical_content_losses": 0, "adjudicated_positive_cases": 1,
              "hard_negative_cases": 1, "max_retry_e2e_ms": 520, "admission_headroom_ms": 700,
              "max_slice_samples": 160000}
    return record


def check(tmp_path, record, runtime=None):
    file = tmp_path / "acceptance.json"
    file.write_text(json.dumps(record), encoding="utf-8")
    return load_acceptance(file, runtime or {"test": "fixture"})


def test_verified_receipt_loads_headroom(tmp_path):
    assert check(tmp_path, receipt(tmp_path)) == (True, 700, "accepted")


@pytest.mark.parametrize("change", [
    lambda r: r["evidence"]["human_oracle"].update(kind="model_agreement"),
    lambda r: r["evidence"]["timing"].update(sha256="0" * 64),
    lambda r: r["evidence"]["contention"].update(file="missing.json"),
    lambda r: r.update(critical_content_losses=1),
    lambda r: r.update(critical_content_losses=False),
    lambda r: r.update(adjudicated_positive_cases=0),
    lambda r: r.update(hard_negative_cases=0),
    lambda r: r.update(admission_headroom_ms=500),
    lambda r: r.update(admission_headroom_ms=float("nan")),
    lambda r: r.update(runtime={"test": "other"}),
    lambda r: r.update(max_slice_samples=480000),
])
def test_missing_wrong_or_unaccepted_evidence_never_enables_retry(tmp_path, change):
    record = receipt(tmp_path)
    change(record)
    accepted, headroom, reason = check(tmp_path, record)
    assert not accepted and headroom is None and reason != "accepted"


def test_flag_alone_cannot_open_apply(monkeypatch):
    monkeypatch.setenv("ASR_REP_RETRY_MODE", "apply")
    monkeypatch.delenv("ASR_REP_RETRY_ACCEPTANCE_PATH", raising=False)
    runtime = RepRetrySession.from_env("test", max_snapshot_samples=480000)
    assert runtime.mode == "apply" and runtime.quality_gate is False
    assert runtime.measured_headroom_ms is None
    assert runtime.acceptance_reason == "acceptance_missing"


def test_r0_evidence_admits_r1_shadow_without_circular_apply_gate(tmp_path):
    record = receipt(tmp_path)
    record["evidence"].pop("r1_shadow")
    assert check(tmp_path, record) == (False, 700, "r1_shadow_pending")


def test_unknown_runtime_is_not_certified(tmp_path):
    record = receipt(tmp_path)
    file = tmp_path / "receipt.json"
    file.write_text(json.dumps(record), encoding="utf-8")
    assert load_acceptance(file, None) == (False, None, "runtime_not_accepted")
