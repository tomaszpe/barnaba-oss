"""
Whisper Hallucination Filter
============================
Detects and filters common Whisper hallucination patterns.

Whisper tends to hallucinate during:
- Silence periods
- Music/organ sections
- Ambient noise
- Reverberant acoustics (churches)

Common hallucinations include:
- "Subtitles by Amara.org"
- "Thanks for watching"
- Repeated phrases in loops
- Music notation symbols
"""

import os
import re
import unicodedata
import numpy as np
from typing import Optional, List, Tuple
from dataclasses import dataclass
from collections import Counter
import logging

from config import HALLUCINATION_PATTERNS, VOLUME_GATE

logger = logging.getLogger(__name__)


# =============================================================================
# REASON CODES (from the "hallucination_filter false-positives" investigation)
# =============================================================================
# detect_hallucination() returns WHICH detector fired, so Phase 0 instrumentation can
# answer: false-positive rate, gate redundancy, and (Phase 1) where to strip vs drop.
# Behaviour is UNCHANGED in Phase 0: is_hallucination() == (detect_hallucination() is not None).

@dataclass
class HallucinationReason:
    code: str                          # see _classify_pattern + detectors below
    matched_span: str = ""             # the offending substring (capped by caller for logs)
    loop_start: Optional[int] = None   # char offset where the repetition/loop begins (rep-family)
    detail: str = ""                   # extra context (pattern source, repeat count, ...)


# rep-family = separable in Phase 1 (strip tail loop, keep clean prefix)
REP_FAMILY = frozenset({
    "regex_repetition", "excessive_trigram", "excessive_bigram", "single_word_repeat",
})


def _classify_pattern(src: str) -> str:
    """Map a HALLUCINATION_PATTERNS regex source to a reason code (config.py unchanged)."""
    if "\\1" in src:
        return "regex_repetition"
    low = src.lower()
    # keys chosen to survive char-class brackets in the source, e.g. "[Aa]mara" -> "mara"
    if any(k in low for k in ("ubtitle", "mara", "watching", "lease", "ubscribe")):
        return "regex_subtitles"
    if "♪" in src or "♫" in src or "usic" in low:
        return "regex_music"
    if src == r"\[.*\]":
        return "regex_bracketed_annotation"
    if src in (r"^\s*\.\s*$", r"^[\s\.\,\!\?]+$"):
        return "regex_punctuation_only"
    # F2 comma-list pattern: a repeated ",<segment>" group. Keyed to "(?:," (the non-capturing
    # comma group) rather than the brittle "{4,}" alone, so a future {4,} regex isn't misclassified.
    # test_all_config_patterns_classified_no_other locks this against drift.
    if "(?:," in src or ",\\s" in src:
        return "regex_comma_list"
    return "regex_other"


# =============================================================================
# F2 PROSE GUARD - flag HALLUCINATION_F2_PROSE_GUARD_ENABLED
# =============================================================================
# Measurement over 9 reference sessions: regex_comma_list (F2) = 98% of live gate-1 drops
# (60/61), and ~100% of those were REAL speech (enumerations and sermon rhetoric);
# rep-family = 0.
# The assumption in config.py ("real sermon text ALWAYS has verbs/sentence structure") is
# refuted: a single sentence with >=4 commas and a closing full stop matches F2.
# Discriminator, prose vs noun-salad loop (measured on 32 sha-verified fixtures,
# whisper/fixtures_f2_prose.json): prose = longer clauses (mean words/item 2.40-5.20,
# max_dup=1); a salad like "Grossrat, Grossraetin, ..." = 1.00-2.00; a phrase loop is
# max_dup>=4.
# The 2.5 threshold rescues 31/32 real false positives and keeps every loop. Default OFF (A/B on the reference set).
F2_PROSE_GUARD_MIN_MEAN_WORDS = 2.5
F2_PROSE_GUARD_MAX_DUP = 2


def _f2_prose_guard_enabled() -> bool:
    # Env read per call: rollback without a redeploy, plus easy tests (monkeypatch.setenv).
    return os.environ.get("HALLUCINATION_F2_PROSE_GUARD_ENABLED", "false").lower() == "true"


