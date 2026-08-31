"""
Whisper ASR Service for Barnaba
================================
FastAPI-based speech recognition service optimized for Swiss German.

Features:
- HuggingFace transformers pipeline with Flash Attention 2
- Swiss German fine-tuned model (Flurin17/whisper-large-v3-turbo-swiss-german)
- Silero VAD for speech detection
- LocalAgreement-n for streaming stability
- Singleton pattern with pre-warming
- Ring buffer for memory management
- Church-optimized VAD settings
- Hallucination filtering

Updated: 2026-01-16 - Migration from faster-whisper to HuggingFace transformers
  - Reason: CT2 conversion bug with fine-tuned whisper-large-v3-turbo (128 vs 80 mel bins)
  - Using Flash Attention 2 for 2.2x speedup + 20% VRAM savings on A100
"""

import os
import logging
import time
import threading
import re
import difflib
import json
from typing import Optional, Dict, Any, List
from contextlib import asynccontextmanager
import asyncio

import numpy as np
import torch
import transformers
from transformers import pipeline
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import uvicorn

# Local imports
from config import (
    MODEL_CONFIG,
    VAD_CONFIG,
    TRANSCRIBE_CONFIG,
    STREAMING_CONFIG,
    SAMPLE_RATE,
    TOKEN_TIMESTAMP_PROBE_ENABLED,
)
from ring_buffer import ChunkedAudioBuffer, GrowingAudioBuffer
from provenance import (
    ProvenanceError,
    align_text_to_spans,
    align_text_to_subspans,
    pcm_sha256,
    relative_timestamp_to_samples,
)
from chunk_diagnostics import diff_summaries, summarize_chunk_timestamps
from generation_compat import (
    GenerationCompatError,
    normalized_generation_config,
    pipeline_generation_config,
    should_retry_with_chunking,
)
from token_timestamp_probe import (
    build_probe_pipeline_class,
    classify_zero_span_layer,
    probe_scope,
)
from rep_shadow import RepShadowSession
from rep_retry_executor import RetryExecutor
from rep_pipeline import install_result_transfer, result_transfer_scope
from rep_retry_runtime import RepRetrySession
from local_agreement import StreamingTranscriptionStabilizer
from trim_context import build_overlap_text_from_timestamps
from vad_processor import VADStreamProcessor
from hallucination_filter import (
    preprocess_transcription,
    should_transcribe,
    calculate_volume_db,
    is_hallucination,
    detect_hallucination,
)
from streaming_resampler import resample_audio, get_resampler_pool


# =============================================================================
# Theological Glossary for Prompt Conditioning (P2)
# =============================================================================
# Terms placed at END of prompt for attention recency bias (arxiv:2406.05806)
# Limit: 224 tokens max. Format: natural sentence > flat list (OpenAI Cookbook)
# These help Whisper spell domain terms correctly, NOT understand topic.

USE_GLOSSARY_PROMPT_IDS = os.environ.get(
    "USE_GLOSSARY_PROMPT_IDS",
    os.environ.get("USE_PROMPT_IDS", "false"),
).lower() == "true"
USE_CONTEXT_PROMPT_IDS = os.environ.get("USE_CONTEXT_PROMPT_IDS", "false").lower() == "true"

# Backward-compatible alias for older logs/config reads.
USE_PROMPT_IDS = USE_GLOSSARY_PROMPT_IDS

THEOLOGICAL_GLOSSARY = (
    "Reformierte Kirche Gottesdienst. "
    "Der Pfarrer hält die Predigt über Gnade, Barmherzigkeit und Vergebung. "
    "Die Gemeinde feiert das Abendmahl, die Taufe und empfängt den Segen. "
    "Gebet, Psalm, Evangelium, Heiliger Geist, Auferstehung, Halleluja, Amen. "
    "Schöpfung, Erlösung, Kreuz, Himmelfahrt, Pfingsten, Dreifaltigkeit. "
    "Apostel, Prophet, Gleichnis, Nächstenliebe, Busse, Beichte, Kirchgemeinde."
)


# =============================================================================
# TimestampDeduplicator - Timestamp-based word deduplication for translations
# =============================================================================

# DISJOINT reasons for a missing provenance record. The enum has three values because a
# record can end up without a span for three DIFFERENT reasons, and collapsing them into one
# bucket would remove any way to tell a model defect from a contract defect - exactly the
# mistake made earlier when the filter was inferred from `bool(chunks_list) and not
# transcription`.
# The codes are safe for cloud logs: they NEVER carry source text (the body of
# `ProvenanceError` contains `repr(word)`, so the exception itself is never logged).
PROVENANCE_REASON_INVALID_TIMESTAMP = "invalid_timestamp"   # timestamp conversion rejected
PROVENANCE_REASON_MISSING_SPAN = "missing_span"             # word added with no sample axis
PROVENANCE_REASON_NON_MONOTONIC = "non_monotonic"           # full records, axis moves backwards
PROVENANCE_REASONS = frozenset({
    PROVENANCE_REASON_INVALID_TIMESTAMP,
    PROVENANCE_REASON_MISSING_SPAN,
    PROVENANCE_REASON_NON_MONOTONIC,
})


class TimestampDeduplicator:
    """
    Tracks confirmed words by their audio timestamps, not array positions.

    v5 (19.01.2026): Timestamp-based deduplication replaces word-count approach.

    KEY INSIGHT: When Whisper adds words at the BEGINNING of transcription,
    existing words shift in array position BUT their timestamps remain the same.
    By tracking words by timestamp, we detect duplicates regardless of position.

    PROBLEM SOLVED (shift detection):
      Iter 1: "Du hast Verantwortung"
              └─ "Du" at [0.5s-0.8s] → CONFIRMED
      Iter 2: "Ja, Du hast Verantwortung und ich"
              └─ "Ja" at [0.2s-0.4s] → NEW (no overlap)
              └─ "Du" at [0.5s-0.8s] → DUPLICATE (same timestamp!)
              └─ "und" at [2.1s-2.3s] → NEW (no overlap)

    ALGORITHM:
      1. For each word from Whisper, check temporal overlap with confirmed words
      2. If overlap > threshold AND same text → duplicate, skip
      3. Otherwise → new word, add to confirmed list and emit
    """

    def __init__(self, overlap_tolerance: float = 0.1, min_new_words: int = 2):
        """
        Initialize deduplicator.

        Args:
            overlap_tolerance: Min overlap RATIO of the CURRENT word's duration
                              (`overlap_duration / word_duration`), NOT milliseconds.
                              0.1 means "10% of this word's length overlaps a confirmed word",
                              so the effective tolerance scales with the word: ~30 ms for a
                              0.3 s word, ~120 ms for a 1.2 s word.
                              FIX (05.08.2026): the old docstring claimed "0.1 = 100ms" — code
                              and documentation disagreed since 21.01. The code is the ratio.
                              A SECOND, separate threshold lives in `_is_duplicate`: overlap
                              ratio > 0.8 with DIFFERENT text triggers a fuzzy replacement.
                              CHANGED (21.01.2026): 0.3 was too aggressive, caused 1112 false duplicates
            min_new_words: Minimum new words before sending delta
                          CHANGED (21.01.2026): 3->2 to reduce latency
        """
        # List of (word, abs_start, abs_end) tuples
        self.confirmed_words: List[tuple] = []
        self.overlap_tolerance = overlap_tolerance
        self.min_new_words = min_new_words

        # For text reconstruction
        self.confirmed_text = ""

        # FIX (19.01.2026): Buffer for words waiting to be sent
        # Prevents word loss when min_new_words threshold not met
        self.pending_words: List[str] = []
        # Span sidecar running parallel to `pending_words`. Kept in the same order and
        # cleared in the same places; `process()` returns exactly the same string as before,
        # spans are read by `process_with_spans()`.
        # Records are INTEGER from the moment they are created: `{text, start_sample,
        # end_sample}`. Samples are never reconstructed from seconds - seconds serve the
        # dedup logic only.
        # PARALLEL to `pending_words`: exactly one entry per word, `None` when no provenance
        # was produced for it. Without this, mixing `process()` and `process_with_spans()`
        # produced a PARTIAL sidecar that looked complete - evidence more dangerous than no
        # evidence at all.
        self.pending_spans: List = []
        # Start of the current buffer and its sample rate; set only by
        # `process_with_spans()`. None = the caller supplied no axis, so no spans are built.
        self._span_origin_sample = None
        self._span_sample_rate = None
        # End of the decoded input: a timestamp beyond the snapshot is not evidence.
        self._span_input_end_sample = None
        # Spans of the words that formed the LAST emitted delta. `confirmed_text` is
        # cumulative and may cover audio already trimmed from the buffer, so it must not be
        # assigned a single range from the current `chunks_list` - a delta may.
        self.last_delta_spans: List[dict] = []

        # Stats for monitoring
        self._total_processed = 0
        self._deltas_sent = 0
        self._duplicates_skipped = 0
        self._fuzzy_replacements = 0
        # REP E2 sidecar: ranges touched by fuzzy replacement in the most recent
        # process() call.  Text behavior is unchanged; the shadow ledger only
        # uses these ranges to make such evidence ineligible for future APPLY.
        self.last_fuzzy_replacement_ranges: List[tuple[int, int]] = []
        self._resets = 0

    def process(self, chunks: List[dict], buffer_offset: float = 0.0) -> Optional[str]:
        """
        Process word chunks with timestamps and return new (non-duplicate) words.

        Args:
            chunks: List of {"text": str, "timestamp": (start, end)} from Whisper
            buffer_offset: Offset in seconds if buffer was trimmed

        Returns:
            New words to send for translation, or None if not enough new content

        FIX (19.01.2026): Uses pending_words buffer to prevent word loss.
        Previously, words were added to confirmed_words but lost if min_new_words
        threshold wasn't met. Now words accumulate in pending_words until sent.
        """
        self._total_processed += 1
        self.last_fuzzy_replacement_ranges = []

        if not chunks:
            return None

        new_words_this_iter = []
        new_spans_this_iter = []

        for chunk in chunks:
            word = chunk.get("text", "").strip()
            timestamp = chunk.get("timestamp", (None, None))

            if not word or timestamp[0] is None or timestamp[1] is None:
                continue

            # Calculate absolute timestamps
            abs_start = buffer_offset + timestamp[0]
            abs_end = buffer_offset + timestamp[1]

            # Check if this is a duplicate
            if self._is_duplicate(word, abs_start, abs_end):
                self._duplicates_skipped += 1
                continue

            # New word - add to confirmed (for future duplicate detection)
            self.confirmed_words.append((word, abs_start, abs_end))
            new_words_this_iter.append(word)
            # One entry per EVERY word. A record is either a dict with a span OR the code
            # for why it is absent (a string from `PROVENANCE_REASONS`). A bare `None`
            # collapsed TWO different causes - no sample axis and a rejected timestamp -
            # into one indistinguishable case.
            span_record = PROVENANCE_REASON_MISSING_SPAN
            if self._span_origin_sample is not None:
                try:
                    # Samples counted HERE, sharing the validation in `provenance.py`.
                    start_sample, end_sample = relative_timestamp_to_samples(
                        timestamp[0], timestamp[1],
                        self._span_origin_sample,
                        self._span_sample_rate or SAMPLE_RATE,
                        self._span_input_end_sample,
                    )
                    span_record = {"text": word, "start_sample": start_sample, "end_sample": end_sample}
                except ProvenanceError:
                    # The word STILL SHIPS (no change to emission), but without provenance.
                    # Only the enum CODE is stored - the body of `ProvenanceError` no longer
                    # carries the word either, but the code is the only thing wanted here.
                    span_record = PROVENANCE_REASON_INVALID_TIMESTAMP
            new_spans_this_iter.append(span_record)

        # Add new words to pending buffer (FIX: accumulate instead of discard)
        self.pending_words.extend(new_words_this_iter)
        self.pending_spans.extend(new_spans_this_iter)

        # Trim old confirmations to prevent memory growth (keep last 60 seconds)
        self._trim_old_confirmations(buffer_offset)

        # DEBUG logging
        logger.info(
            f"[TIMESTAMP_DEDUP] chunks={len(chunks)}, "
            f"confirmed={len(self.confirmed_words)}, "
            f"new_this_iter={len(new_words_this_iter)}, "
            f"pending={len(self.pending_words)}, "
            f"skipped={self._duplicates_skipped}"
        )

        # Decide whether to send
        if not self.pending_words:
            return None

        has_sentence_end = self.pending_words[-1].rstrip().endswith(('.', '!', '?'))
        has_enough_words = len(self.pending_words) >= self.min_new_words

        if has_enough_words or has_sentence_end:
            # C1 (17.02.2026): Max delta size guard
            # After buffer trim + deduplicator reset, huge deltas can pass through
            # >80 words = almost certainly re-transcription of already-sent content
            word_count = len(self.pending_words)
            if word_count > 80:
                logger.warning(
                    f"[C1_MAX_DELTA] Rejecting oversized delta: {word_count} words "
                    f"(first 60 chars: '{' '.join(self.pending_words)[:60]}...')"
                )
                self.pending_words = []
                self.pending_spans = []
                self.last_delta_spans = []
                return None
            elif word_count > 40:
                logger.warning(
                    f"[C1_MAX_DELTA] Large delta warning: {word_count} words "
                    f"(first 60 chars: '{' '.join(self.pending_words)[:60]}...')"
                )

            # Send ALL pending words (FIX: don't lose accumulated words)
            delta = " ".join(self.pending_words)
            self._deltas_sent += 1

            # Update confirmed text
            self.confirmed_text += " " + delta if self.confirmed_text else delta

            logger.info(f"[TIMESTAMP_DEDUP] Sending delta: '{delta[:60]}...' ({len(self.pending_words)} words)")

            # Clear pending buffer after sending
            self.last_delta_spans = list(self.pending_spans)
            self.pending_words = []
            self.pending_spans = []

            return delta

        # Not enough pending words yet - keep accumulating
        logger.debug(f"[TIMESTAMP_DEDUP] Not enough pending words ({len(self.pending_words)} < {self.min_new_words})")
        return None

    @staticmethod
    def _is_span(record) -> bool:
        """A record counts as evidence only when it is a dict carrying a span."""
        return isinstance(record, dict)

    def process_with_spans(self, chunks: List[dict], buffer_start_sample: int,
                           input_end_sample=None, sample_rate: int = 16000) -> tuple:
        """`process()` plus the spans of the words that formed the delta, in the SAMPLE DOMAIN.

        Compatible wrapper: the emitted text is byte-for-byte the same as from `process()`.

        `input_end_sample` closes the contract: a timestamp reaching beyond the decoded
        snapshot leaves the text untouched but produces no record - the delta then ends as
        `incomplete_provenance`.

        Returns `(delta_text, word_records, provenance_status, provenance_reason)`, where the
        status is `complete` / `incomplete_provenance` / `no_delta`. Records are returned
        ONLY for `complete` - a partial set would describe a fragment of the delta while
        looking like evidence for all of it.

        `provenance_reason` is `None` for `complete` and `no_delta`; for
        `incomplete_provenance` it carries ONE of `PROVENANCE_REASONS`:
        `invalid_timestamp` (conversion rejected) / `missing_span` (word added on a path with
        no sample axis) / `non_monotonic` (full records, but the time axis moves backwards).
        It is returned EXPLICITLY in the tuple rather than read from `last_*` state: state
        read separately drifts from the result exactly the way `session.last_decode_provenance`
        once drifted from the response it was meant to describe.
        For MIXED causes the first missing record in delta order is reported - a deterministic
        rule, deliberately narrowing.

        Samples are produced AT THE MOMENT a word is added, as
        `buffer_start_sample + round(relative_timestamp * sample_rate)`. There is no path back
        through seconds anywhere: seconds serve only the dedup logic in `process()`, and the
        integer buffer counter is the single source of truth for spans.
        """
        # Strict argument validation: a silent `int()` on a bad value would turn
        # a wrong snapshot into plausible-looking samples.
        if not isinstance(buffer_start_sample, int) or isinstance(buffer_start_sample, bool) \
                or buffer_start_sample < 0:
            raise ValueError("buffer_start_sample must be a non-negative int, got %r" % (buffer_start_sample,))
        if not isinstance(sample_rate, int) or isinstance(sample_rate, bool) or sample_rate <= 0:
            raise ValueError("sample_rate must be a positive int, got %r" % (sample_rate,))
        if input_end_sample is not None:
            if not isinstance(input_end_sample, int) or isinstance(input_end_sample, bool) \
                    or input_end_sample < buffer_start_sample:
                raise ValueError(
                    "input_end_sample must be an int >= buffer_start_sample, got %r" % (input_end_sample,)
                )

        self._span_origin_sample = buffer_start_sample
        self._span_sample_rate = sample_rate
        self._span_input_end_sample = input_end_sample
        try:
            delta = self.process(chunks, buffer_start_sample / sample_rate)
        finally:
            self._span_origin_sample = None
            self._span_sample_rate = None
            self._span_input_end_sample = None
        if delta is None:
            return None, [], "no_delta", None

        records = self.last_delta_spans
        # ALL or NOTHING. A partial set would look like evidence for the whole delta while
        # describing only a fragment of it - more dangerous than an explicit absence.
        if not records:
            # A delta with no records at all = the words arrived on a path with no sample axis.
            return delta, [], "incomplete_provenance", PROVENANCE_REASON_MISSING_SPAN
        missing = next((r for r in records if not self._is_span(r)), None)
        if missing is not None:
            reason = missing if missing in PROVENANCE_REASONS else PROVENANCE_REASON_MISSING_SPAN
            return delta, [], "incomplete_provenance", reason
        # THE SAME monotonicity rule as in `align_text_to_spans`. Starts moving backwards
        # mean the record order does not match the audio order - an aggregate range would then
        # be fiction. Without this, a single decode could report both
        # `alignment_status=unaligned (non-monotonic start)` and `provenance_status=complete`:
        # two paths for the same evidence disagreeing about the same audio.
        # TEXT UNCHANGED - `delta` is returned in full, only the provenance disappears.
        starts = [record["start_sample"] for record in records]
        if any(nxt < prev for prev, nxt in zip(starts, starts[1:])):
            return delta, [], "incomplete_provenance", PROVENANCE_REASON_NON_MONOTONIC
        return delta, [dict(record) for record in records], "complete", None

    def _is_duplicate(self, word: str, start: float, end: float) -> bool:
        """
        Check if word overlaps temporally with any confirmed word.

        Args:
            word: Word text
            start: Absolute start time in seconds
            end: Absolute end time in seconds

        Returns:
            True if this is a duplicate (should be skipped)

        FIX F8 (17.02.2026): Fuzzy temporal dedup.
        When Whisper re-transcribes a growing buffer, the same audio segment
        may produce slightly different text ("Felser" -> "Felsen").
        Old behavior: only exact word match was treated as duplicate.
        New behavior: >80% temporal overlap = same audio event, regardless of text.
        The new (more accurate) word replaces the old in confirmed_words.
        """
        word_duration = end - start
        if word_duration <= 0:
            return False

        word_lower = word.lower().strip('.,!?;:')

        for idx, (conf_word, conf_start, conf_end) in enumerate(self.confirmed_words):
            # Calculate temporal overlap
            overlap_start = max(start, conf_start)
            overlap_end = min(end, conf_end)

            if overlap_end > overlap_start:  # There is overlap
                overlap_duration = overlap_end - overlap_start
                overlap_ratio = overlap_duration / word_duration

                if overlap_ratio > self.overlap_tolerance:
                    conf_word_lower = conf_word.lower().strip('.,!?;:')

                    if word_lower == conf_word_lower:
                        # Exact text match at same timestamp — classic duplicate
                        logger.debug(
                            f"[TIMESTAMP_DEDUP] Duplicate: '{word}' "
                            f"[{start:.2f}-{end:.2f}] overlaps with "
                            f"'{conf_word}' [{conf_start:.2f}-{conf_end:.2f}] "
                            f"(ratio={overlap_ratio:.2f})"
                        )
                        return True

                    # F8: High temporal overlap with different text = re-transcription
                    # Replace old word with new (more accurate from longer buffer)
                    if overlap_ratio > 0.8:
                        logger.info(
                            f"[TIMESTAMP_DEDUP] Fuzzy replace: '{conf_word}' -> '{word}' "
                            f"[{start:.2f}-{end:.2f}] overlap={overlap_ratio:.2f}"
                        )
                        self.confirmed_words[idx] = (word, start, end)
                        self._fuzzy_replacements += 1
                        self.last_fuzzy_replacement_ranges.append((
                            int(round(start * SAMPLE_RATE)),
                            int(round(end * SAMPLE_RATE)),
                        ))
                        return True

        return False

    def _trim_old_confirmations(self, current_offset: float, keep_seconds: float = 60.0):
        """
        Remove confirmed words older than keep_seconds to prevent memory growth.

        WHAT THIS ACTUALLY DOES (description corrected, BEHAVIOUR UNCHANGED):
        the cutoff is measured from `buffer_offset`, which advances ONLY on a trim - not from
        the current audio time. With infrequent trims the history holds considerably more than
        `keep_seconds` of audio, with frequent trims less. Despite the parameter name this is
        NOT a wall-clock window.
        NOTE - FIX DELIBERATELY DEFERRED: changing the cutoff changes which words count as
        duplicates, which changes the EMITTED TEXT. That does not belong in a patch declared
        as "no change to emission". A separate commit should take `current_audio_end_sample`
        from the BUFFER (`GrowingAudioBuffer.get_input_span()[1]`) rather than `max(end)` over
        model timestamps - a single bad timestamp from the future would wipe correct history.
        NOTE: a future replay ledger MUST NOT inherit this TTL: it has to hold for the whole
        session, otherwise audio returning after 60 s looks new.

        Args:
            current_offset: Current buffer offset in seconds
            keep_seconds: How many seconds of history to keep
        """
        if not self.confirmed_words:
            return

        cutoff_time = current_offset - keep_seconds
        if cutoff_time <= 0:
            return

        # Keep only words with end time > cutoff
        original_count = len(self.confirmed_words)
        self.confirmed_words = [
            (word, start, end)
            for word, start, end in self.confirmed_words
            if end > cutoff_time
        ]

        trimmed = original_count - len(self.confirmed_words)
        if trimmed > 0:
            logger.debug(f"[TIMESTAMP_DEDUP] Trimmed {trimmed} old confirmations")

    def reset(self):
        """Reset deduplicator state (e.g., after buffer trim)."""
        self.confirmed_words = []
        self.confirmed_text = ""
        self.pending_words = []  # FIX: Also clear pending words
        # The span sidecar MUST travel with the text - otherwise the next delta would
        # receive spans belonging to the state from before the reset.
        self.pending_spans = []
        self.last_delta_spans = []
        self.last_fuzzy_replacement_ranges = []
        self._resets += 1
        logger.info("[TIMESTAMP_DEDUP] Reset")

    def carry_over_context(self):
        """
        R1 (17.02.2026): After buffer trim, keep confirmed words for dedup.

        BUGFIX (17.02.2026): Don't shift timestamps! confirmed_words must stay
        in ABSOLUTE frame (audio_buffer offset + raw) to match process().
        Old code shifted by -trim_time, putting confirmed_words in buffer-relative
        frame while process() uses absolute frame → timestamps never overlap
        → dedup completely broken after every trim.
        """
        self.pending_words = []
        self.pending_spans = []
        self.last_delta_spans = []
        self.last_fuzzy_replacement_ranges = []
        self._resets += 1

        if not self.confirmed_words:
            self.confirmed_text = ""
            return

        # Keep confirmed_words in ABSOLUTE timestamp frame (no shift!)
        # process() computes abs = audio_buffer offset + raw, which gives
        # the same absolute time for the same audio event regardless of trims.
        # _trim_old_confirmations() handles memory cleanup (removes words >60s old).
        old_count = len(self.confirmed_words)
        self.confirmed_text = " ".join(w for w, s, e in self.confirmed_words)

        logger.info(
            f"[TIMESTAMP_DEDUP] R1 carry_over: keeping all {old_count} words "
            f"in absolute frame (no shift)"
        )

    def get_stats(self) -> dict:
        """Get deduplicator statistics for monitoring."""
        return {
            "total_processed": self._total_processed,
            "deltas_sent": self._deltas_sent,
            "duplicates_skipped": self._duplicates_skipped,
            "fuzzy_replacements": self._fuzzy_replacements,
            "resets": self._resets,
            "confirmed_words": len(self.confirmed_words),
            "pending_words": len(self.pending_words)  # FIX: Include pending count
        }

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


