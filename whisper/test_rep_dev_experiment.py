from datetime import datetime, timezone

import pytest

from rep_dev_experiment import DevExperiment, authorized_experiment
from rep_retry_budget import RetrySkipped


# Synthetic coordinates only. The real ones are configuration now, and a test that
# pinned them would put a live deployment's identity back into the repository -
# which is exactly what moving them out was for.
ALLOWED_SUBSCRIPTION = "00000000-0000-0000-0000-000000000001"
ALLOWED_CONTAINER_APP = "example-whisper"
ALLOWED_RESOURCE_GROUP = "rg-example-dev"


def environment():
    return {"ASR_REP_DEV_OWNER_AUTHORIZED": "pre_adjudication_one_run",
            "REP_DEV_ALLOWED_SUBSCRIPTION": ALLOWED_SUBSCRIPTION,
            "REP_DEV_ALLOWED_CONTAINER_APP": ALLOWED_CONTAINER_APP,
            "REP_DEV_ALLOWED_RESOURCE_GROUP": ALLOWED_RESOURCE_GROUP,
            "REP_DEV_SUBSCRIPTION": ALLOWED_SUBSCRIPTION,
            "CONTAINER_APP_NAME": ALLOWED_CONTAINER_APP,
            "REP_DEV_RESOURCE_GROUP": ALLOWED_RESOURCE_GROUP,
            "ASR_REP_EXPORT_OPTIMIZATION_ENABLED": "true", "REP_DEV_TEST_ID": "rep-live-test",
            "REP_DEV_EXPIRES_UTC": datetime.fromtimestamp(1900, timezone.utc).isoformat()}


def test_default_closed_and_exact_dev_authorization():
    assert authorized_experiment({}, now=1000) is None
    gate = authorized_experiment(environment(), now=1000)
    assert gate.headroom_ms is None
    with pytest.raises(RetrySkipped):
        gate.require_active()


@pytest.mark.parametrize("field,value", [
    ("REP_DEV_SUBSCRIPTION", "other-subscription"), ("CONTAINER_APP_NAME", "prod"),
    ("REP_DEV_RESOURCE_GROUP", "prod"), ("ASR_REP_EXPORT_OPTIMIZATION_ENABLED", "false"),
    ("REP_DEV_TEST_ID", ""), ("REP_DEV_EXPIRES_UTC", "1970-01-01T00:30:00"),
    ("REP_DEV_EXPIRES_UTC", "1970-01-01T03:00:00+00:00"),
    ("REP_DEV_EXPIRES_UTC", "1970-01-01T00:00:00+00:00")])
def test_other_targets_or_unbounded_window_cannot_authorize(field, value):
    env = environment()
    env[field] = value
    with pytest.raises((RuntimeError, ValueError)):
        authorized_experiment(env, now=1000)


def test_expiry_preflight_session_and_attempt_limits():
    now = [1000]
    gate = DevExperiment("rep-live-test", 1100, clock=lambda: now[0])
    with pytest.raises(RetrySkipped, match="preflight"):
        gate.claim("one")
    gate.headroom_ms = 700
    for session in ("one", "two", "three"):
        gate.claim(session)
    with pytest.raises(RetrySkipped, match="session_limit"):
        gate.claim("four")
    for _ in range(29):
        gate.claim("one")
    with pytest.raises(RetrySkipped, match="attempt_limit"):
        gate.claim("one")
    now[0] = 1100
    with pytest.raises(RetrySkipped, match="expired"):
        gate.require_active()


@pytest.mark.parametrize("measured", [True, False])
def test_preflight_requires_real_quality_measurement(monkeypatch, tmp_path, measured):
    import asyncio
    import hashlib
    import json
    import time
    import numpy as np
    import rep_dev_experiment as module
    from rep_retry_executor import RetryExecutor
    env = environment()
    env["REP_DEV_EXPIRES_UTC"] = datetime.fromtimestamp(time.time()+300, timezone.utc).isoformat()
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    pcm = np.zeros(480000, dtype=np.float32).tobytes()
    (tmp_path / "p010.f32").write_bytes(pcm)
    (tmp_path / "manifest.json").write_text(json.dumps({"pcm_sha256": hashlib.sha256(pcm).hexdigest()}))
    def pipeline(_pipe, _samples, _kwargs, *, use_chunking, capture_quality):
        result = {"text": "fixture", "chunks": []}
        if capture_quality and measured:
            result["rep_quality"] = {"validated_measurement": True, "avg_logprob": -.5}
        return result
    executor = RetryExecutor(max_workers=4, max_retry_parents=10)
    try:
        result = asyncio.run(module.preflight(object(), executor, pipeline, lambda: {}, lambda _: None,
                            root=tmp_path, output=tmp_path / "report.json"))
        assert result["verdict"] == ("PASS" if measured else "FAIL")
        assert (module.current_experiment() is not None) == measured
    finally:
        executor.shutdown()
        monkeypatch.setattr(module, "_active", None)


@pytest.mark.parametrize("missing", [
    "REP_DEV_ALLOWED_SUBSCRIPTION",
    "REP_DEV_ALLOWED_CONTAINER_APP",
    "REP_DEV_ALLOWED_RESOURCE_GROUP",
])
def test_unconfigured_target_leaves_the_experiment_closed(missing):
    """No configured target is not a mismatch to report - it is a closed experiment.

    The coordinates used to be literals in the module, so "configured" was never a
    state that could be absent. Now it can be, and the safe direction for a switch
    that lets a live DEV run mutate production behaviour is closed.
    """
    env = environment()
    del env[missing]
    assert authorized_experiment(env, now=1000) is None
