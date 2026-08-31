"""ASR hypothesis provenance: absolute sample ranges for words and units.

Contract:

  * a match is EXACT or there is none. No Levenshtein, no embeddings, no cosine and no fuzzy
    prefix - that variant was empirically refuted during earlier work;
  * when the token sequence of the accepted text does not correspond EXACTLY to the tokens of
    `chunks_list`, the result is `unaligned` with a count of unmatched words, never a guess;
  * `filtered_window` is a separate, correct state: the hallucination filter rejected the whole
    window, so there is nothing to attribute and nothing will be emitted.

Why this can work: `filter_hallucinations` either rejects the WHOLE window or returns it
unchanged, and `preprocess_transcription` performs only NFC + strip + whitespace
normalisation. Neither step removes individual words, so for an accepted window the token
sequence after canonical normalisation should correspond to `chunks_list` word for word.
If that ever stops holding, the `unaligned` counter will say so rather than failing silently.
"""
from __future__ import annotations

import hashlib
import math
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

ALIGNMENT_EXACT = "exact"
ALIGNMENT_FILTERED_WINDOW = "filtered_window"
ALIGNMENT_UNALIGNED = "unaligned"


def canonical_text(text: str) -> str:
    """Exactly the same steps as the production `preprocess_transcription`: NFC + strip +
    single whitespace. Keep in sync - drift here is a silent `unaligned`."""
    if not text:
        return ""
    normalized = unicodedata.normalize("NFC", text)
    return " ".join(normalized.split())


def canonical_tokens(text: str) -> List[str]:
    """Tokens for sequence comparison. Split on whitespace, content unchanged."""
    return canonical_text(text).split()


class ProvenanceError(ValueError):
    """Provenance EVIDENCE cannot be produced. Never substitute an approximation for it."""


def pcm_sha256(audio) -> str:
    """Hash of the EXACT Float32 bytes handed to inference.

    Requires a float32, C-contiguous array. NO fallback: a hash of repr() would look like
    evidence without being it - two different tensors can share a repr, and the same tensor can
    have different ones (truncation, address). When the exact bytes are unavailable, provenance
    must FAIL.
    """
    import numpy as np
    if not isinstance(audio, np.ndarray):
        raise ProvenanceError("expected numpy.ndarray, got " + type(audio).__name__)
    if audio.dtype != np.float32:
        raise ProvenanceError("expected float32, got " + str(audio.dtype))
    if not audio.flags["C_CONTIGUOUS"]:
        raise ProvenanceError("expected a C-contiguous array (a view/slice is not the tensor)")
    return hashlib.sha256(audio.tobytes()).hexdigest()


@dataclass(frozen=True)
class WordSpan:
    """A single word with its absolute sample range `[start_sample, end_sample)`."""
    text: str
    start_sample: int
    end_sample: int

    def to_dict(self) -> Dict[str, Any]:
        return {"text": self.text, "start_sample": self.start_sample, "end_sample": self.end_sample}


@dataclass
class AlignmentResult:
    """Result of attributing text to sample ranges."""
    status: str
    word_spans: List[WordSpan] = field(default_factory=list)
    unaligned_word_count: Optional[int] = 0
    reason: Optional[str] = None
    text_token_count: Optional[int] = None
    span_token_count: Optional[int] = None

    @property
    def is_exact(self) -> bool:
        return self.status == ALIGNMENT_EXACT

    @property
    def span(self) -> Optional[Tuple[int, int]]:
        """Hull `[min(start), max(end))` of the whole matched text; None when there is no evidence.

        Computed from MIN/MAX rather than the first and last word: monotonic starts permit a
        span nested inside the previous one (A[0,3s], B[1s,2s]), and then
        `word_spans[-1].end_sample` would understate the hull, so the ledger would record less
        audio than was actually emitted.
        """
        if not self.is_exact or not self.word_spans:
            return None
        return (
            min(w.start_sample for w in self.word_spans),
            max(w.end_sample for w in self.word_spans),
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "alignment_status": self.status,
            "unaligned_word_count": self.unaligned_word_count,
            "text_token_count": self.text_token_count,
            "span_token_count": self.span_token_count,
            "alignment_reason": self.reason,
            "word_spans": [w.to_dict() for w in self.word_spans],
            "span": list(self.span) if self.span else None,
        }