def _load_compatible_pipeline_tokenizer(model_name: str, revision: str | None, cache_dir: str):
    """Adapt Transformers 5 tokenizer metadata for the pinned 4.57 runtime."""
    config_path = transformers.utils.hub.cached_file(
        model_name,
        "tokenizer_config.json",
        revision=revision,
        cache_dir=cache_dir,
    )
    with open(config_path, "r", encoding="utf-8") as handle:
        tokenizer_config = json.load(handle)

    extra_tokens = tokenizer_config.get("extra_special_tokens")
    if not isinstance(extra_tokens, list):
        return None

    logger.info(
        "[TOKENIZER_COMPAT] Mapping Transformers 5 extra_special_tokens list "
        "to additional_special_tokens for Transformers %s",
        transformers.__version__,
    )
    return transformers.AutoTokenizer.from_pretrained(
        model_name,
        revision=revision,
        cache_dir=cache_dir,
        extra_special_tokens={},
        additional_special_tokens=extra_tokens,
    )


def _get_pipeline_model_device(pipe) -> str:
    """Best-effort device string for the pipeline model."""
    try:
        return str(next(pipe.model.parameters()).device)
    except Exception:
        return str(getattr(pipe, "device", "unknown"))


def _get_pipeline_target_device(pipe) -> torch.device:
    """Best-effort torch device that tensors passed to model.generate must use."""
    try:
        return next(pipe.model.parameters()).device
    except Exception:
        pipe_device = getattr(pipe, "device", None)
        if pipe_device is None:
            return torch.device("cpu")
        if isinstance(pipe_device, torch.device):
            return pipe_device
        if isinstance(pipe_device, int):
            if pipe_device >= 0 and torch.cuda.is_available():
                return torch.device(f"cuda:{pipe_device}")
            return torch.device("cpu")
        return torch.device(str(pipe_device))


def _summarize_generate_kwargs_devices(generate_kwargs: dict) -> str:
    """Summarize tensor device placement inside generate kwargs."""
    parts = []
    for key, value in sorted(generate_kwargs.items()):
        if isinstance(value, torch.Tensor):
            parts.append(
                f"{key}=Tensor(shape={tuple(value.shape)}, dtype={value.dtype}, device={value.device})"
            )
        else:
            parts.append(f"{key}={value!r}")
    return ", ".join(parts)


def _log_whisper_runtime_diagnostics(pipe, context: str, generate_kwargs: Optional[dict] = None) -> None:
    """Log enough runtime state to diagnose CPU/CUDA tensor mismatches."""
    pipe_device = getattr(pipe, "device", "unknown")
    model_device = _get_pipeline_model_device(pipe)
    hf_device_map = getattr(pipe.model, "hf_device_map", None)
    logger.info(
        f"[GPU_CPU_DIAG] {context}: transformers={transformers.__version__}, "
        f"torch={torch.__version__}, cuda_available={torch.cuda.is_available()}, "
        f"pipe.device={pipe_device}, model.device={model_device}, "
        f"hf_device_map={hf_device_map}"
    )
    if generate_kwargs is not None:
        logger.info(
            f"[GPU_CPU_DIAG] {context}: generate_kwargs="
            f"{_summarize_generate_kwargs_devices(generate_kwargs)}"
        )


def _move_generate_kwargs_tensors_to_device(generate_kwargs: dict, pipe) -> dict:
    """Move tensor-valued generate kwargs to the same device as the Whisper model."""
    target_device = _get_pipeline_target_device(pipe)
    for key, value in list(generate_kwargs.items()):
        if isinstance(value, torch.Tensor) and value.device != target_device:
            logger.warning(
                f"[GPU_CPU_FIX] Moving generate_kwargs[{key}] "
                f"from {value.device} to {target_device}"
            )
            generate_kwargs[key] = value.to(target_device)
    return generate_kwargs


# Class name of the pipeline USED when the model was loaded - `None` means "plain pipeline".
# It travels with every probe event, because otherwise a dead probe (flag ON, class never
# built) is indistinguishable from a probe that simply measured nothing.
_PROBE_PIPELINE_CLASS_NAME: Optional[str] = None


def _token_timestamp_probe_pipeline_kwargs() -> dict:
    """`pipeline()` arguments for the step-4 diagnostics. EMPTY dict when the flag is OFF.

    Two independent reasons for returning an empty dict, each logged separately: the flag is
    disabled (normal state), or the base class is missing in this version of transformers
    (diagnostics must never block service startup).
    """
    global _PROBE_PIPELINE_CLASS_NAME
    _PROBE_PIPELINE_CLASS_NAME = None
    if not TOKEN_TIMESTAMP_PROBE_ENABLED:
        return {}
    probe_cls = build_probe_pipeline_class()
    if probe_cls is None:
        logger.warning(
            "[TOKEN_TS_PROBE] flag ON, but AutomaticSpeechRecognitionPipeline is "
            "unavailable in transformers=%s - diagnostics INACTIVE",
            transformers.__version__,
        )
        return {}
    logger.info(
        "[TOKEN_TS_PROBE] raw-timestamp diagnostics ACTIVE "
        "(transformers=%s, return_timestamps=%s)",
        transformers.__version__,
        TRANSCRIBE_CONFIG["return_timestamps"],
    )
    _PROBE_PIPELINE_CLASS_NAME = probe_cls.__name__
    return {"pipeline_class": probe_cls}


def _token_timestamp_probe_environment() -> dict:
    """Model versions and revision read AT RUNTIME - not from the repo, not from a local install.

    Step 3 showed why: the `transformers>=4.36,<4.48` range in `requirements.txt` does not say
    which `_decode_asr` implementation actually computes the timestamps inside the image.
    """
    return {
        "transformers_version": transformers.__version__,
        "torch_version": torch.__version__,
        "model_revision": MODEL_CONFIG.get("model_revision"),
        "return_timestamps": TRANSCRIBE_CONFIG["return_timestamps"],
        # `None` while the flag is ON = the model was loaded WITHOUT the subclass, i.e. the
        # probe is dead, so every "no_measurement" has a cause instead of looking defect-free.
        "probe_pipeline_class": _PROBE_PIPELINE_CLASS_NAME,
    }