def _comma_list_is_prose(matched: str) -> bool:
    """True when a comma list looks like natural prose rather than a Whisper loop."""
    items = [i.strip() for i in matched.split(",") if i.strip()]
    if len(items) < 2:
        return False
    normalized = [" ".join(i.lower().split()) for i in items]
    if max(Counter(normalized).values()) > F2_PROSE_GUARD_MAX_DUP:
        return False  # the same clause over and over is a loop, whatever its length
    mean_words = sum(len(i.split()) for i in items) / len(items)
    return mean_words >= F2_PROSE_GUARD_MIN_MEAN_WORDS


# Compile patterns once at module load for performance
_COMPILED_PATTERNS: List[re.Pattern] = []
_CLASSIFIED_PATTERNS: List[Tuple[re.Pattern, str]] = []


def _get_compiled_patterns() -> List[re.Pattern]:
    """Get or create compiled regex patterns (lazy initialization)."""
    global _COMPILED_PATTERNS
    if not _COMPILED_PATTERNS:
        _COMPILED_PATTERNS = [
            re.compile(pattern) for pattern in HALLUCINATION_PATTERNS
        ]
    return _COMPILED_PATTERNS


def _get_classified_patterns() -> List[Tuple[re.Pattern, str]]:
    """Compiled patterns paired with their reason code (same order as HALLUCINATION_PATTERNS)."""
    global _CLASSIFIED_PATTERNS
    if not _CLASSIFIED_PATTERNS:
        _CLASSIFIED_PATTERNS = [
            (re.compile(p), _classify_pattern(p)) for p in HALLUCINATION_PATTERNS
        ]
    return _CLASSIFIED_PATTERNS


def detect_hallucination(text: str) -> Optional[HallucinationReason]:
    """
    Check if text contains hallucination patterns and report WHICH detector fired.

    Phase 0 (27.06.2026): replaces the bool-only is_hallucination internals so we can
    attribute each filter event to a reason code (and, in Phase 1, decide strip vs drop).
    Detection ORDER and CONDITIONS are identical to the previous is_hallucination, so
    behaviour is unchanged: is_hallucination(text) == (detect_hallucination(text) is not None).

    Returns:
        HallucinationReason if hallucination detected, else None.
    """
    if not text:
        return None

    text = text.strip()
    if len(text) < 3:
        return None

    # FIX (16.02.2026): Normalize to NFC before regex matching
    # Whisper outputs decomposed Unicode (NFD): ä = a + U+0308
    # F2 regex character class doesn't include combining marks (U+0300-U+036F)
    # NFC normalizes to precomposed: ä = U+00E4 (in range U+00C0-U+024F)
    text = unicodedata.normalize('NFC', text)

    # 1. Compiled regex patterns (per-pattern reason code)
    for pattern, code in _get_classified_patterns():
        m = pattern.search(text)
        if m:
            if code == "regex_comma_list" and _f2_prose_guard_enabled() and _comma_list_is_prose(m.group(0)):
                logger.info(f"[F2_PROSE_GUARD] comma-list kept as prose (diverse items, {len(text)} characters)")
                continue
            logger.debug(f"Hallucination pattern matched ({code}): {pattern.pattern}")
            return HallucinationReason(
                code=code,
                matched_span=m.group(0)[:200],
                loop_start=(m.start() if code == "regex_repetition" else None),
                detail=pattern.pattern,
            )

    # 2. Excessive word repetition (word-level loop_start preferred for Phase 1 strip)
    rep = _detect_excessive_repetition(text)
    if rep is not None:
        return rep

    # 3. F6 (16.02.2026): embedded comma-list hallucination
    if _has_comma_burst_hallucination(text):
        return HallucinationReason(code="comma_burst", matched_span=text[:200])

    # C2 (17.02.2026): Guillemet-number explosion
    # Whisper hallucinates sequences like «20» «30» «60» «70» «50» ...
    # 10+ consecutive guillemet-wrapped tokens = hallucination
    guillemet_tokens = re.findall(r'[«»\u00ab\u00bb\u201e\u201c\u201a\u2018][^«»\u00ab\u00bb\u201e\u201c\u201a\u2018]*?[«»\u00ab\u00bb\u201e\u201c\u201a\u2018]', text)
    if len(guillemet_tokens) > 10:
        logger.info(
            f"[C2_GUILLEMET] Detected {len(guillemet_tokens)} guillemet tokens: "
            f"'{text[:80]}...'"
        )
        return HallucinationReason(code="guillemet", matched_span=" ".join(guillemet_tokens[:10])[:200])

    return None


