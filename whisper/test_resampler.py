"""
Test script for StreamingResampler - CPU only, no Whisper model needed.
Run: python test_resampler.py
"""

import numpy as np
import sys

# Add current directory to path
sys.path.insert(0, '.')

from streaming_resampler import (
    resample_audio,
    StreamingResampler,
    ResamplerPool,
    normalize_int16_to_float32,
    TORCHAUDIO_AVAILABLE
)

def test_basic_resampling():
    """Test basic 48kHz -> 16kHz resampling with sine wave."""
    print("\n" + "="*60)
    print("TEST 1: Basic Resampling (48kHz -> 16kHz)")
    print("="*60)

    # Generate 440Hz tone at 48kHz (1 second)
    duration = 1.0
    sr_source = 48000
    sr_target = 16000

    t = np.linspace(0, duration, int(sr_source * duration), dtype=np.float32)
    audio_48k = np.sin(2 * np.pi * 440 * t).astype(np.float32)

    # Resample
    audio_16k = resample_audio(audio_48k, sr_source, sr_target)

    # Verify
    expected_samples = int(duration * sr_target)
    actual_samples = len(audio_16k)
    ratio = len(audio_48k) / len(audio_16k)

    print(f"Input:  {len(audio_48k)} samples @ {sr_source}Hz ({duration}s)")
    print(f"Output: {actual_samples} samples @ {sr_target}Hz ({actual_samples/sr_target:.3f}s)")
    print(f"Ratio:  {ratio:.2f}x (expected: 3.0x)")
    print(f"Range:  [{audio_16k.min():.4f}, {audio_16k.max():.4f}]")

    # Checks
    assert abs(ratio - 3.0) < 0.01, f"Ratio should be ~3.0, got {ratio}"
    assert abs(actual_samples - expected_samples) <= 1, f"Expected ~{expected_samples} samples"
    assert audio_16k.min() >= -1.1 and audio_16k.max() <= 1.1, "Values out of range"

    print("[OK] PASSED")


def test_different_sample_rates():
    """Test various sample rate combinations."""
    print("\n" + "="*60)
    print("TEST 2: Different Sample Rates")
    print("="*60)

    test_cases = [
        (44100, 16000, "44.1kHz -> 16kHz (common browser rate)"),
        (48000, 16000, "48kHz -> 16kHz (Chrome default)"),
        (32000, 16000, "32kHz -> 16kHz"),
        (16000, 16000, "16kHz -> 16kHz (no resampling)"),
    ]

    for sr_source, sr_target, description in test_cases:
        duration = 0.5
        t = np.linspace(0, duration, int(sr_source * duration), dtype=np.float32)
        audio = np.sin(2 * np.pi * 440 * t).astype(np.float32)

        resampled = resample_audio(audio, sr_source, sr_target)
        expected_len = int(duration * sr_target)

        ok = abs(len(resampled) - expected_len) <= 1
        status = "[OK]" if ok else "[FAIL]"
        print(f"{status} {description}: {len(audio)} -> {len(resampled)} samples")

        # ASSERT, not just a printed verdict. Until 29.08 this loop computed
        # `status` and printed it, and that was all: a resampler returning one
        # sample for every input printed four [FAIL] lines, then "[OK] PASSED",
        # then exited 0. Under pytest the function returned None either way, so
        # the case was reported as passing. A test whose only failure signal is
        # stdout is not a test.
        assert ok, (
            f"{description}: expected ~{expected_len} samples, got {len(resampled)}"
        )

    print("[OK] PASSED")


def test_streaming_chunks():
    """Test that streaming chunks work correctly."""
    print("\n" + "="*60)
    print("TEST 3: Streaming Chunks (simulating real-time audio)")
    print("="*60)

    sr_source = 48000
    sr_target = 16000
    chunk_duration = 0.1  # 100ms chunks (like browser sends)

    resampler = StreamingResampler(sr_source, sr_target)

    # Simulate 5 chunks of audio
    total_input = 0
    total_output = 0

    for i in range(5):
        chunk_samples = int(sr_source * chunk_duration)
        t = np.linspace(i * chunk_duration, (i+1) * chunk_duration, chunk_samples, dtype=np.float32)
        chunk = np.sin(2 * np.pi * 440 * t).astype(np.float32)

        resampled = resampler.process(chunk)
        total_input += len(chunk)
        total_output += len(resampled)

        print(f"  Chunk {i+1}: {len(chunk)} -> {len(resampled)} samples")

    ratio = total_input / total_output
    print(f"\nTotal: {total_input} -> {total_output} samples (ratio: {ratio:.2f}x)")

    assert abs(ratio - 3.0) < 0.05, f"Cumulative ratio should be ~3.0"
    print("[OK] PASSED")


