"""Timestamp counters taken from the pipeline output, WITHOUT TEXT.

WHY: a measured run showed `invalid_timestamp:zero_or_reversed` **137 times** across 211
decodes carrying evidence (exact provenance only 33%). Before anything is repaired, it has to
be known where the degenerate intervals arise.

SCOPE OF THE DIAGNOSIS, NAMED HONESTLY. The two measurement points separate EXACTLY ONE
boundary:

    result returned by `_run_pipeline`   ->   our code before alignment

A matching fingerprint proves that OUR code after `_run_pipeline` did not move the timestamps.
It does **NOT** prove whether a defect arose in the Whisper model or in post-processing inside
the Transformers pipeline - those two sit together on the far side of the boundary. Hence the
name `pipeline_output`, never "raw model output". Instrumenting the internals of Transformers
is a separate decision, to be taken AFTER the data is in.

NO TEXT. Only numbers, indices, type names and digests leave this module. The fingerprint is
computed from timestamps, never from chunk content.

NO REPAIR. This module corrects nothing and guesses no boundaries. `end = start + epsilon`
labelled `exact` would be guessing; an eventual `inferred` status is a separate step AFTER the
diagnosis.
"""
from __future__ import annotations

import hashlib
import math
import numbers
from typing import Any, Dict, List, NamedTuple, Optional, Sequence, Tuple

from provenance import canonical_tokens

# How many position indices to record. A full list at 300 chunks would clutter the log; the
# first and last index are tracked INDEPENDENTLY of this limit (see `_positions`).
MAX_POSITIONS = 20

# Disjoint TIMESTAMP statuses. Every chunk gets exactly one.
TIMESTAMP_STATUSES = (
    "missing_timestamp", "non_finite", "negative_start",
    "zero_length", "reversed", "beyond_snapshot", "timestamp_valid",
)


def _timestamp_type(value: Any) -> str:
    """The type NAME, never a text value."""
    if value is None:
        return "none"
    if isinstance(value, bool):
        return "bool"
    if isinstance(value, int):
        return "int"
    if isinstance(value, float):
        if math.isnan(value):
            return "nan"
        if math.isinf(value):
            return "inf"
        return "float"
    return type(value).__name__


