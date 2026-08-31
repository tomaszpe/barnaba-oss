"""
Audio Ring Buffer with Backpressure (FIXED)
============================================
Implements a fixed-size circular buffer for audio streaming.
When buffer is full, oldest samples are dropped (backpressure policy).

Users perceive brief gaps better than increasing latency.

FIXES (23.01.2026):
- Added hard limit enforcement in GrowingAudioBuffer.add()
- Returns force_trim_time when buffer approaches limit
- Prevents buffer overflow to 50s+
"""

import numpy as np
from dataclasses import dataclass
from typing import Optional, Tuple
import threading
import logging

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class TrimResult:
    """Result of a GrowingAudioBuffer trim operation."""
    requested_trim_time: float
    effective_trim_time: float
    kept_overlap_seconds: float
    new_buffer_offset: float
    trimmed_samples: int
    original_buffer_seconds: float
    remaining_buffer_seconds: float
    did_trim: bool
    # Absolute boundary after a trim (source of truth for spans).
    new_buffer_start_sample: int = 0


@dataclass(frozen=True)
class DecodeInputSnapshot:
    """The exact input of one decode: bytes plus the absolute sample range."""
    audio: np.ndarray
    start_sample: int
    end_sample: int

    @property
    def sample_count(self) -> int:
        return self.end_sample - self.start_sample


