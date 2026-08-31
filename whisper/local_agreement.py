# -*- coding: utf-8 -*-
"""
LocalAgreement-n Policy for Streaming ASR (FIXED)
==================================================
Implementation based on IJCNLP 2023 paper.

Key insight: If n consecutive transcription passes agree on a text prefix,
that prefix can be confirmed as final output. This eliminates "flickering"
in streaming transcription results.

FIXES (23.01.2026):
- Lowered similarity_threshold from 0.85 to 0.75 for Swiss German
- Added aggressive text normalization for German (umlauts, ß)
- Added punctuation-agnostic comparison
- Improved logging for debugging
"""

from typing import Optional, List, Tuple
from dataclasses import dataclass, field
from collections import deque
import difflib
import re
import time
import unicodedata
import logging

logger = logging.getLogger(__name__)


@dataclass
class TranscriptionResult:
    """Result from a single transcription pass."""
    text: str
    is_partial: bool = True
    confidence: float = 0.0
    timestamp_start: float = 0.0
    timestamp_end: float = 0.0


@dataclass
class AgreementResult:
    """Result from LocalAgreement processing."""
    confirmed_text: str  # Text confirmed as final
    tentative_text: str  # Text still being refined
    full_text: str  # confirmed + tentative
    is_new_confirmation: bool  # True if new text was confirmed
    agreement_count: int  # How many consecutive agreements