class WhisperSingleton:
    """
    Thread-safe singleton Whisper model with pre-warming.

    FIX: Uses threading.Lock instead of asyncio.Lock for proper
    thread safety when model loading happens in ThreadPoolExecutor.

    Eliminates cold start latency (30-120s -> <1s) by:
    1. Loading model once at service startup
    2. Pre-warming with realistic audio (P1: 3 passes, not silence)
    3. Pre-computing theological glossary prompt_ids (P2)
    4. Keeping model in GPU memory
    """

    _instance = None
    _model = None
    _prompt_ids = None  # P2: Pre-computed theological glossary token IDs
    _lock = threading.Lock()  # FIX: threading.Lock, not asyncio.Lock

    @classmethod
    def get_instance(cls):
        """Get or create Whisper model instance (thread-safe)."""
        if cls._model is None:
            with cls._lock:
                # Double-check after acquiring lock
                if cls._model is None:
                    cls._model = cls._load_model()
        return cls._model

    @classmethod
    def get_prompt_ids(cls):
        """Get pre-computed theological glossary prompt_ids (P2)."""
        return cls._prompt_ids

    @classmethod
    def get_tokenizer(cls):
        """R1.4 B3: Get tokenizer for post-trim context prompt encoding."""
        if cls._model is not None:
            return cls._model.tokenizer
        return None

    @classmethod
    def _load_model(cls):
        """Load and pre-warm Whisper model using HuggingFace transformers pipeline."""
        model_name = MODEL_CONFIG["model_name"]
        model_revision = MODEL_CONFIG.get("model_revision")
        device = MODEL_CONFIG["device"]
        torch_dtype = getattr(torch, MODEL_CONFIG["torch_dtype"])
        attn_impl = MODEL_CONFIG["attn_implementation"]

        # === QUICK FIX (17.01.2026): PyTorch deterministic mode ===
        # Ensures consistent output across inference runs for LocalAgreement stability
        # See: the LocalAgreement design notes (not part of this repository)
        torch.manual_seed(42)
        if torch.cuda.is_available():
            torch.cuda.manual_seed(42)
            torch.backends.cudnn.deterministic = True
            torch.backends.cudnn.benchmark = False  # Disable auto-tuning for consistency
        logger.info("[DETERMINISM] PyTorch deterministic mode enabled")

        logger.info(f"Loading Whisper model: {model_name} (revision: {model_revision})")
        logger.info(f"Device: cuda:{device}, dtype: {MODEL_CONFIG['torch_dtype']}, attention: {attn_impl}")

        start_time = time.time()

        # With the flag ENABLED, `pipeline()` receives a diagnostic subclass that overrides
        # `_forward()` only. With the flag OFF the dict is EMPTY, so the call is
        # character-identical to the previous one - that is the acceptance condition for
        # "OFF yields an identical ASR result", not a claim about it.
        probe_kwargs = _token_timestamp_probe_pipeline_kwargs()
        compatible_tokenizer = _load_compatible_pipeline_tokenizer(
            model_name,
            model_revision,
            MODEL_CONFIG["cache_dir"],
        )
        tokenizer_kwargs = (
            {"tokenizer": compatible_tokenizer}
            if compatible_tokenizer is not None
            else {}
        )

        # Try Flash Attention 2 first, fall back to SDPA if not available
        try:
            pipe = pipeline(
                "automatic-speech-recognition",
                model=model_name,
                revision=model_revision,
                torch_dtype=torch_dtype,
                device=device,
                model_kwargs={
                    "attn_implementation": attn_impl,
                    "cache_dir": MODEL_CONFIG["cache_dir"],
                },
                **tokenizer_kwargs,
                **probe_kwargs,
            )
            logger.info(f"Loaded with {attn_impl}")
        except Exception as e:
            logger.warning(f"Failed to load with {attn_impl}: {e}")
            logger.info("Falling back to SDPA attention...")
            pipe = pipeline(
                "automatic-speech-recognition",
                model=model_name,
                revision=model_revision,
                torch_dtype=torch_dtype,
                device=device,
                model_kwargs={
                    "attn_implementation": "sdpa",
                    "cache_dir": MODEL_CONFIG["cache_dir"],
                },
                **tokenizer_kwargs,
                **probe_kwargs,
            )
            logger.info("Loaded with SDPA attention")

        # Install only once, on the existing model. Runtime/version drift refuses
        # the enabled optimization instead of silently applying a different patch.
        optimized = install_result_transfer(pipe)
        logger.info("[REP] normal-path export optimization installed=%s", optimized)
        load_time = time.time() - start_time
        logger.info(f"Model loaded in {load_time:.2f}s")
        _log_whisper_runtime_diagnostics(pipe, "model_loaded")

        # =====================================================================
        # P2: Pre-compute theological glossary prompt_ids
        # =====================================================================
        # Uses tokenizer.get_prompt_ids() which adds <|startofprev|> token
        # that Whisper needs for proper prompt conditioning.
        # Helps with spelling of domain terms (Predigt, Abendmahl, etc.)
        # Reference: OpenAI Whisper Prompting Guide, arxiv:2406.05806
        try:
            cls._prompt_ids = torch.tensor(pipe.tokenizer.get_prompt_ids(THEOLOGICAL_GLOSSARY)).to(pipe.device)
            token_count = len(cls._prompt_ids) if cls._prompt_ids is not None else 0
            logger.info(f"[P2] Theological glossary prompt_ids computed: {token_count} tokens")
            if token_count > 224:
                logger.warning(f"[P2] Prompt too long ({token_count} > 224 tokens), will be truncated by Whisper")
        except Exception as e:
            logger.warning(f"[P2] Failed to compute prompt_ids: {e}. Continuing without glossary.")
            cls._prompt_ids = None

        # =====================================================================
        # P1: Enhanced pre-warming with realistic audio (3 passes)
        # =====================================================================
        # FIX (27.01.2026): NO return_timestamps parameter - causes 'num_frames' error
        # FIX (15.02.2026): Use realistic audio (low noise) instead of silence.
        #   - np.zeros (silence) can trigger hallucinations and doesn't test full pipeline
        #   - np.random.randn * 0.01 (low noise) activates all code paths safely
        #   - 3 passes fully initialize CUDA kernels (1 pass = partial init)
        # Reference: PyTorch Performance Tuning Guide, research_whisper_warmup.md
        WARMUP_PASSES = 3
        WARMUP_DURATION_SEC = 3  # 3 seconds per pass (realistic sermon chunk length)
        logger.info(f"[P1] Pre-warming model: {WARMUP_PASSES} passes x {WARMUP_DURATION_SEC}s realistic audio...")

        # F3 FIX: Seed numpy for reproducible warm-up audio (matches torch.manual_seed(42) above)
        np.random.seed(42)
        warmup_audio = np.random.randn(SAMPLE_RATE * WARMUP_DURATION_SEC).astype(np.float32) * 0.01

        warmup_start = time.time()
        for i in range(WARMUP_PASSES):
            warmup_kwargs = {"language": "de", "num_beams": 1}
            # F1+F2 FIX: Last pass uses production params (num_beams=5 + prompt_ids)
            # to fully initialize beam search + prompt conditioning CUDA kernels
            if i == WARMUP_PASSES - 1:
                warmup_kwargs["num_beams"] = TRANSCRIBE_CONFIG["num_beams"]
                if cls._prompt_ids is not None:
                    warmup_kwargs["prompt_ids"] = cls._prompt_ids
            pipe(
                warmup_audio,
                generate_kwargs=warmup_kwargs,
            )
            logger.info(f"[P1] Warm-up pass {i + 1}/{WARMUP_PASSES} done")

        # Ensure all CUDA operations complete before declaring ready
        if torch.cuda.is_available():
            torch.cuda.synchronize()

        warmup_time = time.time() - warmup_start
        logger.info(f"[P1] Pre-warming completed in {warmup_time:.2f}s ({WARMUP_PASSES} passes)")
        logger.info(f"Total initialization: {time.time() - start_time:.2f}s")

        return pipe

    @classmethod
    def is_loaded(cls) -> bool:
        """Check if model is loaded."""
        return cls._model is not None


# =============================================================================
# Transcription Helper Functions (extracted to avoid duplication)
# =============================================================================

def _build_generate_kwargs(language: str = "de", task: str = "transcribe") -> dict:
    """
    Build generate_kwargs dict for transformers pipeline.

    Centralizes all generation parameters from TRANSCRIBE_CONFIG.
    Used by both /transcribe and /session/{id}/chunk endpoints.

    QUICK FIX (17.01.2026): Added threshold=None parameters to disable
    HuggingFace temperature fallback mechanism - main source of LocalAgreement
    instability (hasNew=false). See: the LocalAgreement design notes (not part of this repository)
    """
    return {
        "language": language,
        "task": task,
        "num_beams": TRANSCRIBE_CONFIG["num_beams"],
        "temperature": TRANSCRIBE_CONFIG["temperature"],
        "do_sample": False,  # CRITICAL: Disable stochastic sampling for determinism
        "condition_on_prev_tokens": TRANSCRIBE_CONFIG["condition_on_previous_text"],
        "repetition_penalty": TRANSCRIBE_CONFIG["repetition_penalty"],
        "no_repeat_ngram_size": TRANSCRIBE_CONFIG["no_repeat_ngram_size"],
        # === QUICK FIX: Disable HuggingFace fallback triggers ===
        # These cause retry loops with different temperatures, breaking LocalAgreement
        "compression_ratio_threshold": None,  # Prevents retry on high compression
        "logprob_threshold": None,            # Prevents retry on low confidence
        "no_speech_threshold": None,          # Prevents silence detection variability
    }


def _run_pipeline(
    pipe,
    audio: np.ndarray,
    generate_kwargs: dict,
    use_chunking: bool = True,
    *, capture_quality: bool = False,
) -> dict:
    with result_transfer_scope(pipe, capture_quality=capture_quality) as transfer:
        kwargs = dict(generate_kwargs) if capture_quality else generate_kwargs
        if capture_quality:
            kwargs["output_scores"] = True
        result = _run_pipeline_impl(pipe, audio, kwargs, use_chunking)
    if transfer is not None:
        _log_whisper_diag("rep_result_transfer", optimized_calls=transfer["optimized_calls"],
                          skipped_export_bytes=transfer["encoder_attention_bytes"],
                          postprocess_ms=round(transfer["postprocess_ms"], 3))
    if capture_quality:
        result = {**result, "rep_quality": transfer.get("quality") if transfer else None}
    return result


def _run_pipeline_impl(
    pipe,
    audio: np.ndarray,
    generate_kwargs: dict,
    use_chunking: bool = True,
) -> dict:
    """
    Run transformers pipeline with standard parameters.

    Args:
        pipe: Whisper pipeline instance
        audio: Audio samples as numpy array
        generate_kwargs: Generation parameters
        use_chunking: Whether to use chunk_length_s (disable for streaming with prompt_ids)

    Returns dict with "text" and "chunks" keys.
    """
    # FIX (25.03.2026): Pair-coding session (Claude+Codex+Haiku)
    # Root cause: chunk_length_s=None → float stride → TypeError
    #             chunk_length_s=30  → long-form chunked path → segment timestamps (not word)
    # Solution: For streaming (audio <30s), DON'T pass chunk_length_s at all.
    #           This forces pipeline into short-form path with proper word timestamps.
    #           If TypeError occurs (float stride bug), catch and retry with int(30).
    generate_kwargs = _move_generate_kwargs_tensors_to_device(generate_kwargs, pipe)
    # Normalise a single-element `eos_token_id`. In transformers 4.57.x
    # `WhisperTimeStampLogitsProcessor` uses it as a SLICE BOUNDARY, and our model carries
    # `[50257]` - a list raises `TypeError` on EVERY decode with word timestamps.
    # When the value is already a scalar (the 4.47.1 path), `patched is None` and the call
    # below is character-identical to the previous one.
    patched_config, compat_report = normalized_generation_config(pipeline_generation_config(pipe))
    if compat_report.get("action") != "noop":
        _log_whisper_diag("generation_compat", **compat_report)
    if compat_report.get("action") == "refused":
        # A REFUSAL STOPS THE DECODE. Merely logging and carrying on would run the pipeline
        # with the old, invalid config - the gate would then be impersonating a warning.
        raise GenerationCompatError(
            "eos_token_id is not single-element: {}".format(compat_report.get("reason")))
    if patched_config is not None:
        generate_kwargs = dict(generate_kwargs)
        generate_kwargs["generation_config"] = patched_config
    _log_whisper_runtime_diagnostics(pipe, "before_pipeline", generate_kwargs)
    if use_chunking:
        try:
            return pipe(
                audio,
                generate_kwargs=generate_kwargs,
                return_timestamps=TRANSCRIBE_CONFIG["return_timestamps"],
                batch_size=TRANSCRIBE_CONFIG["batch_size"],
                chunk_length_s=int(TRANSCRIBE_CONFIG["chunk_length_s"]),
            )
        except RuntimeError as e:
            _log_whisper_runtime_diagnostics(pipe, "pipeline_runtime_error", generate_kwargs)
            raise
    else:
        # Streaming path: no chunk_length_s → short-form → word-level timestamps
        try:
            return pipe(
                audio,
                generate_kwargs=generate_kwargs,
                return_timestamps=TRANSCRIBE_CONFIG["return_timestamps"],
                batch_size=TRANSCRIBE_CONFIG["batch_size"],
            )
        except RuntimeError as e:
            _log_whisper_runtime_diagnostics(pipe, "pipeline_runtime_error", generate_kwargs)
            raise
        except TypeError as e:
            # RETRY-WITH-CHUNKING REMOVED. It recognised the historical "float stride" bug
            # from the bare text `"slice indices"`, and therefore also caught the
            # `eos_token_id` error from `logits_process`, triggering a second decode on the
            # CHUNKED path - which returns SEGMENT timestamps instead of word timestamps,
            # silently changing the output shape that alignment and provenance rest on.
            # The historical defect's signature can no longer be reproduced (see
            # `should_retry_with_chunking`), and the condition that triggered it was removed
            # long ago. A loud failure of ONE decode is better here than a silent change to
            # the semantics of the whole stream.
            retry, retry_reason = should_retry_with_chunking(e)
            _log_whisper_diag("pipeline_typeerror_not_retried", reason=retry_reason,
                              error_type=type(e).__name__, retry=retry)
            raise


def _find_sentence_boundary_time(text: str, chunks: list) -> Optional[float]:
    """
    Find timestamp of last complete sentence in confirmed text.

    Used for buffer trimming at natural boundaries.

    FIX (23.01.2026): Added SAFETY_MARGIN_SEC to prevent "In" artifacts.
    The safety margin ensures we don't cut in the middle of a word.

    Args:
        text: Confirmed transcription text
        chunks: List of chunks with timestamps from Whisper

    Returns:
        Timestamp in seconds (with safety margin), or None if no sentence boundary found
    """
    if not chunks:
        return None

    # FIX: Add safety margin to prevent cutting mid-word
    SAFETY_MARGIN_SEC = 0.2  # 200ms padding

    sentence_endings = '.!?'

    for chunk in reversed(chunks):
        chunk_text = chunk.get('text', '').strip()
        timestamp = chunk.get('timestamp', (None, None))

        if chunk_text and chunk_text[-1] in sentence_endings:
            end_time = timestamp[1] if timestamp and len(timestamp) > 1 else None
            if end_time is not None:
                # FIX: Add safety margin
                safe_time = end_time + SAFETY_MARGIN_SEC
                # Round to 100ms boundary for cleaner cuts
                safe_time = round(safe_time * 10) / 10
                logger.debug(f"[TRIM] Found sentence boundary at {end_time:.2f}s, adding margin -> {safe_time:.2f}s")
                return safe_time

    return None


def _find_word_boundary_trim_time(chunks: list, buf_duration: float) -> float:
    """
    R1.4 B1: Find a word boundary near 50% of buffer for emergency trim.

    Instead of trimming at exactly 50% (which may cut mid-word), find the
    nearest word-end timestamp from Whisper chunks. Falls back to 50% if
    no timestamps available.

    Args:
        chunks: Whisper chunks with timestamps [(text, (start, end)), ...]
        buf_duration: Current buffer duration in seconds

    Returns:
        Trim time in seconds (at word boundary)
    """
    target = buf_duration * 0.5
    SAFETY_MARGIN = 0.2

    if not chunks:
        return target

    # Find the word-end timestamp closest to 50% of buffer
    best_time = None
    best_dist = float("inf")

    for chunk in chunks:
        ts = chunk.get("timestamp", (None, None))
        end_time = ts[1] if ts and len(ts) > 1 else None
        if end_time is None:
            continue

        dist = abs(end_time - target)
        if dist < best_dist:
            best_dist = dist
            best_time = end_time

    if best_time is not None:
        safe_time = best_time + SAFETY_MARGIN
        safe_time = round(safe_time * 10) / 10
        # Clamp: at least 2s, at most buf_duration - 1s
        safe_time = max(2.0, min(safe_time, buf_duration - 1.0))
        logger.info(f"[WORD_BOUNDARY_TRIM] target={target:.1f}s, found word end at {best_time:.2f}s -> {safe_time:.2f}s")
        return safe_time

    return target


def _trim_overlap_for_reason(reason: str) -> float:
    """Per-reason trim overlap (28.06.2026). NORMAL trims keep a wide overlap for LA
    warm-start quality; FORCE trims keep a small overlap so the trim actually clears the
    buffer (a wide overlap on hard_limit caused a 96s livelock — see config.py)."""
    if reason == "sentence_confirmed":
        return STREAMING_CONFIG["trim_overlap_sentence_confirmed_sec"]
    if reason == "sentence_boundary":
        return STREAMING_CONFIG["trim_overlap_sentence_boundary_sec"]
    # hard_limit / proactive_hard_limit / emergency / hallucination_burst / default
    return STREAMING_CONFIG["trim_overlap_force_sec"]



def _nearest_confirmed_distance_to_abs_time(session, target_abs: float):
    """Distance in seconds from target_abs to the nearest confirmed word timestamp."""
    confirmed_words = session.timestamp_deduplicator.confirmed_words
    if not confirmed_words:
        return None
    nearest = min(
        0.0 if start <= target_abs <= end
        else (target_abs - end if end < target_abs else start - target_abs)
        for _, start, end in confirmed_words
    )
    return round(nearest, 3)


def _log_truncation_risk_probe(session, reason: str, trim_time: float, source: str) -> None:
    """C.7 shadow-only probe. Uses only pre-submit state; never affects output."""
    buffer_s = len(session.audio_buffer.audio_buffer) / SAMPLE_RATE
    buffer_offset_s = session.audio_buffer.get_buffer_offset()
    edge_abs = buffer_offset_s + buffer_s
    trim_abs = buffer_offset_s + trim_time
    nearest_edge = _nearest_confirmed_distance_to_abs_time(session, edge_abs)
    nearest_trim = _nearest_confirmed_distance_to_abs_time(session, trim_abs)
    confirmation_gap = nearest_edge is None or nearest_edge > 3.0
    # We only call this probe from hard-limit paths. The risk is the buffer edge
    # outrunning confirmation, not proximity to the 50% trim point itself.
    edge_proximity = True
    truncation_risk = bool(confirmation_gap)
    _log_whisper_diag(
        "truncation_risk_probe",
        session_id=session.session_id,
        reason=reason,
        source=source,
        buffer_s=round(buffer_s, 3),
        buffer_offset_s=round(buffer_offset_s, 3),
        trim_time_s=round(trim_time, 3),
        edge_abs_s=round(edge_abs, 3),
        trim_abs_s=round(trim_abs, 3),
        nearest_confirmed_to_edge_s=nearest_edge,
        nearest_confirmed_to_trim_s=nearest_trim,
        edge_proximity=edge_proximity,
        confirmation_gap=confirmation_gap,
        truncation_risk=truncation_risk,
        fuzzy_replacements=session.timestamp_deduplicator._fuzzy_replacements,
    )