class AudioRingBuffer:
    """
    Thread-safe ring buffer for audio samples.

    Features:
    - Fixed memory footprint (max 30 seconds @ 16kHz = 480KB)
    - Automatic drop of oldest samples when full
    - Thread-safe read/write operations
    - Support for getting contiguous audio for Whisper
    """

    def __init__(
        self,
        max_duration_sec: float = 30.0,
        sample_rate: int = 16000
    ):
        """
        Initialize ring buffer.

        Args:
            max_duration_sec: Maximum duration in seconds (default 30s)
            sample_rate: Sample rate in Hz (default 16000 for Whisper)
        """
        self.sample_rate = sample_rate
        self.max_samples = int(max_duration_sec * sample_rate)

        # Pre-allocate buffer
        self.buffer = np.zeros(self.max_samples, dtype=np.float32)

        # Buffer state
        self.write_pos = 0
        self.read_pos = 0
        self.size = 0

        # Thread safety
        self._lock = threading.Lock()

        # Statistics
        self.total_samples_received = 0
        self.total_samples_dropped = 0

    def add(self, audio_chunk: np.ndarray) -> int:
        """
        Add audio samples to the buffer.

        If the chunk is larger than available space, oldest samples are dropped.

        Args:
            audio_chunk: Float32 audio samples

        Returns:
            Number of samples dropped (0 if none)
        """
        with self._lock:
            # Ensure float32
            if audio_chunk.dtype != np.float32:
                audio_chunk = audio_chunk.astype(np.float32)

            chunk_len = len(audio_chunk)
            self.total_samples_received += chunk_len
            dropped = 0

            # If chunk is larger than entire buffer - keep only last max_samples
            if chunk_len > self.max_samples:
                audio_chunk = audio_chunk[-self.max_samples:]
                dropped = chunk_len - self.max_samples
                chunk_len = self.max_samples

            # Check if we need to drop old samples
            available = self.max_samples - self.size
            if chunk_len > available:
                drop_count = chunk_len - available
                self.read_pos = (self.read_pos + drop_count) % self.max_samples
                self.size -= drop_count
                dropped += drop_count

            # Write to ring buffer (may wrap around)
            end_pos = self.write_pos + chunk_len
            if end_pos <= self.max_samples:
                # Simple case - no wrap
                self.buffer[self.write_pos:end_pos] = audio_chunk
            else:
                # Wrap around
                first_part = self.max_samples - self.write_pos
                self.buffer[self.write_pos:] = audio_chunk[:first_part]
                self.buffer[:chunk_len - first_part] = audio_chunk[first_part:]

            self.write_pos = end_pos % self.max_samples
            self.size += chunk_len
            self.total_samples_dropped += dropped

            return dropped

    def get_audio(self, max_samples: Optional[int] = None) -> np.ndarray:
        """
        Get audio from the buffer without consuming it.

        Args:
            max_samples: Maximum samples to return (None = all available)

        Returns:
            Contiguous float32 array of audio samples
        """
        with self._lock:
            if self.size == 0:
                return np.array([], dtype=np.float32)

            samples_to_get = self.size
            if max_samples is not None:
                samples_to_get = min(samples_to_get, max_samples)

            # Read from buffer (may wrap around)
            end_pos = self.read_pos + samples_to_get
            if end_pos <= self.max_samples:
                # Simple case - no wrap
                return self.buffer[self.read_pos:end_pos].copy()
            else:
                # Wrap around - need to concatenate
                first_part = self.buffer[self.read_pos:]
                second_part = self.buffer[:end_pos - self.max_samples]
                return np.concatenate([first_part, second_part])

    def consume(self, num_samples: int) -> int:
        """
        Mark samples as consumed (remove from buffer).

        Args:
            num_samples: Number of samples to consume

        Returns:
            Actual number of samples consumed
        """
        with self._lock:
            to_consume = min(num_samples, self.size)
            self.read_pos = (self.read_pos + to_consume) % self.max_samples
            self.size -= to_consume
            return to_consume

    def get_and_consume(self, max_samples: Optional[int] = None) -> np.ndarray:
        """
        Get audio and consume it in one atomic operation.

        Args:
            max_samples: Maximum samples to return (None = all available)

        Returns:
            Contiguous float32 array of audio samples
        """
        # FIX: Single lock acquisition instead of double locking
        # (get_audio and consume both acquired locks separately)
        with self._lock:
            if self.size == 0:
                return np.array([], dtype=np.float32)

            samples_to_get = self.size
            if max_samples is not None:
                samples_to_get = min(samples_to_get, max_samples)

            # Read from buffer (may wrap around)
            end_pos = self.read_pos + samples_to_get
            if end_pos <= self.max_samples:
                audio = self.buffer[self.read_pos:end_pos].copy()
            else:
                first_part = self.buffer[self.read_pos:]
                second_part = self.buffer[:end_pos - self.max_samples]
                audio = np.concatenate([first_part, second_part])

            # Consume in same lock acquisition
            self.read_pos = (self.read_pos + samples_to_get) % self.max_samples
            self.size -= samples_to_get

            return audio

    def clear(self) -> None:
        """Clear the buffer."""
        with self._lock:
            self.write_pos = 0
            self.read_pos = 0
            self.size = 0

    @property
    def duration_seconds(self) -> float:
        """Current duration of audio in buffer (seconds)."""
        with self._lock:
            return self.size / self.sample_rate

    @property
    def is_empty(self) -> bool:
        """Check if buffer is empty."""
        with self._lock:
            return self.size == 0

    @property
    def is_full(self) -> bool:
        """Check if buffer is full."""
        with self._lock:
            return self.size >= self.max_samples

    def get_stats(self) -> dict:
        """Get buffer statistics."""
        with self._lock:
            return {
                "size_samples": self.size,
                "size_seconds": self.size / self.sample_rate,
                "max_samples": self.max_samples,
                "max_seconds": self.max_samples / self.sample_rate,
                "fill_percentage": (self.size / self.max_samples) * 100,
                "total_received": self.total_samples_received,
                "total_dropped": self.total_samples_dropped,
                "drop_rate": (
                    self.total_samples_dropped / self.total_samples_received * 100
                    if self.total_samples_received > 0 else 0
                )
            }


