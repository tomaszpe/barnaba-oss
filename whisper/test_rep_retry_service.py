"""CPU integration with the real streaming endpoint; model output is synthetic.

These tests are not a human oracle or live quality acceptance.
"""
import asyncio
import hashlib
import time

import numpy as np

import whisper_service as ws
from rep_retry_runtime import RepRetrySession
from rep_shadow import RepShadowSession


def test_streaming_retry_precedes_local_agreement_and_keeps_raw_observation(monkeypatch):
    session = ws.TranscriptionSession("rep-service-test")
    ws.sessions[session.session_id] = session
    session.rep_shadow = RepShadowSession(session.session_id, mode="shadow", protected_text_enabled=True)
    session.rep_retry = RepRetrySession(session.session_id, max_snapshot_samples=96000,
                                       mode="apply", quality_gate=True, measured_headroom_ms=100)
    echo = "Alpha Beta Gamma Delta Epsilon Zeta Eta Theta"
    session.rep_shadow.classify_and_record(echo, [
        {"start_sample": i * 400, "end_sample": (i + 1) * 400} for i in range(8)], decode_id=1)
    words = ("Heute berichtet " + echo + " danach endet").split()
    raw = {"text": " ".join(words), "chunks": [
        {"text": word, "timestamp": (i * .5, (i + 1) * .5)} for i, word in enumerate(words)]}
    candidate = {"text": "berichtet danach endet", "chunks": [
        {"text": word, "timestamp": (i * .5, (i + 1) * .5)}
        for i, word in enumerate("berichtet danach endet".split())],
        "rep_quality": {"validated_measurement": True, "avg_logprob": -.2}}
    calls, observed, stabilized = [], [], []
    def pipeline(pipe, audio, kwargs, use_chunking=False, capture_quality=False):
        calls.append((audio.copy(), dict(kwargs), capture_quality))
        if capture_quality:
            time.sleep(.03)
        return candidate if capture_quality else raw
    original_process = session.stabilizer.process
    def stabilize(text):
        stabilized.append(text)
        return original_process(text)
    monkeypatch.setattr(ws, "_run_pipeline", pipeline)
    monkeypatch.setattr(ws, "should_transcribe", lambda _: True)
    monkeypatch.setattr(ws.WhisperSingleton, "get_instance", classmethod(lambda _: object()))
    monkeypatch.setattr(ws.WhisperSingleton, "get_prompt_ids", classmethod(lambda _: None))
    monkeypatch.setattr(session.vad_processor, "process_chunk", lambda _: (None, True))
    monkeypatch.setattr(session.stabilizer, "process", stabilize)
    monkeypatch.setattr(ws, "_log_rep_event", lambda event: observed.append(event) if event else None)
    t = np.arange(96000, dtype=np.float32) / 16000
    audio = (.2 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
    try:
        response = asyncio.run(ws.process_chunk(session.session_id, ws.StreamChunkRequest(
            session_id=session.session_id, audio=audio.tolist(), sample_rate=16000)))
        assert len(calls) == 2
        assert not calls[0][2] and calls[1][2]
        assert "prompt_ids" not in calls[1][1]
        assert stabilized == ["Heute berichtet danach endet"]
        assert response.rep_retry["policy_applied"] is True
        assert response.rep_retry["retry_decode_id"] == f"{response.decode_id}:retry:1"
        assert response.input_pcm_sha256 == hashlib.sha256(calls[0][0].tobytes()).hexdigest()
        assert response.rep_retry["input_pcm_sha256"] == hashlib.sha256(calls[1][0].tobytes()).hexdigest()
        assert response.decode_total_ms >= response.worker_total_ms + 25
        raw_event = next(e for e in observed if e.get("stage") == "asr_decode_raw"
                         and e.get("event") == "rep_stage_observation")
        assert raw_event["token_count"] == 12
        assert raw_event["lineage_status"] == "complete"
        assert session.rep_retry.leases.retained_bytes == 0
    finally:
        asyncio.run(ws.delete_session(session.session_id))
        assert session.rep_retry.closed


def test_delete_closes_pcm_before_removing_session():
    session = ws.TranscriptionSession("rep-delete-test")
    ws.sessions[session.session_id] = session
    asyncio.run(ws.delete_session(session.session_id))
    assert session.rep_retry.closed
    assert session.session_id not in ws.sessions
