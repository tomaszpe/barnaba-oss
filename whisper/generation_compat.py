"""Compatibility of the `generate()` call across transformers versions. Fail-closed.

WHY (a smoke run on the 4.57 arm: 30/30 decodes raised `TypeError`).
`WhisperTimeStampLogitsProcessor` in transformers 4.57.5 uses `eos_token_id` as a SLICE
BOUNDARY.

The `generation_config` of the pinned model revision carries `eos_token_id = [50257]` - a
single-element LIST. Slicing with a list raises `TypeError: slice indices must be integers or
None or have an __index__ method`, so EVERY decode with `return_timestamps="word"` fails.
Reproduced without a GPU on the pinned config; the same code is in 4.57.6 and 5.14.1, so a
patch/minor upgrade does not fix it by itself.

WE DO NOT CHANGE THE LIBRARY, nor `beams`. The smallest systemic fix is NORMALISING a
   single-element `eos_token_id` at the boundary of OUR call - semantically neutral, because
   `[50257]` and `50257` mean the same thing, provided the singleton really has one element.

RULES that make this normalisation safe:
  * a COPY per call (`deepcopy`) - the pipeline's `generation_config` object is shared between
    executor threads, so mutating it in place would leak between concurrent decodes;
  * we accept ONLY: an `int`, a single-element list/tuple, a single-element tensor;
  * we require EXACTLY one POSITIVE integer - `bool`, `float`, a value <= 0, an empty
    container, multiple EOS values and a missing value are all REJECTED (fail-closed: a known
    library error is preferable to a silent guess that changes generation semantics);
  * when the value is ALREADY a scalar we do NOTHING - the 4.47.1 path stays
    character-identical, with no copy and no `generation_config` injection.

Injection is supported directly by the library: `automatic_speech_recognition.py:533` -
"User-defined `generation_config` passed to the pipeline call take precedence".
"""
from __future__ import annotations

import copy
from typing import Any, Dict, Optional, Tuple

# Disjoint normalisation decisions. `noop` injects nothing and is a CORRECT path (4.47.1).
# `refused` is NOT a path - it stops the decode with an exception.
COMPAT_ACTIONS = ("noop", "normalized", "refused")


class GenerationCompatError(RuntimeError):
    """The `generate()` contract is unmet - the decode MUST NOT start.

    Introduced after review: `refused` was previously ONLY logged while the pipeline started
    with the old, invalid config. A refusal that does not stop inference is not a refusal - it
    is a warning impersonating a gate.

    The message carries ONLY a reason code and type names. No config value and no text - the
    exception reaches cloud logs through `pipeline_error`.
    """


def _positive_int(value: Any) -> Tuple[Optional[int], str]:
    """(a positive int or None, reason). `bool` is NOT a number here - `True` is a defect, not 1."""
    if isinstance(value, bool):
        return None, "bool"
    if isinstance(value, int):
        return (value, "int") if value > 0 else (None, "non_positive")
    return None, "not_an_int:{}".format(type(value).__name__)


def eos_singleton(value: Any) -> Tuple[Optional[int], str]:
    """A scalar `eos_token_id` from a scalar value, a single-element sequence or a tensor.

    `None` in the first element means REFUSAL - the reason is always named, never implicit.
    """
    if value is None:
        return None, "missing"

    # A tensor (or anything with that interface) - recognised BEFORE sequences, because a
    # 0-dimensional tensor has no `len()`, while a single-element 1-D one does and would look
    # like a list.
    if hasattr(value, "numel") and hasattr(value, "tolist"):
        try:
            count = int(value.numel())
        except Exception:
            return None, "tensor_unmeasurable"
        if count != 1:
            return None, "tensor_len_{}".format(count)
        try:
            unwrapped = value.tolist()
        except Exception:
            return None, "tensor_unreadable"
        while isinstance(unwrapped, (list, tuple)) and len(unwrapped) == 1:
            unwrapped = unwrapped[0]
        scalar, reason = _positive_int(unwrapped)
        return (scalar, "tensor") if scalar is not None else (None, "tensor:" + reason)

    if isinstance(value, (list, tuple)):
        if len(value) != 1:
            return None, "sequence_len_{}".format(len(value))
        scalar, reason = _positive_int(value[0])
        return (scalar, "sequence") if scalar is not None else (None, "sequence:" + reason)

    scalar, reason = _positive_int(value)
    return (scalar, "scalar") if scalar is not None else (None, reason)


def normalized_generation_config(generation_config: Any) -> Tuple[Optional[Any], Dict[str, Any]]:
    """(a COPY of the config to inject, or None; plus the decision report).

    `None` in the first element means "inject nothing" and occurs in TWO cases, distinguished in
    the report: `noop` (the value is already scalar - the 4.47.1 path) and `refused` (a shape
    that must not be guessed).
    """
    report: Dict[str, Any] = {
        "action": "refused",
        "reason": "no_generation_config",
        "observed_type": type(generation_config).__name__ if generation_config is not None else None,
        "eos_scalar": None,
    }
    if generation_config is None:
        return None, report

    observed = getattr(generation_config, "eos_token_id", None)
    report["observed_type"] = type(observed).__name__
    scalar, reason = eos_singleton(observed)
    report["reason"] = reason

    if scalar is None:
        # REFUSAL. The caller MUST abort - see `GenerationCompatError`. Returning a bare `None`
        # with no signal would be indistinguishable from `noop`, and those are opposites:
        # "nothing needs doing" versus "this must not be touched".
        report["action"] = "refused"
        return None, report

    if reason == "scalar":
        # ALREADY a scalar: no copy, no injection - exactly today's behaviour.
        report["action"] = "noop"
        report["eos_scalar"] = scalar
        return None, report

    # A COPY per call. The config object is shared between executor threads, so mutating it in
    # place would leak between concurrent decodes.
    patched = copy.deepcopy(generation_config)
    patched.eos_token_id = scalar
    report["action"] = "normalized"
    report["eos_scalar"] = scalar
    return patched, report


def pipeline_generation_config(pipe: Any) -> Any:
    """The config the pipeline will use when we supply none of our own."""
    config = getattr(pipe, "generation_config", None)
    if config is not None:
        return config
    return getattr(getattr(pipe, "model", None), "generation_config", None)


def should_retry_with_chunking(exc: BaseException) -> Tuple[bool, str]:
    """Whether to retry with `chunk_length_s=30`. ALWAYS NO - and that is a decision, not an
    oversight.

    The historical "float stride" defect was recognised from the bare text `"slice indices"`.
    That condition later caught an ENTIRELY DIFFERENT error - `eos_token_id` in
    `WhisperTimeStampLogitsProcessor` - and triggered a second decode on the chunked path.

    WHY DISABLED RATHER THAN NARROWED. Positive recognition needs a known frame and the message
    of the historical defect. Searching the repository yields comments only; the record itself
    says the traceback was never confirmed. The signature CANNOT be reproduced, and negative
    recognition ("since it is not from `generation/`, it must be stride") would still let
    through any other error carrying that message.

    THE STAKE IS LARGER THAN THE RETRY. The chunked path returns SEGMENT timestamps instead of
    word timestamps - it silently changes the output shape that all alignment and provenance
    rest on. A loud failure of one decode is STRICTLY better here than a silent change of
    semantics. The condition that triggered the bug (`chunk_length_s=None`) was in any case
    removed long ago - the streaming path does not pass it at all.

    Should this bug ever return with a REAL traceback, then - and only then - recognition
    comes back here - as POSITIVE recognition pinned to a specific frame, never as a
    match on the message text alone.
    """
    return False, "retry_disabled_no_historical_signature"
