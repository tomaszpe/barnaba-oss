"""Session-bound E4/E5 coordinator before LocalAgreement and listener release."""
import os
import time

from provenance import align_text_to_spans
from rep_retry_budget import RetryDeadline, RetrySkipped
from rep_retry_acceptance import load_acceptance
from rep_dev_experiment import current_experiment
from rep_retry_pcm import ParentPcmLeases
from rep_retry_policy import (
    choose_region,
    compose_replacement,
    project_parent_spans,
    validate_replacement,
)
from rep_retry_selection import select_single_retry


class RepRetrySession:
    def __init__(self, session_id, *, max_snapshot_samples, mode="off", budget_ms=2000,
                 quality_gate=False, measured_headroom_ms=None):
        if mode not in ("off", "shadow", "apply"):
            raise ValueError("Unknown REP retry mode")
        RetryDeadline.start(total_ms=budget_ms)
        self.mode, self.budget_ms = mode, budget_ms
        self.quality_gate = quality_gate is True
        self.measured_headroom_ms = measured_headroom_ms
        self.closed = False
        self.experiment = None
        self.leases = ParentPcmLeases(session_id, max_bytes=max_snapshot_samples * 4,
                                      max_leases=1)

    @classmethod
    def from_env(cls, session_id, *, max_snapshot_samples, runtime_contract=None):
        accepted, headroom, reason = load_acceptance(
            os.getenv("ASR_REP_RETRY_ACCEPTANCE_PATH"), runtime_contract)
        instance = cls(session_id, max_snapshot_samples=max_snapshot_samples,
                   mode=os.getenv("ASR_REP_RETRY_MODE", "off"),
                   budget_ms=int(os.getenv("ASR_REP_RETRY_BUDGET_MS", "2000")),
                   quality_gate=accepted, measured_headroom_ms=headroom)
        instance.acceptance_reason = reason
        experiment = current_experiment()
        if not accepted and experiment is not None:
            instance.experiment = experiment
            instance.measured_headroom_ms = experiment.headroom_ms
            instance.budget_ms = experiment.budget_ms
            instance.acceptance_reason = "owner_authorized_dev_final_human_gate_pending"
        return instance

    def close(self):
        self.closed = True
        self.leases.close()

    async def consider(self, original, *, snapshot, pcm_sha256, decode_id, observer,
                       committed_end_sample, executor, decode, emit, session_current):
        if self.mode == "off":
            return original, None
        deadline = RetryDeadline.start(total_ms=self.budget_ms)
        lease = None
        event = {"event": "rep_retry_decision", "schema_version": 1, "stage": "asr_retry_selection",
                 "coordinate_space_id": observer.coordinate_space_id,
                 "parent_decode_id": decode_id, "retry_decode_id": f"{decode_id}:retry:1",
                 "budget_ms": self.budget_ms, "policy_applied": False,
                 "emitted_text_changed": False, "mode": self.mode}
        if self.experiment is not None:
            event.update(experiment_id=self.experiment.test_id,
                         human_gate="PENDING_FINAL_LISTENING", experimental=True)
        try:
            if self.closed or not session_current():
                raise RetrySkipped("session_closed")
            spans = project_parent_spans(original["text"], original["chunks"], snapshot)
            events = observer.preview_candidates(original["text"], spans, decode_id=decode_id)
            region = choose_region(original["text"], original["chunks"], snapshot,
                                   events, committed_end_sample)
            event["eligible"] = True
            if self.measured_headroom_ms is None:
                raise RetrySkipped("headroom_unproven")
            if self.experiment is not None:
                self.experiment.claim(self.leases.session_id)
            lease = self.leases.retain(snapshot, parent_decode_id=decode_id,
                                       parent_pcm_sha256=pcm_sha256, expires_at=deadline.expires_at)
            retry = self.leases.slice_absolute(lease, region.start_sample, region.end_sample)
            event.update(input_start_sample=retry.start_sample, input_end_sample=retry.end_sample,
                         input_pcm_sha256=retry.pcm_sha256, parent_pcm_sha256=pcm_sha256)

            def work():
                if self.closed or not session_current():
                    raise RetrySkipped("session_closed")
                return decode(retry.audio())

            def validate(candidate):
                if self.closed or not session_current():
                    return False
                return validate_replacement(original, candidate, region)

            outcome = await select_single_retry(original, parent=lease.parent, deadline=deadline,
                executor=executor, decode=work, validate=validate,
                measured_headroom_ms=self.measured_headroom_ms)
            event["reason"] = outcome.reason
            event["candidate_validated"] = outcome.applied
            if not outcome.applied:
                return original, event
            if self.closed or not session_current():
                event["reason"] = "session_closed"
                return original, event
            if self.experiment is not None:
                self.experiment.require_active()
            if self.mode != "apply" or not (self.quality_gate or self.experiment is not None):
                event["reason"] = "shadow_validated" if self.mode == "shadow" else "quality_gate_unproven"
                return original, event
            replacement = compose_replacement(original, outcome.value, region, snapshot.start_sample)
            if not align_text_to_spans(replacement["text"], replacement["chunks"], snapshot.start_sample,
                                       input_end_sample=snapshot.end_sample).is_exact:
                raise RetrySkipped("composite_alignment_unproven")
            deadline.require_remaining()
            event.update(policy_applied=True, emitted_text_changed=True, reason="validated_within_deadline")
            return replacement, event
        except RetrySkipped as skipped:
            event["reason"] = skipped.reason
            return original, event
        except Exception:
            event["reason"] = "retry_error"
            return original, event
        finally:
            if lease is not None:
                self.leases.release(lease)
            event["elapsed_ms"] = round((time.monotonic() - deadline.started_at) * 1000, 3)
            try:
                emit(event)
            except Exception:
                pass  # Telemetry cannot override an original/replacement decision.
