"""Lets the whisper suite run from `whisper/` and from the repository root alike.

Without it, `python -m pytest` from the repo root ended in `ModuleNotFoundError: provenance`,
because the service modules import flatly (`from provenance import ...`) while the sys.path
root was the repo rather than the `whisper/` directory.
"""
import sys
from pathlib import Path

WHISPER_DIR = Path(__file__).resolve().parent
if str(WHISPER_DIR) not in sys.path:
    sys.path.insert(0, str(WHISPER_DIR))
