"""Expiring owner-authorized DEV experiment, never a permanent quality receipt."""
import asyncio
from datetime import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import threading
import time

import numpy as np

from rep_retry_budget import RetryDeadline, RetrySkipped
from rep_retry_pcm import ParentDecodeKey
from rep_shadow import coordinate_space_id

# Target coordinates are CONFIGURATION, not code.
#
# They used to be literals here: a subscription id, a container app name and a
# resource group. That put a map of one deployment into a file that is published,
# and it also meant the authorised target could never be anything else.
#
# There is deliberately no built-in default. With the three variables below unset,
# authorized_experiment() returns None and the experiment stays CLOSED - the safe
# direction for a switch that lets a live DEV run mutate production behaviour.
_TARGET_KEYS = (
    "REP_DEV_ALLOWED_SUBSCRIPTION",
    "REP_DEV_ALLOWED_CONTAINER_APP",
    "REP_DEV_ALLOWED_RESOURCE_GROUP",
)
_active = None


def _allowed_target(environ):
    """The configured target, or None when it is not fully configured."""
    values = tuple((environ.get(key) or "").strip() for key in _TARGET_KEYS)
    return values if all(values) else None


class DevExperiment:
    def __init__(self, test_id, expires_at, *, clock=time.time):
        self.test_id, self.expires_at, self.clock = test_id, expires_at, clock
        self.headroom_ms = None
        self.budget_ms = 2000
        self.remaining = 32
        self.sessions = set()
        self._lock = threading.Lock()

    def require_active(self):
        if self.clock() >= self.expires_at:
            raise RetrySkipped("dev_experiment_expired")
        if self.headroom_ms is None:
            raise RetrySkipped("dev_preflight_not_passed")

    def claim(self, session_id):
        with self._lock:
            self.require_active()
            # A single isolated broadcaster, with at most three sequential clips.
            if session_id not in self.sessions and len(self.sessions) >= 3:
                raise RetrySkipped("dev_session_limit")
            if self.remaining <= 0:
                raise RetrySkipped("dev_attempt_limit")
            self.sessions.add(session_id)
            self.remaining -= 1


def authorized_experiment(environ, now=None):
    if environ.get("ASR_REP_DEV_OWNER_AUTHORIZED") != "pre_adjudication_one_run":
        return None
    allowed = _allowed_target(environ)
    if allowed is None:
        # Not configured means no authorised target exists, which is not a mismatch
        # to report but an experiment that is simply closed.
        return None
    allowed_subscription, allowed_container_app, allowed_resource_group = allowed
    if (environ.get("REP_DEV_SUBSCRIPTION") != allowed_subscription
            or environ.get("CONTAINER_APP_NAME") != allowed_container_app
            or environ.get("REP_DEV_RESOURCE_GROUP") != allowed_resource_group
            or environ.get("ASR_REP_EXPORT_OPTIMIZATION_ENABLED") != "true"):
        raise RuntimeError("DEV experiment target mismatch")
    test_id = environ.get("REP_DEV_TEST_ID", "")
    if not test_id.startswith("rep-live-") or len(test_id) > 80:
        raise RuntimeError("DEV experiment ID invalid")
    now = time.time() if now is None else now
    expires = datetime.fromisoformat(environ["REP_DEV_EXPIRES_UTC"])
    if expires.tzinfo is None or not 0 < expires.timestamp() - now <= 1800:
        raise RuntimeError("DEV experiment expiry invalid")
    return DevExperiment(test_id, expires.timestamp())


def current_experiment():
    return _active