def relative_timestamp_to_samples(
    rel_start: Any,
    rel_end: Any,
    origin_sample: int,
    sample_rate: int = 16000,
    input_end_sample: Optional[int] = None,
) -> Tuple[int, int]:
    """One RELATIVE timestamp -> `[start_sample, end_sample)` in absolute space.

    The ONLY place this validation lives. Both paths use it: text alignment and the direct
    delta sidecar in the deduplicator. Splitting them would mean one is strict while the other
    silently accepts `inf`, a zero-length span or a range outside the snapshot.

    MESSAGES CARRY NO SOURCE TEXT. Each of them used to interpolate `repr(label)`, i.e. THE
    WORD - and `alignment_reason` travels into the HTTP response, into the `decode_provenance`
    event and on into the gateway's cloud logs. The `label` parameter was REMOVED rather than
    merely omitted from formatting: a field that does not exist cannot leak on the next edit.
    What remains are NUMBERS (diagnostic, non-personal) and DISJOINT subtypes - a full run
    should be able to compute from them the share of zero-length intervals, non-finite values,
    out-of-range values and non-monotonic ones.
    """
    try:
        start_s = float(rel_start)
        end_s = float(rel_end)
    except (TypeError, ValueError):
        raise ProvenanceError("invalid_timestamp:non_numeric")
    if not math.isfinite(start_s) or not math.isfinite(end_s):
        raise ProvenanceError(
            "invalid_timestamp:non_finite [{}, {}]".format(start_s, end_s)
        )
    if start_s < 0:
        raise ProvenanceError("invalid_timestamp:negative_start [{}, {}]".format(start_s, end_s))
    if end_s <= start_s:
        # A degenerate interval (`[2.18, 2.18]`) is the MOST COMMON case on a live model -
        # it gets its own subtype so it does not vanish into an aggregate "invalid".
        raise ProvenanceError(
            "invalid_timestamp:zero_or_reversed [{}, {}]".format(start_s, end_s)
        )

    start = int(origin_sample) + int(round(start_s * sample_rate))
    end = int(origin_sample) + int(round(end_s * sample_rate))
    # A positive interval shorter than a single sample rounds to zero.
    if end <= start:
        raise ProvenanceError(
            "invalid_timestamp:rounds_to_empty [{}, {})".format(start, end)
        )
    if input_end_sample is not None and end > int(input_end_sample):
        raise ProvenanceError(
            "invalid_timestamp:beyond_input {} > {}".format(end, input_end_sample)
        )
    return start, end


def chunks_to_word_spans(
    chunks: Sequence[Dict[str, Any]],
    buffer_start_sample: int,
    sample_rate: int = 16000,
    input_end_sample: Optional[int] = None,
) -> List[WordSpan]:
    """chunks_list (times RELATIVE to the buffer) -> words in ABSOLUTE sample space.

    The "exact or nothing" contract applies here too: a corrupt timestamp (end <= start, a
    negative value, NaN, a span outside the snapshot) is NOT repaired - it raises
    ProvenanceError, which the caller turns into `unaligned: invalid_timestamp`. Swapping start
    with end, as an earlier version did, was guessing the model's intent.
    """
    spans: List[WordSpan] = []
    for chunk in chunks or []:
        text = (chunk.get("text") or "").strip()
        timestamp = chunk.get("timestamp") or (None, None)
        if not text or timestamp[0] is None or timestamp[1] is None:
            continue
        start, end = relative_timestamp_to_samples(
            timestamp[0], timestamp[1], buffer_start_sample, sample_rate, input_end_sample
        )
        # Starts must increase. Slight overlap between words is normal, but the time axis
        # MOVING BACKWARDS means the chunk order does not match the audio order - the aggregate
        # span (first.start, last.end) would then be fiction.
        if spans and start < spans[-1].start_sample:
            raise ProvenanceError(
                "non_monotonic_start {} after {}".format(start, spans[-1].start_sample)
            )
        spans.append(WordSpan(text=text, start_sample=start, end_sample=end))
    return spans


