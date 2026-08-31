"""Measurement of RAW token timestamps, INSIDE the Transformers pipeline.

WHY. An earlier step closed one boundary: a 200/200 fingerprint match proved that OUR code
after `_run_pipeline` does not move timestamps. That leaves the other side of the boundary,
where two layers sit TOGETHER - `model.generate()` and Transformers post-processing. This
module separates them:

    audio -> model.generate() -> token_timestamps  <-- NEW measurement point
                              -> tokenizer._decode_asr()
                              -> word chunks       <-- existing `chunk_timestamp_audit`

Both measurements are joined by `decode_id`.

HOW A ZERO-LENGTH SPAN ARISES - read FROM THE 4.47.1 SOURCES, not guessed. In
`tokenization_whisper._decode_asr`, the `return_timestamps == "word"` branch:

    start_time = round(token_timestamps[i] + time_offset, 2)
    end_time   = round(token_timestamps[i + 1] + time_offset, 2)

and `_collate_word_timestamps` builds a word from `(timestamps[first][0], timestamps[last][1])`.
A word therefore has ZERO length exactly when two adjacent token timestamps are equal - and
there are TWO disjoint routes to that equality:

  * **already equal raw** - DTW assigned both tokens the same frame; the defect is in the
    output of `model.generate()`, before `_decode_asr` touches anything;
  * **equal only after rounding** - raw values differ (e.g. 2.1841 and 2.1846) and are made
    equal by `round(..., 2)`; post-processing creates the defect.

So both counters are kept separately and the rounding is reproduced EXACTLY as `_decode_asr`
does it (same `round` function, same number of decimals). The verdict does not fall into a
single "invalid timestamp" bucket: `generation`, `rounding` and `generation_and_rounding` are
three different places to fix.

ATTRIBUTION MUST BE CAUSAL, NOT CORRELATIONAL. A bare count of equal pairs in a decode would
only prove co-occurrence: `_decode_asr` skips special and timestamp tokens, strips the prompt,
cuts the sequence into chunks and merges sub-tokens into words, so an equal pair may sit
somewhere entirely different from a zero-length word. The probe therefore REPRODUCES the
`_decode_asr` state machine (mask, chunk boundaries, word grouping) and classifies EVERY
zero-length word separately: `raw_equal_at_word_boundary` / `rounded_equal_at_word_boundary` /
`unexplained`.

PROOF THAT THE REPRODUCTION IS CORRECT - a fingerprint, not a claim. The reproduced boundaries
are hashed with THE SAME function `chunk_timestamp_audit` uses on the REAL chunks. Matching
digests mean the same pairs of numbers were reproduced, in the same order. A mismatch degrades
the verdict to its `_candidate` form - the name then carries the strength of the evidence.

TOKENS: IDS ARE READ TRANSIENTLY AND NEVER LEAVE THE PROCESS. Reproducing the grouping needs
token ids and tokenizer calls; all of that lives in the memory of a single call. Only numbers,
type names and digests OF TIMES are emitted. No token id, no word and no fragment of text is
logged or hashed. A value that cannot be honestly encoded as a number does NOT even enter the
hashed material - the fingerprint is then marked INCOMPLETE.

NO REPAIR. Nothing here corrects boundaries or widens zero-length intervals.

NO SECOND INFERENCE. The measurement reads a tensor `_forward` has already returned.

State lives only in `contextvars` for the duration of one `probe_scope(decode_id)` - there is
no global `last_result`, which with four executor threads would mix decodes together.
"""
from __future__ import annotations

import contextvars
import hashlib
import math
import numbers
import threading
from contextlib import contextmanager
from typing import Any, Dict, List, NamedTuple, Optional, Sequence, Tuple

from chunk_diagnostics import fingerprint_scalar, timestamp_fingerprint

# Number of decimal places used by `_decode_asr` (transformers 4.47.1,
# `tokenization_whisper.py`, `round(token_timestamps[i] + time_offset, 2)`).
# Changing this constant without checking that version's sources invalidates the rounding
# collision counter.
DECODE_ASR_ROUNDING_DECIMALS = 2

# How many individual measurements to keep in the result. Our streaming path performs EXACTLY
# one `_forward` per decode; the limit protects the log should a chunked path ever appear.
MAX_MEASUREMENTS = 8

# Disjoint statuses for READING the sequence.
READ_STATUSES = (
    "ok", "missing", "empty", "unindexable", "not_a_sequence", "conversion_failed",
)

class BoundaryConvention(NamedTuple):
    """How a GIVEN version of `_decode_asr` builds a word range from the token timestamp sequence.

    `bounds(first, last, ts)` returns `(start_raw, end_raw, end_unavailable, start_is_constant)`
    for a word made of the tokens at indices `first..last` in `token_ids` AFTER `_strip_prompt`.
    """
    version: str
    bounds: Any
    library_returns_none_end: bool   # whether the source has an explicit `end = None` branch