def _snap_force_trim_time_to_word_boundary(session, trim_time: float, reason: str, source: str) -> float:
    """C.9: snap hard-limit force trim to a nearby confirmed word-end.

    Force trims keep a small overlap. The destructive cut is therefore the
    effective trim boundary (requested trim minus applied overlap), not the raw
    requested trim value. We snap that effective cut to a nearby confirmed word
    end plus the same 200ms safety margin used by chunk timestamp trims. If no
    word end is close enough, behavior is unchanged.
    """
    safety_margin_s = 0.2
    buffer_s = len(session.audio_buffer.audio_buffer) / SAMPLE_RATE
    buffer_offset_s = session.audio_buffer.get_buffer_offset()
    trim_overlap_configured = _trim_overlap_for_reason(reason)
    trim_overlap_applied = min(trim_overlap_configured, max(0.0, trim_time - 1.0))
    target_effective_abs = buffer_offset_s + max(0.0, trim_time - trim_overlap_applied)
    window_s = max(0.0, STREAMING_CONFIG["force_trim_word_boundary_snap_window_sec"])
    confirmed_words = session.timestamp_deduplicator.confirmed_words

    nearest = None
    if confirmed_words:
        for word, _start, end in confirmed_words:
            if end is None:
                continue
            dist = abs(float(end) - target_effective_abs)
            if nearest is None or dist < nearest["distance_s"]:
                nearest = {"word": word, "end_abs_s": float(end), "distance_s": dist}

    would_snap_trim = trim_time
    would_snap = False
    if nearest and nearest["distance_s"] <= window_s:
        requested = nearest["end_abs_s"] + safety_margin_s - buffer_offset_s + trim_overlap_applied
        # Keep the existing hard-limit safety geometry: trim must clear at least
        # 1s and must leave at least 1s in the buffer after the requested point.
        would_snap_trim = max(2.0, min(requested, buffer_s - 1.0))
        would_snap = abs(would_snap_trim - trim_time) > 1e-6

    enabled = STREAMING_CONFIG["force_trim_word_boundary_snap_enabled"]
    snapped_trim = would_snap_trim if enabled and would_snap else trim_time
    applied = enabled and would_snap
    would_delta = would_snap_trim - trim_time
    snap_delta = snapped_trim - trim_time

    _log_whisper_diag(
        "force_trim_word_boundary_snap_probe",
        session_id=session.session_id,
        reason=reason,
        source=source,
        enabled=enabled,
        would_snap=would_snap,
        applied=applied,
        original_trim_s=round(trim_time, 3),
        would_snap_trim_s=round(would_snap_trim, 3),
        would_snap_delta_s=round(would_delta, 3),
        would_snap_direction="forward" if would_delta > 0 else ("backward" if would_delta < 0 else "none"),
        snapped_trim_s=round(snapped_trim, 3),
        snap_delta_s=round(snap_delta, 3),
        snap_direction="forward" if snap_delta > 0 else ("backward" if snap_delta < 0 else "none"),
        buffer_s=round(buffer_s, 3),
        buffer_offset_s=round(buffer_offset_s, 3),
        trim_overlap_sec_applied=round(trim_overlap_applied, 3),
        target_effective_cut_abs_s=round(target_effective_abs, 3),
        snap_window_s=round(window_s, 3),
        safety_margin_s=round(safety_margin_s, 3),
        nearest_word=nearest["word"] if nearest else None,
        nearest_word_end_abs_s=round(nearest["end_abs_s"], 3) if nearest else None,
        nearest_word_end_distance_s=round(nearest["distance_s"], 3) if nearest else None,
        confirmed_words_total=len(confirmed_words),
    )
    return snapped_trim


def _set_pending_force_trim(session, trim_time: float, reason: str) -> None:
    """Remember the most conservative pending force trim until the next submit finishes."""
    previous = session.pending_force_trim_time
    is_new_attempt = previous is None
    session.pending_force_trim_time = max(previous or 0.0, trim_time)
    session.pending_force_trim_reason = reason
    if is_new_attempt:
        session.pre_submit_attempts += 1

    buffer_s = len(session.audio_buffer.audio_buffer) / SAMPLE_RATE
    buffer_offset_s = session.audio_buffer.get_buffer_offset()
    trim_overlap_configured = _trim_overlap_for_reason("hard_limit")
    trim_overlap_applied = min(trim_overlap_configured, max(0.0, trim_time - 1.0))
    legacy_drop_end_abs_s = buffer_offset_s + max(0.0, trim_time - trim_overlap_applied)

    _log_whisper_diag(
        "hard_limit_pre_submit" if is_new_attempt else "hard_limit_pre_submit_update",
        session_id=session.session_id,
        reason=reason,
        requested_trim_s=round(trim_time, 3),
        previous_pending_trim_s=None if previous is None else round(previous, 3),
        buffer_s=round(buffer_s, 3),
        buffer_offset_s=round(buffer_offset_s, 3),
        trim_overlap_sec_applied=round(trim_overlap_applied, 3),
        legacy_drop_start_abs_s=round(buffer_offset_s, 3),
        legacy_drop_end_abs_s=round(legacy_drop_end_abs_s, 3),
        is_new_attempt=is_new_attempt,
        pre_submit_attempts=session.pre_submit_attempts,
        pre_submit_completions=session.pre_submit_completions,
    )


def _perform_pending_force_trim_after_submit(session, chunks_list: list, confirmed_text: str) -> None:
    """C.7: after the extra submit, force-trim with the force-overlap invariant intact."""
    if session.pending_force_trim_time is None:
        return

    trim_time = session.pending_force_trim_time
    reason = session.pending_force_trim_reason or "hard_limit_post_submit"
    pre_submit_text = confirmed_text or ""
    pre_trim_confirmed_words = len(pre_submit_text.split())
    import hashlib
    _log_whisper_diag(
        "hard_limit_post_submit",
        session_id=session.session_id,
        pending_reason=reason,
        requested_trim_s=round(trim_time, 3),
        pre_submit_confirmed_words=pre_trim_confirmed_words,
        pre_submit_confirmed_chars=len(pre_submit_text),
        pre_submit_confirmed_preview=pre_submit_text[:180],
        pre_submit_confirmed_sha256=hashlib.sha256(pre_submit_text.encode("utf-8", "ignore")).hexdigest()[:16] if pre_submit_text else None,
        buffer_s=round(len(session.audio_buffer.audio_buffer) / SAMPLE_RATE, 3),
    )
    session.pre_submit_completions += 1
    session.pending_force_trim_time = None
    session.pending_force_trim_reason = None
    _perform_buffer_trim(session, trim_time, chunks_list, reason=reason)


def _perform_buffer_trim(
    session,  # TranscriptionSession
    trim_time: float,
    chunks_list: list,
    reason: str = "sentence_boundary"
) -> None:
    """
    Perform buffer trim operation.

    FIX (23.01.2026): Extracted to separate function for reuse.

    Args:
        session: TranscriptionSession instance
        trim_time: Time offset to trim at
        chunks_list: Whisper chunks for context
        reason: Reason for trim (for logging)
    """
    # P1 (17.02.2026): Reduced from 200→60 words
    # Note: F7 blocks buffer_prompt from reaching Whisper prompt_ids,
    # but we still store it for potential future use and buffer context
    context_words = session.confirmed_text.split()[-60:]
    new_prompt = " ".join(context_words)

    # Trim buffer and preserve context. PER-REASON overlap (28.06.2026): normal trims get
    # a wide overlap (LA warm-start quality), force trims get a small one (must clear the
    # buffer, else livelock). See _trim_overlap_for_reason / config.py.
    #
    # CAP: trim_at_time skips the trim entirely when overlap >= trim_time (effective_trim
    # = trim_samples - overlap_samples <= 0 -> did_trim=False, ring_buffer.py:516). Cap the
    # applied overlap so at least 1s of real trim always happens.
    trim_overlap_configured = _trim_overlap_for_reason(reason)
    trim_overlap_applied = min(trim_overlap_configured, max(0.0, trim_time - 1.0))
    trim_result = session.audio_buffer.trim_at_time(
        trim_time, new_prompt, overlap_seconds=trim_overlap_applied
    )
    if not trim_result.did_trim:
        logger.debug(
            f"[BUFFER_TRIM] {reason}: skipped invalid trim request "
            f"at {trim_time:.2f}s (buffer={trim_result.original_buffer_seconds:.2f}s)"
        )
        return

    session.last_processed_samples = len(session.audio_buffer.audio_buffer)

    overlap_text = build_overlap_text_from_timestamps(
        session.timestamp_deduplicator.confirmed_words,
        trim_result.new_buffer_offset,
        trim_result.new_buffer_offset + trim_result.kept_overlap_seconds,
    )

    # R2 (17.02.2026): Warm-start stabilizer instead of creating fresh one
    # Pre-fill history with timestamp-selected overlap text so first post-trim
    # transcription is compared against the exact retained audio region.
    session.stabilizer = StreamingTranscriptionStabilizer(
        n=STREAMING_CONFIG["local_agreement_n"],
        similarity_threshold=STREAMING_CONFIG["la_similarity_threshold"],
    )

    # Phase 2 part 2 (29.06.2026): no-empty warm-start. Pick seed + trust level:
    #  - timestamp/audio overlap present -> trusted seed (confirmed_text exported now).
    #  - empty overlap + LA_TEXT_ANCHOR_ENABLED -> confirmed_text tail as anchor_only seed
    #    (history seeded for stability, confirmed stays empty -> divergence-safe).
    #  - empty overlap + flag OFF -> regular reset (legacy behaviour, unchanged).
    if overlap_text.strip():
        warm_text, warm_trusted, warm_source = overlap_text, True, "timestamp_overlap"
    elif STREAMING_CONFIG["la_text_anchor_enabled"] and session.confirmed_text.strip():
        _anchor_words = session.confirmed_text.split()[-STREAMING_CONFIG["la_text_anchor_words"]:]
        warm_text, warm_trusted, warm_source = " ".join(_anchor_words), False, "text_anchor"
    else:
        warm_text, warm_trusted, warm_source = "", True, "empty"
    session.stabilizer.warm_start(warm_text, trusted=warm_trusted)

    # R1 (17.02.2026): Carry over context instead of reset
    # Keep confirmed_words in absolute frame (no timestamp shift)
    session.timestamp_deduplicator.carry_over_context()

    logger.info(
        f"[BUFFER_TRIM] {reason}: requested={trim_result.requested_trim_time:.2f}s, "
        f"effective={trim_result.effective_trim_time:.2f}s, "
        f"kept_overlap={trim_result.kept_overlap_seconds:.2f}s, "
        f"buffer_offset={trim_result.new_buffer_offset:.2f}s, "
        f"R1=carry_over, R2=warm_start(src={warm_source},{len(warm_text.split())}w,trusted={warm_trusted})"
    )
    # SHADOW DIAGNOSTICS (28.06.2026): is overlap WIDTH the right lever, per trim reason?
    # Counts how many confirmed words a 1/2/3/5s overlap window WOULD have warm-started,
    # independent of the live trim_overlap_sec. Same absolute frame + same function as the
    # live warm-start, so apples-to-apples. If hard_limit shows 1s=0 but 3s/5s>0, widening
    # overlap helps; if 3s/5s also 0, the deduplicator simply has no confirmed words near the
    # trim point (fix trim ordering / warm-start source, not the window width).
    _conf_words = session.timestamp_deduplicator.confirmed_words
    _trim_point_abs = trim_result.new_buffer_offset + trim_result.kept_overlap_seconds

    def _shadow_words(w):
        return len(build_overlap_text_from_timestamps(
            _conf_words, _trim_point_abs - w, _trim_point_abs, max_words=10000
        ).split())

    if _conf_words:
        _nearest = min(
            0.0 if start <= _trim_point_abs <= end
            else (_trim_point_abs - end if end < _trim_point_abs else start - _trim_point_abs)
            for _, start, end in _conf_words
        )
        _nearest = round(_nearest, 3)
    else:
        _nearest = None

    _log_whisper_diag(
        "buffer_trim",
        session_id=session.session_id,
        reason=reason,
        requested_trim_s=round(trim_result.requested_trim_time, 3),
        effective_trim_s=round(trim_result.effective_trim_time, 3),
        original_buffer_s=round(trim_result.original_buffer_seconds, 3),
        remaining_buffer_s=round(len(session.audio_buffer.audio_buffer) / SAMPLE_RATE, 3),
        kept_overlap_s=round(trim_result.kept_overlap_seconds, 3),
        buffer_offset_s=round(trim_result.new_buffer_offset, 3),
        chunks=len(chunks_list or []),
        warm_start_words=len(overlap_text.split()),
        warm_start_source=warm_source,
        warm_start_applied_words=len(warm_text.split()),
        warm_start_trusted=warm_trusted,
        trim_overlap_sec_configured=trim_overlap_configured,
        trim_overlap_sec_applied=round(trim_overlap_applied, 3),
        warm_start_words_1s=_shadow_words(1.0),
        warm_start_words_2s=_shadow_words(2.0),
        warm_start_words_3s=_shadow_words(3.0),
        warm_start_words_5s=_shadow_words(5.0),
        confirmed_words_total=len(_conf_words),
        nearest_confirmed_word_distance_s=_nearest,
    )


class TranscriptionSession:
    """
    Manages state for a streaming transcription session.

    Uses church-optimized settings from config.py.

    ARCHITECTURE UPDATE (17.01.2026):
    Changed from ChunkedAudioBuffer (sliding window) to GrowingAudioBuffer.
    This is required for LocalAgreement to work correctly - consecutive
    transcriptions must share a common audio prefix for text stabilization.

    Reference: Real-time Streaming ASR with Whisper and LocalAgreement.md
    """

    def __init__(self, session_id: str):
        self.session_id = session_id
        self.created_at = time.time()
        self.last_activity = time.time()

        # Monotonic decode identifier within the session. Assigned BEFORE the snapshot is sent
        # to the executor, so that identifier order follows submission order rather than
        # completion order.
        self.decode_seq = 0
        self.last_decode_provenance = None

        # Audio buffering with GROWING buffer for LocalAgreement compatibility
        # KEY CHANGE: Use GrowingAudioBuffer instead of ChunkedAudioBuffer
        self.audio_buffer = GrowingAudioBuffer(
            min_chunk_seconds=STREAMING_CONFIG["chunk_duration_sec"],  # Min audio before processing
            max_buffer_seconds=STREAMING_CONFIG["max_buffer_sec"],     # Whisper's 30s limit
            trim_threshold_ratio=0.8,  # Trim at 80% of max (24s)
            sample_rate=SAMPLE_RATE,
        )

        # Track last processed buffer length to detect new audio
        self.last_processed_samples = 0
        self.transcription_in_progress = False
        self.coalesced_audio_pending = False
        self.coalesced_request_count = 0
        # Phase 1b livelock guard: consecutive hard_limit force-trims (chunk-add path)
        # with no intervening Whisper submit. Reset to 0 on every real submit.
        self.hard_limit_without_submit_count = 0
        # C.7 submit-before-force-trim state. Pending trim is applied after the
        # next full-buffer submit gives LA/timestamp dedup one final chance.
        self.pending_force_trim_time = None
        self.pending_force_trim_reason = None
        self.pre_submit_attempts = 0
        self.pre_submit_completions = 0

        # VAD processing with church-optimized settings
        self.vad_processor = VADStreamProcessor(
            threshold=VAD_CONFIG["threshold"],
            min_speech_ms=VAD_CONFIG["min_speech_duration_ms"],
            min_silence_ms=VAD_CONFIG["min_silence_duration_ms"],
            sample_rate=SAMPLE_RATE,
        )

        # Transcription stabilization with LocalAgreement-n
        self.stabilizer = StreamingTranscriptionStabilizer(
            n=STREAMING_CONFIG["local_agreement_n"],
            similarity_threshold=STREAMING_CONFIG["la_similarity_threshold"],
        )

        # Context accumulator for domain-specific prompting
        # P2 (15.02.2026): Now uses THEOLOGICAL_GLOSSARY from module level
        # Prompt conditioning helps Whisper spell domain terms correctly
        self.context_text = THEOLOGICAL_GLOSSARY

        # Results storage
        self.transcriptions: List[str] = []
        self.confirmed_text: str = ""  # All confirmed text (for trimming context)
        self.total_audio_seconds = 0.0

        # Timestamp-based deduplicator - tracks words by audio time, not position
        # FIX (19.01.2026): Replaces word-count approach which failed on text shifts
        # FIX (21.01.2026): overlap_tolerance 0.3→0.1, min_new_words 3→2.
        # NOTE: 0.1 is a PROPORTION of word length, not 100 ms - see the docstring of
        # `TimestampDeduplicator.__init__`. The previous comment ("100ms industry standard")
        # was untrue and had been sitting here since the January change.
        self.timestamp_deduplicator = TimestampDeduplicator(
            overlap_tolerance=0.1,  # ratio of word duration (NOT ms); 0.3 was too aggressive
            min_new_words=2  # Reduced latency (was 3)
        )

        # REP E0-E2: one session-lifetime shadow ledger beside timestamp dedup.
        # The object is inert in `off`; it never returns replacement text.
        self.rep_shadow = RepShadowSession.from_env(session_id)
        self.rep_retry = RepRetrySession.from_env(session_id,
            max_snapshot_samples=int(STREAMING_CONFIG["max_buffer_sec"] * SAMPLE_RATE),
            runtime_contract={"model": MODEL_CONFIG["model_name"],
                "revision": MODEL_CONFIG.get("model_revision"),
                "dtype": MODEL_CONFIG["torch_dtype"],
                "attention": MODEL_CONFIG["attn_implementation"],
                "transformers": transformers.__version__,
                "decoder": _build_generate_kwargs(),
                "export_optimization": os.getenv("ASR_REP_EXPORT_OPTIMIZATION_ENABLED", "false")})

        # F6b (16.02.2026): Hallucination burst counter
        # CIO audit: force-trim only after 3+ consecutive hallucination detections
        self.hallucination_burst_count = 0

    def update_activity(self):
        """Update last activity timestamp."""
        self.last_activity = time.time()