def is_hallucination(text: str) -> bool:
    """Backward-compat bool wrapper. Identical result to the pre-Phase-0 implementation."""
    return detect_hallucination(text) is not None


def _detect_excessive_repetition(
    text: str, min_words: int = 10, max_repeats: int = 2
) -> Optional[HallucinationReason]:
    """
    Detect excessive word/phrase repetition and report the reason + loop_start.

    Same detection conditions as the pre-Phase-0 _has_excessive_repetition (so the bool
    wrapper below stays behaviour-identical); additionally returns a HallucinationReason
    whose loop_start marks where the repeated run begins (word-level, for Phase 1 strip).
    """
    words = text.split()
    if len(words) < min_words:
        return None

    # Check for repeated 3-word phrases
    for i in range(len(words) - 5):
        phrase = " ".join(words[i:i+3])
        count = text.count(phrase)
        if count > max_repeats:
            ls = text.find(phrase)
            return HallucinationReason(
                code="excessive_trigram", matched_span=phrase,
                loop_start=(ls if ls >= 0 else None), detail=f"x{count}",
            )

    # C3 (17.02.2026): Check for repeated 2-word phrases (4+ times)
    # Catches template hallucinations like "Er ist" "Es ist" "Sie ist" repeating
    if len(words) >= 8:
        bigrams = [" ".join(words[i:i+2]).lower() for i in range(len(words) - 1)]
        bigram_counts = Counter(bigrams)
        for bigram, count in bigram_counts.most_common(3):
            if count >= 4:
                logger.info(f"[C3_BIGRAM_REP] 2-word phrase '{bigram}' repeated {count}x")
                ls = text.lower().find(bigram)
                return HallucinationReason(
                    code="excessive_bigram", matched_span=bigram,
                    loop_start=(ls if ls >= 0 else None), detail=f"x{count}",
                )

    # Check for single word repeated many times in a row
    for i in range(len(words) - 3):
        if words[i] == words[i+1] == words[i+2] == words[i+3]:
            return HallucinationReason(
                code="single_word_repeat", matched_span=words[i],
                loop_start=_word_char_offset(text, words, i), detail="x4_consecutive",
            )

    return None


def _word_char_offset(text: str, words: List[str], i: int) -> Optional[int]:
    """Best-effort char offset of the i-th whitespace-split token in text (for loop_start)."""
    pos = 0
    for j in range(i + 1):
        k = text.find(words[j], pos)
        if k < 0:
            return None
        if j == i:
            return k
        pos = k + len(words[j])
    return None


def _has_excessive_repetition(text: str, min_words: int = 10, max_repeats: int = 2) -> bool:
    """Backward-compat bool wrapper around _detect_excessive_repetition."""
    return _detect_excessive_repetition(text, min_words, max_repeats) is not None


def _has_comma_burst_hallucination(text: str) -> bool:
    """
    F6 (16.02.2026): Detect embedded comma-list hallucination.

    CIO audit approved with modified thresholds (safer than original proposal).
    Catches glossary hallucinations mixed with real text:
      "Das ist nicht der Fall, wobei die Gemeinde, die Gemeinden, die Eidreffekte..."

    Safe for neutral enumerations:
      "Klarheit, Ruhe, Mut, Geduld, Hoffnung"
      → has 4 commas but NO repetition and NO function words → safe

    Logic: (commas >= 3 AND segments >= 4 AND avg_words < 2.5)
           AND (first_word_repetition > 0.5 OR function_word_density > 0.5)

    Threshold lowered from CIO audit (4/5) to 3/4 after production logs showed
    "Die Gemeinden, die Gemeinde, Gemeinden und Verwaltungen" (3 commas) passing through.
    Second condition (repetition OR function_words) prevents false positives on Bible quotes.
    """
    commas = text.count(',')
    if commas < 3:
        return False

    segments = [s.strip() for s in text.split(',') if s.strip()]
    if len(segments) < 4:
        return False

    total_words = sum(len(s.split()) for s in segments)
    avg_words = total_words / len(segments)
    if avg_words >= 2.5:
        return False

    # Density trigger met — now require EITHER repetition OR function word pattern

    # Check 1: First-word repetition > 0.5
    first_words = [s.split()[0].lower() for s in segments if s.split()]
    if first_words:
        most_common_count = Counter(first_words).most_common(1)[0][1]
        if most_common_count / len(first_words) > 0.5:
            logger.info(
                f"[F6_COMMA_BURST] Detected: commas={commas}, segments={len(segments)}, "
                f"avg_words={avg_words:.1f}, first_word_rep={most_common_count}/{len(first_words)}"
            )
            return True

    # Check 2: German function words (articles/conjunctions) in >50% of segments
    function_words = {'die', 'der', 'das', 'des', 'dem', 'den', 'wobei', 'dass', 'weil', 'wenn', 'obwohl'}
    segments_with_function = sum(
        1 for seg in segments
        if {w.lower() for w in seg.split()} & function_words
    )
    if segments_with_function / len(segments) > 0.5:
        logger.info(
            f"[F6_COMMA_BURST] Detected (verb pattern): commas={commas}, segments={len(segments)}, "
            f"avg_words={avg_words:.1f}, function_word_segs={segments_with_function}/{len(segments)}"
        )
        return True

    return False


