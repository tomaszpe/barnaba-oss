import asyncio
from contextlib import contextmanager
import hashlib
import json
from types import SimpleNamespace

import numpy as np
import pytest
import torch

import rep_optimization_benchmark as benchmark
from rep_retry_executor import RetryExecutor


class Adapter:
    closed = False
    enabled = False

    def __init__(self, model):
        pass

    @contextmanager
    def scope(self, enabled, synchronize=None):
        self.enabled = enabled
        yield {'enabled': enabled, 'synchronize': synchronize}

    def close(self):
        self.closed = True


def fixture(root):
    root.mkdir()
    audio = np.arange(15*16000, dtype=np.float32)
    raw = audio.tobytes()
    (root / 'p010.f32').write_bytes(raw)
    manifest = {'source_start_sample': 100, 'pcm_sha256': hashlib.sha256(raw).hexdigest(),
        'cases': [{'case_id': str(i), 'parent_start_sample': 100,
                   'parent_end_sample': 240100, 'retry_start_sample': 160100}
                  for i in range(12)]}
    (root / 'manifest.json').write_text(json.dumps(manifest))
    return audio


def test_paired_harness_uses_same_pcm_alternating_arms_and_never_claims_e5(tmp_path, monkeypatch):
    root = tmp_path / 'fixture'
    audio = fixture(root)
    adapter = Adapter(None)
    monkeypatch.setattr(benchmark, 'WhisperResultTransfer', lambda model: adapter)
    calls, events = [], []
    pipe = SimpleNamespace(model=object())
    def run(actual_pipe, samples, kwargs, use_chunking):
        assert actual_pipe is pipe and not use_chunking and kwargs == {'num_beams': 3}
        assert np.array_equal(samples, audio[-80000:])
        calls.append(adapter.enabled)
        return {'text': 'über', 'chunks': [{'text': 'über', 'timestamp': (0, .5)}]}
    pool = RetryExecutor(max_workers=4, max_retry_parents=64)
    try:
        report = asyncio.run(benchmark.run_optimization(pipe, pool, run, lambda: {'num_beams': 3},
            events.append, root=root, output=tmp_path / 'report.json'))
    finally:
        pool.shutdown()
    assert report['complete'] and len(report['cases']) == 24
    assert len(calls) == 52 and calls[:6] == [False, True, False, True, True, False]
    assert all(pair['text_equal'] and pair['chunks_equal'] for pair in report['cases'])
    assert all(pair['baseline']['pcm_sha256'] == pair['optimized']['pcm_sha256']
               for pair in report['cases'])
    assert not report['apply_approved'] and not report['adjudicated_oracle']
    assert adapter.closed and 'über' not in json.dumps(report, ensure_ascii=False)


def test_failure_restores_wrapper_and_does_not_claim_completion(tmp_path, monkeypatch):
    root = tmp_path / 'fixture'
    fixture(root)
    adapter = Adapter(None)
    monkeypatch.setattr(benchmark, 'WhisperResultTransfer', lambda model: adapter)
    def fail(*args, **kwargs):
        raise RuntimeError('decode failed')
    pool = RetryExecutor(max_workers=1, max_retry_parents=2)
    output = tmp_path / 'report.json'
    try:
        with pytest.raises(RuntimeError, match='decode failed'):
            asyncio.run(benchmark.run_optimization(SimpleNamespace(model=None), pool, fail,
                dict, lambda _: None, root=root, output=output))
    finally:
        pool.shutdown()
    assert adapter.closed
    assert not json.loads(output.read_text()).get('complete', False)
