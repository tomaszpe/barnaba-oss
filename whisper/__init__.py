"""
Barnaba Whisper Service
=======================
Swiss German speech recognition service optimized for church sermons.

Components:
- whisper_service: FastAPI main service
- ring_buffer: Audio buffering with backpressure
- local_agreement: Streaming transcription stabilization
- vad_processor: Silero VAD for speech detection
"""

__version__ = "1.0.0"
__author__ = "Barnaba Team"