class LocalAgreementBuffer:
    """
    Implements LocalAgreement-n policy for streaming transcription stability.

    The algorithm works by:
    1. Maintaining a history of the last n transcriptions
    2. Finding the longest common prefix among them
    3. Marking that prefix as "confirmed" (won't change)
    4. Only the suffix after the confirmed part can still change

    This provides stable partial results without sacrificing accuracy.

    FIXES (23.01.2026):
    - similarity_threshold lowered to 0.75 (was 0.85)
    - Added _normalize_german() for better comparison
    - Improved word matching for Swiss German variations
    """

    def __init__(
        self,
        n: int = 2,
        min_word_agreement: int = 1,
        similarity_threshold: float = 0.75  # FIX: Lowered from 0.85
    ):
        """
        Initialize LocalAgreement buffer.

        Args:
            n: Number of consecutive agreements required (default 2)
            min_word_agreement: Minimum words to require agreement on
            similarity_threshold: Threshold for fuzzy word matching (0-1)
                                 FIX: Lowered to 0.75 for Swiss German
        """
        self.n = n
        self.min_word_agreement = min_word_agreement
        self.similarity_threshold = similarity_threshold

        # History of recent transcriptions
        self.history: deque = deque(maxlen=n + 1)

        # Confirmed text that won't change
        self.confirmed_text = ""

        # Track confirmation state
        self._last_confirmed_length = 0

        # FIX: Stats for debugging
        self._total_processed = 0
        self._agreements_found = 0
        self._confirmations_made = 0

        # D3: Observability — track timing for confirmation latency
        self._first_seen_time: float = 0.0  # time when current unconfirmed text first appeared
        self._last_similarity_scores: List[float] = []  # scores from last word agreement check

    def process(self, transcription: str) -> AgreementResult:
        """
        Process a new transcription and update confirmed text.

        Args:
            transcription: New transcription text

        Returns:
            AgreementResult with confirmed and tentative parts
        """
        self._total_processed += 1
        process_start = time.monotonic()

        # NFC normalize + clean (Whisper may output NFD decomposed Unicode)
        transcription = unicodedata.normalize('NFC', transcription).strip()

        # D3: Track first-seen time for confirmation latency measurement
        if self._first_seen_time == 0.0:
            self._first_seen_time = process_start

        # Add to history
        self.history.append(transcription)

        # FIX: Debug logging
        logger.debug(f"[LA] Processing transcription #{self._total_processed} ({len(transcription)} characters)")
        logger.debug(f"[LA] History size: {len(self.history)}/{self.n}")

        # Need at least n transcriptions to check agreement
        if len(self.history) < self.n:
            return AgreementResult(
                confirmed_text=self.confirmed_text,
                tentative_text=transcription,
                full_text=self.confirmed_text + (" " if self.confirmed_text else "") + transcription,
                is_new_confirmation=False,
                agreement_count=len(self.history)
            )

        # Get the last n transcriptions
        recent = list(self.history)[-self.n:]

        # Find longest common prefix (word-based)
        common_prefix = self._find_word_common_prefix(recent)

        if common_prefix:
            self._agreements_found += 1

        # Update confirmed text if we have agreement on more than before
        is_new_confirmation = False
        if common_prefix and len(common_prefix) > len(self.confirmed_text):
            old_confirmed = self.confirmed_text
            self.confirmed_text = common_prefix
            is_new_confirmation = True
            self._last_confirmed_length = len(common_prefix)
            self._confirmations_made += 1

            # FIX: Log confirmation
            new_words = common_prefix[len(old_confirmed):].strip()
            logger.info(f"[LA] NEW CONFIRMATION: {len(new_words)} new characters (total confirmed: {len(common_prefix)} chars)")

            # D3: Structured observability event
            confirmation_latency_ms = (process_start - self._first_seen_time) * 1000 if self._first_seen_time > 0 else 0
            logger.info(
                "[LA_METRICS] %s",
                {
                    "event": "confirmation",
                    "n": self.n,
                    "similarity_threshold": self.similarity_threshold,
                    "confirmed_new_words": len(new_words.split()),
                    "confirmed_total_words": len(common_prefix.split()),
                    "confirmation_latency_ms": round(confirmation_latency_ms, 1),
                    "passes_since_first_seen": self._total_processed,
                    "similarity_scores": self._last_similarity_scores[:10],
                }
            )
            # Reset timer for next unconfirmed segment
            self._first_seen_time = process_start

        # Calculate tentative text (part after confirmed)
        tentative = transcription
        if self.confirmed_text and transcription.startswith(self.confirmed_text):
            tentative = transcription[len(self.confirmed_text):].strip()
        elif self.confirmed_text:
            # Transcription diverged - find overlap
            tentative = self._find_divergent_suffix(transcription)

        # Build full text
        if tentative:
            full_text = self.confirmed_text + (" " if self.confirmed_text else "") + tentative
        else:
            full_text = self.confirmed_text

        return AgreementResult(
            confirmed_text=self.confirmed_text,
            tentative_text=tentative,
            full_text=full_text.strip(),
            is_new_confirmation=is_new_confirmation,
            agreement_count=self.n if common_prefix else 0
        )

    def _normalize_german(self, word: str) -> str:
        """
        Aggressive normalization for German text comparison.

        FIX (23.01.2026): New method for better Swiss German handling.

        Handles:
        - Case insensitivity
        - Punctuation removal
        - Umlaut normalization (ä→ae, etc.)
        - ß→ss conversion
        - Common Swiss German variations
        """
        w = unicodedata.normalize('NFC', word).lower()

        # Remove all punctuation (ASCII + German/Swiss quotation marks)
        # Using Unicode escapes for compatibility: – \u2013, — \u2014, „ \u201e, " \u201c, ‚ \u201a, ' \u2018, » \u00bb, « \u00ab
        w = re.sub(r'[.,!?;:\'"()\-\u2013\u2014\u201e\u201c\u201a\u2018\u00bb\u00ab]', '', w)

        # Normalize German characters
        replacements = {
            'ä': 'ae', 'ö': 'oe', 'ü': 'ue',
            'ß': 'ss',
            'é': 'e', 'è': 'e', 'ê': 'e',
            'à': 'a', 'â': 'a',
            # Swiss German specific
            'ch': 'ch',  # Keep as-is (important in Swiss German)
        }

        for old, new in replacements.items():
            w = w.replace(old, new)

        return w.strip()

    def _find_word_common_prefix(self, transcriptions: List[str]) -> str:
        """
        Find the longest common prefix at word boundaries.

        Uses fuzzy matching to handle minor transcription variations.

        FIX: Uses _normalize_german() for comparison.
        """
        if not transcriptions:
            return ""

        # D3: Reset similarity scores for this prefix search
        self._last_similarity_scores = []

        # Split all transcriptions into words
        word_lists = [t.split() for t in transcriptions]

        # Find minimum length
        min_len = min(len(words) for words in word_lists)
        if min_len == 0:
            return ""

        # Find longest matching prefix
        common_words = []
        for i in range(min_len):
            # Get word at position i from all transcriptions
            words_at_i = [words[i] for words in word_lists]

            # Check if all words match (with fuzzy matching)
            if self._words_agree(words_at_i):
                # Use the most common variant
                common_words.append(self._get_consensus_word(words_at_i))
            else:
                # FIX: Log disagreement for debugging
                normalized = [self._normalize_german(w) for w in words_at_i]
                logger.debug(f"[LA] Word disagreement at position {i}: {words_at_i} (normalized: {normalized})")
                break

        # Must have at least min_word_agreement words
        if len(common_words) < self.min_word_agreement:
            return self.confirmed_text  # Keep previous confirmed

        return " ".join(common_words)

    def _words_agree(self, words: List[str]) -> bool:
        """
        Check if all words in the list agree (fuzzy match).

        FIX: Uses _normalize_german() and lowered threshold.
        """
        if not words:
            return False

        # FIX: Use German normalization
        normalized = [self._normalize_german(w) for w in words]

        # Check pairwise similarity
        reference = normalized[0]
        for word in normalized[1:]:
            if reference == word:
                self._last_similarity_scores.append(1.0)
                continue

            # Fuzzy match for slight variations
            ratio = difflib.SequenceMatcher(None, reference, word).ratio()
            self._last_similarity_scores.append(round(ratio, 3))
            if ratio < self.similarity_threshold:
                return False

        return True

    def _get_consensus_word(self, words: List[str]) -> str:
        """Get the most common word variant."""
        # Simple majority vote
        word_counts = {}
        for word in words:
            word_counts[word] = word_counts.get(word, 0) + 1
        return max(word_counts, key=word_counts.get)

    def _find_divergent_suffix(self, transcription: str) -> str:
        """
        Find the suffix of transcription that diverges from confirmed text.
        Used when transcription doesn't start with confirmed text.
        """
        # Try to find where the divergence starts
        confirmed_words = self.confirmed_text.split()
        trans_words = transcription.split()

        # FIX: Use normalized comparison
        match_len = 0
        for i, (c, t) in enumerate(zip(confirmed_words, trans_words)):
            if self._normalize_german(c) == self._normalize_german(t):
                match_len = i + 1
            else:
                break

        # Return everything after the matching part
        if match_len < len(trans_words):
            return " ".join(trans_words[match_len:])
        return ""

    def warm_start(self, overlap_text: str, trusted: bool = True) -> None:
        """
        R2 (17.02.2026): Pre-fill history with overlap text after buffer trim.
        Phase 2 part 2 (29.06.2026): anchor_only mode via trusted=False.

        Instead of resetting to empty (which lets the next re-transcriptions of the
        carried-over tail re-confirm already-emitted content), we seed the history with
        `overlap_text` n times. This forces the next transcription to AGREE with the seed
        before anything is confirmed (anti-premature-confirm).

        trusted=True  (timestamp/audio-overlap backed): the retained audio WILL re-produce
            this text, so we also set it as confirmed_text — the gateway can export it
            immediately as a stable prefix. (Legacy behaviour, default.)
        trusted=False (text anchor only, no audio overlap): seed the history for stability
            but DO NOT set confirmed_text. The next transcription is of fresh audio that may
            diverge; setting confirmed_text=anchor would risk re-emitting it and corrupting
            the common_prefix[len(confirmed):] slicing on divergence.

        Args:
            overlap_text: Seed text (timestamp overlap region, or confirmed_text tail).
            trusted: Whether the seed is backed by retained audio (see above).
        """
        self.history.clear()
        # NFC-normalize so the seed matches process() inputs (Whisper may emit NFD).
        overlap_text = unicodedata.normalize('NFC', overlap_text or "").strip()

        if not overlap_text:
            # No seed text — fall back to regular reset
            self.confirmed_text = ""
            self._last_confirmed_length = 0
            logger.info("[LA] warm_start: no seed text, doing regular reset")
            return

        # Pre-fill history n times so the next real transcription
        # must agree with this seed to confirm anything
        for _ in range(self.n):
            self.history.append(overlap_text)

        if trusted:
            # Audio-overlap-backed: treat the seed as already-confirmed/known text.
            self.confirmed_text = overlap_text
            self._last_confirmed_length = len(overlap_text)
        else:
            # anchor_only: history seeded for stability, but confirmed stays empty so a
            # diverging next transcription cannot re-emit the anchor or corrupt slicing.
            self.confirmed_text = ""
            self._last_confirmed_length = 0

        logger.info(
            f"[LA] warm_start(trusted={trusted}): seeded history {self.n}x with "
            f"{len(overlap_text.split())} words: '{overlap_text[:60]}...'"
        )

    def reset(self) -> None:
        """Reset the buffer state."""
        self.history.clear()
        self.confirmed_text = ""
        self._last_confirmed_length = 0
        self._first_seen_time = 0.0
        self._last_similarity_scores = []
        logger.info("[LA] Buffer reset")

    def finalize(self, final_transcription: str) -> str:
        """
        Finalize transcription session.

        Merges confirmed text with final transcription result.
        """
        if not self.confirmed_text:
            return final_transcription.strip()

        # If final starts with confirmed, use final
        if final_transcription.startswith(self.confirmed_text):
            return final_transcription.strip()

        # Otherwise merge intelligently
        final_words = final_transcription.split()
        confirmed_words = self.confirmed_text.split()

        # Find overlap at the end of confirmed / start of final
        for i in range(len(confirmed_words), 0, -1):
            if final_words[:len(confirmed_words) - i + 1] == confirmed_words[i - 1:]:
                # Found overlap
                merged = confirmed_words[:i - 1] + final_words
                return " ".join(merged)

        # No good overlap found, concatenate
        return f"{self.confirmed_text} {final_transcription}".strip()

    def get_stats(self) -> dict:
        """Get buffer statistics."""
        return {
            "history_size": len(self.history),
            "n": self.n,
            "confirmed_text": self.confirmed_text,
            "confirmed_word_count": len(self.confirmed_text.split()) if self.confirmed_text else 0,
            # FIX: Added detailed stats
            "total_processed": self._total_processed,
            "agreements_found": self._agreements_found,
            "confirmations_made": self._confirmations_made,
            "similarity_threshold": self.similarity_threshold,
        }