def align_text_to_spans(
    accepted_text: str,
    chunks: Sequence[Dict[str, Any]],
    buffer_start_sample: int,
    sample_rate: int = 16000,
    input_end_sample: Optional[int] = None,
    window_filtered: bool = False,
) -> AlignmentResult:
    """Exact match of the accepted text to the timestamped words.

    Returns `exact` ONLY when the token sequence agrees word for word and in order. Every other
    case is `unaligned` - deliberately WITHOUT any attempt to repair via similarity.

    `window_filtered` must be supplied BY THE CALLER. Empty text does not by itself prove the
    hallucination filter fired: it may equally mean an empty model result, no speech, or an
    error. This function does not guess that.
    """
    text_tokens = canonical_tokens(accepted_text)
    chunk_tokens_all = canonical_tokens(" ".join((c.get("text") or "") for c in chunks or []))
    if not text_tokens:
        if window_filtered:
            return AlignmentResult(
                status=ALIGNMENT_FILTERED_WINDOW,
                reason="window_rejected_by_filter",
                text_token_count=0,
                span_token_count=len(chunk_tokens_all),
            )
        return AlignmentResult(
            status=ALIGNMENT_UNALIGNED,
            unaligned_word_count=None,
            reason="empty_accepted_text_without_filter_signal",
            text_token_count=0,
            span_token_count=len(chunk_tokens_all),
        )

    try:
        spans = chunks_to_word_spans(chunks, buffer_start_sample, sample_rate, input_end_sample)
    except ProvenanceError as exc:
        return AlignmentResult(
            status=ALIGNMENT_UNALIGNED,
            unaligned_word_count=None,
            reason=str(exc),
            text_token_count=len(text_tokens),
            span_token_count=len(chunk_tokens_all),
        )
    if not spans:
        return AlignmentResult(
            status=ALIGNMENT_UNALIGNED,
            unaligned_word_count=None,
            reason="no_word_timestamps",
            text_token_count=len(text_tokens),
            span_token_count=0,
        )

    span_tokens: List[str] = []
    for span in spans:
        tokens = canonical_tokens(span.text)
        if len(tokens) != 1:
            # The pipeline declares PER-WORD timestamps. A chunk with several tokens means one
            # audio range describes several words - and then there is no way to say which
            # samples belong to which word. That is an ambiguity which MUST NOT enter the
            # accumulator; its real frequency is measured separately.
            return AlignmentResult(
                status=ALIGNMENT_UNALIGNED,
                unaligned_word_count=None,
                # The token count rather than the chunk itself: "how many words sit in one
                # range" is enough to decide about the contract, and the text has no business
                # going to the log.
                reason="non_word_level_chunk:tokens={}".format(len(tokens)),
                text_token_count=len(text_tokens),
                span_token_count=None,
            )
        span_tokens.append(tokens[0])

    if len(span_tokens) != len(text_tokens):
        # A length difference does NOT say how many tokens drifted - both counters are reported
        # along with an explicit None instead of a number that cannot be computed.
        return AlignmentResult(
            status=ALIGNMENT_UNALIGNED,
            unaligned_word_count=None,
            text_token_count=len(text_tokens),
            span_token_count=len(span_tokens),
            reason="token_count_mismatch:{}!={}".format(len(text_tokens), len(span_tokens)),
        )

    mismatched = sum(1 for a, b in zip(text_tokens, span_tokens) if a != b)
    if mismatched:
        return AlignmentResult(
            status=ALIGNMENT_UNALIGNED,
            unaligned_word_count=mismatched,
            text_token_count=len(text_tokens),
            span_token_count=len(span_tokens),
            reason="token_sequence_mismatch",
        )

    return AlignmentResult(
        status=ALIGNMENT_EXACT,
        word_spans=list(spans),
        text_token_count=len(text_tokens),
        span_token_count=len(span_tokens),
    )


def align_text_to_subspans(
    accepted_text: str,
    chunks: Sequence[Dict[str, Any]],
    buffer_start_sample: int,
    sample_rate: int = 16000,
    input_end_sample: Optional[int] = None,
) -> AlignmentResult:
    """Strictly map a partial/stable hypothesis to one unique contiguous chunk run.

    LocalAgreement exposes tentative text separately from the confirmed delta. The text may
    cover only a suffix of the current decoder output, so whole-window equality is too strict.
    A unique exact token run is still proof; zero or multiple matches remain unaligned.
    """
    text_tokens = canonical_tokens(accepted_text)
    if not text_tokens:
        return AlignmentResult(
            status=ALIGNMENT_UNALIGNED,
            unaligned_word_count=None,
            reason="empty_subtext",
            text_token_count=0,
            span_token_count=0,
        )

    try:
        spans = chunks_to_word_spans(chunks, buffer_start_sample, sample_rate, input_end_sample)
    except ProvenanceError as exc:
        return AlignmentResult(
            status=ALIGNMENT_UNALIGNED,
            unaligned_word_count=None,
            reason=str(exc),
            text_token_count=len(text_tokens),
            span_token_count=None,
        )

    span_tokens: List[str] = []
    for span in spans:
        tokens = canonical_tokens(span.text)
        if len(tokens) != 1:
            return AlignmentResult(
                status=ALIGNMENT_UNALIGNED,
                unaligned_word_count=None,
                reason="non_word_level_chunk:tokens={}".format(len(tokens)),
                text_token_count=len(text_tokens),
                span_token_count=None,
            )
        span_tokens.append(tokens[0])

    matches = [
        start for start in range(0, len(span_tokens) - len(text_tokens) + 1)
        if span_tokens[start:start + len(text_tokens)] == text_tokens
    ]
    if len(matches) != 1:
        return AlignmentResult(
            status=ALIGNMENT_UNALIGNED,
            unaligned_word_count=None,
            reason="subtext_match_not_unique" if matches else "subtext_not_contiguous",
            text_token_count=len(text_tokens),
            span_token_count=len(span_tokens),
        )

    start = matches[0]
    return AlignmentResult(
        status=ALIGNMENT_EXACT,
        word_spans=list(spans[start:start + len(text_tokens)]),
        text_token_count=len(text_tokens),
        span_token_count=len(text_tokens),
    )


def merge_spans(spans: Sequence[Tuple[int, int]]) -> List[Tuple[int, int]]:
    """The union of sample ranges, merged and sorted.

    Basis for a future replay ledger: the audio range actually routed to the queue. The key is
    sample intervals, not text, not `release_seq`, not the input hash.
    """
    ordered = sorted((int(s), int(e)) for s, e in spans if e > s)
    if not ordered:
        return []
    merged = [list(ordered[0])]
    for start, end in ordered[1:]:
        if start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return [(s, e) for s, e in merged]


def overlap_samples(a: Tuple[int, int], b: Tuple[int, int]) -> int:
    """Number of samples shared by two intervals (0 when disjoint)."""
    return max(0, min(a[1], b[1]) - max(a[0], b[0]))
