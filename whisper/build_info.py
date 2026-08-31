"""Records what the image actually contains, and fails the build when it does not
contain what was declared.

Why this is a Python script and not a shell one-liner (26.08.2026)
------------------------------------------------------------------
The first version of this step was

    RUN set -eu; echo "torch=$(python -c 'import torch; print(torch.__version__)')" >> ...

which does NOT fail when the Python inside the command substitution fails:
`set -eu; echo "x=$(false)"` exits 0. The inventory could therefore record an empty
value, or nothing at all, while the build stayed green - the same class of defect as
the `|| echo` that used to hide a missing Flash Attention.

Here the interpreter itself does the importing and the writing, so an ImportError is
a non-zero exit and the build stops.

Flash Attention is verified by IMPORTING it, not by the exit code of `pip install`.
A successful install is not evidence that the extension loads: flash-attn compiles
against a specific torch/CUDA ABI and can install yet fail at import time.
"""

import os
import sys
from importlib import import_module
from pathlib import Path

INFO_PATH = Path(os.environ.get("BARNABA_BUILD_INFO", "/etc/barnaba-build-info"))

# Absent from the image is a supported outcome for flash_attn (SDPA fallback);
# absent for everything else is a broken image.
REQUIRED = ("torch", "transformers")
OPTIONAL = ("flash_attn",)


def version_of(module) -> str:
    return getattr(module, "__version__", "unknown")


def main() -> int:
    lines = []

    for name in REQUIRED:
        # No try/except: an ImportError here must take the build down.
        lines.append(f"{name}={version_of(import_module(name))}")

    flash_ok = True
    for name in OPTIONAL:
        try:
            lines.append(f"{name}={version_of(import_module(name))}")
        except Exception as exc:  # noqa: BLE001 - any import failure is the same outcome here
            flash_ok = False
            lines.append(f"{name}=absent ({type(exc).__name__})")

    silero_ref = os.environ.get("SILERO_VAD_REF", "")
    if len(silero_ref) != 40 or any(c not in "0123456789abcdef" for c in silero_ref):
        # A branch or tag would defeat the pin: both can be moved to point at
        # different code without the reference changing.
        print(
            f"FATAL: SILERO_VAD_REF must be a 40-char commit SHA, got {silero_ref!r}",
            file=sys.stderr,
        )
        return 1
    lines.append(f"silero_vad_ref={silero_ref}")

    lines.append(f"python={sys.version.split()[0]}")

    INFO_PATH.parent.mkdir(parents=True, exist_ok=True)
    INFO_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")

    print(f"--- {INFO_PATH} ---")
    print("\n".join(lines))

    if not flash_ok:
        if os.environ.get("WHISPER_REQUIRE_FLASH_ATTN") == "1":
            print(
                "FATAL: flash_attn does not import and WHISPER_REQUIRE_FLASH_ATTN=1",
                file=sys.stderr,
            )
            return 1
        print(
            "WARNING: flash_attn does not import; runtime will use the SDPA path",
            file=sys.stderr,
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