class StreamingTranscriptionStabilizer:
    """
    Higher-level wrapper combining LocalAgreement with segment tracking.

    Manages multiple sentences/segments and provides stable streaming output.
    """

    def __init__(
        self,
        n: int = 2,
        similarity_threshold: float = 0.75,
        sentence_delimiters: str = ".!?",
        min_sentence_words: int = 3
    ):
        """
        Initialize stabilizer.

        Args:
            n: LocalAgreement-n parameter
            similarity_threshold: Threshold for fuzzy word matching (0-1)
            sentence_delimiters: Characters that end a sentence
            min_sentence_words: Minimum words before considering sentence complete
        """
        self.sentence_delimiters = sentence_delimiters
        self.min_sentence_words = min_sentence_words
        self._similarity_threshold = similarity_threshold

        # Current segment buffer
        self._current_buffer = LocalAgreementBuffer(n=n, similarity_threshold=similarity_threshold)

        # Completed segments
        self._completed_segments: List[str] = []

    def process(self, transcription: str) -> Tuple[str, str, bool]:
        """
        Process transcription and return stable output.

        Args:
            transcription: New transcription text

        Returns:
            Tuple of (stable_text, partial_text, has_new_stable)
        """
        transcription = unicodedata.normalize('NFC', transcription)
        result = self._current_buffer.process(transcription)

        # Check if confirmed text ends with sentence delimiter
        new_complete_sentence = False
        if result.confirmed_text and result.confirmed_text[-1] in self.sentence_delimiters:
            word_count = len(result.confirmed_text.split())
            if word_count >= self.min_sentence_words:
                # Complete sentence confirmed
                self._completed_segments.append(result.confirmed_text)
                self._current_buffer.reset()
                new_complete_sentence = True

        # Build output
        completed = " ".join(self._completed_segments)
        current = result.full_text if not new_complete_sentence else result.tentative_text

        stable = completed
        if result.confirmed_text and not new_complete_sentence:
            stable = f"{completed} {result.confirmed_text}".strip()

        partial = result.tentative_text

        return stable, partial, result.is_new_confirmation or new_complete_sentence

    def warm_start(self, overlap_text: str, trusted: bool = True) -> None:
        """
        R2 (17.02.2026): Warm-start after buffer trim.
        Phase 2 part 2 (29.06.2026): forwards `trusted` (anchor_only when False).
        Pre-fills the internal LocalAgreementBuffer with overlap/anchor text.
        Clears completed segments (they've already been sent).
        """
        self._current_buffer.warm_start(overlap_text, trusted=trusted)
        self._completed_segments.clear()

    def reset(self) -> None:
        """Reset all state."""
        self._current_buffer.reset()
        self._completed_segments.clear()

    def get_full_text(self) -> str:
        """Get all text (completed + current)."""
        completed = " ".join(self._completed_segments)
        current_stats = self._current_buffer.get_stats()
        current = current_stats.get("confirmed_text", "")
        return f"{completed} {current}".strip()

    def get_stats(self) -> dict:
        """Get stabilizer statistics."""
        return {
            "completed_segments": len(self._completed_segments),
            "current_buffer": self._current_buffer.get_stats(),
        }