class ChunkedAudioBuffer:
    """
    Higher-level buffer that groups audio into Whisper-friendly chunks.

    Accumulates audio until a target chunk size is reached,
    then returns the chunk for transcription.
    """

    def __init__(
        self,
        chunk_duration_sec: float = 5.0,
        overlap_duration_sec: float = 1.0,
        sample_rate: int = 16000,
        max_buffer_sec: float = 30.0
    ):
        """
        Initialize chunked buffer.

        Args:
            chunk_duration_sec: Target chunk size for Whisper (5-10s optimal)
            overlap_duration_sec: Overlap between chunks (1-2s recommended)
            sample_rate: Audio sample rate
            max_buffer_sec: Maximum buffer size before dropping
        """
        self.chunk_size = int(chunk_duration_sec * sample_rate)
        self.overlap_size = int(overlap_duration_sec * sample_rate)
        self.sample_rate = sample_rate

        # Underlying ring buffer
        self._buffer = AudioRingBuffer(max_buffer_sec, sample_rate)

        # Track what we've already processed
        self._processed_samples = 0

    def add(self, audio_chunk: np.ndarray) -> None:
        """Add audio samples to the buffer."""
        self._buffer.add(audio_chunk)

    def get_chunk_if_ready(self) -> Optional[np.ndarray]:
        """
        Get a chunk if enough audio has accumulated.

        Returns:
            Audio chunk ready for Whisper, or None if not enough audio yet
        """
        available = self._buffer.size

        # Need at least chunk_size samples
        if available < self.chunk_size:
            return None

        # Get chunk with overlap from previous
        chunk = self._buffer.get_audio(self.chunk_size)

        # Consume only the non-overlapping part
        consume_amount = self.chunk_size - self.overlap_size
        self._buffer.consume(consume_amount)
        self._processed_samples += consume_amount

        return chunk

    def get_remaining(self) -> Optional[np.ndarray]:
        """
        Get any remaining audio (for final transcription).

        Returns:
            Remaining audio, or None if empty
        """
        if self._buffer.is_empty:
            return None

        return self._buffer.get_and_consume()

    def clear(self) -> None:
        """Clear the buffer and reset state."""
        self._buffer.clear()
        self._processed_samples = 0

    def get_stats(self) -> dict:
        """Get buffer statistics."""
        stats = self._buffer.get_stats()
        stats["processed_samples"] = self._processed_samples
        stats["processed_seconds"] = self._processed_samples / self.sample_rate
        return stats


