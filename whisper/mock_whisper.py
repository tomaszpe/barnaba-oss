"""
Mock Whisper Service for testing audio pipeline.
Does NOT load Whisper model - just responds to /health and /test-audio.
"""

from fastapi import FastAPI
from pydantic import BaseModel, Field
from typing import List
import numpy as np
import uvicorn
import time

# Import resampler
from streaming_resampler import resample_audio, get_resampler_pool

app = FastAPI(title="Mock Whisper Service")
start_time = time.time()
SAMPLE_RATE = 16000


class TranscribeRequest(BaseModel):
    audio: List[float] = Field(..., description="PCM audio samples")
    sample_rate: int = Field(default=16000)
    language: str = Field(default="de")
    task: str = Field(default="transcribe")


class HealthResponse(BaseModel):
    status: str
    model_loaded: bool
    model_path: str
    device: str
    active_sessions: int
    uptime_seconds: float


class TestAudioResponse(BaseModel):
    success: bool
    input_samples: int
    input_rate: int
    output_samples: int
    output_rate: int
    min_value: float
    max_value: float
    mean_value: float
    duration_sec: float
    resampler_backend: str
    message: str


@app.get("/health", response_model=HealthResponse)
async def health():
    """Mock health - reports model loaded for testing."""
    return HealthResponse(
        status="healthy",
        model_loaded=True,  # Lie for testing!
        model_path="MOCK_MODEL",
        device="cpu",
        active_sessions=0,
        uptime_seconds=time.time() - start_time
    )


@app.get("/ready")
async def ready():
    return {"ready": True}


@app.post("/test-audio", response_model=TestAudioResponse)
async def test_audio(request: TranscribeRequest):
    """Test audio resampling without Whisper."""
    audio = np.array(request.audio, dtype=np.float32)

    if len(audio) == 0:
        return TestAudioResponse(
            success=False,
            input_samples=0,
            input_rate=request.sample_rate,
            output_samples=0,
            output_rate=SAMPLE_RATE,
            min_value=0.0,
            max_value=0.0,
            mean_value=0.0,
            duration_sec=0.0,
            resampler_backend="none",
            message="Empty audio"
        )

    pool = get_resampler_pool(SAMPLE_RATE)
    resampler = pool.get_resampler(request.sample_rate)
    backend = resampler.backend

    if request.sample_rate != SAMPLE_RATE:
        audio_16k = resample_audio(audio, request.sample_rate, SAMPLE_RATE)
    else:
        audio_16k = audio

    return TestAudioResponse(
        success=True,
        input_samples=len(audio),
        input_rate=request.sample_rate,
        output_samples=len(audio_16k),
        output_rate=SAMPLE_RATE,
        min_value=float(audio_16k.min()),
        max_value=float(audio_16k.max()),
        mean_value=float(audio_16k.mean()),
        duration_sec=len(audio_16k) / SAMPLE_RATE,
        resampler_backend=backend,
        message=f"OK: {request.sample_rate}Hz -> {SAMPLE_RATE}Hz via {backend}"
    )


@app.post("/transcribe")
async def transcribe(request: TranscribeRequest):
    """Mock transcribe - returns test text."""
    audio = np.array(request.audio, dtype=np.float32)

    # Resample if needed
    if request.sample_rate != SAMPLE_RATE:
        audio_16k = resample_audio(audio, request.sample_rate, SAMPLE_RATE)
    else:
        audio_16k = audio

    duration = len(audio_16k) / SAMPLE_RATE

    print(f"[MOCK] Received {len(audio)} samples @ {request.sample_rate}Hz")
    print(f"[MOCK] Resampled to {len(audio_16k)} samples @ {SAMPLE_RATE}Hz ({duration:.2f}s)")
    print(f"[MOCK] Audio range: [{audio_16k.min():.3f}, {audio_16k.max():.3f}]")

    return {
        "text": f"[MOCK] Received {duration:.1f}s audio",
        "segments": [],
        "language": "de"
    }


if __name__ == "__main__":
    print("=" * 60)
    print("MOCK Whisper Service (no model)")
    print("=" * 60)
    print("Endpoints:")
    print("  /health     - Returns model_loaded=True")
    print("  /test-audio - Tests resampling pipeline")
    print("  /transcribe - Returns mock transcription")
    print("=" * 60)
    uvicorn.run(app, host="0.0.0.0", port=8000)