async def preflight(pipe, executor, run_pipeline, build_kwargs, emit,
                    root=Path("/app/rep-r0"), output=Path("/tmp/rep-live-preflight.json")):
    global _active
    _active = None
    experiment = authorized_experiment(os.environ)
    if experiment is None:
        return
    manifest = json.loads((root / "manifest.json").read_text())
    pcm = (root / "p010.f32").read_bytes()
    if hashlib.sha256(pcm).hexdigest() != manifest["pcm_sha256"]:
        raise RuntimeError("DEV fixture hash mismatch")
    audio = np.frombuffer(pcm, dtype=np.float32)
    report = {"schema": "rep-live-preflight/1", "test_id": experiment.test_id,
              "human_gate": "PENDING_FINAL_LISTENING", "model_instances": 1,
              "fixture_sha256": manifest["pcm_sha256"], "pairs": [], "checks": {}}
    started = time.monotonic()

    def decode(samples, quality=False):
        tick = time.monotonic()
        result = run_pipeline(pipe, samples, build_kwargs(), use_chunking=False,
                              capture_quality=quality)
        return result, (time.monotonic() - tick) * 1000

    async def normal(samples, quality=False):
        return await asyncio.wrap_future(executor.submit_normal(lambda: decode(samples, quality)))

    def fingerprint(value):
        return hashlib.sha256(json.dumps([value["text"], value["chunks"]],
                                        sort_keys=True, default=str).encode()).hexdigest()

    try:
        await normal(audio[:80000])
        for offset, length in ((0, 80000), (80000, 160000), (240000, 80000), (320000, 160000)):
            if time.monotonic() - started > 90:
                raise RuntimeError("DEV preflight wall bound")
            samples = audio[offset:offset + length].copy()
            baseline, base_ms = await normal(samples)
            candidate, retry_ms = await normal(samples, True)
            quality = candidate.get("rep_quality") or {}
            report["pairs"].append({"samples": length, "baseline_ms": base_ms,
                "retry_ms": retry_ms, "same_text_and_chunks": fingerprint(baseline) == fingerprint(candidate),
                "quality_measured": quality.get("validated_measurement") is True,
                "avg_logprob": quality.get("avg_logprob")})
        headroom = max(row["retry_ms"] for row in report["pairs"]) * 1.3 + 100
        if not math.isfinite(headroom) or headroom >= 2600:
            raise RuntimeError("DEV headroom not within reserve")
        experiment.budget_ms = 2000 if headroom < 1800 else 2800
        # Two normal submissions occupy accounting before retry admission.
        hold = threading.Event()
        busy = executor.submit_normal(lambda: hold.wait(3))
        parent = ParentDecodeKey("dev-preflight", coordinate_space_id("dev-preflight"), 1)
        try:
            executor.submit_retry(parent, RetryDeadline.start(total_ms=experiment.budget_ms),
                                  lambda: None, measured_headroom_ms=headroom)
            report["checks"]["normal_admission_priority"] = False
        except RetrySkipped as exc:
            report["checks"]["normal_admission_priority"] = exc.reason == "normal_work_pending"
        finally:
            hold.set()
            await asyncio.wrap_future(busy)
        # Real GPU contention: a normal call arrives after the retry starts.
        entered = threading.Event()
        def retry_work():
            entered.set()
            return decode(audio[80000:240000].copy(), True)
        retry = executor.submit_retry(parent, RetryDeadline.start(total_ms=experiment.budget_ms),
                                      retry_work, measured_headroom_ms=headroom)
        await asyncio.to_thread(entered.wait, 3)
        collision_started = time.monotonic()
        normal_value, normal_ms = await normal(audio[:80000].copy())
        collision_e2e = (time.monotonic() - collision_started) * 1000
        retry_value, retry_ms = await asyncio.wrap_future(retry)
        report["contention"] = {"normal_ms": normal_ms, "normal_e2e_ms": collision_e2e,
            "retry_ms": retry_ms, "normal_extra_ms": collision_e2e - report["pairs"][0]["baseline_ms"]}
        repeated_normal, _ = await normal(audio[:80000].copy())
        repeated_retry, _ = await normal(audio[80000:240000].copy())
        report["checks"].update(
            export_equivalence=all(row["same_text_and_chunks"] for row in report["pairs"]),
            quality_measured=all(row["quality_measured"] for row in report["pairs"]),
            normal_contention_bounded=report["contention"]["normal_extra_ms"] < 700,
            retry_contention_bounded=retry_ms < experiment.budget_ms - 100,
            contention_outputs_unchanged=(fingerprint(normal_value) == fingerprint(repeated_normal)
                                         and fingerprint(retry_value) == fingerprint(repeated_retry)))
        if all(report["checks"].values()):
            experiment.headroom_ms = max(headroom, retry_ms * 1.3 + 100)
            if experiment.headroom_ms >= experiment.budget_ms - 100:
                experiment.budget_ms = 2800
            experiment.require_active()
            if experiment.headroom_ms >= 2700:
                raise RuntimeError("Contention headroom exceeds reserve")
            _active = experiment
        report["verdict"] = "PASS" if _active is experiment else "FAIL"
    except Exception as error:
        report.update(verdict="FAIL", error_type=type(error).__name__, error=str(error)[:160])
    finally:
        report.update(headroom_ms=experiment.headroom_ms, budget_ms=experiment.budget_ms,
                      elapsed_seconds=time.monotonic() - started)
        output.write_text(json.dumps(report, indent=2), encoding="utf-8")
        emit({"event": "rep_dev_preflight", **report, "policy_applied": False})
    return report  # Failed preflight leaves normal translation and original retention available.