def filter_hallucinations(text: str) -> str:
    """
    Filter hallucinations from text.

    Args:
        text: Input transcription text

    Returns:
        Cleaned text, or empty string if entire text is hallucination
    """
    if not text:
        return ""

    text = unicodedata.normalize('NFC', text).strip()

    if is_hallucination(text):
        logger.info(f"Filtered hallucination ({len(text)} characters)")
        return ""

    return text


def calculate_volume_db(audio: np.ndarray) -> float:
    """
    Calculate volume level in decibels.

    Args:
        audio: Float32 audio array

    Returns:
        Volume in dB (negative values, -inf for silence)
    """
    if len(audio) == 0:
        return float('-inf')

    # Calculate RMS (Root Mean Square)
    rms = np.sqrt(np.mean(audio.astype(np.float64)**2))

    # Convert to dB (add small epsilon to avoid log(0))
    db = 20 * np.log10(rms + 1e-10)

    return db


def should_transcribe(audio: np.ndarray, threshold_db: Optional[float] = None) -> bool:
    """
    Volume gate - check if audio is loud enough to transcribe.

    Prevents transcription of silence/very quiet audio which often
    triggers hallucinations.

    Args:
        audio: Float32 audio array
        threshold_db: Minimum volume threshold in dB (default from config)

    Returns:
        True if audio should be transcribed, False if too quiet
    """
    if not VOLUME_GATE["enabled"]:
        return True

    if len(audio) == 0:
        return False

    if threshold_db is None:
        threshold_db = VOLUME_GATE["threshold_db"]

    db = calculate_volume_db(audio)
    should_process = db > threshold_db

    if not should_process:
        logger.debug(f"Volume gate: {db:.1f}dB < {threshold_db}dB threshold")

    return should_process


def preprocess_transcription(text: str) -> Optional[str]:
    """
    Full preprocessing pipeline for transcription output.

    Applies all filters and cleanup in correct order:
    1. NFC normalize (Whisper may output NFD decomposed Unicode)
    2. Strip whitespace
    3. Filter hallucinations
    4. Normalize whitespace
    5. Final validation

    Args:
        text: Raw transcription from Whisper

    Returns:
        Cleaned text, or None if should be filtered entirely
    """
    if not text:
        return None

    # NFC normalize + strip (Whisper outputs NFD: ä = a+U+0308 → NFC: ä = U+00E4)
    text = unicodedata.normalize('NFC', text).strip()

    if not text:
        return None

    # Filter hallucinations
    text = filter_hallucinations(text)

    if not text:
        return None

    # Normalize internal whitespace (multiple spaces -> single)
    text = " ".join(text.split())

    # Final validation - must have at least some content
    if len(text) < 2:
        return None

    # Check for text that's only punctuation
    if all(c in '.,!?;:\'"()-' for c in text.replace(' ', '')):
        return None

    return text


def clean_segment_text(text: str) -> str:
    """
    Light cleaning for segment text (preserves more content).

    Use this for segment-level cleaning where we want to keep
    the text even if it has minor issues.

    Args:
        text: Segment text

    Returns:
        Cleaned text
    """
    if not text:
        return ""

    # NFC normalize + strip and normalize whitespace
    text = " ".join(unicodedata.normalize('NFC', text).strip().split())

    # Remove leading/trailing punctuation that shouldn't be there
    text = text.strip('.,')

    return text
