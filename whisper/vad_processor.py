"""
Silero VAD Processor
====================
Voice Activity Detection using Silero VAD model.

Key features:
- <1ms processing per 30ms audio chunk
- 2MB model footprint
- ~97% speech detection accuracy (vs ~85% energy-based)
- Proper speech boundary detection
"""

import numpy as np
import torch
from typing import List, Optional, Tuple
from dataclasses import dataclass
import logging

from config import SILERO_VAD_REPO, SILERO_VAD_REF

logger = logging.getLogger(__name__)


@dataclass
class SpeechSegment:
    """Represents a detected speech segment."""
    start_sample: int
    end_sample: int
    start_seconds: float
    end_seconds: float
    confidence: float = 1.0

    @property
    def duration_seconds(self) -> float:
        return self.end_seconds - self.start_seconds

    @property
    def duration_samples(self) -> int:
        return self.end_sample - self.start_sample


class SileroVADProcessor:
    """
    Silero VAD wrapper for speech detection.

    Usage:
        vad = SileroVADProcessor()
        segments = vad.detect_speech(audio_array)
        speech_only = vad.extract_speech(audio_array, segments)
    """

    def __init__(
        self,
        threshold: float = 0.5,
        min_speech_duration_ms: int = 250,
        min_silence_duration_ms: int = 300,
        speech_pad_ms: int = 30,
        sample_rate: int = 16000
    ):
        """
        Initialize Silero VAD.

        Args:
            threshold: Speech probability threshold (0-1)
            min_speech_duration_ms: Minimum speech segment duration
            min_silence_duration_ms: Minimum silence to split segments
            speech_pad_ms: Padding around speech segments
            sample_rate: Audio sample rate (must be 16000 for Silero)
        """
        if sample_rate != 16000:
            raise ValueError("Silero VAD requires 16kHz sample rate")

        self.threshold = threshold
        self.min_speech_duration_ms = min_speech_duration_ms
        self.min_silence_duration_ms = min_silence_duration_ms
        self.speech_pad_ms = speech_pad_ms
        self.sample_rate = sample_rate

        # Load Silero VAD model
        self.model = None
        self._load_model()

        # Processing state for streaming
        self._reset_state()

    def _load_model(self) -> None:
        """Load Silero VAD model from torch hub."""
        try:
            # Pinned revision, shared with the image build - see config.SILERO_VAD_REF.
            # Logged because "which VAD are we actually running" was previously
            # unanswerable from the logs alone.
            source = f"{SILERO_VAD_REPO}:{SILERO_VAD_REF}"
            logger.info("Loading Silero VAD model from %s", source)
            self.model, self.utils = torch.hub.load(
                repo_or_dir=source,
                model='silero_vad',
                force_reload=False,
                onnx=False  # Use PyTorch for GPU support
            )
            (
                self.get_speech_timestamps,
                self.save_audio,
                self.read_audio,
                self.VADIterator,
                self.collect_chunks
            ) = self.utils
            logger.info("Silero VAD model loaded successfully")
        except Exception as e:
            logger.error(f"Failed to load Silero VAD: {e}")
            raise

    def _reset_state(self) -> None:
        """Reset streaming state."""
        if self.model is not None:
            self.model.reset_states()

    def detect_speech(
        self,
        audio: np.ndarray,
        return_seconds: bool = True
    ) -> List[SpeechSegment]:
        """
        Detect speech segments in audio.

        Args:
            audio: Float32 audio array at 16kHz
            return_seconds: Include timestamps in seconds

        Returns:
            List of SpeechSegment objects
        """
        if len(audio) == 0:
            return []

        # Ensure correct dtype and shape
        if audio.dtype != np.float32:
            audio = audio.astype(np.float32)

        # Convert to torch tensor
        audio_tensor = torch.from_numpy(audio)

        # Get speech timestamps
        speech_timestamps = self.get_speech_timestamps(
            audio_tensor,
            self.model,
            threshold=self.threshold,
            min_speech_duration_ms=self.min_speech_duration_ms,
            min_silence_duration_ms=self.min_silence_duration_ms,
            speech_pad_ms=self.speech_pad_ms,
            return_seconds=False  # We'll calculate ourselves
        )

        # Convert to SpeechSegment objects
        segments = []
        for ts in speech_timestamps:
            start_sample = ts['start']
            end_sample = ts['end']

            segment = SpeechSegment(
                start_sample=start_sample,
                end_sample=end_sample,
                start_seconds=start_sample / self.sample_rate if return_seconds else 0,
                end_seconds=end_sample / self.sample_rate if return_seconds else 0
            )
            segments.append(segment)

        return segments

    def extract_speech(
        self,
        audio: np.ndarray,
        segments: Optional[List[SpeechSegment]] = None,
        concatenate: bool = True
    ) -> np.ndarray:
        """
        Extract speech-only audio.

        Args:
            audio: Full audio array
            segments: Pre-computed segments (will compute if None)
            concatenate: If True, concatenate all segments; else return list

        Returns:
            Audio array with only speech
        """
        if segments is None:
            segments = self.detect_speech(audio)

        if not segments:
            return np.array([], dtype=np.float32)

        # Extract each segment
        speech_parts = []
        for seg in segments:
            start = max(0, seg.start_sample)
            end = min(len(audio), seg.end_sample)
            speech_parts.append(audio[start:end])

        if concatenate:
            return np.concatenate(speech_parts) if speech_parts else np.array([], dtype=np.float32)
        return speech_parts

    def get_speech_probability(self, audio_chunk: np.ndarray) -> float:
        """
        Get speech probability for a single chunk.

        Silero VAD requires exactly 512 samples at 16kHz (32ms frames).
        This method handles any chunk size by processing in 512-sample frames.

        Args:
            audio_chunk: Audio chunk (any size)

        Returns:
            Speech probability (0-1) - max of all frame probabilities
        """
        if len(audio_chunk) == 0:
            return 0.0

        # Silero VAD requires exactly 512 samples at 16kHz
        FRAME_SIZE = 512

        # Ensure correct dtype
        if audio_chunk.dtype != np.float32:
            audio_chunk = audio_chunk.astype(np.float32)

        # Process in 512-sample frames
        max_prob = 0.0
        num_frames = len(audio_chunk) // FRAME_SIZE

        if num_frames == 0:
            # Chunk smaller than frame size - pad with zeros
            padded = np.zeros(FRAME_SIZE, dtype=np.float32)
            padded[:len(audio_chunk)] = audio_chunk
            audio_tensor = torch.from_numpy(padded)
            with torch.no_grad():
                max_prob = self.model(audio_tensor, self.sample_rate).item()
        else:
            # Process each full frame, return max probability
            for i in range(num_frames):
                start = i * FRAME_SIZE
                end = start + FRAME_SIZE
                frame = audio_chunk[start:end]
                audio_tensor = torch.from_numpy(frame)
                with torch.no_grad():
                    prob = self.model(audio_tensor, self.sample_rate).item()
                    max_prob = max(max_prob, prob)

        return max_prob

    def is_speech(self, audio_chunk: np.ndarray) -> bool:
        """
        Quick check if chunk contains speech.

        Args:
            audio_chunk: Audio chunk

        Returns:
            True if speech detected
        """
        return self.get_speech_probability(audio_chunk) >= self.threshold

    def process_stream(
        self,
        audio_chunk: np.ndarray,
        context_samples: int = 0
    ) -> Tuple[bool, float, Optional[SpeechSegment]]:
        """
        Process a streaming audio chunk.

        Args:
            audio_chunk: New audio chunk
            context_samples: Number of samples already processed

        Returns:
            Tuple of (is_speech, probability, segment_if_completed)
        """
        prob = self.get_speech_probability(audio_chunk)
        is_speech = prob >= self.threshold

        # For now, return simple result
        # Full streaming logic would track state across chunks
        return is_speech, prob, None

    def reset(self) -> None:
        """Reset VAD state for new session."""
        self._reset_state()