def _bounds_4_47_1(first: int, last: int, ts: Sequence[Any]):
    """4.47.1: `start = ts[i]`, `end = ts[i+1]`, with an explicit `end = None` branch at the end.

        start_time = round(token_timestamps[i] + time_offset, 2)
        if i + 1 < len(token_timestamps):
            end_time = round(token_timestamps[i + 1] + time_offset, 2)
        else:
            end_time = None  # should never happen
    """
    start_raw = ts[first] if first < len(ts) else None
    end_unavailable = last + 1 >= len(ts)
    end_raw = None if end_unavailable else ts[last + 1]
    return start_raw, end_raw, end_unavailable, False


def _bounds_4_57_5(first: int, last: int, ts: Sequence[Any]):
    """4.57.5: `start = ts[i-1]` OR THE CONSTANT 0.0 for `i == 0`, `end = ts[i]`. No `None` branch.

        if i == 0:
            start_time = round(0.0 + time_offset, 2)
        else:
            start_time = round(token_timestamps[i - 1] + time_offset, 2)
        end_time = round(token_timestamps[i] + time_offset, 2)

    The first token takes its start from a CONSTANT, not from the array - this is not `ts[-1]`
    and must not be computed that way. This version does not handle a missing end: an
    out-of-range index would raise inside the library, so here it is an INCOMPATIBILITY state,
    not "end unknown".
    """
    if first == 0:
        start_raw, start_is_constant = 0.0, True
    else:
        start_raw = ts[first - 1] if first - 1 < len(ts) else None
        start_is_constant = False
    end_unavailable = last >= len(ts)
    end_raw = None if end_unavailable else ts[last]
    return start_raw, end_raw, end_unavailable, start_is_constant


# Versions whose `_decode_asr` convention was READ FROM THE SOURCES and reproduced here.
# Adding a version REQUIRES reading `_decode_asr` in THAT wheel and a contract test on
# the real code - otherwise we would be pinning our own idea of the library. Ranges (`>=4.57`)
# are forbidden: 4.57.5 assembles a word differently from 4.47.1, so reproducing under the
# wrong version would return numbers that LOOK like evidence.
DECODE_ASR_CONVENTIONS: Dict[str, BoundaryConvention] = {
    "4.47.1": BoundaryConvention("4.47.1", _bounds_4_47_1, library_returns_none_end=True),
    "4.57.5": BoundaryConvention("4.57.5", _bounds_4_57_5, library_returns_none_end=False),
}
SUPPORTED_DECODE_ASR_VERSIONS = tuple(sorted(DECODE_ASR_CONVENTIONS))

# Disjoint statuses for REPRODUCING word boundaries.
BOUNDARY_STATUSES = (
    "ok", "no_grouping", "no_tokens", "unsupported_stride",
    "unverified_decode_asr_version", "failed",
)

# What the verdict rests on. This field travels with the verdict and decides its NAME.
ATTRIBUTION_BASES = ("word_boundary", "sequence_candidate", "none")

# Disjoint layer verdicts. `undetermined` exists so that a missing measurement NEVER looks
# like "nothing was found" - the same principle as `unavailable` vs `count: 0`.
#
# The `_candidate` suffix is NOT decoration: without reproduced word boundaries we only know
# that an equal pair occurred IN THE SAME decode as a zero-length word - which is
# co-occurrence, not causation. The suffix travels with the value into every table and log, so
# it cannot be lost in quotation.
LAYER_VERDICTS = (
    "undetermined",
    "no_word_zero_spans",
    # causal: the boundary of a specific zero-length word
    "generation",
    "rounding",
    "generation_and_rounding",
    "unexplained_post_processing",
    # correlational: counters at the level of the whole sequence
    "generation_candidate",
    "rounding_candidate",
    "generation_and_rounding_candidate",
    "unexplained_candidate",
)

# Counters summable across `_forward` calls within a single decode.
SUMMABLE_FIELDS = (
    "count", "adjacent_pairs_total", "adjacent_pairs", "adjacent_unmeasurable",
    "adjacent_equal_raw", "adjacent_equal_rounded_only", "adjacent_negative",
    "non_finite", "negative_value", "non_numeric",
    # reproduced word boundaries
    "word_count", "zero_length_words", "raw_equal_at_word_boundary",
    "rounded_equal_at_word_boundary", "word_boundary_unmeasurable", "word_end_missing",
    "prompt_tokens_stripped", "first_token_constant_start",
)


# -- measurement of one sequence --------------------------------------------------

def sequence_fingerprint(values: Sequence[Any]) -> Tuple[str, bool]:
    """(digest, is_complete) of an ORDERED sequence of numbers.

    The same encoder as in `chunk_diagnostics`, deliberately - so that both sides of the
    boundary talk about values the same way. A non-numeric value does not enter the hashed
    material (it could be content), so the digest is then marked INCOMPLETE and comparing two
    digests must not yield an "identical" verdict.
    """
    tokens: List[str] = []
    complete = True
    for value in values:
        encoded = fingerprint_scalar(value)
        if encoded is None:
            complete = False
            tokens.append("unencodable:{}".format(type(value).__name__))
        else:
            tokens.append(encoded)
    digest = hashlib.sha256("\n".join(tokens).encode("utf-8")).hexdigest()
    return digest, complete


