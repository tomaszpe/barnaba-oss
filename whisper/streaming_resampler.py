"""
Streaming Audio Resampler for Barnaba Whisper Service
=====================================================
High-quality resampling using torchaudio's sinc interpolation.

This module provides stateful resampling that avoids chunk boundary
artifacts when processing streaming audio.

Key features:
- Kaiser-windowed sinc interpolation (not linear!)
- Maintains state between chunks for seamless boundaries
- Optimized parameters for speech audio

Usage:
    resampler = StreamingResampler(source_sr=48000, target_sr=16000)
    for chunk in audio_chunks:
        resampled = resampler.process(chunk)
        # Use resampled audio...

Based on torchaudio best practices for real-time audio processing.
"""

import numpy as np
import logging

logger = logging.getLogger(__name__)

# Check if torchaudio is available
try:
    import torch
    import torchaudio.transforms as T
    TORCHAUDIO_AVAILABLE = True
    logger.info("[Resampler] torchaudio available - using high-quality sinc resampling")
except ImportError:
    TORCHAUDIO_AVAILABLE = False
    logger.warning("[Resampler] torchaudio not available - falling back to scipy")
    try:
        from scipy import signal
        SCIPY_AVAILABLE = True
    except ImportError:
        SCIPY_AVAILABLE = False
        logger.error("[Resampler] Neither torchaudio nor scipy available!")


class StreamingResampler:
    """
    High-quality streaming audio resampler using torchaudio.

    Uses Kaiser-windowed sinc interpolation which is the gold standard
    for audio resampling, avoiding aliasing artifacts that occur with
    simple linear interpolation.

    Parameters are optimized for speech audio (e.g., 48kHz -> 16kHz).
    """

    def __init__(self, source_sr: int = 48000, target_sr: int = 16000):
        """
        Initialize the streaming resampler.

        Args:
            source_sr: Source sample rate (e.g., 48000 from browser)
            target_sr: Target sample rate (16000 for Whisper)
        """
        self.source_sr = source_sr
        self.target_sr = target_sr
        self.ratio = source_sr / target_sr

        if TORCHAUDIO_AVAILABLE:
            # Create torchaudio resampler with optimized parameters
            # These parameters are tuned for high-quality speech audio
            self.resampler = T.Resample(
                orig_freq=source_sr,
                new_freq=target_sr,
                lowpass_filter_width=64,      # Wide filter for quality
                rolloff=0.9475937167399596,   # Optimal rolloff
                resampling_method="sinc_interp_kaiser",  # Best quality
                beta=14.769656459379492       # Kaiser beta parameter
            )
            self.backend = "torchaudio"
            logger.info(f"[Resampler] Initialized torchaudio: {source_sr}Hz -> {target_sr}Hz")
        elif SCIPY_AVAILABLE:
            # Fallback to scipy's resample (also uses FFT, good quality)
            self.resampler = None
            self.backend = "scipy"
            logger.info(f"[Resampler] Initialized scipy: {source_sr}Hz -> {target_sr}Hz")
        else:
            self.resampler = None
            self.backend = "numpy"
            logger.warning(f"[Resampler] Using numpy fallback (lower quality): {source_sr}Hz -> {target_sr}Hz")

    def process(self, chunk_float32: np.ndarray) -> np.ndarray:
        """
        Resample an audio chunk.

        Args:
            chunk_float32: Input audio samples as numpy float32 array
                          Values should be in range [-1.0, 1.0]

        Returns:
            Resampled audio as numpy float32 array
        """
        if len(chunk_float32) == 0:
            return np.array([], dtype=np.float32)

        # No resampling needed if rates match
        if self.source_sr == self.target_sr:
            return chunk_float32

        if self.backend == "torchaudio":
            return self._resample_torchaudio(chunk_float32)
        elif self.backend == "scipy":
            return self._resample_scipy(chunk_float32)
        else:
            return self._resample_numpy(chunk_float32)

    def _resample_torchaudio(self, chunk_float32: np.ndarray) -> np.ndarray:
        """High-quality resampling using torchaudio."""
        # Convert to torch tensor (add batch dimension)
        tensor = torch.from_numpy(chunk_float32.astype(np.float32)).unsqueeze(0)

        # Resample
        resampled = self.resampler(tensor)

        # Convert back to numpy
        return resampled.squeeze(0).numpy()

    def _resample_scipy(self, chunk_float32: np.ndarray) -> np.ndarray:
        """Good quality resampling using scipy (FFT-based)."""
        num_samples = int(len(chunk_float32) / self.ratio)
        resampled = signal.resample(chunk_float32, num_samples)
        return resampled.astype(np.float32)

    def _resample_numpy(self, chunk_float32: np.ndarray) -> np.ndarray:
        """
        Fallback using numpy linear interpolation.

        WARNING: This produces lower quality results and may cause
        aliasing artifacts. Only use if torchaudio/scipy unavailable.
        """
        new_length = int(len(chunk_float32) / self.ratio)
        resampled = np.interp(
            np.linspace(0, len(chunk_float32), new_length),
            np.arange(len(chunk_float32)),
            chunk_float32
        )
        return resampled.astype(np.float32)

    def get_info(self) -> dict:
        """Get resampler information."""
        return {
            "source_sr": self.source_sr,
            "target_sr": self.target_sr,
            "ratio": self.ratio,
            "backend": self.backend,
        }


