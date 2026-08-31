"""Contract: the Silero VAD revision is pinned, and pinned to the SAME value
everywhere it is consumed.

Why this test exists (26.08.2026)
---------------------------------
Both the image build (Dockerfile.base) and the runtime loader (vad_processor.py)
used to call torch.hub.load('snakers4/silero-vad', ...) with no revision - each
resolving HEAD of a third-party repository on its own. Two silent consequences:

  * two builds a week apart could bake different VAD versions, unrecorded;
  * build (force_reload=True) and runtime (force_reload=False) could disagree
    whenever the baked cache was absent.

The value is duplicated between config.py and Dockerfile.base. An earlier version
of this docstring justified that by Docker cache invalidation; that reason was wrong
(a COPY after the heavy layers does not invalidate them) and was removed on 26.08.
The duplication simply keeps the base image independent of application code. What
makes it safe is this test: it fails the moment the two drift apart, and it checks
the EFFECTIVE revision an image would run with, not only the two defaults.
"""

import os
import re
from pathlib import Path

import pytest

import config

WHISPER_DIR = Path(__file__).resolve().parent
DOCKERFILE_BASE = WHISPER_DIR / "Dockerfile.base"
VAD_PROCESSOR = WHISPER_DIR / "vad_processor.py"

# A 40-char hex commit SHA. A branch or tag would defeat the purpose: both can
# be moved to point at different code without the reference changing.
SHA_RE = re.compile(r"^[0-9a-f]{40}$")


def test_config_pin_is_a_commit_sha():
    assert SHA_RE.match(config.SILERO_VAD_REF), (
        f"SILERO_VAD_REF must be a 40-char commit SHA, got {config.SILERO_VAD_REF!r}. "
        "Branches and tags can be moved; a SHA cannot."
    )


def test_dockerfile_base_pins_the_same_revision():
    text = DOCKERFILE_BASE.read_text(encoding="utf-8")
    match = re.search(r"^ARG SILERO_VAD_REF=(\S+)", text, re.MULTILINE)
    assert match, "Dockerfile.base must declare ARG SILERO_VAD_REF"
    assert match.group(1) == config.SILERO_VAD_REF, (
        f"Dockerfile.base pins {match.group(1)} but config.py pins "
        f"{config.SILERO_VAD_REF}. Build and runtime would load different VAD code."
    )


def test_dockerfile_base_does_not_load_vad_unpinned():
    text = DOCKERFILE_BASE.read_text(encoding="utf-8")
    assert "torch.hub.load('snakers4/silero-vad'," not in text, (
        "Dockerfile.base loads Silero without a revision - that is the drift this pin removes."
    )


def test_dockerfile_base_persists_the_effective_revision_as_env():
    """ARG alone is not enough: it disappears after the build.

    Gap found in review 26.08: building with --build-arg SILERO_VAD_REF=X baked X
    into the image, while the runtime kept resolving config.py's default. The two
    could disagree and all the default-vs-default assertions would still pass.
    Persisting the ARG as ENV makes the image carry its own effective revision,
    which config.py then reads.
    """
    text = DOCKERFILE_BASE.read_text(encoding="utf-8")
    assert re.search(r"^ENV SILERO_VAD_REF=\$\{SILERO_VAD_REF\}", text, re.MULTILINE), (
        "Dockerfile.base must persist ARG SILERO_VAD_REF as ENV, otherwise an image "
        "built with --build-arg runs with a different revision than it was built with."
    )


def test_config_rejects_a_movable_reference():
    """The env override must not be able to downgrade the pin to a branch or tag."""
    import importlib

    for bad in ("master", "v6.2", "be95df9"):
        os.environ["SILERO_VAD_REF"] = bad
        try:
            with pytest.raises(ValueError):
                importlib.reload(config)
        finally:
            os.environ.pop("SILERO_VAD_REF", None)
            importlib.reload(config)


def test_runtime_loader_uses_the_shared_constant():
    text = VAD_PROCESSOR.read_text(encoding="utf-8")
    assert "SILERO_VAD_REF" in text, "vad_processor.py must load the pinned revision from config"
    assert "repo_or_dir='snakers4/silero-vad'" not in text, (
        "vad_processor.py still hardcodes an unpinned repo reference"
    )