def _as_float(value: Any) -> Optional[float]:
    """A number or `None`. `bool` is NOT a number here - `True` where a time belongs is a defect, not 1.0."""
    if isinstance(value, bool):
        return None
    if isinstance(value, numbers.Real):
        return float(value)
    return None


def _rounded_or_none(value: Any) -> Optional[float]:
    """A rounded FINITE value or `None`. NaN and inf are not a boundary, they are its absence."""
    as_float = _as_float(value)
    if as_float is None or not math.isfinite(as_float):
        return None
    return round(as_float, DECODE_ASR_ROUNDING_DECIMALS)


def _run_lengths(values: Sequence[Optional[float]]) -> Tuple[int, Dict[str, int]]:
    """(longest run of identical values, histogram of runs >= 2).

    `None` = an UNMEASURABLE value (non-numeric or non-finite). It breaks the run and never
    forms a pair - without this, a NaN in the middle of a sequence would glue together
    neighbours that are not neighbours in the data, producing "equal timestamps" the model
    never returned.
    """
    histogram: Dict[str, int] = {}
    longest = 0
    current = 0
    previous: Optional[float] = None

    def close(run: int) -> None:
        if run >= 2:
            histogram[str(run)] = histogram.get(str(run), 0) + 1

    for value in values:
        if value is None:
            close(current)
            longest = max(longest, current)
            current, previous = 0, None
            continue
        if current and previous is not None and value == previous:
            current += 1
        else:
            close(current)
            longest = max(longest, current)
            current = 1
        previous = value
    close(current)
    return max(longest, current), histogram


def summarize_token_timestamps(values: Optional[Sequence[Any]]) -> Dict[str, Any]:
    """Counters for one sequence of token timestamps. A pure function - it logs nothing.

    The result shape is FIXED and does not depend on the data: a consumer cannot confuse
    "there were no degenerates" with "the field was not computed".
    """
    raw = list(values or [])
    digest, fingerprint_complete = sequence_fingerprint(raw)
    summary: Dict[str, Any] = {
        "count": len(raw),
        "numeric_count": 0,
        "non_numeric": 0,
        "non_finite": 0,
        "negative_value": 0,
        "unique_count": 0,
        "unique_rounded_count": 0,
        "adjacent_pairs_total": 0,
        "adjacent_pairs": 0,
        "adjacent_unmeasurable": 0,
        "adjacent_equal_raw": 0,
        "adjacent_equal_rounded_only": 0,
        "adjacent_negative": 0,
        "run_length_max": 0,
        "run_length_histogram": {},
        "rounded_run_length_max": 0,
        "rounded_run_length_histogram": {},
        "min_value": None,
        "max_value": None,
        "min_positive_step": None,
        "monotonic_non_decreasing": None,
        # How many leading values are EXACTLY zero. This is the only RUNTIME trace of how many
        # prefix positions enter the array: 4.57.x fills it with `cat([zeros(num_input_ids),
        # jump_times, [last]])` after cutting the prefix out of DTW, so there are as many zeros
        # as forced tokens; 4.47.1 has a single zero from `timestamps[:, 1:] = jump_times`.
        # Measured, not assumed - it confirms the convention against live data.
        "leading_zero_timestamps": 0,
        "rounding_decimals": DECODE_ASR_ROUNDING_DECIMALS,
        "fingerprint": digest,
        "fingerprint_complete": fingerprint_complete,
    }
    if not raw:
        return summary

    # Positions preserved 1:1 with the input sequence; `None` = an unmeasurable value.
    # Compacting the list (dropping NaN) would turn two NON-neighbours into neighbours, i.e.
    # produce "equal timestamps" that are absent from the data.
    positional: List[Optional[float]] = []
    for value in raw:
        as_float = _as_float(value)
        if as_float is None:
            summary["non_numeric"] += 1
            positional.append(None)
            continue
        if not math.isfinite(as_float):
            summary["non_finite"] += 1
            positional.append(None)
            continue
        if as_float < 0:
            summary["negative_value"] += 1
        positional.append(as_float)

    measurable = [value for value in positional if value is not None]
    summary["numeric_count"] = len(measurable)
    summary["adjacent_pairs_total"] = max(0, len(positional) - 1)
    if not measurable:
        summary["adjacent_unmeasurable"] = summary["adjacent_pairs_total"]
        return summary

    rounded_positional = [
        None if value is None else round(value, DECODE_ASR_ROUNDING_DECIMALS)
        for value in positional
    ]
    summary["unique_count"] = len(set(measurable))
    summary["unique_rounded_count"] = len({v for v in rounded_positional if v is not None})
    for value in positional:
        if value == 0.0:
            summary["leading_zero_timestamps"] += 1
        else:
            break
    summary["min_value"] = min(measurable)
    summary["max_value"] = max(measurable)

    monotonic = True
    min_positive_step: Optional[float] = None
    for index in range(len(positional) - 1):
        left, right = positional[index], positional[index + 1]
        if left is None or right is None:
            summary["adjacent_unmeasurable"] += 1
            continue
        summary["adjacent_pairs"] += 1
        step = right - left
        if step < 0:
            summary["adjacent_negative"] += 1
            monotonic = False
        if right == left:
            summary["adjacent_equal_raw"] += 1
        elif rounded_positional[index + 1] == rounded_positional[index]:
            # Raw values DIFFER and are made equal only by `round(..., 2)` in `_decode_asr`.
            # This is the only counter that points a finger at post-processing.
            summary["adjacent_equal_rounded_only"] += 1
        if step > 0 and (min_positive_step is None or step < min_positive_step):
            min_positive_step = step
    summary["monotonic_non_decreasing"] = monotonic
    summary["min_positive_step"] = min_positive_step

    summary["run_length_max"], summary["run_length_histogram"] = _run_lengths(positional)
    summary["rounded_run_length_max"], summary["rounded_run_length_histogram"] = _run_lengths(
        rounded_positional)
    return summary


