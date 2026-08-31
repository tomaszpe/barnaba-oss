"""Install the pinned export adapter once; scope it inside each inference worker."""
from contextlib import nullcontext
import os

from rep_result_transfer import WhisperResultTransfer


def install_result_transfer(pipe):
    if os.getenv("ASR_REP_EXPORT_OPTIMIZATION_ENABLED", "false").lower() != "true":
        return False
    if getattr(pipe, "_rep_result_transfer", None) is None:
        pipe._rep_result_transfer = WhisperResultTransfer(pipe.model)
    return True


def result_transfer_scope(pipe, *, capture_quality=False):
    adapter = getattr(pipe, "_rep_result_transfer", None)
    return (adapter.scope(enabled=True, capture_quality=capture_quality)
            if adapter is not None else nullcontext(None))
