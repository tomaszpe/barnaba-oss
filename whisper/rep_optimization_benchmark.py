"""Bounded paired DEV experiment. Never changes listener output or enables E5."""
import asyncio
import hashlib
import json
from pathlib import Path
import time

import numpy as np

from provenance import align_text_to_spans
from rep_result_transfer import WhisperResultTransfer
from rep_retry_budget import RetryDeadline, RetrySkipped
from rep_retry_pcm import ParentPcmLeases
from ring_buffer import DecodeInputSnapshot


def fingerprint(value):
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False).encode()
    return hashlib.sha256(encoded).hexdigest()


async def run_optimization(pipe, executor, run_pipeline, build_kwargs, emit,
                           root=Path('/app/rep-r0'),
                           output=Path('/tmp/rep-e4-optimization.json')):
    manifest = json.loads((root / 'manifest.json').read_text())
    raw = (root / 'p010.f32').read_bytes()
    if hashlib.sha256(raw).hexdigest() != manifest['pcm_sha256']:
        raise RuntimeError('Optimization fixture digest mismatch')
    if len(manifest['cases']) != 12 or len(raw) > 16000 * 180 * 4:
        raise RuntimeError('Unexpected optimization fixture size')
    audio = np.frombuffer(raw, dtype=np.float32)
    origin = manifest['source_start_sample']
    adapter = WhisperResultTransfer(pipe.model)
    started = time.monotonic()
    report = {'schema': 'rep-optimization/1', 'model_count': 1, 'decoder_changed': False,
              'condition': 'paired_new_P010_boundaries_not_historical_parent',
              'apply_approved': False, 'policy_applied': False, 'adjudicated_oracle': False,
              'live_contention_tested': False, 'cases': [], 'diagnostics': [],
              'source_pcm_sha256': manifest['pcm_sha256'], 'decoder_kwargs': build_kwargs()}

    def decode(samples, start, end, enabled, synchronize=None):
        with adapter.scope(enabled, synchronize=synchronize) as stats:
            result = run_pipeline(pipe, samples, build_kwargs(), use_chunking=False)
        alignment = align_text_to_spans(result.get('text', ''), result.get('chunks', []),
                                       start, input_end_sample=end).to_dict()
        return {'text': result.get('text', ''), 'chunks': result.get('chunks', []),
                'alignment_status': alignment['alignment_status'],
                'alignment_reason': alignment['alignment_reason'],
                'stats': {key: value for key, value in stats.items() if key != 'synchronize'}}

    async def measure(case, enabled):
        # Includes PCM retention/copy/hash, queue, pipeline, alignment and handoff.
        deadline = RetryDeadline.start(total_ms=2800)
        start, end = case['parent_start_sample'], case['parent_end_sample']
        snapshot = DecodeInputSnapshot(audio[start-origin:end-origin].copy(), start, end)
        leases = ParentPcmLeases('rep-opt', max_bytes=len(raw), max_leases=1)
        try:
            lease = leases.retain(snapshot, parent_decode_id=1,
                parent_pcm_sha256=hashlib.sha256(snapshot.audio.tobytes()).hexdigest(),
                expires_at=deadline.expires_at)
            retry = leases.slice_absolute(lease, case['retry_start_sample'], end)
            samples = retry.audio()
            future = executor.submit_normal(lambda: decode(samples, retry.start_sample, end, enabled))
            try:
                value = await deadline.wait(future)
                within_reserve = True
            except RetrySkipped:
                # Offline evidence drain ONLY; never used by listener selection.
                within_reserve = False
                value = await asyncio.wrap_future(future)
            total_ms = (time.monotonic() - deadline.started_at) * 1000
            return value, {'total_ms': total_ms, 'within_2000ms': total_ms < 2000,
                'within_2800ms': within_reserve and total_ms < 2800,
                'alignment_status': value['alignment_status'],
                'alignment_reason': value['alignment_reason'], 'stats': value['stats'],
                'text_sha256': fingerprint(value['text']),
                'chunks_sha256': fingerprint(value['chunks']), 'pcm_sha256': retry.pcm_sha256}
        finally:
            leases.close()

    try:
        # Warm both arms before paired measurements; no new model is loaded.
        for enabled in (False, True):
            await measure(manifest['cases'][0], enabled)
        for repeat in range(2):
            for index, case in enumerate(manifest['cases']):
                if time.monotonic() - started > 240:
                    raise RuntimeError('Optimization experiment exceeded 240s bound')
                arms, values = {}, {}
                order = (False, True) if (index + repeat) % 2 == 0 else (True, False)
                for enabled in order:
                    key = 'optimized' if enabled else 'baseline'
                    values[key], arms[key] = await measure(case, enabled)
                entry = {'case_id': case['case_id'], 'repeat': repeat,
                    'audio_seconds': (case['parent_end_sample']-case['retry_start_sample'])/16000,
                    'text_equal': values['baseline']['text'] == values['optimized']['text'],
                    'chunks_equal': values['baseline']['chunks'] == values['optimized']['chunks'],
                    **arms}
                report['cases'].append(entry)
                output.write_text(json.dumps(report, ensure_ascii=False), encoding='utf-8')
                emit({'event': 'rep_optimization_pair', 'case_id': case['case_id'],
                      'repeat': repeat, 'text_equal': entry['text_equal'],
                      'chunks_equal': entry['chunks_equal'], 'policy_applied': False})
        import torch
        # Diagnostic calls are separated from acceptance timing: explicit sync
        # distinguishes queued GPU work from the measured postprocessing stage.
        for enabled in (False, True):
            value = await asyncio.get_running_loop().run_in_executor(executor, decode,
                audio[10*16000:15*16000].copy(), origin+10*16000, origin+15*16000,
                enabled, torch.cuda.synchronize)
            report['diagnostics'].append(value['stats'])
        report['complete'] = True
    finally:
        adapter.close()
        report['wall_seconds'] = time.monotonic() - started
        output.write_text(json.dumps(report, ensure_ascii=False), encoding='utf-8')
    emit({'event': 'rep_optimization_complete', 'pairs': len(report['cases']),
          'policy_applied': False})
    return report