# -- reading the `_forward` output --------------------------------------------------

def extract_token_timestamps(forward_output: Any) -> Tuple[List[Any], Dict[str, Any]]:
    """(sequence for POSITION 0 in the batch, read metadata).

    Position 0, because that is exactly what `_decode_asr` reads:
    `output["token_timestamps"][0].tolist()`. Measuring anything else would describe data that
    never became chunks.

    In 4.47.1 `_forward` returns, for `return_timestamps="word"`, either a LIST of tensors (the
    `segments` branch, enabled by `return_segments=True`) or a 2D tensor (the branch without
    segments). Both shapes index the same way, so they are treated alike and which one occurred
    is recorded.
    """
    meta: Dict[str, Any] = {
        "read_status": "missing",
        "container_type": None,
        "batch_items": None,
        "element_type": None,
    }
    container = forward_output.get("token_timestamps") if isinstance(forward_output, dict) else None
    if container is None:
        return [], meta

    meta["container_type"] = type(container).__name__
    try:
        meta["batch_items"] = len(container)
    except TypeError:
        meta["batch_items"] = None
    if meta["batch_items"] == 0:
        meta["read_status"] = "empty"
        return [], meta

    try:
        first = container[0]
    except (TypeError, KeyError, IndexError):
        meta["read_status"] = "unindexable"
        return [], meta

    meta["element_type"] = type(first).__name__
    try:
        values = first.tolist() if hasattr(first, "tolist") else list(first)
    except Exception:
        # The exception TYPE NAME goes to `record_failure` at the caller; the message NEVER
        # does, because an object's `repr` can carry content - exactly the leak a smoke run
        # caught.
        meta["read_status"] = "conversion_failed"
        return [], meta

    if not isinstance(values, list):
        meta["read_status"] = "not_a_sequence"
        return [], meta

    meta["read_status"] = "ok"
    return values, meta


class WordGrouping(NamedTuple):
    """A tokenizer facade - EXACTLY the operations `_decode_asr` uses, and nothing more.

    A facade rather than a hard import, for two reasons: production substitutes the REAL
    library functions (`tokenizer._strip_prompt`, `_combine_tokens_into_words`), so the grouping
    cannot drift from that version; tests substitute a stub and exercise the state machine with
    no model.
    """
    strip_prompt: Any             # List[int] -> List[int]
    is_special: Any               # int -> bool
    detect_language: Any          # int -> Optional[str]
    combine_tokens_into_words: Any  # (List[int], Optional[str]) -> List[List[int]]
    timestamp_begin: int
    time_precision: float
    library_version: Optional[str] = None


def build_word_grouping(pipeline_obj: Any) -> Optional[WordGrouping]:
    """A facade built from the LIVE pipeline. `None` when anything is missing - never guessing."""
    try:
        import transformers  # noqa: WPS433
        from transformers.models.whisper.tokenization_whisper import (  # noqa: WPS433
            LANGUAGES,
            _combine_tokens_into_words,
        )
    except Exception:
        return None
    try:
        tokenizer = pipeline_obj.tokenizer
        prompt_token_id = tokenizer.convert_tokens_to_ids("<|startofprev|>")
        decoder_start_token_id = tokenizer.convert_tokens_to_ids("<|startoftranscript|>")
        timestamp_begin = tokenizer.convert_tokens_to_ids("<|notimestamps|>") + 1
        special_ids = set(tokenizer.all_special_ids)
        # The same arithmetic as in `postprocess`: `chunk_length / max_source_positions`.
        time_precision = (
            pipeline_obj.feature_extractor.chunk_length
            / pipeline_obj.model.config.max_source_positions
        )

        def detect_language(token_id: int) -> Optional[str]:
            # A language token (`<|de|>`), not content. The shell is stripped exactly as `_decode_asr` does.
            return LANGUAGES.get(tokenizer.decode([token_id])[2:-2], None)

        return WordGrouping(
            strip_prompt=lambda ids: tokenizer._strip_prompt(
                ids, prompt_token_id, decoder_start_token_id),
            is_special=lambda token: token in special_ids,
            detect_language=detect_language,
            combine_tokens_into_words=lambda tokens, language: _combine_tokens_into_words(
                tokenizer, tokens, language)[2],
            timestamp_begin=int(timestamp_begin),
            time_precision=float(time_precision),
            library_version=getattr(transformers, "__version__", None),
        )
    except Exception:
        return None


