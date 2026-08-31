"""Bounded DEV-only R0 experiment, using the already loaded service pipeline.

Runs before ASGI startup yields: no listener/session output is changed. This is
a NEW boundary experiment on the P010 recording, not a recovered historical
parent decode or an adjudicated content oracle. Never produces an APPLY gate.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
from pathlib import Path
import time

import numpy as np

from provenance import align_text_to_spans, pcm_sha256
from rep_retry_budget import RetryDeadline, RetrySkipped
from rep_retry_pcm import ParentPcmLeases
from ring_buffer import DecodeInputSnapshot


async def run_r0(pipe, executor, run_pipeline, build_kwargs, emit,
                 root=Path("/app/rep-r0"), output=Path("/tmp/rep-e4-r0.json")):
    if os.getenv("REP_E4_OPTIMIZATION_BENCHMARK_ENABLED", "false").lower() == "true":
        from rep_optimization_benchmark import run_optimization
        return await run_optimization(pipe, executor, run_pipeline, build_kwargs, emit)
    if os.getenv("REP_E4_PROFILE_ENABLED", "false").lower() == "true":
        from rep_profile_benchmark import run_profile
        return await run_profile(pipe, executor, run_pipeline, build_kwargs, emit)
    manifest = json.loads((root / "manifest.json").read_text())
    pcm_bytes = (root / "p010.f32").read_bytes()
    if hashlib.sha256(pcm_bytes).hexdigest() != manifest["pcm_sha256"]:
        raise RuntimeError("R0 fixture digest mismatch")
    if len(manifest["cases"]) > 16 or len(pcm_bytes) > 16000 * 180 * 4:
        raise RuntimeError("R0 fixture exceeds approved experiment size")
    audio = np.frombuffer(pcm_bytes, dtype=np.float32)
    origin = manifest["source_start_sample"]
    report = {
        "schema": "rep-r0/1", "condition": "new_P010_boundary_experiment",
        "original_historical_parent_reconstructed": False,
        "adjudicated_oracle": False, "apply_approved": False,
        "model_count": 1, "max_extra_ms": 2000,
        "source": manifest, "decoder_kwargs": build_kwargs(), "cases": [],
    }
    experiment_start = time.monotonic()
    loop = asyncio.get_running_loop()

    def decode(samples, start, end):
        before = time.monotonic()
        # No prompt_ids, glossary, LA/history or decoder-parameter changes.
        result = run_pipeline(pipe, samples, build_kwargs(), use_chunking=False)
        inference_ms = (time.monotonic() - before) * 1000
        alignment = align_text_to_spans(result.get("text", ""), result.get("chunks", []),
                                       start, input_end_sample=end)
        return {"text": result.get("text", ""), "chunks": result.get("chunks", []),
                "alignment": alignment.to_dict(), "inference_ms": inference_ms,
                "confidence_available": False}

    try:
        for index, case in enumerate(manifest["cases"]):
            if time.monotonic() - experiment_start > 180:
                report["aborted_reason"] = "experiment_wall_limit"
                break
            start, end = case["parent_start_sample"], case["parent_end_sample"]
            snapshot = DecodeInputSnapshot(
                audio=audio[start-origin:end-origin].copy(), start_sample=start, end_sample=end)
            parent_hash = pcm_sha256(snapshot.audio)
            parent_result = await loop.run_in_executor(executor, decode, snapshot.audio, start, end)
            deadline = RetryDeadline.start()
            leases = ParentPcmLeases("rep-r0-p010", max_bytes=len(pcm_bytes), max_leases=1)
            item = {"case_id": case["case_id"], "parent_decode_id": index,
                    "retry_decode_id": f"{index}:retry:1", "parent_pcm_sha256": parent_hash,
                    "parent_start_sample": start, "parent_end_sample": end,
                    "parent": parent_result, "retry": None, "policy_applied": False}
            try:
                lease = leases.retain(snapshot, parent_decode_id=index,
                                      parent_pcm_sha256=parent_hash, expires_at=deadline.expires_at)
                retry_slice = leases.slice_absolute(lease, case["retry_start_sample"], end)
                item.update(retry_pcm_sha256=retry_slice.pcm_sha256,
                            retry_start_sample=retry_slice.start_sample, retry_end_sample=end)
                # R0 is an isolated measurement, NOT live admission. The ordinary
                # executor path measures previously unknown headroom without faking it.
                future = executor.submit_normal(lambda: decode(
                    retry_slice.audio(), retry_slice.start_sample, end))
                try:
                    item["retry"] = await deadline.wait(future)
                    item["within_deadline"] = True
                except RetrySkipped as skipped:
                    item["within_deadline"] = False
                    item["reason"] = skipped.reason
                item["decision_ms"] = (time.monotonic() - deadline.started_at) * 1000
                # Drain only in this offline harness, never in the listener path.
                # Preserve late evidence but never label it eligible for APPLY.
                if item["retry"] is None:
                    item["late_retry"] = await asyncio.wrap_future(future)
                item["worker_total_ms"] = (time.monotonic() - deadline.started_at) * 1000
            except Exception as error:
                item["error_type"] = type(error).__name__
                item["within_deadline"] = False
            finally:
                leases.close()
            report["cases"].append(item)
            # Content remains in the explicit private report, never this cloud log.
            emit({"event": "rep_r0_case", "case_id": item["case_id"],
                  "within_deadline": item.get("within_deadline", False),
                  "decision_ms": item.get("decision_ms"),
                  "worker_total_ms": item.get("worker_total_ms"), "policy_applied": False})
            output.write_text(json.dumps(report, ensure_ascii=False), encoding="utf-8")
    finally:
        report["total_wall_seconds"] = time.monotonic() - experiment_start
        report["complete"] = len(report["cases"]) == len(manifest["cases"])
        output.write_text(json.dumps(report, ensure_ascii=False), encoding="utf-8")
        emit({"event": "rep_r0_complete", "complete": report["complete"],
              "cases": len(report["cases"]), "within_deadline": sum(
                  item.get("within_deadline", False) for item in report["cases"]),
              "wall_seconds": report["total_wall_seconds"], "apply_approved": False})
    return report