# Global session store
sessions: Dict[str, TranscriptionSession] = {}
executor = RetryExecutor(max_workers=4, max_retry_parents=50_000)
_WHISPER_EXECUTOR_MAX_WORKERS = 4
_whisper_diag_lock = threading.Lock()
_whisper_diag_sequence = 0
_whisper_diag_in_flight_total = 0
_whisper_diag_in_flight_by_session: Dict[str, int] = {}

# Service startup time
service_start_time = time.time()


def _log_whisper_diag(event: str, **fields) -> None:
    """Emit parseable Whisper timing diagnostics without changing pipeline behavior."""
    payload = {"event": event, **fields}
    logger.info("[WHISPER_DIAG] " + json.dumps(payload, ensure_ascii=False, default=str))


def _log_rep_event(payload: Optional[dict]) -> None:
    """Emit one privacy-safe REP event; diagnostics are always fail-open."""
    if not payload:
        return
    try:
        logger.info("[REP_OBSERVER] " + json.dumps(payload, ensure_ascii=True, default=str))
    except Exception as exc:
        logger.warning("[REP_OBSERVER] event dropped: %s", type(exc).__name__)


def _emit_rep_decode_events(
    session, decode_timing, chunks_list, provenance, stable_text,
    timestamp_dedup_text, candidate_events,
) -> None:
    """Build REP observations only in shadow; `off` pays no alignment cost."""
    if session.rep_shadow.mode != "shadow":
        return
    raw_text = decode_timing.pop("rep_raw_text", "")
    alignment = align_text_to_spans(
        raw_text,
        decode_timing.pop("rep_raw_chunks", chunks_list),
        provenance.get("input_start_sample") or 0,
        SAMPLE_RATE,
        input_end_sample=provenance.get("input_end_sample"),
    )
    raw_spans = [span.to_dict() for span in alignment.word_spans] if alignment.is_exact else []
    common = {
        "decode_id": provenance.get("decode_id"),
        "input_start_sample": provenance.get("input_start_sample"),
        "input_end_sample": provenance.get("input_end_sample"),
        "queue_depth": _executor_queue_size(),
        "in_flight": _in_flight_total(),
    }
    _log_rep_event(session.rep_shadow.observe_stage(
        "asr_decode_raw", raw_text, spans=raw_spans,
        lineage_status="complete" if alignment.is_exact else "incomplete_provenance",
        lineage_reason=alignment.reason, **common,
    ))
    _log_rep_event(session.rep_shadow.observe_stage(
        "asr_local_agreement", stable_text,
        spans=provenance.get("stable_word_spans") or [],
        lineage_status=provenance.get("stable_provenance_status"),
        lineage_reason=provenance.get("stable_alignment_status"), **common,
    ))
    _log_rep_event(session.rep_shadow.observe_stage(
        "asr_timestamp_dedup", timestamp_dedup_text,
        spans=provenance.get("confirmed_word_spans") or [],
        lineage_status=provenance.get("provenance_status"),
        lineage_reason=provenance.get("provenance_reason"),
        fuzzy_replacement_count=session.timestamp_deduplicator._fuzzy_replacements,
        **common,
    ))
    for event in candidate_events:
        _log_rep_event(event)


def _log_rep_retry_event(payload):
    # Separate contract: the E0-E2 observer schema requires policy_applied=false.
    # Mixing APPLY into it would invalidate the existing shadow invariant audit.
    try:
        logger.info("[REP_RETRY] " + json.dumps(payload, ensure_ascii=True))
    except Exception:
        logger.warning("[REP_RETRY] diagnostic dropped")


def _log_token_timestamp_probe(session_id, decode_id, transcribe_status,
                               probe_result, chunk_summary) -> None:
    """The `token_timestamp_probe` event - raw token timestamps plus the layer verdict.

    Stays silent when the flag is OFF (no probe result). Fail-open: any error in the
    diagnostics itself ends as a warning carrying the exception TYPE NAME, never its message -
    an object's `repr` can carry content, as a smoke run caught on `alignment_reason`.
    """
    if not probe_result:
        return
    try:
        verdict = classify_zero_span_layer(probe_result.get("totals"), chunk_summary)
        _log_whisper_diag(
            "token_timestamp_probe",
            session_id=session_id,
            transcribe_status=transcribe_status,
            **probe_result,
            **verdict,
        )
    except Exception as exc:
        logger.warning(
            "[TOKEN_TS_PROBE] diagnostics skipped for decode_id=%s: %s",
            decode_id, type(exc).__name__,
        )


def _strict_hypothesis_provenance(text, chunks, input_start_sample, input_end_sample):
    """Return exact spans for one partial/stable hypothesis, or an explicit absence."""
    if not text:
        return "no_text", [], None
    alignment = align_text_to_subspans(
        text,
        chunks,
        buffer_start_sample=input_start_sample,
        sample_rate=SAMPLE_RATE,
        input_end_sample=input_end_sample,
    )
    if not alignment.is_exact:
        return "incomplete_provenance", [], alignment.status
    return "complete", [span.to_dict() for span in alignment.word_spans], alignment.status


def _build_decode_provenance_diag(provenance: dict) -> dict:
    """`decode_provenance` event payload: the VERDICT, without the delta words.

    The delta text is not needed to compute coverage and would reach cloud logs - the full
    spans stay in the response and in the session history.

    The range is computed with `min`/`max`, NOT from the first and last record. The sidecar
    currently rejects non-monotonic series (`process_with_spans` -> `incomplete_provenance`),
    so this is defence in depth: if that rule ever loosened, the edge records would understate
    the range by the whole length of an utterance while the event still looked credible.
    """
    spans = provenance.get("confirmed_word_spans") or []
    partial_spans = provenance.get("partial_word_spans") or []
    stable_spans = provenance.get("stable_word_spans") or []
    text_bearing_span_fields = {
        "confirmed_word_spans", "partial_word_spans", "stable_word_spans",
    }
    diag = {k: v for k, v in provenance.items() if k not in text_bearing_span_fields}
    diag["confirmed_word_span_count"] = len(spans)
    diag["confirmed_span_start_sample"] = min(s["start_sample"] for s in spans) if spans else None
    diag["confirmed_span_end_sample"] = max(s["end_sample"] for s in spans) if spans else None
    diag["partial_word_span_count"] = len(partial_spans)
    diag["stable_word_span_count"] = len(stable_spans)
    return diag


def _log_hallucination_detected(gate, text, reason, **ctx) -> None:
    """Phase 0 instrumentation (27.06.2026): structured hallucination_detected event.

    Privacy (#6): sha256 + length + bounded previews only — never the full raw transcript in
    cloud logs. Full fixtures are reconstructed locally from raw/whisper_logs.jsonl. Zero
    behaviour change: this only emits a log line.
    """
    import hashlib
    t = text or ""
    sha = hashlib.sha256(t.encode("utf-8", "ignore")).hexdigest()[:16]
    ls = getattr(reason, "loop_start", None) if reason is not None else None
    if isinstance(ls, int) and 0 <= ls <= len(t):
        prefix_preview, suffix_preview = t[:ls][-80:], t[ls:ls + 80]
    else:
        prefix_preview, suffix_preview = t[:80], (t[-80:] if len(t) > 80 else "")
    # reason is None at gate 1 when preprocess_transcription dropped for a NON-hallucination
    # reason (punctuation-only / too short) -> reason_code "preprocess_validation_drop".
    # SCORING CONVENTION: scorers MUST EXCLUDE reason_code=="preprocess_validation_drop" from the
    # hallucination-filter false-positive rate (it is not a hallucination decision). The event name
    # is "hallucination_detected" for all cases, so counting by event name alone overcounts.
    # See the hallucination filter module for the scoring convention.
    _log_whisper_diag(
        "hallucination_detected",
        gate=gate,
        reason_code=(reason.code if reason is not None else "preprocess_validation_drop"),
        text_sha256=sha,
        text_len=len(t),
        loop_start=ls,
        prefix_preview=prefix_preview,
        matched_span_preview=(getattr(reason, "matched_span", "")[:80] if reason is not None else ""),
        suffix_preview=suffix_preview,
        **ctx,
    )


def _next_whisper_diag_id() -> int:
    global _whisper_diag_sequence
    with _whisper_diag_lock:
        _whisper_diag_sequence += 1
        return _whisper_diag_sequence


def _executor_queue_size() -> Optional[int]:
    try:
        return executor.queue_size
    except Exception:
        return None


def _in_flight_total() -> int:
    with _whisper_diag_lock:
        return _whisper_diag_in_flight_total


def _mark_whisper_pipeline_start(session_id: str) -> tuple[int, int]:
    global _whisper_diag_in_flight_total
    with _whisper_diag_lock:
        _whisper_diag_in_flight_total += 1
        session_count = _whisper_diag_in_flight_by_session.get(session_id, 0) + 1
        _whisper_diag_in_flight_by_session[session_id] = session_count
        return _whisper_diag_in_flight_total, session_count


def _mark_whisper_pipeline_finish(session_id: str) -> tuple[int, int]:
    global _whisper_diag_in_flight_total
    with _whisper_diag_lock:
        _whisper_diag_in_flight_total = max(0, _whisper_diag_in_flight_total - 1)
        session_count = max(0, _whisper_diag_in_flight_by_session.get(session_id, 0) - 1)
        if session_count:
            _whisper_diag_in_flight_by_session[session_id] = session_count
        else:
            _whisper_diag_in_flight_by_session.pop(session_id, None)
        return _whisper_diag_in_flight_total, session_count


# =============================================================================
# Pydantic Models
# =============================================================================

class TranscribeRequest(BaseModel):
    """Request for single audio transcription."""
    audio: List[float] = Field(..., description="PCM audio samples as float32 array")
    sample_rate: int = Field(default=16000, description="Audio sample rate")
    language: str = Field(default="de", description="Target language code")
    task: str = Field(default="transcribe", description="Task: transcribe or translate")


class TranscribeResponse(BaseModel):
    """Response from transcription."""
    text: str
    language: str
    duration_seconds: float
    processing_time_ms: float
    segments: List[Dict[str, Any]] = []


class StreamChunkRequest(BaseModel):
    """Request for streaming audio chunk."""
    session_id: str
    audio: List[float] = Field(..., description="PCM audio chunk")
    sample_rate: int = Field(default=16000, description="Audio sample rate (will resample to 16kHz if needed)")
    is_final: bool = Field(default=False, description="True if this is the last chunk")


class StreamChunkResponse(BaseModel):
    """Response for streaming chunk."""
    session_id: str
    partial_text: str
    confirmed_text: str           # DELTA only (new confirmed words this step); "" when no new confirm
    is_speech: bool
    has_new_transcription: bool
    # Phase 2 part 1 (28.06.2026): cumulative LA stable prefix, exported SEPARATELY from the delta.
    # On a stall (has_new_transcription=False) confirmed_text="" but stable_text may be non-empty —
    # the gateway needs this for pacing decisions (soft-commit the stable prefix instead of
    # force-fallback). Instrumentation-only for now: gateway logs it, does not yet use it.
    stable_text: str = ""
    la_confirmed_word_count: int = 0
    la_confirmed_char_count: int = 0
    # Provenance for the hypothesis. ALL fields optional - an older gateway ignores them with
    # no change in behaviour. None of them affects the text.
    # `decode_in_flight_at_fallback` is DELIBERATELY absent: the response arrives after
    # inference completes, so live state must be measured by the gateway, not by Whisper.
    decode_id: Optional[int] = None
    rep_retry: Optional[Dict[str, Any]] = None
    input_pcm_sha256: Optional[str] = None
    input_start_sample: Optional[int] = None
    input_end_sample: Optional[int] = None
    decode_requested_at_ms: Optional[float] = None
    decode_started_at_ms: Optional[float] = None
    decode_finished_at_ms: Optional[float] = None
    executor_wait_ms: Optional[float] = None
    # `inference_ms` = `_run_pipeline` alone; `worker_total_ms` = worker plus the return to
    # the event loop; `decode_total_ms` = request-to-result including the executor queue.
    # The names are deliberately disjoint - the track has to separate waiting from computing,
    # so a single aggregate number was the worst possible field.
    inference_ms: Optional[float] = None
    worker_total_ms: Optional[float] = None
    decode_total_ms: Optional[float] = None
    transcribe_status: Optional[str] = None
    # `complete` / `incomplete_provenance` / `no_delta` (the deduplicator released no delta) /
    # `delta_filtered` (gate 2) / `no_confirmed_delta` (a decode happened but never reached the
    # deduplicator). `None` means ONLY one thing: there was no decode in this request.
    provenance_status: Optional[str] = None
    # DISJOINT reason for `incomplete_provenance`: `invalid_timestamp` / `missing_span` /
    # `non_monotonic`. `None` for every other status. Downstream reports these buckets
    # SEPARATELY - an aggregate "incomplete" cannot separate a model defect from a contract one.
    provenance_reason: Optional[str] = None
    confirmed_word_spans: Optional[List[Dict[str, Any]]] = None
    # FQF-4B: tentative and cumulative stable hypotheses are different texts from the
    # confirmed delta and therefore require their own exact, fail-closed span evidence.
    partial_provenance_status: Optional[str] = None
    partial_word_spans: Optional[List[Dict[str, Any]]] = None
    partial_alignment_status: Optional[str] = None
    stable_provenance_status: Optional[str] = None
    stable_word_spans: Optional[List[Dict[str, Any]]] = None
    stable_alignment_status: Optional[str] = None
    text_token_count: Optional[int] = None
    span_token_count: Optional[int] = None
    alignment_status: Optional[str] = None
    alignment_reason: Optional[str] = None
    unaligned_word_count: Optional[int] = None
    non_word_level_chunk: Optional[bool] = None
    aligned_span: Optional[List[int]] = None


class SessionCreateResponse(BaseModel):
    """Response when creating a session."""
    session_id: str
    message: str


class HealthResponse(BaseModel):
    """Health check response."""
    status: str
    model_loaded: bool
    model_path: str
    device: str
    active_sessions: int
    uptime_seconds: float


# =============================================================================
# FastAPI Application
# =============================================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifecycle manager - pre-warm model on startup."""
    logger.info("Starting Whisper service (HuggingFace transformers)...")

    # Log config values for debugging
    from config import VOLUME_GATE
    logger.info(f"[CONFIG] Model: {MODEL_CONFIG['model_name']} (revision: {MODEL_CONFIG.get('model_revision', 'latest')})")
    logger.info(f"[CONFIG] Attention: {MODEL_CONFIG['attn_implementation']}")
    logger.info(f"[CONFIG] VOLUME_GATE enabled={VOLUME_GATE['enabled']}, threshold={VOLUME_GATE['threshold_db']}dB")
    logger.info(f"[CONFIG] External Silero VAD: threshold={VAD_CONFIG['threshold']}")

    # Pre-warm model in thread pool (blocking operation)
    loop = asyncio.get_event_loop()
    try:
        await loop.run_in_executor(None, WhisperSingleton.get_instance)
        logger.info("Whisper model ready!")
    except Exception as e:
        # FAIL FAST, DO NOT LIMP. Until 29.08 this handler logged the error and
        # fell through, under the comment "Continue anyway - will fail on first
        # request". What it actually produced was worse than a failure on the
        # first request: the process stayed up indefinitely, /health kept
        # answering 200 with status="warming_up", and a service that could never
        # transcribe was indistinguishable from one that was still starting.
        #
        # A container that exits is diagnosable - the orchestrator restarts it,
        # the logs carry the cause, and the failure is visible. A container stuck
        # in warming_up is not. Uvicorn turns the exception below into
        # "Application startup failed. Exiting."
        #
        # This deliberately does not try to tell transient from permanent: a
        # restart re-attempts the load, which is the correct response to a
        # transient fault and an honest crash-loop for a permanent one.
        logger.critical("Failed to load Whisper model, refusing to serve: %s", e)
        raise RuntimeError(f"Whisper model failed to load: {e}") from e

    # Explicit DEV experiment only. Same loaded model, before serving requests.
    # This flag never enables replacement of any listener output.
    if os.getenv("REP_E4_R0_ENABLED", "false").lower() == "true":
        from rep_r0_benchmark import run_r0
        if not WhisperSingleton.is_loaded():
            raise RuntimeError("R0 requires the existing model to be ready")
        await run_r0(WhisperSingleton.get_instance(), executor, _run_pipeline,
                     _build_generate_kwargs, _log_rep_event)

    # Start background cleanup task
    if os.getenv("ASR_REP_DEV_OWNER_AUTHORIZED") == "pre_adjudication_one_run":
        from rep_dev_experiment import preflight
        await preflight(WhisperSingleton.get_instance(), executor, _run_pipeline,
                        _build_generate_kwargs, _log_rep_retry_event)

    cleanup_task = asyncio.create_task(cleanup_stale_sessions())

    yield

    # Cleanup
    logger.info("Shutting down Whisper service...")
    cleanup_task.cancel()
    for session in list(sessions.values()):
        session.rep_retry.close()
    executor.shutdown(wait=True)