def _empty_boundaries(status: str) -> Dict[str, Any]:
    """A fixed shape even when nothing was reproduced - zeros must not impersonate a measurement."""
    return {
        "boundary_status": status,
        "word_count": None,
        "zero_length_words": None,
        "raw_equal_at_word_boundary": None,
        "rounded_equal_at_word_boundary": None,
        "word_boundary_unmeasurable": None,
        "word_end_missing": None,
        "first_token_constant_start": None,
        "boundary_convention": None,
        "prompt_tokens_stripped": None,
        "reproduced_chunk_fingerprint": None,
        "reproduced_fingerprint_complete": None,
    }


def reproduce_word_boundaries(token_ids: Optional[Sequence[int]],
                              token_timestamps: Sequence[Any],
                              grouping: Optional[WordGrouping],
                              stride_present: bool = False) -> Dict[str, Any]:
    """Reproduces word boundaries as `_decode_asr` OF A GIVEN VERSION will - and classifies zero ones.

    The conventions live in `DECODE_ASR_CONVENTIONS` and are selected by
    `grouping.library_version`; a version
    outside the registry ends as `unverified_decode_asr_version`, because reproducing under the
    wrong convention does not crash - it returns a consistent FALSEHOOD. Differences between the
    supported versions:

        4.47.1  start = ts[first]      end = ts[last+1]      explicit `end = None` branch
        4.57.5  start = ts[first-1]    end = ts[last]        NO `end = None` branch
                (for first == 0 the start comes from the CONSTANT 0.0, not from the array)

    Common to both: the state machine follows the source - a special token only updates the
    language; a timestamp token opens a chunk or (when its time differs from the opening one)
    closes it; a regular token adds a pair. A word takes its start from its FIRST token and its
    end from its LAST, and the grouping is done by the REAL `_combine_tokens_into_words` from
    the library.

    Scope: ONE `_forward` output and NO stride, i.e. exactly our streaming path. With a stride,
    `_decode_asr` enables the `skip` / `last_timestamp` / `first_timestamp` branches and adds
    `time_offset`; reproducing those blind would give numbers that LOOK like evidence, so
    `unsupported_stride` is returned instead.

    Agreement with every supported version is enforced by CONTRACT tests against the real
    library code (`whisper/test_decode_asr_contract.py`), not by reading the sources alone.
    """
    if stride_present:
        return _empty_boundaries("unsupported_stride")
    if grouping is None:
        return _empty_boundaries("no_grouping")
    # The `(ts[i], ts[i+1])` convention is read from the 4.47.1 sources. On another version the
    # reproduction would not crash - it would give CONSISTENT but false numbers. The fingerprint
    # would catch the drift, but this guard names the cause outright instead of leaving it as
    # "the data does not match".
    convention = DECODE_ASR_CONVENTIONS.get(grouping.library_version)
    if convention is None:
        return _empty_boundaries("unverified_decode_asr_version")
    if not token_ids:
        return _empty_boundaries("no_tokens")

    stripped = grouping.strip_prompt(list(token_ids))
    result = _empty_boundaries("ok")
    result["prompt_tokens_stripped"] = len(token_ids) - len(stripped)
    result["boundary_convention"] = convention.version

    segments: List[Tuple[List[int], Optional[str]]] = []
    current: List[int] = []
    chunk_start_time: Optional[float] = None
    last_language: Optional[str] = None

    for index, token in enumerate(stripped):
        if grouping.is_special(token):
            language = grouping.detect_language(token)
            if language is not None:
                last_language = language
            continue
        if token >= grouping.timestamp_begin:
            time = round((token - grouping.timestamp_begin) * grouping.time_precision, 2)
            if chunk_start_time is None:
                chunk_start_time = time
            elif time == chunk_start_time:
                # A duplicated timestamp token - the source explicitly describes this as a
                # model error and treats it as a fresh start, not as an end.
                pass
            else:
                segments.append((current, last_language))
                current, chunk_start_time = [], None
            continue
        current.append(index)
    if current:
        # "Leftover tokens": no closing timestamp, yet words are still produced.
        segments.append((current, last_language))

    spans: List[Dict[str, Any]] = []
    counters = {"word_count": 0, "zero_length_words": 0, "raw_equal_at_word_boundary": 0,
                "rounded_equal_at_word_boundary": 0, "word_boundary_unmeasurable": 0,
                "word_end_missing": 0, "first_token_constant_start": 0}

    for indices_in_output, language in segments:
        if not indices_in_output:
            continue
        chunk_tokens = [stripped[index] for index in indices_in_output]
        for word_indices in grouping.combine_tokens_into_words(chunk_tokens, language):
            if not word_indices:
                continue
            counters["word_count"] += 1
            first = indices_in_output[word_indices[0]]
            last = indices_in_output[word_indices[-1]]
            start_raw, end_raw, end_missing, start_is_constant = convention.bounds(
                first, last, token_timestamps)
            if start_is_constant:
                counters["first_token_constant_start"] += 1
            start = _rounded_or_none(start_raw)
            end = _rounded_or_none(end_raw)
            spans.append({"timestamp": (start, end)})
            if end_missing:
                counters["word_end_missing"] += 1
                continue
            if start is None or end is None:
                # The boundary exists but cannot be evaluated (NaN, inf, non-numeric value).
                # Without this counter such a case would silently fall out of EVERY bucket.
                counters["word_boundary_unmeasurable"] += 1
                continue
            if start != end:
                continue
            counters["zero_length_words"] += 1
            if start_raw == end_raw:
                counters["raw_equal_at_word_boundary"] += 1
            else:
                counters["rounded_equal_at_word_boundary"] += 1

    fingerprint = timestamp_fingerprint(spans)
    result.update(counters)
    result["reproduced_chunk_fingerprint"] = fingerprint.digest
    result["reproduced_fingerprint_complete"] = fingerprint.complete
    return result