class VADStreamProcessor:
    """
    Streaming VAD processor that accumulates speech segments.

    Designed for real-time audio processing where audio comes in
    small chunks and we need to detect complete utterances.
    """

    def __init__(
        self,
        threshold: float = 0.5,
        min_speech_ms: int = 250,
        min_silence_ms: int = 500,  # Longer silence to detect utterance end
        max_speech_ms: int = 30000,  # Max 30s per utterance
        sample_rate: int = 16000
    ):
        """
        Initialize streaming VAD.

        Args:
            threshold: Speech probability threshold
            min_speech_ms: Minimum speech duration
            min_silence_ms: Silence duration to end utterance
            max_speech_ms: Maximum utterance duration
            sample_rate: Audio sample rate
        """
        # FIX: Use the passed min_silence_ms parameter instead of hardcoded 300
        self.vad = SileroVADProcessor(
            threshold=threshold,
            min_speech_duration_ms=min_speech_ms,
            min_silence_duration_ms=min_silence_ms,  # Was hardcoded to 300
            sample_rate=sample_rate
        )

        self.min_silence_samples = int(min_silence_ms * sample_rate / 1000)
        self.max_speech_samples = int(max_speech_ms * sample_rate / 1000)
        self.sample_rate = sample_rate

        # State
        self._speech_buffer: List[np.ndarray] = []
        self._silence_samples = 0
        self._is_speaking = False
        self._total_speech_samples = 0

    def process_chunk(
        self,
        audio_chunk: np.ndarray
    ) -> Tuple[Optional[np.ndarray], bool]:
        """
        Process an audio chunk and return complete utterance if ready.

        Args:
            audio_chunk: Audio chunk to process

        Returns:
            Tuple of (utterance_audio_if_complete, is_currently_speaking)
        """
        is_speech = self.vad.is_speech(audio_chunk)

        if is_speech:
            # Speech detected
            self._speech_buffer.append(audio_chunk)
            self._total_speech_samples += len(audio_chunk)
            self._silence_samples = 0
            self._is_speaking = True

            # Check max duration
            if self._total_speech_samples >= self.max_speech_samples:
                return self._finalize_utterance(), True

        else:
            # Silence detected
            if self._is_speaking:
                # Still in utterance, accumulate silence
                self._speech_buffer.append(audio_chunk)
                self._silence_samples += len(audio_chunk)

                # Check if utterance ended
                if self._silence_samples >= self.min_silence_samples:
                    return self._finalize_utterance(), False

        return None, self._is_speaking

    def _finalize_utterance(self) -> Optional[np.ndarray]:
        """Finalize and return current utterance."""
        if not self._speech_buffer:
            return None

        utterance = np.concatenate(self._speech_buffer)
        self._speech_buffer = []
        self._silence_samples = 0
        self._is_speaking = False
        self._total_speech_samples = 0

        return utterance

    def get_partial(self) -> Optional[np.ndarray]:
        """Get current partial utterance (for streaming transcription)."""
        if not self._speech_buffer:
            return None
        return np.concatenate(self._speech_buffer)

    def reset(self) -> None:
        """Reset all state."""
        self._speech_buffer = []
        self._silence_samples = 0
        self._is_speaking = False
        self._total_speech_samples = 0
        self.vad.reset()

    def force_finalize(self) -> Optional[np.ndarray]:
        """Force finalize current utterance (e.g., at session end)."""
        return self._finalize_utterance()