# Create FastAPI app
app = FastAPI(
    title="Barnaba Whisper Service",
    description="Swiss German speech recognition service with church optimization",
    version="2.0.0",
    lifespan=lifespan
)

def parse_allowed_origins(value: str) -> list[str]:
    return [origin.strip() for origin in value.split(",") if origin.strip()]


ALLOWED_CORS_ORIGINS = parse_allowed_origins(
    os.getenv(
        "WHISPER_CORS_ALLOWED_ORIGINS",
        "http://localhost,http://localhost:3000,http://localhost:8080,http://127.0.0.1,http://127.0.0.1:8080",
    )
)


# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# =============================================================================
# Health Endpoints
# =============================================================================

@app.get("/health", response_model=HealthResponse)
async def health_check():
    """Health check endpoint."""
    device_str = f"cuda:{MODEL_CONFIG['device']}" if MODEL_CONFIG['device'] >= 0 else "cpu"
    return HealthResponse(
        status="healthy" if WhisperSingleton.is_loaded() else "warming_up",
        model_loaded=WhisperSingleton.is_loaded(),
        model_path=MODEL_CONFIG["model_name"],
        device=device_str,
        active_sessions=len(sessions),
        uptime_seconds=time.time() - service_start_time
    )


@app.get("/ready")
async def ready():
    """Readiness probe: return 503 until the model is loaded and warmed."""
    if not WhisperSingleton.is_loaded():
        raise HTTPException(status_code=503, detail="Whisper model warming up")
    return {"ready": True}


# =============================================================================
# Test Endpoints (for debugging audio pipeline)
# =============================================================================

class TestAudioResponse(BaseModel):
    """Response for test-audio endpoint."""
    success: bool
    input_samples: int
    input_rate: int
    output_samples: int
    output_rate: int
    min_value: float
    max_value: float
    mean_value: float
    duration_sec: float
    resampler_backend: str
    message: str


@app.post("/test-audio", response_model=TestAudioResponse)
async def test_audio(request: TranscribeRequest):
    """
    Test audio path WITHOUT running Whisper model.

    Use this to verify:
    1. Audio arrives correctly from browser
    2. Sample rate is correct
    3. Resampling works (48kHz -> 16kHz)
    4. Values are in expected range [-1, 1]

    No GPU/model needed - CPU only!
    """
    # Convert to numpy
    audio = np.array(request.audio, dtype=np.float32)

    if len(audio) == 0:
        return TestAudioResponse(
            success=False,
            input_samples=0,
            input_rate=request.sample_rate,
            output_samples=0,
            output_rate=SAMPLE_RATE,
            min_value=0.0,
            max_value=0.0,
            mean_value=0.0,
            duration_sec=0.0,
            resampler_backend="none",
            message="Empty audio received"
        )

    # Get resampler info
    pool = get_resampler_pool(SAMPLE_RATE)
    resampler = pool.get_resampler(request.sample_rate)
    backend = resampler.backend

    # Resample if needed
    if request.sample_rate != SAMPLE_RATE:
        audio_16k = resample_audio(audio, request.sample_rate, SAMPLE_RATE)
    else:
        audio_16k = audio

    return TestAudioResponse(
        success=True,
        input_samples=len(audio),
        input_rate=request.sample_rate,
        output_samples=len(audio_16k),
        output_rate=SAMPLE_RATE,
        min_value=float(audio_16k.min()),
        max_value=float(audio_16k.max()),
        mean_value=float(audio_16k.mean()),
        duration_sec=len(audio_16k) / SAMPLE_RATE,
        resampler_backend=backend,
        message=f"Audio OK: {request.sample_rate}Hz -> {SAMPLE_RATE}Hz via {backend}"
    )


# =============================================================================
# Transcription Endpoints
# =============================================================================

@app.post("/transcribe", response_model=TranscribeResponse)
async def transcribe_audio(request: TranscribeRequest):
    """
    Transcribe a complete audio segment.

    This is the simple API for non-streaming use cases.
    Includes hallucination filtering and volume gating.

    Uses HuggingFace transformers pipeline (migrated from faster-whisper 16.01.2026).
    """
    start_time = time.time()

    # Get model (transformers pipeline)
    pipe = WhisperSingleton.get_instance()
    if pipe is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    # Convert audio to numpy array
    audio = np.array(request.audio, dtype=np.float32)

    if len(audio) == 0:
        return TranscribeResponse(
            text="",
            language=request.language,
            duration_seconds=0,
            processing_time_ms=0,
            segments=[]
        )

    # Volume gate - skip if too quiet
    volume_db = calculate_volume_db(audio)
    logger.info(f"[DIAG] Audio volume: {volume_db:.1f}dB, samples: {len(audio)}")
    if not should_transcribe(audio):
        logger.info(f"[DIAG] Volume gate BLOCKED - audio too quiet ({volume_db:.1f}dB)")
        return TranscribeResponse(
            text="",
            language=request.language,
            duration_seconds=len(audio) / SAMPLE_RATE,
            processing_time_ms=(time.time() - start_time) * 1000,
            segments=[]
        )
    logger.info(f"[DIAG] Volume gate PASSED")

    # Resample if needed (using high-quality torchaudio sinc interpolation)
    # This fixes the "Whisper returns ." bug caused by linear interpolation aliasing
    if request.sample_rate != SAMPLE_RATE:
        logger.info(f"[DIAG] Resampling: {request.sample_rate}Hz -> {SAMPLE_RATE}Hz ({len(audio)} samples)")
        audio = resample_audio(audio, request.sample_rate, SAMPLE_RATE)
        logger.info(f"[DIAG] After resampling: {len(audio)} samples")

    # Run transcription in thread pool
    def do_transcribe():
        generate_kwargs = _build_generate_kwargs(request.language, request.task)
        return _run_pipeline(pipe, audio, generate_kwargs)

    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(executor, do_transcribe)

    # Transform result to our format
    # transformers returns: {"text": "...", "chunks": [{"text": "...", "timestamp": (start, end)}, ...]}
    raw_text = result.get("text", "")
    chunks = result.get("chunks", [])

    logger.info(f"[DIAG] transformers returned {len(chunks)} chunks")
    for i, chunk in enumerate(chunks):
        logger.info(f"[DIAG] Chunk {i}: {len(chunk.get('text', ''))} characters, ts={chunk.get('timestamp', 'N/A')}")

    # Filter hallucinations. Contract: preprocess_transcription returns None when the
    # WHOLE window is classified as hallucination (e.g. C3_BIGRAM_REP firing on
    # rhetorical repetition) — coerce to "" like the streaming path does (:1935),
    # otherwise TranscribeResponse(text=None) raises pydantic ValidationError → 500
    # (grid-dependent /transcribe bug). Segments stay raw by design.
    clean_text = preprocess_transcription(raw_text) or ""
    logger.info(f"[DIAG] Preprocess: {len(raw_text)} -> {len(clean_text)} characters")

    # Build response
    processing_time = (time.time() - start_time) * 1000
    audio_duration = len(audio) / SAMPLE_RATE

    # Convert chunks to segment format
    segments = []
    for chunk in chunks:
        ts = chunk.get("timestamp", (0, 0))
        if ts and len(ts) == 2:
            segments.append({
                "start": ts[0] if ts[0] is not None else 0,
                "end": ts[1] if ts[1] is not None else 0,
                "text": chunk.get("text", ""),
                "confidence": 0.0  # transformers doesn't provide logprob per segment
            })

    return TranscribeResponse(
        text=clean_text,
        language=request.language,
        duration_seconds=audio_duration,
        processing_time_ms=processing_time,
        segments=segments
    )


# =============================================================================
# Session Management Endpoints
# =============================================================================

@app.post("/session/create", response_model=SessionCreateResponse)
async def create_session():
    """Create a new streaming transcription session."""
    import uuid
    session_id = str(uuid.uuid4())

    sessions[session_id] = TranscriptionSession(session_id)

    logger.info(f"Created session: {session_id}")

    return SessionCreateResponse(
        session_id=session_id,
        message="Session created successfully"
    )