def token_ids_for_reproduction(forward_output: Any) -> Optional[List[int]]:
    """Token ids for position 0 - TRANSIENTLY, solely to reproduce the grouping.

    This list does not leave the process: it is not logged, not hashed and enters no result
    field. It goes only into `reproduce_word_boundaries`, which returns counters alone.
    `_decode_asr` reads exactly the same thing: `output["tokens"][0].tolist()`.
    """
    tokens = forward_output.get("tokens") if isinstance(forward_output, dict) else None
    if tokens is None:
        return None
    try:
        first = tokens[0]
        values = first.tolist() if hasattr(first, "tolist") else list(first)
    except Exception:
        return None
    if not isinstance(values, list):
        return None
    return [value for value in values if isinstance(value, int)] if all(
        isinstance(value, int) for value in values) else None


def sequence_shape(forward_output: Any) -> Optional[Tuple[int, ...]]:
    """The SHAPE of `tokens`, from the `.shape` attribute only. Never indexing, never values.

    Why touch `tokens` at all: `_decode_asr` indexes `token_timestamps[i]` with the index of the
    loop over `token_ids`, and `token_ids` have already passed through `_strip_prompt`. Two
    lists of different length mean two DIFFERENT axes are being paired - and that is the only
    mechanism which explains a zero-length word with not a single equal adjacent pair.

    `.shape` is a tuple of numbers; it cannot carry content. A missing attribute -> `None`,
    i.e. "not measured", never guessing from indices.
    """
    tokens = forward_output.get("tokens") if isinstance(forward_output, dict) else None
    shape = getattr(tokens, "shape", None)
    if shape is None:
        return None
    try:
        return tuple(int(dimension) for dimension in shape)
    except (TypeError, ValueError):
        return None


def measure_forward_output(forward_output: Any,
                           grouping: Optional[WordGrouping] = None) -> Dict[str, Any]:
    """Full measurement of one `_forward` call: sequence plus reproduced word boundaries."""
    values, meta = extract_token_timestamps(forward_output)
    summary = summarize_token_timestamps(values)
    summary.update(meta)
    stride_present_flag = bool(
        isinstance(forward_output, dict) and forward_output.get("stride") is not None)
    summary.update(reproduce_word_boundaries(
        token_ids_for_reproduction(forward_output) if meta["read_status"] == "ok" else None,
        values,
        grouping,
        stride_present=stride_present_flag,
    ))
    shape = sequence_shape(forward_output)
    summary["sequence_shape"] = list(shape) if shape else None
    summary["sequence_length"] = shape[-1] if shape else None
    # `None` = nothing to compare. `False` = two axes of different length, i.e. `_decode_asr`
    # pairs a timestamp with a different token than it appears to.
    summary["length_matches_timestamps"] = (
        None if summary["sequence_length"] is None or meta["read_status"] != "ok"
        else summary["sequence_length"] == summary["count"]
    )
    # `stride` is present in the output ONLY on the chunked path. When it is, `_decode_asr` adds
    # `time_offset`, and the rounding we reproduce is then computed from a different base - the
    # collision counter stops being evidence, and that has to be visible, not implicit.
    stride_present = bool(isinstance(forward_output, dict) and forward_output.get("stride") is not None)
    summary["stride_present"] = stride_present
    summary["zero_time_offset_assumed"] = not stride_present
    return summary


# -- per-decode state ---------------------------------------------------------------

_ACTIVE_PROBE: "contextvars.ContextVar[Optional[TokenTimestampProbe]]" = contextvars.ContextVar(
    "barnaba_token_timestamp_probe", default=None
)


class TokenTimestampProbe:
    """Container for the measurements of ONE decode. Visible only inside its own context."""

    def __init__(self, decode_id: Any, environment: Optional[Dict[str, Any]] = None):
        self.decode_id = decode_id
        self.environment = dict(environment or {})
        self._lock = threading.Lock()
        self._measurements: List[Dict[str, Any]] = []
        self._forward_calls = 0
        self._failures: List[str] = []

    def record(self, measurement: Dict[str, Any]) -> None:
        with self._lock:
            self._forward_calls += 1
            if len(self._measurements) < MAX_MEASUREMENTS:
                self._measurements.append(measurement)

    def record_failure(self, exc: BaseException) -> None:
        """The exception TYPE NAME ONLY. The message could carry source text."""
        with self._lock:
            self._failures.append(type(exc).__name__)

    def result(self) -> Dict[str, Any]:
        with self._lock:
            measurements = list(self._measurements)
            failures = list(self._failures)
            forward_calls = self._forward_calls
        return {
            "decode_id": self.decode_id,
            "probe_status": _probe_status(measurements, failures),
            "forward_calls": forward_calls,
            "measurements_recorded": len(measurements),
            "probe_failures": failures,
            "environment": dict(self.environment),
            "totals": _totals(measurements),
            "measurements": measurements,
        }