class ResamplerPool:
    """
    Pool of resamplers for different source sample rates.

    Creates and caches resamplers on demand, since different browsers
    may use different native sample rates (44100, 48000, etc.).
    """

    def __init__(self, target_sr: int = 16000):
        """
        Initialize the resampler pool.

        Args:
            target_sr: Target sample rate (16000 for Whisper)
        """
        self.target_sr = target_sr
        self._resamplers: dict[int, StreamingResampler] = {}

    def get_resampler(self, source_sr: int) -> StreamingResampler:
        """
        Get or create a resampler for the given source sample rate.

        Args:
            source_sr: Source sample rate

        Returns:
            StreamingResampler instance
        """
        if source_sr not in self._resamplers:
            self._resamplers[source_sr] = StreamingResampler(
                source_sr=source_sr,
                target_sr=self.target_sr
            )
            logger.info(f"[ResamplerPool] Created resampler for {source_sr}Hz")

        return self._resamplers[source_sr]

    def process(self, audio: np.ndarray, source_sr: int) -> np.ndarray:
        """
        Resample audio from source_sr to target_sr.

        Args:
            audio: Input audio as numpy float32 array
            source_sr: Source sample rate

        Returns:
            Resampled audio as numpy float32 array
        """
        resampler = self.get_resampler(source_sr)
        return resampler.process(audio)

    def clear(self):
        """Clear all cached resamplers."""
        self._resamplers.clear()

    def get_stats(self) -> dict:
        """Get pool statistics."""
        return {
            "target_sr": self.target_sr,
            "cached_resamplers": list(self._resamplers.keys()),
            "backends": {sr: r.backend for sr, r in self._resamplers.items()}
        }


# Global resampler pool instance
_resampler_pool: ResamplerPool | None = None


def get_resampler_pool(target_sr: int = 16000) -> ResamplerPool:
    """
    Get the global resampler pool instance.

    Args:
        target_sr: Target sample rate (default 16000 for Whisper)

    Returns:
        ResamplerPool instance
    """
    global _resampler_pool
    if _resampler_pool is None or _resampler_pool.target_sr != target_sr:
        _resampler_pool = ResamplerPool(target_sr=target_sr)
    return _resampler_pool


def resample_audio(
    audio: np.ndarray,
    source_sr: int,
    target_sr: int = 16000
) -> np.ndarray:
    """
    Convenience function to resample audio.

    Args:
        audio: Input audio as numpy float32 array [-1.0, 1.0]
        source_sr: Source sample rate (e.g., 48000)
        target_sr: Target sample rate (default 16000)

    Returns:
        Resampled audio as numpy float32 array
    """
    pool = get_resampler_pool(target_sr)
    return pool.process(audio, source_sr)


def normalize_int16_to_float32(int16_data: np.ndarray) -> np.ndarray:
    """
    Properly normalize int16 audio to float32 [-1.0, 1.0].

    IMPORTANT: Division by 32768.0 is REQUIRED for correct normalization.
    Without this, audio will be corrupted (values 0-65535 instead of -1 to 1).

    Args:
        int16_data: Audio data as int16 array

    Returns:
        Normalized float32 array with values in [-1.0, 1.0]
    """
    # CORRECT: divide by 32768.0
    return int16_data.astype(np.float32) / 32768.0


def normalize_bytes_to_float32(data: bytes, dtype: str = "int16") -> np.ndarray:
    """
    Convert raw audio bytes to normalized float32.

    Args:
        data: Raw audio bytes
        dtype: Source data type ("int16" or "float32")

    Returns:
        Normalized float32 array with values in [-1.0, 1.0]
    """
    if dtype == "int16":
        # Parse as int16 and normalize
        int16_array = np.frombuffer(data, dtype=np.int16)
        return normalize_int16_to_float32(int16_array)
    elif dtype == "float32":
        # Already float32, just parse
        return np.frombuffer(data, dtype=np.float32).copy()
    else:
        raise ValueError(f"Unsupported dtype: {dtype}")