@app.post("/session/{session_id}/chunk", response_model=StreamChunkResponse)
async def process_chunk(session_id: str, request: StreamChunkRequest):
    """
    Process a streaming audio chunk.

    This is the main API for real-time streaming transcription.
    Uses church-optimized VAD and hallucination filtering.
    """
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found")

    session = sessions[session_id]
    session.update_activity()

    # Provenance describes ONLY the work done for THIS request.
    # It stays `None` when there was no decode - buffer too short, no new audio, empty
    # snapshot, no model, pipeline exception. Inheriting the previous evidence would describe
    # different audio and be false evidence the gateway has no way to detect.
    response_provenance = None
    rep_candidate_events = []
    rep_timestamp_dedup_text = ""

    # Convert audio
    audio = np.array(request.audio, dtype=np.float32)

    if len(audio) == 0 and not request.is_final:
        return StreamChunkResponse(
            session_id=session_id,
            partial_text="",
            confirmed_text="",
            is_speech=False,
            has_new_transcription=False
        )

    # Resample if needed (using high-quality torchaudio sinc interpolation)
    if request.sample_rate != SAMPLE_RATE:
        logger.info(f"[Session] Resampling: {request.sample_rate}Hz -> {SAMPLE_RATE}Hz ({len(audio)} samples)")
        audio = resample_audio(audio, request.sample_rate, SAMPLE_RATE)
        logger.info(f"[Session] After resampling: {len(audio)} samples")

    # Volume gate - skip very quiet audio
    if len(audio) > 0 and not should_transcribe(audio):
        return StreamChunkResponse(
            session_id=session_id,
            partial_text="",
            confirmed_text="",
            is_speech=False,
            has_new_transcription=False
        )

    # Add to buffer - FIX: Check for force trim signal
    force_trim_time = session.audio_buffer.add(audio)
    session.total_audio_seconds += len(audio) / SAMPLE_RATE

    if session.transcription_in_progress:
        current_buffer_samples = len(session.audio_buffer.audio_buffer)
        session.coalesced_audio_pending = True
        session.coalesced_request_count += 1
        if force_trim_time is not None:
            _log_truncation_risk_probe(session, "hard_limit", force_trim_time, source="coalesced")
            force_trim_time = _snap_force_trim_time_to_word_boundary(session, force_trim_time, "hard_limit", source="coalesced")
            if STREAMING_CONFIG["force_trim_submit_before_trim_enabled"]:
                _set_pending_force_trim(session, force_trim_time, reason="hard_limit_deferred")
        _log_whisper_diag(
            "coalesced_skip",
            session_id=session_id,
            current_buffer_samples=current_buffer_samples,
            last_processed_samples=session.last_processed_samples,
            pending_requests=session.coalesced_request_count,
            buffer_s=round(current_buffer_samples / SAMPLE_RATE, 3),
            force_trim_deferred=force_trim_time is not None,
            pending_force_trim=session.pending_force_trim_time is not None,
        )
        return StreamChunkResponse(
            session_id=session_id,
            partial_text="",
            confirmed_text="",
            is_speech=True,
            has_new_transcription=False
        )

    # FIX (23.01.2026): Handle force trim from buffer hard limit
    # C.7 (30.06.2026): optionally submit the full buffer once before the
    # destructive hard-limit trim. The force overlap remains unchanged.
    livelock_force_submit = False
    if force_trim_time is not None:
        logger.warning(f"[FORCE_TRIM] Buffer returned force_trim_time={force_trim_time:.2f}s")
        _log_truncation_risk_probe(session, "hard_limit", force_trim_time, source="chunk_add")
        force_trim_time = _snap_force_trim_time_to_word_boundary(session, force_trim_time, "hard_limit", source="chunk_add")
        if STREAMING_CONFIG["force_trim_submit_before_trim_enabled"]:
            _set_pending_force_trim(session, force_trim_time, reason="hard_limit_post_submit")
        else:
            _perform_buffer_trim(session, force_trim_time, [], reason="hard_limit")
            session.hard_limit_without_submit_count += 1
            if session.hard_limit_without_submit_count >= STREAMING_CONFIG["livelock_guard_max_hard_trims"]:
                livelock_force_submit = True
                logger.warning(
                    f"[LIVELOCK_GUARD] hard_limit_without_submit_count="
                    f"{session.hard_limit_without_submit_count}, forcing submit"
                )
                _log_whisper_diag(
                    "livelock_guard",
                    session_id=session_id,
                    hard_limit_without_submit_count=session.hard_limit_without_submit_count,
                )

    # Check VAD
    is_speech = True  # Default to true if VAD not ready
    try:
        _, is_speaking = session.vad_processor.process_chunk(audio)
        is_speech = is_speaking
    except Exception as e:
        logger.warning(f"VAD error: {e}")

    # Initialize response variables
    has_new_transcription = False
    partial_text = ""
    confirmed_text = ""
    stable_text = ""  # Phase 2 part 1: cumulative LA stable prefix (separate from confirmed delta)
    did_submit_this_cycle = False

    # GROWING BUFFER ARCHITECTURE (17.01.2026):
    # Instead of sliding window (each chunk = different audio), we use growing buffer:
    # - Iter 1: audio 0-2s → transcribe → compare with previous
    # - Iter 2: audio 0-4s → transcribe → compare with previous
    # - Iter 3: audio 0-6s → transcribe → compare with previous
    # This creates the consistent prefix that LocalAgreement needs.

    # Check if we have enough NEW audio for transcription
    should_process = session.audio_buffer.should_process() or request.is_final
    current_buffer_samples = len(session.audio_buffer.audio_buffer)
    has_new_audio = current_buffer_samples > session.last_processed_samples

    if (should_process and has_new_audio) or livelock_force_submit:
        did_submit_this_cycle = True
        session.transcription_in_progress = True
        # The WHOLE cycle sits in try/finally. An exception from the snapshot, the hash or the
        # code before the inner `try` - and an empty snapshot too - used to leave
        # `transcription_in_progress=True` for the next cycle, so the Whisper session locked
        # itself up after a single error.
        try:
            session.coalesced_audio_pending = False
            session.coalesced_request_count = 0
            session.hard_limit_without_submit_count = 0  # a real submit is happening -> reset guard
            # Audio and its absolute range are taken under ONE lock - the hash and the sample
            # boundaries describe exactly the same tensor. `get_full_buffer()` plus a separate
            # range read created a window in which a new chunk invalidated the evidence.
            decode_snapshot = session.audio_buffer.snapshot_for_decode()
            full_audio = decode_snapshot.audio
            session.decode_seq += 1
            decode_id = session.decode_seq
            decode_requested_at_ms = time.time() * 1000.0
            decode_started_perf = time.perf_counter()

            if len(full_audio) > 0:
                # Update tracking
                session.last_processed_samples = len(full_audio)

                # DIAGNOSTIC: Log audio stats before transcription
                rms = np.sqrt(np.mean(full_audio.astype(np.float64)**2))
                db = 20 * np.log10(rms + 1e-10)
                buffer_duration = len(full_audio) / SAMPLE_RATE
                logger.info(f"[GROWING_BUFFER] Processing {buffer_duration:.2f}s of audio (samples={len(full_audio)}, dB={db:.1f})")

                # Transcribe using transformers pipeline
                pipe = WhisperSingleton.get_instance()
                if pipe is not None:
                    try:
                        diag_id = _next_whisper_diag_id()
                        queued_at = time.perf_counter()
                        _log_whisper_diag(
                            "submit",
                            request_id=diag_id,
                            session_id=session_id,
                            audio_s=round(buffer_duration, 3),
                            samples=len(full_audio),
                            db=round(float(db), 1),
                            executor_max_workers=_WHISPER_EXECUTOR_MAX_WORKERS,
                            executor_queue_size=_executor_queue_size(),
                            num_beams=TRANSCRIBE_CONFIG["num_beams"],
                            return_timestamps=TRANSCRIBE_CONFIG["return_timestamps"],
                            batch_size=TRANSCRIBE_CONFIG["batch_size"],
                            max_buffer_s=STREAMING_CONFIG["max_buffer_sec"],
                            buffer_offset_s=round(session.audio_buffer.get_buffer_offset(), 3),
                        )
                        # Build prompt for context continuity (from previous trims)
                        # After trim: buffer has last ~200 words of confirmed text
                        # Before trim: empty → falls back to context_text (THEOLOGICAL_GLOSSARY)
                        buffer_prompt = session.audio_buffer.get_prompt()

                        # Hash computed FROM THE SNAPSHOT, BEFORE the array is handed to the
                        # executor. It has to prove the exact bytes given to the model -
                        # computing it after inference would assume the pipeline never
                        # modifies the array.
                        try:
                            input_pcm_sha256 = pcm_sha256(full_audio)
                        except ProvenanceError as exc:
                            input_pcm_sha256 = None
                            logger.warning("[PROVENANCE] hash unavailable: %s", exc)
                        decode_submitted_perf = time.perf_counter()
                        decode_timing = {}

                        def do_transcribe():
                            transcribe_status = "empty_model_output"
                            pipeline_start = time.perf_counter()
                            # Executor wait time vs the inference time itself - without that
                            # split, "duration" is request-to-result, not inference.
                            decode_timing["decode_started_at_ms"] = time.time() * 1000.0
                            decode_timing["executor_wait_ms"] = (pipeline_start - decode_submitted_perf) * 1000.0
                            # Start of the WHOLE worker (prompt + inference + return). This is
                            # NOT inference - that has its own measurement around
                            # `_run_pipeline`.
                            decode_timing["_worker_start_perf"] = pipeline_start
                            queued_ms = (pipeline_start - queued_at) * 1000
                            active_total, active_session = _mark_whisper_pipeline_start(session_id)
                            _log_whisper_diag(
                                "pipeline_start",
                                request_id=diag_id,
                                session_id=session_id,
                                queued_ms=round(queued_ms, 1),
                                in_flight_total=active_total,
                                in_flight_session=active_session,
                                executor_queue_size=_executor_queue_size(),
                            )
                            generate_kwargs = _build_generate_kwargs(
                                TRANSCRIBE_CONFIG["language"], "transcribe"
                            )

                            try:
                                # P2 (15.02.2026): Prompt conditioning — glossary only
                                # FIX F7 (16.02.2026): Use ONLY pre-computed glossary, NOT buffer_prompt
                                # FIX F13 (18.02.2026): USE_PROMPT_IDS env var toggle (default OFF)
                                #
                                # R1.4 B3: Post-trim context prompt (safe path, separate from F7)
                                # After buffer trim, inject last 200 chars of CONFIRMED text as prompt.
                                # This is safe because: (a) text is LA-confirmed, not hallucinated,
                                # (b) capped at 200 chars, (c) only active for 1-2 iterations post-trim.
                                # Glossary prompt_ids take priority when enabled.
                                if is_speech and USE_GLOSSARY_PROMPT_IDS:
                                    glossary_ids = WhisperSingleton.get_prompt_ids()
                                    if glossary_ids is not None:
                                        generate_kwargs["prompt_ids"] = glossary_ids
                                        logger.debug(f"[P2] Glossary-only prompt_ids ({len(glossary_ids)} tokens)")
                                elif is_speech and buffer_prompt and USE_CONTEXT_PROMPT_IDS:
                                    # B3: Use confirmed text as context (UFAL pattern: 200 chars)
                                    context_text = buffer_prompt[-200:].strip()
                                    if context_text:
                                        tokenizer = WhisperSingleton.get_tokenizer()
                                        if tokenizer is not None:
                                            ctx_ids = tokenizer.encode(context_text, add_special_tokens=False)
                                            # Cap at 50 tokens to avoid overshadowing audio
                                            ctx_ids = ctx_ids[-50:]
                                            generate_kwargs["prompt_ids"] = torch.tensor(
                                                ctx_ids,
                                                dtype=torch.long,
                                                device=_get_pipeline_target_device(pipe),
                                            )
                                            logger.debug(f"[B3] Post-trim context prompt: {len(ctx_ids)} tokens, {len(context_text)} characters")
                                elif not is_speech:
                                    logger.debug("[P2] VAD: no speech — skipping prompt_ids")
                                else:
                                    logger.debug(
                                        "[P2] prompt_ids DISABLED "
                                        f"(USE_GLOSSARY_PROMPT_IDS={USE_GLOSSARY_PROMPT_IDS}, "
                                        f"USE_CONTEXT_PROMPT_IDS={USE_CONTEXT_PROMPT_IDS})"
                                    )

                                # use_chunking=False: streaming audio is always <30s, no chunking needed
                                # Also avoids prompt_ids + chunk_length_s incompatibility bug
                                # `inference_ms` describes `_run_pipeline` ONLY. Measuring from
                                # worker start would include prompt building and the return to
                                # the event loop - the same mistake as the old
                                # `decode_duration_ms`.
                                inference_start_perf = time.perf_counter()
                                # The diagnostic scope covers EXACTLY one decode and lives in
                                # this executor thread. Flag OFF -> `probe is None` and
                                # `_run_pipeline` runs exactly as before.
                                # NOTE: with the flag ON, `inference_ms` GROWS by the cost of
                                # reading the tensor in `_forward` (a GPU sync). Comparing
                                # latency between flag states is therefore not legitimate -
                                # this is a diagnostic measurement, not an A/B arm.
                                with probe_scope(
                                    decode_id,
                                    enabled=TOKEN_TIMESTAMP_PROBE_ENABLED,
                                    environment=(
                                        _token_timestamp_probe_environment()
                                        if TOKEN_TIMESTAMP_PROBE_ENABLED else None
                                    ),
                                ) as probe:
                                    result = _run_pipeline(pipe, full_audio, generate_kwargs, use_chunking=False)
                                    decode_timing["inference_ms"] = (
                                        time.perf_counter() - inference_start_perf) * 1000.0
                                    if probe is not None:
                                        decode_timing["token_timestamp_probe"] = probe.result()

                                # Get raw text and filter hallucinations
                                raw_text = result.get("text", "")
                                chunks_list = result.get("chunks", [])
                                # Kept only in process memory until the privacy-safe REP
                                # observer hashes it; it is never copied into REP logs.
                                if session.rep_shadow.mode == "shadow":
                                    decode_timing["rep_raw_text"] = raw_text
                                    decode_timing["rep_raw_chunks"] = chunks_list

                                # Measured at the PIPELINE OUTPUT, before our code touches the
                                # chunks. The same measurement is repeated at the moment the
                                # chunks are handed to alignment; matching fingerprints prove
                                # OUR code did not move the timestamps. It does NOT decide
                                # whether a defect originated in the model or in Transformers
                                # post-processing - both sit on the far side of that boundary.
                                # No text, no repair.
                                decode_timing["pipeline_output_chunk_audit"] = summarize_chunk_timestamps(
                                    chunks_list,
                                    sample_rate=SAMPLE_RATE,
                                    snapshot_samples=len(full_audio),
                                )
                                pipeline_ms = (time.perf_counter() - pipeline_start) * 1000
                                chunk_rate = len(chunks_list) / buffer_duration if buffer_duration > 0 else 0.0
                                _log_whisper_diag(
                                    "pipeline_done",
                                    request_id=diag_id,
                                    session_id=session_id,
                                    pipeline_ms=round(pipeline_ms, 1),
                                    audio_s=round(buffer_duration, 3),
                                    realtime_factor=round(pipeline_ms / max(buffer_duration * 1000, 1), 3),
                                    chunks=len(chunks_list),
                                    chunks_per_s=round(chunk_rate, 3),
                                    raw_text_chars=len(raw_text),
                                )

                                logger.info(f"[GROWING_BUFFER] Whisper returned {len(raw_text)} characters ({len(chunks_list)} chunks)")

                                # F3 FIX (16.02.2026): Chunk rate anomaly = hallucination loop
                                # Normal: 2-5 chunks/s. >12 chunks/s = repetition loop
                                # CIO audit: lowered from 15 to 12 (catches 12.8/s glossary case, safe margin 2-3x)
                                if buffer_duration > 0 and len(chunks_list) / buffer_duration > 12:
                                    transcribe_status = "filtered_chunk_rate"
                                    logger.warning(f"[HALLUCINATION] Anomalous chunk rate: {len(chunks_list)/buffer_duration:.1f}/s ({len(chunks_list)} chunks in {buffer_duration:.1f}s) — skipping")
                                    # Phase 0: attribute the chunk-rate drop (gate 1b / F3).
                                    _log_whisper_diag(
                                        "hallucination_detected", gate="1b", reason_code="chunk_rate",
                                        session_id=session_id, request_id=diag_id,
                                        chunks=len(chunks_list),
                                        chunks_per_s=round(len(chunks_list) / buffer_duration, 2),
                                        text_len=len(raw_text),
                                    )
                                    # CONTRACT: every `do_transcribe()` return is a TRIPLE.
                                    # Returning a pair here ended in an unpacking exception at
                                    # the caller, so a hallucination loop produced an error
                                    # instead of `filtered_chunk_rate`.
                                    return "", chunks_list, transcribe_status

                                clean = preprocess_transcription(raw_text)
                                if clean:
                                    logger.info(f"[GROWING_BUFFER] Text ACCEPTED: '{clean[:100]}...'")
                                else:
                                    # Phase 0: attribute the drop (gate 1, full raw_text) to a reason code.
                                    _log_hallucination_detected(
                                        gate=1, text=raw_text, reason=detect_hallucination(raw_text),
                                        session_id=session_id, request_id=diag_id,
                                    )
                                    logger.info(f"[GROWING_BUFFER] Text FILTERED OUT")

                                # The status must be EXPLICIT. Empty text on its own does not
                                # prove the filter fired - it may be an empty model result.
                                if clean:
                                    transcribe_status = "accepted"
                                elif raw_text and raw_text.strip():
                                    transcribe_status = "filtered_preprocess"
                                else:
                                    transcribe_status = "empty_model_output"
                                return clean if clean else "", chunks_list, transcribe_status
                            except Exception as exc:
                                _log_whisper_diag(
                                    "pipeline_error",
                                    request_id=diag_id,
                                    session_id=session_id,
                                    elapsed_ms=round((time.perf_counter() - pipeline_start) * 1000, 1),
                                    error=type(exc).__name__,
                                    message=str(exc)[:200],
                                )
                                raise
                            finally:
                                active_after_total, active_after_session = _mark_whisper_pipeline_finish(session_id)
                                _log_whisper_diag(
                                    "pipeline_finish",
                                    request_id=diag_id,
                                    session_id=session_id,
                                    total_ms=round((time.perf_counter() - queued_at) * 1000, 1),
                                    in_flight_total_after=active_after_total,
                                    in_flight_session_after=active_after_session,
                                    executor_queue_size=_executor_queue_size(),
                                )

                        loop = asyncio.get_event_loop()
                        transcription, chunks_list, transcribe_status = await loop.run_in_executor(
                            executor, do_transcribe
                        )
                        normal_finished_perf = time.perf_counter()
                        retry_event = None
                        if transcribe_status == "accepted" and session.rep_retry.mode != "off":
                            original = {"text": transcription, "chunks": chunks_list}
                            committed_end = max((int(round(end * SAMPLE_RATE))
                                for _, _, end in session.timestamp_deduplicator.confirmed_words), default=0)
                            selected, retry_event = await session.rep_retry.consider(
                                original, snapshot=decode_snapshot, pcm_sha256=input_pcm_sha256,
                                decode_id=decode_id, observer=session.rep_shadow,
                                committed_end_sample=committed_end, executor=executor,
                                decode=lambda audio: _run_pipeline(pipe, audio,
                                    _build_generate_kwargs(TRANSCRIBE_CONFIG["language"], "transcribe"),
                                    use_chunking=False, capture_quality=True),
                                emit=_log_rep_retry_event,
                                session_current=lambda: sessions.get(session_id) is session)
                            transcription, chunks_list = selected["text"], selected["chunks"]
                        decode_finished_perf = time.perf_counter()
                        # Three DISJOINT timings, each named for what it actually measures:
                        # `inference_ms` = `_run_pipeline` alone (None when it was never
                        # reached), `worker_total_ms` = the whole worker plus the return to the
                        # event loop, `decode_total_ms` = request-to-result including the
                        # executor queue.
                        inference_ms = decode_timing.get("inference_ms")
                        worker_total_ms = (normal_finished_perf - decode_timing.get(
                            "_worker_start_perf", decode_submitted_perf)) * 1000.0

                        # The same measurement at the moment the chunks are handed to
                        # alignment. A matching FINGERPRINT (not just the count) proves OUR
                        # code did not change the timestamps between `_run_pipeline` and
                        # alignment - two different sequences can land in the same buckets.
                        chunks_at_alignment = summarize_chunk_timestamps(
                            chunks_list,
                            sample_rate=SAMPLE_RATE,
                            snapshot_samples=decode_snapshot.sample_count,
                        )
                        _log_whisper_diag(
                            "chunk_timestamp_audit",
                            session_id=session_id,
                            decode_id=decode_id,
                            transcribe_status=transcribe_status,
                            rep_retry_applied=bool(retry_event and retry_event.get("policy_applied")),
                            pipeline_output=decode_timing.get("pipeline_output_chunk_audit"),
                            at_alignment=chunks_at_alignment,
                            **diff_summaries(
                                decode_timing.get("pipeline_output_chunk_audit"), chunks_at_alignment
                            ),
                        )

                        # Second measurement point - the RAW token timestamps from before
                        # `_decode_asr`. A separate event, joined to the chunk audit through
                        # `decode_id`; the verdict is computed here because only here are both
                        # sides of the boundary available at once. Emission does NOT depend on
                        # the verdict - the whole section is fail-open, because diagnostics
                        # have no right to interrupt a decode.
                        _log_token_timestamp_probe(
                            session_id=session_id,
                            decode_id=decode_id,
                            transcribe_status=transcribe_status,
                            probe_result=decode_timing.get("token_timestamp_probe"),
                            chunk_summary=decode_timing.get("pipeline_output_chunk_audit"),
                        )

                        # Provenance for THIS request's hypothesis. SHADOW - it touches neither
                        # the text nor any emission decision; the output is a record and
                        # counters.
                        alignment = align_text_to_spans(
                            transcription or "",
                            chunks_list,
                            decode_snapshot.start_sample,
                            SAMPLE_RATE,
                            input_end_sample=decode_snapshot.end_sample,
                            # `filtered_window` comes ONLY from the explicit status, never from empty text.
                            window_filtered=(transcribe_status in ("filtered_preprocess", "filtered_chunk_rate")),
                        )
                        response_provenance = {
                            "decode_id": decode_id,
                            "rep_retry": retry_event,
                            "input_pcm_sha256": input_pcm_sha256,
                            "input_start_sample": decode_snapshot.start_sample,
                            "input_end_sample": decode_snapshot.end_sample,
                            "decode_requested_at_ms": round(decode_requested_at_ms, 1),
                            "decode_started_at_ms": round(decode_timing.get("decode_started_at_ms") or 0.0, 1) or None,
                            "decode_finished_at_ms": round(time.time() * 1000.0, 1),
                            "executor_wait_ms": round(decode_timing.get("executor_wait_ms") or 0.0, 1),
                            "inference_ms": round(inference_ms, 1) if inference_ms is not None else None,
                            "worker_total_ms": round(worker_total_ms, 1),
                            "decode_total_ms": round((decode_finished_perf - decode_started_perf) * 1000.0, 1),
                            "transcribe_status": transcribe_status,
                            # The provenance status is EXPLICIT even when the decode produced
                            # no delta. A missing field would be indistinguishable from an old
                            # client without provenance - two different things.
                            "provenance_status": "no_confirmed_delta",
                            # `None` for statuses with nothing to explain: evidence exists,
                            # there was no delta, or policy rejected it.
                            "provenance_reason": None,
                            "confirmed_word_spans": [],
                            "partial_provenance_status": "no_text",
                            "partial_word_spans": [],
                            "partial_alignment_status": None,
                            "stable_provenance_status": "no_text",
                            "stable_word_spans": [],
                            "stable_alignment_status": None,
                            "alignment_status": alignment.status,
                            "unaligned_word_count": alignment.unaligned_word_count,
                            "text_token_count": alignment.text_token_count,
                            "span_token_count": alignment.span_token_count,
                            "alignment_reason": alignment.reason,
                            "non_word_level_chunk": bool(
                                alignment.reason and alignment.reason.startswith("non_word_level_chunk")
                            ),
                            "aligned_span": list(alignment.span) if alignment.span else None,
                        }
                        # Session history and the `decode_provenance` event are written ONLY
                        # after the delta is processed (the `finally` below). Written here they
                        # would not see `provenance_status` or `confirmed_word_spans`, so the
                        # first run could not compute from the logs the very thing this change
                        # declares as its result.
                        sentence_completed = False

                        if transcription:
                            # Process through LocalAgreement stabilizer
                            # F5 FIX (16.02.2026): Track sentence completion for post-sentence trim
                            segments_before = len(session.stabilizer._completed_segments)
                            stable, partial, is_new = session.stabilizer.process(transcription)
                            sentence_completed = len(session.stabilizer._completed_segments) > segments_before
                            partial_text = partial
                            has_new_transcription = is_new
                            # Phase 2 part 1: capture the cumulative stable prefix regardless of whether a
                            # NEW delta was confirmed this step. On stalls (is_new=False) confirmed_text
                            # below is "" but stable_text stays the LA-confirmed cumulative prefix.
                            stable_text = stable or ""

                            partial_lineage = _strict_hypothesis_provenance(
                                partial_text,
                                chunks_list,
                                decode_snapshot.start_sample,
                                decode_snapshot.end_sample,
                            )
                            stable_lineage = _strict_hypothesis_provenance(
                                stable_text,
                                chunks_list,
                                decode_snapshot.start_sample,
                                decode_snapshot.end_sample,
                            )
                            (
                                response_provenance["partial_provenance_status"],
                                response_provenance["partial_word_spans"],
                                response_provenance["partial_alignment_status"],
                            ) = partial_lineage
                            (
                                response_provenance["stable_provenance_status"],
                                response_provenance["stable_word_spans"],
                                response_provenance["stable_alignment_status"],
                            ) = stable_lineage

                            # Use TimestampDeduplicator for delta calculation
                            # FIX (19.01.2026): Timestamp-based deduplication handles text shifts
                            # Key insight: Words have same timestamp regardless of array position
                            if is_new and stable and chunks_list:
                                # Calculate delta using timestamp-based deduplication
                                # The PRODUCTION path computes the delta spans and the provenance
                                # status. The emitted text is identical to that from `process()`.
                                delta, confirmed_word_spans, provenance_status, provenance_reason = (
                                    session.timestamp_deduplicator.process_with_spans(
                                        chunks_list,
                                        buffer_start_sample=decode_snapshot.start_sample,
                                        input_end_sample=decode_snapshot.end_sample,
                                        sample_rate=SAMPLE_RATE,
                                    )
                                )
                                response_provenance["provenance_status"] = provenance_status
                                response_provenance["provenance_reason"] = provenance_reason
                                response_provenance["confirmed_word_spans"] = confirmed_word_spans

                                if delta:
                                    rep_timestamp_dedup_text = delta
                                    try:
                                        rep_candidate_events = session.rep_shadow.classify_and_record(
                                            delta,
                                            confirmed_word_spans,
                                            decode_id=decode_id,
                                            fuzzy_tainted_ranges=(
                                                session.timestamp_deduplicator
                                                .last_fuzzy_replacement_ranges
                                            ),
                                        )
                                        session.rep_shadow.fuzzy_replacement_count = (
                                            session.timestamp_deduplicator._fuzzy_replacements
                                        )
                                    except Exception as rep_exc:
                                        logger.warning(
                                            "[REP_OBSERVER] classifier skipped decode_id=%s: %s",
                                            decode_id,
                                            type(rep_exc).__name__,
                                        )
                                    # F5 FIX (16.02.2026): Check delta for hallucination patterns
                                    # F6 (16.02.2026): Also catches embedded comma-burst hallucination
                                    _delta_reason = detect_hallucination(delta)
                                    if _delta_reason is not None:
                                        session.hallucination_burst_count += 1
                                        logger.warning(
                                            f"[F6_DELTA_HALLUCINATION] Delta filtered: '{delta[:80]}...' "
                                            f"(burst={session.hallucination_burst_count})"
                                        )
                                        # Phase 0: attribute the delta drop (gate 2) to a reason code.
                                        _log_hallucination_detected(
                                            gate=2, text=delta, reason=_delta_reason,
                                            session_id=session_id, burst=session.hallucination_burst_count,
                                        )
                                        confirmed_text = ""
                                        # Delta rejected: its spans do NOT describe emitted
                                        # content. `reason` returns to `None` - evidence either
                                        # existed or was absent for its own reason, but the
                                        # spans disappear here because of POLICY, not missing
                                        # provenance. Keeping the old reason would mix the two
                                        # in the downstream buckets.
                                        response_provenance["provenance_status"] = "delta_filtered"
                                        response_provenance["provenance_reason"] = None
                                        response_provenance["confirmed_word_spans"] = []

                                        # F6b: Force-trim after 3+ consecutive hallucinations
                                        # Breaks the hallucination spiral before OOM crash
                                        # R1.4 B4: Use _perform_buffer_trim instead of bare reset
                                        if session.hallucination_burst_count >= 3:
                                            buf_duration = len(session.audio_buffer.audio_buffer) / SAMPLE_RATE
                                            logger.warning(
                                                f"[F6b_BURST_TRIM] {session.hallucination_burst_count} consecutive "
                                                f"hallucinations — force trimming buffer ({buf_duration:.1f}s)"
                                            )
                                            trim_time = buf_duration * 0.5
                                            _perform_buffer_trim(session, trim_time, chunks_list, reason="hallucination_burst")
                                            session.last_processed_samples = len(session.audio_buffer.audio_buffer)
                                            session.hallucination_burst_count = 0
                                    else:
                                        session.hallucination_burst_count = 0  # Reset on clean delta
                                        confirmed_text = delta  # Send only delta to gateway

                                        # Update full confirmed text for trimming context
                                        session.confirmed_text += " " + delta
                                        session.transcriptions.append(delta)

                                        logger.info(f"[LOCAL_AGREEMENT] hasNew={is_new}, delta={len(delta)} chars, full_confirmed={len(stable)} chars")
                                else:
                                    # Not enough new words yet
                                    confirmed_text = ""
                                    logger.debug(f"[LOCAL_AGREEMENT] hasNew={is_new}, but deduplicator waiting for more words")

                            else:
                                # No new confirmation - send empty confirmed_text
                                confirmed_text = ""
                                logger.debug(f"[LOCAL_AGREEMENT] hasNew=False, partial={len(partial) if partial else 0} chars")

                            # F5 FIX (16.02.2026): Trim buffer after sentence confirmation
                            # Root cause of repeat loop: LA resets after sentence → same audio
                            # re-transcribed → same text re-confirmed → sent to gateway again
                            # Fix: trim the audio that produced the confirmed sentence
                            # CIO audit: approved as primary fix (addresses root cause)
                            # Pre-roll guard: keep min 1s audio after trim for acoustic context
                            if session.pending_force_trim_time is None and sentence_completed and chunks_list:
                                buf_duration = len(session.audio_buffer.audio_buffer) / SAMPLE_RATE
                                if buf_duration > 4.0:  # Don't trim tiny buffers
                                    trim_time = _find_sentence_boundary_time(stable, chunks_list)
                                    if trim_time and (buf_duration - trim_time) >= 1.0:
                                        _perform_buffer_trim(session, trim_time, chunks_list, reason="sentence_confirmed")
                                    elif trim_time:
                                        logger.debug(f"[F5] Skipping post-sentence trim: only {buf_duration - trim_time:.1f}s would remain (min 1.0s)")

                            # FIX (23.01.2026): Check buffer trim OUTSIDE is_new block (CRITICAL!)
                            # This ensures trimming happens even when LA doesn't confirm
                            elif session.pending_force_trim_time is None and session.audio_buffer.needs_trim():
                                trim_time = _find_sentence_boundary_time(stable, chunks_list)
                                if trim_time:
                                    _perform_buffer_trim(session, trim_time, chunks_list, reason="sentence_boundary")
                                elif session.audio_buffer.is_at_hard_limit():
                                    # R1.4 B4: Use _perform_buffer_trim with word-boundary trim
                                    # instead of bare force_trim_at_half + full reset
                                    buf_dur = len(session.audio_buffer.audio_buffer) / SAMPLE_RATE
                                    emergency_trim_time = _find_word_boundary_trim_time(chunks_list, buf_dur)
                                    logger.warning(f"[EMERGENCY_TRIM] No sentence boundary, trimming at {emergency_trim_time:.2f}s (buf={buf_dur:.1f}s)")
                                    _perform_buffer_trim(session, emergency_trim_time, chunks_list, reason="emergency")

                        # R1.4 B5: Proactive soft trim — check even when no transcription
                        # or no new confirmation. Catches cases where Whisper returned empty
                        # or hallucinated text but buffer keeps growing.
                        if STREAMING_CONFIG["force_trim_submit_before_trim_enabled"]:
                            _perform_pending_force_trim_after_submit(session, chunks_list, confirmed_text)

                        if session.pending_force_trim_time is None and session.audio_buffer.needs_trim() and not sentence_completed:
                            buf_dur = len(session.audio_buffer.audio_buffer) / SAMPLE_RATE
                            if session.audio_buffer.is_at_hard_limit():
                                emergency_time = _find_word_boundary_trim_time(chunks_list, buf_dur)
                                logger.warning(f"[B5_PROACTIVE_TRIM] Hard limit reached ({buf_dur:.1f}s), trimming at {emergency_time:.2f}s")
                                _perform_buffer_trim(session, emergency_time, chunks_list, reason="proactive_hard_limit")

                    except Exception as e:
                        import traceback
                        logger.error(f"Transcription error: {e}\n{traceback.format_exc()}")

        finally:
            # 1) The session returns to the pool ALWAYS and FIRST. Whatever throws below -
            #    payload construction, logger, serialisation - must not block the session,
            #    because that would be exactly the bug this `finally` was added to remove.
            session.transcription_in_progress = False
            # 2) History AFTER the delta is processed: `provenance_status` and
            #    `confirmed_word_spans` are produced later than the decode evidence itself.
            #    A plain assignment, unguarded - dict() over a ready dict cannot fail.
            if response_provenance is not None:
                session.last_decode_provenance = dict(response_provenance)
            # 3) Diagnostics are FAIL-OPEN: an observability event has no right to break the
            #    request or block the session.
            try:
                if response_provenance is not None:
                    _emit_rep_decode_events(
                        session,
                        decode_timing,
                        chunks_list,
                        response_provenance,
                        stable_text,
                        rep_timestamp_dedup_text,
                        rep_candidate_events,
                    )
                    _log_whisper_diag(
                        "decode_provenance",
                        session_id=session_id,
                        **_build_decode_provenance_diag(response_provenance),
                    )
                if session.coalesced_audio_pending:
                    _log_whisper_diag(
                        "coalesced_pending_after_finish",
                        session_id=session_id,
                        pending_requests=session.coalesced_request_count,
                        current_buffer_samples=len(session.audio_buffer.audio_buffer),
                        last_processed_samples=session.last_processed_samples,
                        buffer_s=round(len(session.audio_buffer.audio_buffer) / SAMPLE_RATE, 3),
                        pending_force_trim=session.pending_force_trim_time is not None,
                        pre_submit_attempts=session.pre_submit_attempts,
                        pre_submit_completions=session.pre_submit_completions,
                    )
            except Exception as diag_exc:
                logger.warning("[WHISPER_DIAG] post-decode diagnostics failed: %s", diag_exc)

    # C.7 defense-in-depth: with the current ordering, a pending force-trim should always
    # be resolved by a submit in the same cycle or by the in-flight submit that just finished.
    # If that invariant is broken by a future gate/order change, clear the buffer instead of
    # letting a pending trim silently accumulate toward OOM.
    if (
        STREAMING_CONFIG["force_trim_submit_before_trim_enabled"]
        and session.pending_force_trim_time is not None
        and not did_submit_this_cycle
        and not session.transcription_in_progress
    ):
        trim_time = session.pending_force_trim_time
        reason = session.pending_force_trim_reason or "hard_limit_pending_fallback"
        _log_whisper_diag(
            "hard_limit_pending_fallback_trim",
            session_id=session_id,
            pending_reason=reason,
            requested_trim_s=round(trim_time, 3),
            buffer_s=round(len(session.audio_buffer.audio_buffer) / SAMPLE_RATE, 3),
            pre_submit_attempts=session.pre_submit_attempts,
            pre_submit_completions=session.pre_submit_completions,
        )
        session.pending_force_trim_time = None
        session.pending_force_trim_reason = None
        _perform_buffer_trim(session, trim_time, [], reason=reason)

    # Final cleanup
    if request.is_final:
        # Get final text
        confirmed_text = session.stabilizer.get_full_text()
        stable_text = confirmed_text  # Phase 2 part 1: on final flush the full text IS the stable prefix
        # Clean up session after a delay
        asyncio.create_task(_cleanup_session_delayed(session_id, delay=60))

    # Phase 2 part 1 instrumentation: per-session probe of the delta-vs-stable split. On stalls
    # (has_new=False) confirmed_delta is "" — does the cumulative stable prefix still hold words?
    # This splits the pauses into "stable existed but wasn't exported" vs "LA truly empty".
    _log_whisper_diag(
        "la_stable_probe",
        session_id=session_id,
        has_new=has_new_transcription,
        confirmed_delta_len=len(confirmed_text),
        stable_word_count=len(stable_text.split()),
        stable_char_count=len(stable_text),
        stable_preview=stable_text[:80],
    )

    # ONLY the work done for THIS request. An empty dict when there was no decode (buffer too
    # short, no new audio, empty snapshot, no model, pipeline exception) - inherited provenance
    # would describe different audio and be false evidence.
    provenance = response_provenance or {}
    return StreamChunkResponse(
        session_id=session_id,
        partial_text=partial_text,
        confirmed_text=confirmed_text,
        is_speech=is_speech,
        has_new_transcription=has_new_transcription,
        stable_text=stable_text,
        la_confirmed_word_count=len(stable_text.split()),
        la_confirmed_char_count=len(stable_text),
        decode_id=provenance.get("decode_id"),
        input_pcm_sha256=provenance.get("input_pcm_sha256"),
        input_start_sample=provenance.get("input_start_sample"),
        input_end_sample=provenance.get("input_end_sample"),
        decode_requested_at_ms=provenance.get("decode_requested_at_ms"),
        decode_started_at_ms=provenance.get("decode_started_at_ms"),
        decode_finished_at_ms=provenance.get("decode_finished_at_ms"),
        executor_wait_ms=provenance.get("executor_wait_ms"),
        inference_ms=provenance.get("inference_ms"),
        worker_total_ms=provenance.get("worker_total_ms"),
        decode_total_ms=provenance.get("decode_total_ms"),
        rep_retry=provenance.get("rep_retry"),
        transcribe_status=provenance.get("transcribe_status"),
        provenance_status=provenance.get("provenance_status"),
        provenance_reason=provenance.get("provenance_reason"),
        confirmed_word_spans=provenance.get("confirmed_word_spans"),
        partial_provenance_status=provenance.get("partial_provenance_status"),
        partial_word_spans=provenance.get("partial_word_spans"),
        partial_alignment_status=provenance.get("partial_alignment_status"),
        stable_provenance_status=provenance.get("stable_provenance_status"),
        stable_word_spans=provenance.get("stable_word_spans"),
        stable_alignment_status=provenance.get("stable_alignment_status"),
        text_token_count=provenance.get("text_token_count"),
        span_token_count=provenance.get("span_token_count"),
        alignment_status=provenance.get("alignment_status"),
        alignment_reason=provenance.get("alignment_reason"),
        unaligned_word_count=provenance.get("unaligned_word_count"),
        non_word_level_chunk=provenance.get("non_word_level_chunk"),
        aligned_span=provenance.get("aligned_span"),
    )