def _probe_status(measurements: List[Dict[str, Any]], failures: List[str]) -> str:
    if measurements and failures:
        return "degraded"
    if measurements:
        return "ok"
    if failures:
        return "failed"
    return "no_measurement"


def _totals(measurements: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Counter totals. `None` in summed fields when there was NO measurement at all.

    Zero and "not measured" are two different states; returning zeros for an empty list would
    turn absent data into proof that everything is fine.
    """
    totals: Dict[str, Any] = {field: None for field in SUMMABLE_FIELDS}
    totals["sequences"] = len(measurements)
    totals["all_sequences_read"] = None
    totals["all_fingerprints_complete"] = None
    totals["all_boundaries_reproduced"] = None
    totals["boundary_statuses"] = []
    totals["reproduced_chunk_fingerprint"] = None
    totals["reproduced_fingerprint_complete"] = None
    if not measurements:
        return totals
    for field in SUMMABLE_FIELDS:
        totals[field] = sum(int(m.get(field) or 0) for m in measurements)
    totals["all_sequences_read"] = all(m.get("read_status") == "ok" for m in measurements)
    totals["all_fingerprints_complete"] = all(bool(m.get("fingerprint_complete")) for m in measurements)
    totals["all_boundaries_reproduced"] = all(
        m.get("boundary_status") == "ok" for m in measurements)
    totals["boundary_statuses"] = sorted({str(m.get("boundary_status")) for m in measurements})
    # The fingerprint can be compared with the chunk audit ONLY for a single `_forward` call.
    # With several, the audit describes their concatenation while we would hold partial digests -
    # the comparison would then be false evidence, so instead there is nothing to compare.
    if len(measurements) == 1:
        totals["reproduced_chunk_fingerprint"] = measurements[0].get("reproduced_chunk_fingerprint")
        totals["reproduced_fingerprint_complete"] = measurements[0].get(
            "reproduced_fingerprint_complete")
    return totals


@contextmanager
def probe_scope(decode_id: Any, enabled: bool = True, environment: Optional[Dict[str, Any]] = None):
    """Opens measurement for ONE decode. Disabled -> `None` and no trace at all.

    The context must be opened in the same thread that calls the pipeline - `contextvars` gives
    each executor thread its own state, so four concurrent decodes cannot see one another's
    measurements.
    """
    if not enabled:
        yield None
        return
    probe = TokenTimestampProbe(decode_id, environment)
    token = _ACTIVE_PROBE.set(probe)
    try:
        yield probe
    finally:
        _ACTIVE_PROBE.reset(token)


def active_probe() -> Optional[TokenTimestampProbe]:
    return _ACTIVE_PROBE.get()


# ── the pipeline subclass ─────────────────────────────────────────────────────────────────────────

def make_probe_pipeline_class(base_cls: type, grouping_builder: Any = None) -> type:
    """Builds a subclass that overrides `_forward` ONLY.

    The base class and the facade builder are parameters rather than hard imports: tests can
    substitute a stub and exercise the state machine with no GPU and no transformers, while
    production gets exactly the class `pipeline()` returned and the REAL library functions.
    """
    build_grouping = grouping_builder or build_word_grouping

    class TokenTimestampProbePipeline(base_cls):  # type: ignore[misc, valid-type]
        """Diagnostic ASR subclass. It changes neither the input nor the output of `_forward`."""

        def _forward(self, model_inputs, *args, **kwargs):
            output = super()._forward(model_inputs, *args, **kwargs)
            probe = None
            try:
                probe = active_probe()
                if probe is not None:
                    probe.record(measure_forward_output(output, build_grouping(self)))
            except Exception as exc:  # fail-open: diagnostics must not change emission
                try:
                    if probe is not None:
                        probe.record_failure(exc)
                except Exception:
                    pass
            return output

    return TokenTimestampProbePipeline


def build_probe_pipeline_class():
    """A subclass over the REAL `AutomaticSpeechRecognitionPipeline`, or `None`.

    The import is lazy so the module can be tested without transformers. `None` instead of an
    exception, because missing diagnostics must not block service startup.
    """
    try:
        from transformers.pipelines.automatic_speech_recognition import (
            AutomaticSpeechRecognitionPipeline,
        )
    except Exception:
        return None
    return make_probe_pipeline_class(AutomaticSpeechRecognitionPipeline)


# -- joining the two measurement points ---------------------------------------------

def reproduction_matches_audit(totals: Optional[Dict[str, Any]],
                               chunk_summary: Optional[Dict[str, Any]]) -> Optional[bool]:
    """Whether the reproduced word boundaries are EXACTLY those `_decode_asr` returned.

    The comparison runs over a FINGERPRINT computed by the same function on both sides, so a
    match means: the same pairs of numbers, in the same order, in the same quantity. That is the
    condition under which per-word attribution may be called causal.

    `None` = nothing to compare (no reproduction, or either digest incomplete); the verdict then
    drops to its `_candidate` form instead of impersonating evidence.
    """
    if not isinstance(totals, dict) or not isinstance(chunk_summary, dict):
        return None
    if not totals.get("all_boundaries_reproduced"):
        return None
    reproduced = totals.get("reproduced_chunk_fingerprint")
    audited = chunk_summary.get("timestamp_fingerprint")
    if not reproduced or not audited:
        return None
    if not totals.get("reproduced_fingerprint_complete") or not chunk_summary.get(
            "fingerprint_complete"):
        # An incomplete digest means something could not be encoded - the absence of a
        # difference would follow from narrowed encoding, not from the data.
        return None
    return reproduced == audited


def classify_zero_span_layer(totals: Optional[Dict[str, Any]],
                             chunk_summary: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Which layer produced the zero-length word ranges - based on BOTH measurement points.

    TWO STRENGTHS OF EVIDENCE, distinguished in the verdict NAME:

    * `attribution_basis == "word_boundary"` - the `_decode_asr` state machine was reproduced
      and the digest of the reproduced boundaries matches the audit of the real chunks, so every
      zero-length word has its own verified boundary. Verdicts without a suffix: `generation`
      (the boundary is already zero raw), `rounding` (`round(..., 2)` makes it equal),
      `generation_and_rounding` (both mechanisms present, reported TOGETHER),
      `unexplained_post_processing` (a zero-length word whose boundary neither route explains -
      i.e. grouping).
    * `attribution_basis == "sequence_candidate"` - boundaries were not reproduced or the digest
      does not match; what remains are sequence-level counters, which prove CO-OCCURRENCE,
      not causation. The verdicts take the `_candidate` suffix.

    `undetermined` (basis `none`) is reserved for a missing measurement - a gap in the data has
    no right to look like a clean result.
    """
    word_zero = chunk_summary.get("zero_length") if isinstance(chunk_summary, dict) else None
    raw_equal = totals.get("adjacent_equal_raw") if isinstance(totals, dict) else None
    rounded_only = totals.get("adjacent_equal_rounded_only") if isinstance(totals, dict) else None
    readable = bool(totals.get("all_sequences_read")) if isinstance(totals, dict) else False
    matches = reproduction_matches_audit(totals, chunk_summary)

    fields = {
        "attribution_basis": "none",
        "reproduction_matches": matches,
        # `None` outside the causal path: boundary counters from an UNVERIFIED reproduction
        # have no right to look accounting-consistent.
        "boundary_accounting_matches": None,
        "word_zero_length": word_zero,
        "zero_length_words_reproduced": (
            totals.get("zero_length_words") if isinstance(totals, dict) else None),
        "raw_equal_at_word_boundary": (
            totals.get("raw_equal_at_word_boundary") if isinstance(totals, dict) else None),
        "rounded_equal_at_word_boundary": (
            totals.get("rounded_equal_at_word_boundary") if isinstance(totals, dict) else None),
        "raw_equal_adjacent": raw_equal,
        "rounding_only_adjacent": rounded_only,
    }
    if word_zero is None or raw_equal is None or rounded_only is None or not readable:
        return {"layer_verdict": "undetermined", **fields}
    if word_zero == 0:
        return {"layer_verdict": "no_word_zero_spans", **fields}

    if matches:
        fields["attribution_basis"] = "word_boundary"
        raw_boundary = totals.get("raw_equal_at_word_boundary") or 0
        rounded_boundary = totals.get("rounded_equal_at_word_boundary") or 0
        # ACCOUNTING CONSISTENCY is a NECESSARY condition, checked BEFORE splitting into routes.
        # Equality, not `max(0, ...)`: over-counting (boundaries explaining MORE zero-length
        # words than the audit sees) is as dangerous as under-counting, and a floored
        # would hide it in a zero. The previous version let an unexplained word through when
        # both routes had a hit - a mixed result swallowed the third case.
        fields["boundary_accounting_matches"] = (
            raw_boundary + rounded_boundary == int(word_zero))
        if not fields["boundary_accounting_matches"]:
            return {"layer_verdict": "unexplained_post_processing", **fields}

        if raw_boundary > 0 and rounded_boundary > 0:
            verdict = "generation_and_rounding"
        elif raw_boundary > 0:
            verdict = "generation"
        else:
            # The accounting matches and `word_zero > 0`, so `rounded_boundary > 0`.
            verdict = "rounding"
        return {"layer_verdict": verdict, **fields}

    fields["attribution_basis"] = "sequence_candidate"
    if raw_equal > 0 and rounded_only > 0:
        return {"layer_verdict": "generation_and_rounding_candidate", **fields}
    if raw_equal > 0:
        return {"layer_verdict": "generation_candidate", **fields}
    if rounded_only > 0:
        return {"layer_verdict": "rounding_candidate", **fields}
    return {"layer_verdict": "unexplained_candidate", **fields}