def _fingerprint_value(value: Any) -> Optional[str]:
    """The EXACT numeric value, or `None` when it cannot be honestly encoded.

    `numbers.Real` ALSO covers NumPy scalars (`numpy.float32` is registered there), which the
    Transformers pipeline can return. An earlier version recognised only built-in `int`/`float`,
    so `float32(0.5)` and `float32(7.0)` produced an IDENTICAL token - the fingerprint reported
    "no change" for two different sequences.

    `float.hex()` records the value losslessly (0.1 does not become 0.1000000000000000055).
    A NON-NUMERIC value does not enter here at all: it could be, for instance, the text of a
    word, and text has no right to reach even the hashed material. `None` is returned instead
    and the caller marks the fingerprint INCOMPLETE - see `timestamp_fingerprint`.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, numbers.Integral):
        return "int:{}".format(int(value))
    if isinstance(value, numbers.Real):
        as_float = float(value)
        if math.isnan(as_float):
            return "nan"          # NaN != NaN numerically, so compare by name
        if math.isinf(as_float):
            return "inf:+" if as_float > 0 else "inf:-"
        return "float:{}".format(as_float.hex())
    return None


def fingerprint_scalar(value: Any) -> Optional[str]:
    """Public entry to THE SAME encoder `timestamp_fingerprint` uses.

    The token-level probe measures TOKEN timestamps (single numbers); the chunk audit measures
    WORD timestamps (pairs). A shared encoder is the condition for both fingerprints to talk
    about values the same way - including the rule that a non-numeric value is never encoded by
    force.
    """
    return _fingerprint_value(value)


def _fingerprint_token(timestamp: Any) -> Tuple[str, bool]:
    """(token, is_complete) for a single timestamp."""
    if timestamp is None:
        return "missing", True            # a missing timestamp is a FAITHFULLY represented state
    if not isinstance(timestamp, (tuple, list)) or len(timestamp) != 2:
        return "malformed", False         # the shape cannot be represented without guessing
    parts = []
    complete = True
    for value in timestamp:
        encoded = _fingerprint_value(value)
        if encoded is None:
            complete = False
            parts.append("unencodable:{}".format(_timestamp_type(value)))
        else:
            parts.append(encoded)
    return "|".join(parts), complete


class Fingerprint(NamedTuple):
    """Sequence digest plus an honest statement of whether it describes the sequence IN FULL."""
    digest: str
    complete: bool


def timestamp_fingerprint(chunks: Optional[Sequence[Dict[str, Any]]]) -> Fingerprint:
    """SHA-256 of the ORDERED timestamp sequence. Order matters.

    Why, given that counters exist: two DIFFERENT sequences can land in the same buckets -
    `(0.0, 0.5)` and `(7.0, 8.0)` are both `timestamp_valid`. A counter alone would then report
    "no change".

    `complete=False` means at least one value could not be encoded without risk (e.g. a string
    where a number belongs). Comparing two fingerprints MUST NOT then yield an "identical"
    verdict - the absence of a difference would follow from narrowing, not from the data. This
    is the same principle that separates `unavailable` from `count: 0`.
    """
    tokens, complete = [], True
    for chunk in (chunks or []):
        token, token_complete = _fingerprint_token(
            chunk.get("timestamp") if isinstance(chunk, dict) else None
        )
        tokens.append(token)
        complete = complete and token_complete
    digest = hashlib.sha256("\n".join(tokens).encode("utf-8")).hexdigest()
    return Fingerprint(digest=digest, complete=complete)


def summarize_chunk_timestamps(
    chunks: Optional[Sequence[Dict[str, Any]]],
    sample_rate: int = 16000,
    snapshot_samples: Optional[int] = None,
) -> Dict[str, Any]:
    """Counters for one set of chunks. A pure function - it logs nothing and changes nothing.

    TWO AXES, deliberately separated:
      * TIMESTAMP status (disjoint, `TIMESTAMP_STATUSES`),
      * CONTENT shape (`empty_text` / `single_token` / `multi_token`).
    `provenance_usable` is their CONJUNCTION and the only number matching the real behaviour of
    `align_text_to_spans()`: a multi-token chunk is rejected there as `non_word_level_chunk`,
    and a chunk without text creates no span at all - despite a valid timestamp. Tokenisation is
    the same as in production (`provenance.canonical_tokens`).
    """
    chunk_list = list(chunks or [])
    fingerprint = timestamp_fingerprint(chunk_list)
    summary: Dict[str, Any] = {
        "chunk_count": len(chunk_list),
        # axis 1: timestamp status (disjoint)
        "missing_timestamp": 0,
        "non_finite": 0,
        "negative_start": 0,
        "zero_length": 0,
        "reversed": 0,
        "beyond_snapshot": 0,
        "timestamp_valid": 0,
        # axis 2: content shape
        "empty_text": 0,
        "single_token": 0,
        "multi_token": 0,
        # conjunction of both axes - what can really be attributed to samples
        "provenance_usable": 0,
        "timestamp_types": {},
        "zero_length_positions": [],
        "reversed_positions": [],
        "zero_length_first_pos": None,
        "zero_length_last_pos": None,
        # ALWAYS initialised: the summary shape must not depend on the data, otherwise a
        # consumer cannot tell "there were no degenerates" from "the field was not computed".
        "zero_length_first_pos_pct": None,
        "zero_length_last_pos_pct": None,
        "snapshot_samples": snapshot_samples,
        "sample_rate": sample_rate,
        "degenerate_pct": 0.0,
        "timestamp_fingerprint": fingerprint.digest,
        "fingerprint_complete": fingerprint.complete,
    }
    if not chunk_list:
        return summary

    for index, chunk in enumerate(chunk_list):
        text = (chunk.get("text") or "").strip() if isinstance(chunk, dict) else ""
        token_count = len(canonical_tokens(text)) if text else 0
        if token_count == 0:
            summary["empty_text"] += 1
        elif token_count == 1:
            summary["single_token"] += 1
        else:
            summary["multi_token"] += 1

        timestamp = chunk.get("timestamp") if isinstance(chunk, dict) else None
        status = _timestamp_status(timestamp, sample_rate, snapshot_samples, summary)
        summary[status] += 1
        if status == "zero_length":
            _record_position(summary, "zero_length", index)
        elif status == "reversed":
            _record_position(summary, "reversed", index)
        elif status == "timestamp_valid" and token_count == 1:
            summary["provenance_usable"] += 1

    degenerate = summary["zero_length"] + summary["reversed"]
    summary["degenerate_pct"] = round(degenerate / summary["chunk_count"] * 100, 1)
    last_index = summary["chunk_count"] - 1
    if summary["zero_length_first_pos"] is not None and last_index > 0:
        # Computed from INDEPENDENTLY tracked extreme indices, not from the truncated sample
        # list - with more than 20 degenerates the last recorded index is not the last occurrence.
        summary["zero_length_first_pos_pct"] = round(
            summary["zero_length_first_pos"] / last_index * 100, 1)
        summary["zero_length_last_pos_pct"] = round(
            summary["zero_length_last_pos"] / last_index * 100, 1)
    return summary


def _timestamp_status(timestamp, sample_rate, snapshot_samples, summary) -> str:
    """One DISJOINT status, in the same order as `relative_timestamp_to_samples`."""
    if not isinstance(timestamp, (tuple, list)) or len(timestamp) != 2:
        key = "missing" if timestamp is None else "malformed"
        summary["timestamp_types"][key] = summary["timestamp_types"].get(key, 0) + 1
        return "missing_timestamp"

    start, end = timestamp[0], timestamp[1]
    key = "{}/{}".format(_timestamp_type(start), _timestamp_type(end))
    summary["timestamp_types"][key] = summary["timestamp_types"].get(key, 0) + 1

    if start is None or end is None:
        return "missing_timestamp"
    try:
        start_f, end_f = float(start), float(end)
    except (TypeError, ValueError):
        return "missing_timestamp"

    if not math.isfinite(start_f) or not math.isfinite(end_f):
        return "non_finite"
    if start_f < 0:
        return "negative_start"
    # A zero-length interval is NOT the same as a reversed one, even though both used to end as
    # `zero_or_reversed` - they point at different defects on the far side of the boundary.
    if end_f == start_f:
        return "zero_length"
    if end_f < start_f:
        return "reversed"
    if snapshot_samples is not None and int(round(end_f * sample_rate)) > int(snapshot_samples):
        return "beyond_snapshot"
    return "timestamp_valid"


def _record_position(summary: Dict[str, Any], kind: str, index: int) -> None:
    positions: List[int] = summary["{}_positions".format(kind)]
    if len(positions) < MAX_POSITIONS:
        positions.append(index)
    if kind == "zero_length":
        if summary["zero_length_first_pos"] is None:
            summary["zero_length_first_pos"] = index
        summary["zero_length_last_pos"] = index


# Fields compared between measurement points (classification, not the sequence itself).
COMPARED_FIELDS = (
    "chunk_count", "missing_timestamp", "non_finite", "negative_start", "zero_length",
    "reversed", "beyond_snapshot", "timestamp_valid",
    "empty_text", "single_token", "multi_token", "provenance_usable",
)


def diff_summaries(pipeline_output: Optional[Dict[str, Any]],
                   at_alignment: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Whether OUR code moved the timestamps between `_run_pipeline` and alignment.

    `timestamps_identical` is computed from the FINGERPRINT, because only that sees a value
    change within the same bucket. `classification_counts_identical` stays separate - it says
    something else: whether the DISTRIBUTION of defects changed.
    """
    if pipeline_output is None or at_alignment is None:
        return {
            "comparable": False,
            "timestamps_comparable": False,
            "timestamps_identical": None,
            "classification_counts_identical": None,
            "changed_fields": [],
        }
    changed = [f for f in COMPARED_FIELDS if pipeline_output.get(f) != at_alignment.get(f)]
    # An "identical" verdict comes ONLY from COMPLETE fingerprints. When either is incomplete,
    # the absence of a difference would follow from narrowed encoding rather than from the data -
    # exactly the false evidence this whole track must not produce.
    timestamps_comparable = bool(
        pipeline_output.get("fingerprint_complete") and at_alignment.get("fingerprint_complete")
    )
    return {
        "comparable": True,
        "timestamps_comparable": timestamps_comparable,
        "timestamps_identical": (
            pipeline_output.get("timestamp_fingerprint") == at_alignment.get("timestamp_fingerprint")
            if timestamps_comparable else None
        ),
        "classification_counts_identical": not changed,
        "changed_fields": changed,
    }