class GrowingAudioBuffer:
    """
    Growing buffer for LocalAgreement-compatible streaming ASR.

    Unlike ChunkedAudioBuffer (sliding window), this buffer:
    1. Accumulates audio without consuming it
    2. Returns the ENTIRE buffer for each transcription
    3. Only trims at sentence boundaries when approaching max length
    4. Preserves context via prompt when trimming

    This is required for LocalAgreement to work - consecutive transcriptions
    must share a common audio prefix for text stabilization.

    Reference: UFAL whisper_streaming, IWSLT 2022

    FIXES (23.01.2026):
    - add() now returns force_trim_time when approaching hard limit
    - Added HARD_LIMIT_RATIO (0.9 = 27s) to prevent 50s+ overflow
    - Added soft_needs_trim() vs hard limit distinction
    """

    # FIX: Hard limit at 90% of max (27s for 30s max)
    HARD_LIMIT_RATIO = 0.9

    def __init__(
        self,
        min_chunk_seconds: float = 1.0,
        max_buffer_seconds: float = 30.0,
        trim_threshold_ratio: float = 0.8,
        sample_rate: int = 16000
    ):
        """
        Initialize growing buffer.

        Args:
            min_chunk_seconds: Minimum audio before processing (1.0s recommended)
            max_buffer_seconds: Maximum buffer before trimming (30s = Whisper limit)
            trim_threshold_ratio: Trim when buffer reaches this ratio of max (0.8 = 24s)
            sample_rate: Audio sample rate (16000 for Whisper)
        """
        self.sample_rate = sample_rate
        self.min_chunk_samples = int(min_chunk_seconds * sample_rate)
        self.max_buffer_samples = int(max_buffer_seconds * sample_rate)
        self.trim_threshold = int(max_buffer_seconds * trim_threshold_ratio * sample_rate)

        # FIX: Hard limit samples (90% of max)
        self.hard_limit_samples = int(max_buffer_seconds * self.HARD_LIMIT_RATIO * sample_rate)

        # Growing audio buffer - KEY: append-only until trim
        self.audio_buffer = np.array([], dtype=np.float32)

        # ABSOLUTE SAMPLE DOMAIN.
        # The source of truth is the TOTAL counter of samples removed from the start of the
        # stream. `buffer_offset` (seconds) is DERIVED from it rather than accumulated -
        # previously the offset grew by the float `trim_time` while the audio was cut by the
        # int `trim_samples`, so the offset and the actual audio drifted apart on every trim.
        # Without this, "absolute sample space" would only be apparent, and a replay guard
        # built on it
        # over sample ranges would be non-deterministic.
        self.buffer_start_sample: int = 0

        # Context preservation
        self.prompt_text: str = ""  # Last ~200 words for Whisper context
        self.prompt_uses_remaining: int = 0

        # Thread safety
        self._lock = threading.Lock()

        # Statistics
        self.total_samples_received = 0
        self.total_trims = 0
        self.force_trims = 0  # FIX: Track force trims separately

    @property
    def buffer_offset(self) -> float:
        """Cumulative trim offset in SECONDS, derived from the sample counter.

        Read-only on purpose: every writer must move `buffer_start_sample` by the exact
        number of samples it removed, so seconds can never drift away from audio.
        """
        return self.buffer_start_sample / self.sample_rate

    def get_buffer_start_sample(self) -> int:
        """Absolute index of the first sample still held in the buffer."""
        with self._lock:
            return self.buffer_start_sample

    def get_input_span(self) -> tuple:
        """`[start, end)` absolute sample span of the CURRENT buffer contents.

        ⚠️ Do NOT pair this with a separate `get_full_buffer()` call to describe one decode:
        a chunk can land between the two locks and the hash would then describe a different
        tensor than the recorded span. Use `snapshot_for_decode()`.
        """
        with self._lock:
            return (self.buffer_start_sample, self.buffer_start_sample + len(self.audio_buffer))

    def snapshot_for_decode(self) -> "DecodeInputSnapshot":
        """Audio plus its absolute range, taken under ONE lock.

        The only admissible provenance input: the hash computed from `audio` and the recorded
        `[start_sample, end_sample)` describe exactly the same tensor. Splitting those two reads
        creates a window in which a new chunk invalidates the evidence.
        """
        with self._lock:
            audio = self.audio_buffer.copy()
            start = self.buffer_start_sample
            return DecodeInputSnapshot(
                audio=audio,
                start_sample=start,
                end_sample=start + len(audio),
            )

    def add(self, audio_chunk: np.ndarray) -> Optional[float]:
        """
        Append audio to growing buffer.

        Args:
            audio_chunk: Float32 audio samples

        Returns:
            Force trim time (in seconds) if buffer is approaching hard limit,
            None otherwise. Caller MUST handle force trim when returned!

        FIX (23.01.2026): Returns force_trim_time to prevent buffer overflow.
        """
        with self._lock:
            if audio_chunk.dtype != np.float32:
                audio_chunk = audio_chunk.astype(np.float32)

            self.audio_buffer = np.concatenate([self.audio_buffer, audio_chunk])
            self.total_samples_received += len(audio_chunk)

            # FIX: Check hard limit and return force trim time
            if len(self.audio_buffer) >= self.hard_limit_samples:
                buffer_seconds = len(self.audio_buffer) / self.sample_rate
                force_trim_time = buffer_seconds * 0.5  # Trim at 50% point

                logger.warning(
                    f"[BUFFER_HARD_LIMIT] Buffer at {buffer_seconds:.1f}s "
                    f"(>= {self.hard_limit_samples / self.sample_rate:.1f}s hard limit), "
                    f"forcing trim at {force_trim_time:.1f}s"
                )

                return force_trim_time

            return None

    def should_process(self) -> bool:
        """Check if minimum audio has accumulated for processing."""
        with self._lock:
            return len(self.audio_buffer) >= self.min_chunk_samples

    def get_full_buffer(self) -> np.ndarray:
        """
        Get the ENTIRE audio buffer for transcription.

        This is the key difference from sliding window - we transcribe
        the same audio repeatedly with more data added each time.

        Returns:
            Complete audio buffer (copy)
        """
        with self._lock:
            return self.audio_buffer.copy()

    def needs_trim(self) -> bool:
        """
        Check if buffer is approaching max length and needs trimming.

        This is a SOFT limit - caller should try to find sentence boundary.
        For HARD limit enforcement, check return value of add().
        """
        with self._lock:
            return len(self.audio_buffer) >= self.trim_threshold

    def is_at_hard_limit(self) -> bool:
        """
        Check if buffer is at hard limit (MUST trim immediately).

        FIX (23.01.2026): Separate method for hard limit check.
        """
        with self._lock:
            return len(self.audio_buffer) >= self.hard_limit_samples

    def trim_at_time(self, trim_time_seconds: float, new_prompt: str = "",
                     overlap_seconds: float = 1.0,
                     prompt_uses: int = 2) -> TrimResult:
        """
        Trim buffer at specified time offset, keeping audio overlap.

        R1.4 B2: Keeps `overlap_seconds` of audio BEFORE trim point so Whisper
        re-transcribes the overlap region. This helps LocalAgreement agree faster
        after trim (warm-start text matches the re-transcribed overlap).

        Args:
            trim_time_seconds: Time offset to trim at (relative to current buffer start)
            new_prompt: Context text for next segment (last ~200 words)
            overlap_seconds: Audio to keep before trim point (default 1.0s)

        Returns:
            TrimResult with requested/effective trim metadata.
        """
        with self._lock:
            trim_samples = int(trim_time_seconds * self.sample_rate)
            original_samples = len(self.audio_buffer)
            original_seconds = original_samples / self.sample_rate

            if trim_samples <= 0 or trim_samples >= original_samples:
                return TrimResult(
                    requested_trim_time=trim_time_seconds,
                    effective_trim_time=0.0,
                    kept_overlap_seconds=0.0,
                    new_buffer_offset=self.buffer_offset,
                    new_buffer_start_sample=self.buffer_start_sample,
                    trimmed_samples=0,
                    original_buffer_seconds=original_seconds,
                    remaining_buffer_seconds=original_seconds,
                    did_trim=False,
                )

            # R1.4 B2: Keep overlap_seconds of audio before trim point
            overlap_samples = max(0, int(overlap_seconds * self.sample_rate))
            effective_trim = max(0, trim_samples - overlap_samples)

            if effective_trim <= 0:
                return TrimResult(
                    requested_trim_time=trim_time_seconds,
                    effective_trim_time=0.0,
                    kept_overlap_seconds=trim_samples / self.sample_rate,
                    new_buffer_offset=self.buffer_offset,
                    new_buffer_start_sample=self.buffer_start_sample,
                    trimmed_samples=0,
                    original_buffer_seconds=original_seconds,
                    remaining_buffer_seconds=original_seconds,
                    did_trim=False,
                )

            # Trim audio (keeping overlap)
            self.audio_buffer = self.audio_buffer[effective_trim:]

            # Offset advances by effective trim, not requested trim.
            # The sample counter is the source of truth; seconds are derived from it.
            effective_time = effective_trim / self.sample_rate
            self.buffer_start_sample += effective_trim
            kept_overlap = max(0.0, trim_time_seconds - effective_time)

            # Store prompt for context continuity
            self.prompt_text = new_prompt
            self.prompt_uses_remaining = prompt_uses if new_prompt else 0

            self.total_trims += 1

            return TrimResult(
                requested_trim_time=trim_time_seconds,
                effective_trim_time=effective_time,
                kept_overlap_seconds=kept_overlap,
                new_buffer_offset=self.buffer_offset,
                new_buffer_start_sample=self.buffer_start_sample,
                trimmed_samples=effective_trim,
                original_buffer_seconds=original_seconds,
                remaining_buffer_seconds=len(self.audio_buffer) / self.sample_rate,
                did_trim=True,
            )

    def force_trim_at_half(self) -> float:
        """
        Force trim at 50% of buffer when no sentence boundary found.

        FIX (23.01.2026): Emergency fallback when LocalAgreement fails to confirm.

        Returns:
            New buffer offset (cumulative trim time)
        """
        with self._lock:
            # The trim is computed in SAMPLES. Previously the offset grew by the float
            # `trim_time` while the audio was cut by the int `trim_samples` - every forced trim
            # added error to the absolute time axis.
            trim_samples = len(self.audio_buffer) // 2
            trim_time = trim_samples / self.sample_rate

            if trim_samples <= 0:
                return self.buffer_offset

            # Trim audio
            self.audio_buffer = self.audio_buffer[trim_samples:]

            # Update offset via the sample counter (single source of truth)
            self.buffer_start_sample += trim_samples

            self.total_trims += 1
            self.force_trims += 1

            logger.warning(
                f"[FORCE_TRIM] Emergency trim at {trim_time:.1f}s "
                f"(50% of buffer), new offset={self.buffer_offset:.1f}s"
            )

            return self.buffer_offset

    def get_prompt(self) -> str:
        """Get post-trim context prompt, consuming one allowed use."""
        with self._lock:
            if not self.prompt_text or self.prompt_uses_remaining <= 0:
                return ""
            prompt = self.prompt_text
            self.prompt_uses_remaining -= 1
            if self.prompt_uses_remaining <= 0:
                self.prompt_text = ""
            return prompt

    def get_buffer_offset(self) -> float:
        """Get cumulative time offset from all trims."""
        with self._lock:
            return self.buffer_offset

    @property
    def duration_seconds(self) -> float:
        """Current buffer duration in seconds."""
        with self._lock:
            return len(self.audio_buffer) / self.sample_rate

    @property
    def is_empty(self) -> bool:
        """Check if buffer is empty."""
        with self._lock:
            return len(self.audio_buffer) == 0

    def clear(self) -> None:
        """Clear buffer and reset state."""
        with self._lock:
            self.audio_buffer = np.array([], dtype=np.float32)
            # The sample axis is MONOTONIC within the object. Resetting the counter meant that
            # after `clear()` new audio received the same numbers as the old, so two different
            # fragments of the same session had an identical span - a replay guard would then be
            # comparing things that are not comparable.
            self.buffer_start_sample = self.total_samples_received
            self.prompt_text = ""
            self.prompt_uses_remaining = 0

    def get_stats(self) -> dict:
        """Get buffer statistics."""
        with self._lock:
            return {
                "size_samples": len(self.audio_buffer),
                "size_seconds": len(self.audio_buffer) / self.sample_rate,
                "max_seconds": self.max_buffer_samples / self.sample_rate,
                "hard_limit_seconds": self.hard_limit_samples / self.sample_rate,
                "buffer_offset": self.buffer_offset,
                "total_received": self.total_samples_received,
                "total_trims": self.total_trims,
                "force_trims": self.force_trims,  # FIX: Include force trim count
                "has_prompt": bool(self.prompt_text),
                "prompt_uses_remaining": self.prompt_uses_remaining,
                "fill_percentage": (len(self.audio_buffer) / self.max_buffer_samples) * 100
            }