def test_resampler_pool():
    """Test ResamplerPool caching."""
    print("\n" + "="*60)
    print("TEST 4: ResamplerPool (caching)")
    print("="*60)

    pool = ResamplerPool(target_sr=16000)

    # Get resamplers for different rates
    r1 = pool.get_resampler(48000)
    r2 = pool.get_resampler(44100)
    r3 = pool.get_resampler(48000)  # Should return cached

    print(f"Created resampler for 48000Hz: {r1.backend}")
    print(f"Created resampler for 44100Hz: {r2.backend}")
    print(f"Retrieved cached 48000Hz: {r1 is r3}")

    stats = pool.get_stats()
    print(f"Pool stats: {stats}")

    assert r1 is r3, "48000Hz resampler should be cached"
    assert len(stats['cached_resamplers']) == 2, "Should have 2 cached resamplers"

    print("[OK] PASSED")


def test_int16_normalization():
    """Test int16 to float32 normalization."""
    print("\n" + "="*60)
    print("TEST 5: Int16 Normalization")
    print("="*60)

    # Test edge cases
    int16_data = np.array([0, 32767, -32768, 16384, -16384], dtype=np.int16)
    float32_data = normalize_int16_to_float32(int16_data)

    print(f"Int16:   {int16_data}")
    print(f"Float32: {float32_data}")

    # Verify
    assert abs(float32_data[0] - 0.0) < 0.001, "0 should map to 0.0"
    assert abs(float32_data[1] - 1.0) < 0.001, "32767 should map to ~1.0"
    assert abs(float32_data[2] - (-1.0)) < 0.001, "-32768 should map to -1.0"
    assert abs(float32_data[3] - 0.5) < 0.001, "16384 should map to ~0.5"

    print("[OK] PASSED")


def test_audio_quality():
    """Test that resampled audio maintains quality (no obvious distortion)."""
    print("\n" + "="*60)
    print("TEST 6: Audio Quality Check")
    print("="*60)

    sr_source = 48000
    sr_target = 16000
    duration = 1.0
    freq = 440  # A4 note

    # Generate clean sine wave
    t_source = np.linspace(0, duration, int(sr_source * duration), dtype=np.float32)
    audio_source = np.sin(2 * np.pi * freq * t_source).astype(np.float32)

    # Resample
    audio_resampled = resample_audio(audio_source, sr_source, sr_target)

    # Generate reference sine at target rate
    t_target = np.linspace(0, duration, int(sr_target * duration), dtype=np.float32)
    audio_reference = np.sin(2 * np.pi * freq * t_target).astype(np.float32)

    # Compare (allow for small differences due to phase)
    # Use correlation instead of direct comparison
    min_len = min(len(audio_resampled), len(audio_reference))
    correlation = np.corrcoef(audio_resampled[:min_len], audio_reference[:min_len])[0, 1]

    print(f"Source: {len(audio_source)} samples @ {sr_source}Hz")
    print(f"Resampled: {len(audio_resampled)} samples @ {sr_target}Hz")
    print(f"Reference: {len(audio_reference)} samples @ {sr_target}Hz")
    print(f"Correlation with reference: {correlation:.4f}")

    # High correlation means the resampled audio matches expected sine wave
    assert correlation > 0.99, f"Correlation should be > 0.99, got {correlation}"

    print("[OK] PASSED")


def main():
    print("\n" + "#"*60)
    print("# STREAMING RESAMPLER TEST SUITE")
    print("#"*60)
    print(f"\nBackend: {'torchaudio' if TORCHAUDIO_AVAILABLE else 'scipy/numpy fallback'}")

    tests = [
        test_basic_resampling,
        test_different_sample_rates,
        test_streaming_chunks,
        test_resampler_pool,
        test_int16_normalization,
        test_audio_quality,
    ]

    passed = 0
    failed = 0

    for test in tests:
        try:
            # Count by EXCEPTION, not by return value. A test that signals failure by
            # returning False passes silently under pytest; assertions cannot.
            test()
            passed += 1
        except Exception as e:
            print(f"[FAIL] FAILED: {e}")
            failed += 1

    print("\n" + "#"*60)
    print(f"# RESULTS: {passed} passed, {failed} failed")
    print("#"*60)

    return failed == 0


if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)
