import asyncio
import hashlib
import json
from pathlib import Path

import numpy as np

import rep_profile_benchmark as profile_module
from rep_r0_benchmark import run_r0
from rep_retry_executor import RetryExecutor


def test_profile_uses_one_existing_model_and_two_exact_inputs(tmp_path, monkeypatch):
    root = tmp_path / 'fixture'
    root.mkdir()
    audio = np.arange(240000, dtype=np.float32)
    raw = audio.tobytes()
    (root / 'p010.f32').write_bytes(raw)
    (root / 'manifest.json').write_text(json.dumps({'pcm_sha256': hashlib.sha256(raw).hexdigest()}))
    output = tmp_path / 'profile.json'
    monkeypatch.setattr(profile_module, 'Path', lambda path: root if path == '/app/rep-r0' else output)
    pipe, seen, events = object(), [], []
    def decode(actual_pipe, samples, kwargs, use_chunking):
        assert actual_pipe is pipe and kwargs == {'num_beams': 3}
        assert not use_chunking
        seen.append(samples.copy())
        return {'text': 'test'}
    pool = RetryExecutor(max_workers=4, max_retry_parents=10)
    try:
        asyncio.run(profile_module.run_profile(pipe, pool, decode, lambda: {'num_beams': 3}, events.append))
    finally:
        pool.shutdown()
    assert np.array_equal(seen[0], audio[-32000:])
    assert np.array_equal(seen[1], audio[-80000:])
    result = json.loads(output.read_text())
    assert result['complete'] and not result['decoder_changed']
    assert result['model_count'] == 1 and len(result['cases']) == 2
    assert result['cases'][0]['top_own']


def test_profile_dispatch_is_explicit_and_does_not_run_r0_too(monkeypatch):
    monkeypatch.setenv('REP_E4_PROFILE_ENABLED', 'true')
    calls = []
    async def fake_profile(*args):
        calls.append(args)
        return 'profile_only'
    monkeypatch.setattr(profile_module, 'run_profile', fake_profile)
    assert asyncio.run(run_r0(None, None, None, None, None)) == 'profile_only'
    assert len(calls) == 1
