"""Two ways this service must refuse to run, kept as tests rather than as a note.

Both behaviours were added on 29.08 after review and both were verified by hand,
which is the weakest form of verification there is: it holds until the next
person edits the file. What follows is the same verification, executed by CI.

  1. THE MODEL TRUST GATE. `config.py` accepts exactly one model/revision pair -
     the one whose `config.json` was inspected for CVE-2026-4372 - unless
     `WHISPER_ALLOW_UNVERIFIED_MODEL=true` says otherwise deliberately. A full
     40-character SHA proves immutability, not trustworthiness.

  2. THE STARTUP FAIL-FAST. A model that cannot load ends the process instead of
     leaving a service that answers /health with "warming_up" for ever.

The gate is exercised in a SUBPROCESS on purpose: it fires at import time, and a
module already imported into this interpreter cannot be re-imported with a
different environment without lying about what is being tested.
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
from pathlib import Path

import pytest

# PLAIN IMPORT, deliberately not pytest.importorskip. If whisper_service stops
# importing, these two tests must go RED, not green-with-a-skip: they are the
# regression tests for a service that refuses to start, and a skip would report
# the refusal as working while nothing ran at all.
import whisper_service

WHISPER_DIR = Path(__file__).parent
VERIFIED_MODEL = "Flurin17/whisper-large-v3-turbo-swiss-german"
VERIFIED_REVISION = "34415231e554d1e7005118264f41e287922f9218"
OTHER_REVISION = "0" * 40


def import_config(**env) -> subprocess.CompletedProcess:
    """Import config.py in a clean interpreter with the given environment."""
    child_env = dict(os.environ)
    for key in ("WHISPER_MODEL", "WHISPER_MODEL_REVISION", "WHISPER_ALLOW_UNVERIFIED_MODEL"):
        child_env.pop(key, None)
    child_env.update({k: v for k, v in env.items() if v is not None})
    child_env["PYTHONIOENCODING"] = "utf-8"
    return subprocess.run(
        [sys.executable, "-c", "import config; print(config.MODEL_CONFIG['model_name'])"],
        cwd=str(WHISPER_DIR),
        env=child_env,
        capture_output=True,
        text=True,
        timeout=120,
    )


# =============================================================================
# 1. Model trust gate
# =============================================================================

def test_the_verified_pair_starts():
    result = import_config()
    assert result.returncode == 0, result.stderr
    assert VERIFIED_MODEL in result.stdout


def test_another_model_refuses_to_start():
    result = import_config(WHISPER_MODEL="attacker/whisper-lookalike")
    assert result.returncode != 0
    assert "Refusing to start with an unverified model" in result.stderr
    assert "CVE-2026-4372" in result.stderr


def test_another_revision_of_the_same_model_refuses_to_start():
    """The pair is the unit. A different revision of our own repository is not
    the revision whose config.json anyone read."""
    result = import_config(WHISPER_MODEL_REVISION=OTHER_REVISION)
    assert result.returncode != 0
    assert "Refusing to start with an unverified model" in result.stderr


def test_the_flag_downgrades_the_refusal_to_a_warning():
    result = import_config(
        WHISPER_MODEL="someone/other-model",
        WHISPER_ALLOW_UNVERIFIED_MODEL="true",
    )
    assert result.returncode == 0, result.stderr
    assert "someone/other-model" in result.stdout


def test_an_abbreviated_sha_is_rejected_before_the_pair_is_even_considered():
    """The old pin was `3441523`. Hugging Face resolves it, which is what makes
    an abbreviation dangerous rather than merely imprecise."""
    result = import_config(WHISPER_MODEL_REVISION="3441523")
    assert result.returncode != 0
    assert "full 40-character commit SHA" in result.stderr


def test_the_flag_does_not_weaken_the_sha_format_check():
    result = import_config(
        WHISPER_MODEL_REVISION="3441523",
        WHISPER_ALLOW_UNVERIFIED_MODEL="true",
    )
    assert result.returncode != 0
    assert "full 40-character commit SHA" in result.stderr


# =============================================================================
# 2. Startup fail-fast
# =============================================================================

def test_a_model_that_cannot_load_ends_startup(monkeypatch):
    """Until 29.08 this path logged the error and served anyway: /health kept
    answering 200 with status="warming_up", so a service that could never
    transcribe looked like one that was still starting."""
    def boom():
        raise RuntimeError("simulated: no CUDA device")

    monkeypatch.setattr(
        whisper_service.WhisperSingleton, "get_instance", staticmethod(boom)
    )

    async def enter_lifespan():
        await whisper_service.lifespan(whisper_service.app).__aenter__()

    with pytest.raises(RuntimeError, match="Whisper model failed to load"):
        asyncio.run(enter_lifespan())


def test_the_original_error_is_not_swallowed(monkeypatch):
    """A cause that does not survive the re-raise turns a diagnosable crash into
    an anonymous one."""
    def boom():
        raise ValueError("out of VRAM, allocating 1.6 GB")

    monkeypatch.setattr(
        whisper_service.WhisperSingleton, "get_instance", staticmethod(boom)
    )

    async def enter_lifespan():
        await whisper_service.lifespan(whisper_service.app).__aenter__()

    with pytest.raises(RuntimeError) as excinfo:
        asyncio.run(enter_lifespan())
    assert "out of VRAM" in str(excinfo.value)
    assert isinstance(excinfo.value.__cause__, ValueError)
