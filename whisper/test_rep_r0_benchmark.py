import asyncio
import hashlib
import json
from pathlib import Path

import numpy as np
import pytest

from rep_r0_benchmark import run_r0
from rep_retry_executor import RetryExecutor


def fixture(root):
    root.mkdir()
    pcm = np.arange(32000, dtype=np.float32).tobytes()
    (root / "p010.f32").write_bytes(pcm)
    manifest = {"source_start_sample": 100, "pcm_sha256": hashlib.sha256(pcm).hexdigest(),
                "cases": [{"case_id": "test", "parent_start_sample": 100,
                           "parent_end_sample": 32100, "retry_start_sample": 16100}]}
    (root / "manifest.json").write_text(json.dumps(manifest))
    return manifest


def test_r0_uses_same_pipeline_exact_slice_no_prompt_and_never_claims_apply(tmp_path):
    root = tmp_path / "input"
    fixture(root)
    pipe, calls, events = object(), [], []
    def run(actual_pipe, samples, kwargs, use_chunking):
        assert actual_pipe is pipe
        assert kwargs == {"num_beams": 3}
        assert not use_chunking
        calls.append(samples.copy())
        return {"text": "eins", "chunks": [{"text": "eins", "timestamp": (0, .5)}]}
    executor = RetryExecutor(max_workers=4, max_retry_parents=10)
    try:
        report = asyncio.run(run_r0(pipe, executor, run, lambda: {"num_beams": 3},
                                    events.append, root=root, output=tmp_path / "report.json"))
    finally:
        executor.shutdown()
    assert len(calls) == 2
    assert np.array_equal(calls[0][16000:], calls[1])
    assert report["complete"] and report["cases"][0]["within_deadline"]
    assert report["cases"][0]["retry"]["alignment"]["span"] == [16100, 24100]
    assert not report["adjudicated_oracle"] and not report["apply_approved"]
    assert not report["original_historical_parent_reconstructed"]
    assert all("text" not in str(event) for event in events)


def test_r0_digest_failure_never_calls_decoder(tmp_path):
    root = tmp_path / "input"
    fixture(root)
    (root / "p010.f32").write_bytes(b"changed")
    def forbidden(*args, **kwargs):
        pytest.fail("Decoder must not run on changed fixture")
    with pytest.raises(RuntimeError, match="digest mismatch"):
        asyncio.run(run_r0(None, None, forbidden, dict, forbidden,
                           root=root, output=tmp_path / "report.json"))


def test_both_service_routes_share_admission_and_r0_is_opt_in():
    source = Path(__file__).with_name("whisper_service.py").read_text(encoding="utf-8")
    assert "executor = RetryExecutor(max_workers=4" in source
    assert source.count("await loop.run_in_executor(executor, do_transcribe)") == 1
    assert "transcription, chunks_list, transcribe_status = await loop.run_in_executor(\n" in source
    assert 'os.getenv("REP_E4_R0_ENABLED", "false")' in source
    assert source.index("await run_r0(") < source.index("    yield\n", source.index("async def lifespan"))
