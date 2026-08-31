"""DEV-only Python timing profile of the existing pipeline, no decode changes."""
import asyncio
import cProfile
import hashlib
import json
from pathlib import Path
import pstats
import time

import numpy as np


async def run_profile(pipe, executor, run_pipeline, build_kwargs, emit):
    root = Path('/app/rep-r0')
    manifest = json.loads((root / 'manifest.json').read_text())
    raw = (root / 'p010.f32').read_bytes()
    if hashlib.sha256(raw).hexdigest() != manifest['pcm_sha256']:
        raise RuntimeError('Profile fixture digest mismatch')
    audio = np.frombuffer(raw, dtype=np.float32)
    report = {'schema': 'rep-profile/1', 'model_count': 1, 'decoder_changed': False,
              'profile_overhead_not_a_latency_gate': True, 'cases': []}

    def profile_case(seconds):
        samples = audio[(15-seconds)*16000:15*16000].copy()
        profiler = cProfile.Profile()
        started = time.monotonic()
        profiler.enable()
        result = run_pipeline(pipe, samples, build_kwargs(), use_chunking=False)
        profiler.disable()
        rows = []
        for (filename, line, name), (primitive, calls, own, cumulative, _) in pstats.Stats(profiler).stats.items():
            rows.append({'file': filename, 'line': line, 'function': name, 'calls': calls,
                         'own_ms': own*1000, 'cumulative_ms': cumulative*1000})
        return {'audio_seconds': seconds, 'wall_ms': (time.monotonic()-started)*1000,
                'text_length': len(result.get('text', '')),
                'top_own': sorted(rows, key=lambda row: row['own_ms'], reverse=True)[:30],
                'top_cumulative': sorted(rows, key=lambda row: row['cumulative_ms'], reverse=True)[:40]}

    for seconds in (2, 5):
        report['cases'].append(await asyncio.get_running_loop().run_in_executor(
            executor, profile_case, seconds))
    report['complete'] = True
    Path('/tmp/rep-e4-profile.json').write_text(json.dumps(report), encoding='utf-8')
    emit({'event': 'rep_profile_complete', 'cases': 2, 'policy_applied': False})
