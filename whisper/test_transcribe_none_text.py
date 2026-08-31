"""Regression test for the grid-dependent /transcribe 500.

Root cause: preprocess_transcription() returns None when the whole window is
classified as hallucination (documented contract, hallucination_filter.py:370).
The /transcribe handler passed that None straight into TranscribeResponse(text=...),
which requires str -> pydantic ValidationError -> HTTP 500. The streaming path
already coerced None to "" (whisper_service.py:1935); /transcribe must do the same.

Trigger observed live: C3_BIGRAM_REP fired on genuine rhetorical repetition
("er ist" x4 within one decode window) — whether the phrase lands 4x in one
window depends on chunk framing, hence the "grid-dependent" symptom.
"""
import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))  # run from repo root or whisper/

import whisper_service as ws


@pytest.fixture()
def transcribe_request():
    # 1s of quiet-but-nonzero mono 16k audio; volume gate is bypassed via monkeypatch.
    return ws.TranscribeRequest(
        audio=[0.01] * 16000,
        sample_rate=16000,
        language="de",
        task="transcribe",
    )


def _patch_pipeline(monkeypatch, text, chunks):
    monkeypatch.setattr(ws.WhisperSingleton, "get_instance", staticmethod(lambda: object()))
    monkeypatch.setattr(ws, "should_transcribe", lambda audio: True)
    monkeypatch.setattr(
        ws, "_run_pipeline",
        lambda pipe, audio, generate_kwargs, use_chunking=True: {"text": text, "chunks": chunks},
    )


def test_transcribe_coerces_filtered_none_to_empty_text(monkeypatch, transcribe_request):
    """preprocess -> None (whole window filtered) must yield 200 with text='', raw segments kept."""
    chunks = [{"text": " er ist", "timestamp": (0.0, 1.0)}]
    _patch_pipeline(monkeypatch, "er ist er ist er ist er ist toll", chunks)
    monkeypatch.setattr(ws, "preprocess_transcription", lambda t: None)  # documented contract

    response = asyncio.run(ws.transcribe_audio(transcribe_request))

    assert response.text == ""          # was: pydantic ValidationError -> 500
    assert len(response.segments) == 1  # segments stay raw (denominator reads these)


def test_transcribe_real_filter_bigram_repeat_returns_200(monkeypatch, transcribe_request):
    """End-to-end through the REAL filter: C3_BIGRAM_REP-style text must not 500."""
    text = "er ist gross er ist reich er ist stark er ist gerecht"  # 'er ist' x4
    chunks = [{"text": text, "timestamp": (0.0, 3.0)}]
    _patch_pipeline(monkeypatch, text, chunks)

    response = asyncio.run(ws.transcribe_audio(transcribe_request))

    assert isinstance(response.text, str)  # None is never surfaced
    assert len(response.segments) == 1


def test_transcribe_clean_text_passthrough(monkeypatch, transcribe_request):
    """Sanity: normal text is unaffected by the coercion."""
    text = "Gott ist gut und seine Gnade ist ewig."
    chunks = [{"text": text, "timestamp": (0.0, 2.0)}]
    _patch_pipeline(monkeypatch, text, chunks)

    response = asyncio.run(ws.transcribe_audio(transcribe_request))

    assert response.text == text
    assert response.segments[0]["text"] == text