@app.delete("/session/{session_id}")
async def delete_session(session_id: str):
    """Delete a transcription session."""
    if session_id in sessions:
        _log_rep_event(sessions[session_id].rep_shadow.close_event())
        sessions[session_id].rep_retry.close()
        del sessions[session_id]
        logger.info(f"Deleted session: {session_id}")
        return {"status": "deleted", "session_id": session_id}
    raise HTTPException(status_code=404, detail="Session not found")


@app.get("/session/{session_id}/transcript")
async def get_transcript(session_id: str):
    """Get full transcript for a session."""
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found")

    session = sessions[session_id]
    return {
        "session_id": session_id,
        "full_text": session.stabilizer.get_full_text(),
        "segments": session.transcriptions,
        "total_audio_seconds": session.total_audio_seconds,
        "created_at": session.created_at,
        "last_activity": session.last_activity,
        "deduplicator_stats": session.timestamp_deduplicator.get_stats()
    }


# =============================================================================
# Background Tasks
# =============================================================================

async def _cleanup_session_delayed(session_id: str, delay: int = 60):
    """Clean up session after delay."""
    await asyncio.sleep(delay)
    if session_id in sessions:
        _log_rep_event(sessions[session_id].rep_shadow.close_event())
        sessions[session_id].rep_retry.close()
        del sessions[session_id]
        logger.info(f"Auto-cleaned session: {session_id}")


async def cleanup_stale_sessions():
    """Remove sessions inactive for more than configured timeout."""
    timeout = STREAMING_CONFIG["session_timeout_sec"]
    while True:
        await asyncio.sleep(60)  # Check every minute
        now = time.time()
        stale = [
            sid for sid, session in sessions.items()
            if now - session.last_activity > timeout
        ]
        for sid in stale:
            _log_rep_event(sessions[sid].rep_shadow.close_event())
            sessions[sid].rep_retry.close()
            del sessions[sid]
            logger.info(f"Cleaned stale session: {sid}")


# =============================================================================
# Main Entry Point
# =============================================================================

if __name__ == "__main__":
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run(
        "whisper_service:app",
        host="0.0.0.0",
        port=port,
        workers=1,  # Single worker for GPU
        log_level="info"
    )
