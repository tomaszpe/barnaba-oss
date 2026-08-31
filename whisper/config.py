"""
Church-Optimized Whisper Configuration
======================================
Settings tuned for Swiss German church services with reverberant acoustics.

Based on recommendations from:
- Flurin17/whisper-large-v3-turbo-swiss-german model docs
- HuggingFace transformers pipeline optimization
- Azure A100 deployment best practices

MIGRATION NOTE (16.01.2026):
- Migrated from faster-whisper/CTranslate2 to HuggingFace transformers
- Reason: CT2 conversion bug with fine-tuned whisper-large-v3-turbo (128 vs 80 mel bins)
- Using Flash Attention 2 for 2.2x speedup + 20% VRAM savings on A100

QUICK FIX - LocalAgreement Stability (17.01.2026):
- Problem: hasNew=false - LocalAgreement not confirming text
- Root cause: HuggingFace temperature fallback mechanism
- Solution: Disable threshold fallbacks + PyTorch deterministic mode
- Changes in whisper_service.py:
  * compression_ratio_threshold=None
  * logprob_threshold=None
  * no_speech_threshold=None
  * do_sample=False (explicit)
  * torch.backends.cudnn.deterministic=True
- Changes in config.py:
  * chunk_duration_sec: 1.5s -> 2.0s (more context = more stability)
- Reference: the LocalAgreement design notes (not part of this repository)

MODEL UPDATE (14.04.2026):
- Flurin17 retrained the model on 20.03.2026 (checkpoint-750)
- Training data: ~301h (SwissDial 24h + Swiss Parliament V2 293h + FHNW 13h + ArchiMob)
- WER improvement: 39.18 eval (-6.54 vs base), 37.96 validation (best checkpoint)
- Previous cached model was from May 2025 training run
- Pinned to a full-SHA revision to ensure reproducible builds
"""

import logging
import os
import re

# =============================================================================
# MODEL CONFIGURATION (HuggingFace transformers pipeline)
# =============================================================================

MODEL_CONFIG = {
    # HuggingFace model name (fine-tuned Swiss German)
    "model_name": os.getenv(
        "WHISPER_MODEL",
        "Flurin17/whisper-large-v3-turbo-swiss-german"
    ),
    # Model revision, pinned as a FULL 40-character commit SHA.
    # An abbreviation is not a pin: Hugging Face resolves it, but it is ambiguous by
    # construction and gives the reader nothing to compare against. The value is
    # validated below so a short hash cannot silently come back through the env var.
    "model_revision": os.getenv("WHISPER_MODEL_REVISION", "34415231e554d1e7005118264f41e287922f9218"),
    # Device: 0 for cuda:0, -1 for CPU
    "device": 0 if os.getenv("WHISPER_DEVICE", "cuda") == "cuda" else -1,
    # Torch dtype: "float16" or "float32"
    "torch_dtype": os.getenv("WHISPER_COMPUTE_TYPE", "float16"),
    # Cache directory for HuggingFace models
    "cache_dir": os.getenv("WHISPER_DOWNLOAD_ROOT", "/var/cache/whisper"),
    # Attention implementation: "flash_attention_2" (2.2x speedup + 20% VRAM) or "sdpa" (fallback)
    # Flash Attention 2 requires: pip install flash-attn --no-build-isolation
    "attn_implementation": os.getenv("WHISPER_ATTN_IMPL", "flash_attention_2"),
}

# Fail closed on an abbreviated or malformed revision. A short hash is exactly what
# the pin used to be, and it is the dangerous case: Hugging Face resolves it, so a
# regression here would be silent rather than loud.
_REVISION = MODEL_CONFIG["model_revision"]
if not re.fullmatch(r"[0-9a-f]{40}", _REVISION):
    raise ValueError(
        "WHISPER_MODEL_REVISION must be a full 40-character commit SHA, got: "
        f"{_REVISION!r}"
    )

# =============================================================================
# MODEL TRUST GATE
# =============================================================================
#
# A FULL SHA GUARANTEES IMMUTABILITY, NOT TRUSTWORTHINESS. The two are easy to
# conflate, and the difference is the whole point of this gate.
#
# transformers < 5.3.0 - the pinned 4.57.5 included - is vulnerable to
# CVE-2026-4372 / GHSA-29pf-2h5f-8g72: a malicious `config.json` carrying
# `_attn_implementation_internal` can execute code from an attacker-controlled
# repository EVEN WITH `trust_remote_code=False`. whisper/requirements.txt accepts
# that risk, and the acceptance rests on one specific fact: the config.json of the
# pair below was READ, and contains no `_attn_implementation_internal`, no
# `auto_map` and no `trust_remote_code`.
#
# That fact is a property of THIS repository AT THIS REVISION. It says nothing
# about any other model, and the SHA check above cannot supply it.
#
# This matters in practice, not in theory: README.md tells a commercial deployment
# to substitute a different model, because the default one is CC BY-NC. Without
# this gate, following the licensing advice would silently leave the security
# exception behind.
VERIFIED_MODEL = "Flurin17/whisper-large-v3-turbo-swiss-german"
VERIFIED_MODEL_REVISION = "34415231e554d1e7005118264f41e287922f9218"

ALLOW_UNVERIFIED_MODEL = os.getenv("WHISPER_ALLOW_UNVERIFIED_MODEL", "false").lower() == "true"

if (MODEL_CONFIG["model_name"], _REVISION) != (VERIFIED_MODEL, VERIFIED_MODEL_REVISION):
    _substitution = (
        f"WHISPER_MODEL={MODEL_CONFIG['model_name']!r} "
        f"WHISPER_MODEL_REVISION={_REVISION!r}"
    )
    if not ALLOW_UNVERIFIED_MODEL:
        raise ValueError(
            "Refusing to start with an unverified model.\n"
            f"  requested: {_substitution}\n"
            f"  verified:  WHISPER_MODEL={VERIFIED_MODEL!r} WHISPER_MODEL_REVISION={VERIFIED_MODEL_REVISION!r}\n"
            "\n"
            "transformers 4.57.5 is affected by CVE-2026-4372 (GHSA-29pf-2h5f-8g72): a crafted\n"
            "config.json can execute remote code even with trust_remote_code=False. The pin is\n"
            "accepted only because THAT revision's config.json was inspected and carries none of\n"
            "_attn_implementation_internal, auto_map, trust_remote_code. A full SHA makes a model\n"
            "immutable, not safe - an attacker's SHA is just as immutable as ours.\n"
            "\n"
            "To use another model, read its config.json AT THE REVISION YOU PIN, confirm the same\n"
            "three keys are absent, then set WHISPER_ALLOW_UNVERIFIED_MODEL=true. Upgrading to\n"
            "transformers >= 5.3.0 removes the vulnerability and is the real fix; whisper/\n"
            "requirements.txt describes what qualifying 5.x involves.\n"
        )
    logging.getLogger(__name__).warning(
        "WHISPER_ALLOW_UNVERIFIED_MODEL=true: running %s, which is NOT the "
        "config.json-inspected pair. transformers 4.57.5 is affected by "
        "CVE-2026-4372; responsibility for that config.json is now yours.",
        _substitution,
    )

# =============================================================================
# VAD CONFIGURATION (Church-Optimized)
# =============================================================================

# Silero VAD source revision - SINGLE SOURCE OF TRUTH for build and runtime.
#
# Why this is pinned (26.08.2026)
# -------------------------------
# Both the image build (whisper/Dockerfile.base) and the runtime loader
# (whisper/vad_processor.py) called torch.hub.load('snakers4/silero-vad', ...)
# with no revision, i.e. whatever HEAD of somebody else's repository happened to
# be at that moment. Two consequences, both silent:
#   * two builds a week apart can bake different VAD versions with no record;
#   * build (force_reload=True) and runtime (force_reload=False) can disagree
#     whenever the baked cache is absent.
# Reproducibility is one of the three areas this project invites contributions
# to, so an unpinned dependency of the audio front end is not a detail.
#
# Value: commit be95df9 = tag v6.2 = version 6.2.0. A commit SHA rather than a tag,
# because tags can be moved to point at different code and a SHA cannot.
#
# 🔴 THIS IS A VERSION CHOICE, NOT A NEUTRAL PIN. An earlier version of this note
# claimed the pin "does not change what a fresh build produces today, it only stops
# the drift". That was WRONG and was corrected on 26.08 after checking the remote:
#     master -> 867c2aa692646a1f1de3e94a15c9dd9f614c0acb
#     v6.2   -> be95df9152c0d7618fa1edfeb296fc3dae32376f
# The local torch.hub cache said 6.2.0, but a cache directory records when it was
# fetched, not what HEAD is now. Pinning therefore MOVES a fresh build off master.
#
# 🔴 TWO THINGS TO SETTLE BEFORE THIS SHIPS TO PRODUCTION:
#  1. Which revision the running image actually carries. The architecture record notes
#     "silero-vad 5.0+", so the deployed VAD may be a 5.x - going to 6.2 would then
#     be a behaviour change needing its own gate, not a hygiene fix.
#  2. Runtime code and base image must ship TOGETHER. torch.hub keys its cache by
#     reference: the baked cache directory is snakers4_silero-vad_<ref>. Pinned
#     runtime code on an older base image (cached as _master) finds no cache and
#     falls back to fetching from the network at startup - in a container that may
#     have no egress, and during a service.
SILERO_VAD_REPO = "snakers4/silero-vad"
SILERO_VAD_REF = os.getenv("SILERO_VAD_REF", "be95df9152c0d7618fa1edfeb296fc3dae32376f")

# Validated here, not only in the Dockerfile, so an override via the environment
# cannot quietly downgrade the pin to a movable branch or tag.
if len(SILERO_VAD_REF) != 40 or any(c not in "0123456789abcdef" for c in SILERO_VAD_REF):
    raise ValueError(
        f"SILERO_VAD_REF must be a 40-character commit SHA, got {SILERO_VAD_REF!r}. "
        "Branches and tags can be moved; a SHA cannot."
    )

VAD_CONFIG = {
    # Higher threshold reduces false positives from music/reverb
    # Claude Research: 0.50 optimal for Swiss German (lower 0.3-0.4 for soft speech)
    "threshold": float(os.getenv("VAD_THRESHOLD", "0.50")),

    # Filter brief sounds (organ notes, coughs) but catch short words
    # Deep Research: 250ms catches "Amen", "Yes" while filtering noise
    "min_speech_duration_ms": int(os.getenv("VAD_MIN_SPEECH_MS", "250")),

    # Silence threshold before segment end - higher for Swiss German prosody
    # Claude+Gemini Research: 500-1000ms optimal, using 1000ms for quality
    "min_silence_duration_ms": int(os.getenv("VAD_MIN_SILENCE_MS", "1000")),

    # Generous padding preserves word boundaries in echo
    # Default 30ms -> 600ms for reverberant spaces
    "speech_pad_ms": int(os.getenv("VAD_SPEECH_PAD_MS", "600")),

    # Sample rate (must be 16kHz for Silero VAD)
    "sample_rate": 16000,
}

# =============================================================================
# TRANSCRIPTION CONFIGURATION (HuggingFace transformers pipeline)
# =============================================================================

# NOTE: Parameters removed during migration from faster-whisper (16.01.2026):
# - vad_filter, vad_parameters: External Silero VAD handles this (whisper_service.py)
# - hallucination_silence_threshold: Not supported by transformers pipeline
# - best_of: Not supported (use num_beams instead)
# - compression_ratio_threshold: Not supported
# - log_prob_threshold: Not supported

TRANSCRIBE_CONFIG = {
    # Target language (German for Swiss German -> Standard German)
    # Note: "gsw" (Swiss German) is NOT supported - falls back to English!
    "language": os.getenv("WHISPER_LANGUAGE", "de"),

    # Beam size: 5 = optimal quality (ChrF metric) per Claude+Gemini research
    # Trade-off: +300-500ms latency vs beam=1, but better accuracy
    # Maps to: generate_kwargs={"num_beams": 5}
    "num_beams": int(os.getenv("WHISPER_BEAM_SIZE", "5")),

    # Temperature: 0.0 = deterministic decoding, no fallbacks
    # Single value avoids latency from retry mechanisms
    # Maps to: generate_kwargs={"temperature": 0.0, "do_sample": False}
    "temperature": float(os.getenv("WHISPER_TEMPERATURE", "0.0")),

    # CRITICAL: False prevents hallucination/error propagation in streaming
    # True causes repetition loops and spreads errors to subsequent segments
    # Maps to: generate_kwargs={"condition_on_prev_tokens": False}
    "condition_on_previous_text": False,

    # Word timestamps: return_timestamps="word" in transformers
    # Enables word-level timing for subtitle generation
    "return_timestamps": "word",

    # Repetition penalty: prevents hallucination loops (1.1-1.2 recommended)
    # Maps to: generate_kwargs={"repetition_penalty": 1.1}
    "repetition_penalty": float(os.getenv("REPETITION_PENALTY", "1.1")),

    # N-gram repetition blocking: additional protection against loops
    # Maps to: generate_kwargs={"no_repeat_ngram_size": 3}
    "no_repeat_ngram_size": int(os.getenv("NO_REPEAT_NGRAM_SIZE", "3")),

    # Batch size for pipeline (1 for streaming, can increase for batch processing)
    "batch_size": int(os.getenv("WHISPER_BATCH_SIZE", "1")),

    # Chunk length for long audio (30s default, same as Whisper context window)
    "chunk_length_s": int(os.getenv("WHISPER_CHUNK_LENGTH_S", "30")),
}

# =============================================================================
# HALLUCINATION DETECTION PATTERNS
# =============================================================================

# Regex patterns for common Whisper hallucinations
HALLUCINATION_PATTERNS = [
    r"[Ss]ubtitles?\s*(by|created|provided)",
    r"[Aa]mara\.org",
    r"[Tt]hanks?\s*for\s*watching",
    r"[Pp]lease\s*(like|subscribe|comment)",
    r"[Ss]ubscribe\s*(to|now|here)",
    r"(.{5,}?)\1{3,}",  # Repetition 3+ times
    r"[♪♫]|[Mm]usic\s*playing",
    r"\[.*\]",  # Bracketed annotations like [Music], [Applause]
    r"^\s*\.\s*$",  # Just a period
    r"^[\s\.\,\!\?]+$",  # Only punctuation
    # F2 FIX (16.02.2026): Comma-separated word lists without verbs = glossary hallucination
    # Catches: "Grossrat, Grossrätin, Schäupte, Schöttemberg, Schubstabe, Schutze..."
    # Safe: real sermon text ALWAYS has verbs/prepositions/sentence structure
    # ^ ASSUMPTION REFUTED BY MEASUREMENT: a single prose sentence with >=4 commas matches
    #   (98% of live drops were real speech). Guard:
    #   HALLUCINATION_F2_PROSE_GUARD_ENABLED (hallucination_filter._comma_list_is_prose).
    r"^[\w\s\u00c0-\u024f\u00df\u00ab\u00bb\u201e\u201c\u201a\u2018]+(?:,\s*[\w\s\u00c0-\u024f\u00df\u00ab\u00bb\u201e\u201c\u201a\u2018]+){4,}\.{0,4}$",
]

# =============================================================================
# VOLUME GATE CONFIGURATION
# =============================================================================

VOLUME_GATE = {
    # Enable/disable volume gate
    "enabled": os.getenv("VOLUME_GATE_ENABLED", "true").lower() == "true",
    # Minimum volume threshold in dB (below = silence)
    "threshold_db": float(os.getenv("VOLUME_THRESHOLD_DB", "-45")),
}

# =============================================================================
# STREAMING CONFIGURATION
# =============================================================================

STREAMING_CONFIG = {
    # Chunk duration for Whisper (2.0s for LocalAgreement stability)
    # QUICK FIX (17.01.2026): Increased from 1.5s to 2.0s
    # Larger chunks = more acoustic context = more consistent predictions
    # Trade-off: ~2s baseline latency (acceptable for church services)
    "chunk_duration_sec": float(os.getenv("CHUNK_DURATION_SEC", "2.0")),

    # Overlap between chunks (0.5s for context continuity)
    # NOTE (28.06.2026): this is the LEGACY ChunkedAudioBuffer config and does NOT
    # control growing-buffer trim overlap. The growing-buffer trim uses trim_overlap_sec
    # below. See _perform_buffer_trim() / ring_buffer.trim_at_time(overlap_seconds=...).
    "overlap_duration_sec": float(os.getenv("OVERLAP_DURATION_SEC", "0.5")),

    # Growing-buffer TRIM overlap, PER REASON (28.06.2026 — supersedes the global
    # TRIM_OVERLAP_SEC which is now a no-op fallback only):
    # - NORMAL trims (sentence_confirmed/boundary) keep a WIDE overlap for LA warm-start
    #   quality. Run 28.06 (overlap=5) showed this gives 0% inter-emission duplicates +
    #   fuller text on the normal path.
    # - FORCE trims (hard_limit/proactive/emergency/hallucination_burst) keep a SMALL
    #   overlap. A wide overlap on hard_limit makes effective_trim = trim - overlap too
    #   small (e.g. 7-5=2s) to clear the hard limit faster than real-time audio refills
    #   it -> the buffer pins at the limit, no submit happens, Whisper stalls (LIVELOCK,
    #   observed 28.06: 96s silence). hard_limit is the ONLY reason in the chunk-add path
    #   before the has_new_audio gate, so it is the livelock site.
    "trim_overlap_sentence_confirmed_sec": float(os.getenv("TRIM_OVERLAP_SENTENCE_CONFIRMED_SEC", "5.0")),
    "trim_overlap_sentence_boundary_sec": float(os.getenv("TRIM_OVERLAP_SENTENCE_BOUNDARY_SEC", "3.0")),
    "trim_overlap_force_sec": float(os.getenv("TRIM_OVERLAP_FORCE_SEC", "1.0")),
    # Legacy global (pre-per-reason). Kept readable so a stale TRIM_OVERLAP_SEC env does
    # not crash; NO LONGER used by _perform_buffer_trim. Do not rely on it.
    "trim_overlap_sec": float(os.getenv("TRIM_OVERLAP_SEC", "1.0")),
    # Livelock guard: force a submit after this many consecutive hard_limit force-trims
    # with no intervening Whisper submit (defense-in-depth; should never fire once force
    # overlap clears the buffer, but caps any future regression at N*~2s instead of 96s).
    "livelock_guard_max_hard_trims": int(os.getenv("LIVELOCK_GUARD_MAX_HARD_TRIMS", "5")),

    # C.7 (30.06.2026): on hard-limit, submit the full buffer once before the
    # destructive force-trim. This gives LA/timestamp dedup one final chance to
    # confirm content while keeping TRIM_OVERLAP_FORCE_SEC unchanged.
    "force_trim_submit_before_trim_enabled": os.getenv("FORCE_TRIM_SUBMIT_BEFORE_TRIM_ENABLED", "false").lower() == "true",
    # C.9 (01.07.2026): hard-limit word-boundary snap. The legacy chunk-add
    # force path trimmed at raw buffer*0.5 with no chunks/timestamps, unlike
    # emergency/proactive trims. Shadow probe is logged regardless; apply is
    # gated by this flag and snaps only to a nearby confirmed word end.
    "force_trim_word_boundary_snap_enabled": os.getenv("FORCE_TRIM_WORD_BOUNDARY_SNAP_ENABLED", "false").lower() == "true",
    "force_trim_word_boundary_snap_window_sec": float(os.getenv("FORCE_TRIM_WORD_BOUNDARY_SNAP_WINDOW_SEC", "1.2")),

    # LocalAgreement-n parameter (n=2 means 2 consecutive agreements)
    "local_agreement_n": int(os.getenv("LOCAL_AGREEMENT_N", "2")),

    # LocalAgreement similarity threshold for fuzzy word matching (0-1)
    # Lowered from 0.85 to 0.75 for Swiss German dialect variation (23.01.2026)
    "la_similarity_threshold": float(os.getenv("LA_SIMILARITY_THRESHOLD", "0.75")),

    # Phase 2 part 2 (29.06.2026): no-empty warm-start (anchor_only).
    # When a force-trim leaves no timestamp/audio overlap, seed the LA history with the
    # confirmed_text tail as an anti-premature-confirm anchor. In anchor_only mode the
    # confirmed_text STAYS empty (divergence-safe: a diverging next transcription cannot
    # re-emit or corrupt the common-prefix slicing). Default OFF = legacy regular reset.
    "la_text_anchor_enabled": os.getenv("LA_TEXT_ANCHOR_ENABLED", "false").lower() == "true",
    # Number of confirmed_text tail words used as the anchor seed when enabled.
    # Clamped to [1, 30]: too few = weak gating, too many = whole-buffer seed.
    "la_text_anchor_words": max(1, min(30, int(os.getenv("LA_TEXT_ANCHOR_WORDS", "8")))),

    # Maximum audio buffer duration (30s)
    "max_buffer_sec": float(os.getenv("MAX_BUFFER_SEC", "30.0")),

    # Session timeout (5 minutes)
    "session_timeout_sec": int(os.getenv("SESSION_TIMEOUT_SEC", "300")),
}

# =============================================================================
# SMOOTH MODE CONFIGURATION (26.01.2026)
# =============================================================================
# Smooth Mode provides:
# 1. Initial 10s buffer to collect context before first output
# 2. Minimum 2 sentences before releasing to translation
# 3. Better translation quality at cost of ~15-20s latency
#
# Ideal for: Church services (no interaction needed)
# Not for: Live Q&A (latency too high)

SMOOTH_MODE_CONFIG = {
    # Enable/disable Smooth Mode (default: enabled for church services)
    "enabled": os.getenv("SMOOTH_MODE_ENABLED", "true").lower() == "true",

    # Initial buffer duration before first output (seconds)
    # During this time, audio accumulates and UI shows "Preparing..."
    "initial_buffer_sec": float(os.getenv("SMOOTH_INITIAL_BUFFER_SEC", "10.0")),

    # Minimum sentences to accumulate before releasing to translation
    "min_sentences": int(os.getenv("SMOOTH_MIN_SENTENCES", "2")),

    # Minimum characters even if min_sentences met (prevents "Amen. Halleluja." edge case)
    "min_chars": int(os.getenv("SMOOTH_MIN_CHARS", "50")),

    # Maximum hold time before force release (seconds)
    # Safety valve: if no sentence boundary found, release anyway
    "max_hold_sec": float(os.getenv("SMOOTH_MAX_HOLD_SEC", "15.0")),

    # Catch-up threshold (seconds) - when buffer grows too large
    # If buffer > this value, release 3+ sentences to catch up
    "catchup_threshold_sec": float(os.getenv("SMOOTH_CATCHUP_THRESHOLD_SEC", "25.0")),

    # Minimum sentences to release in catch-up mode
    "catchup_min_sentences": int(os.getenv("SMOOTH_CATCHUP_MIN_SENTENCES", "3")),
}

# =============================================================================
# RAW TOKEN TIMESTAMP DIAGNOSTICS (OFF BY DEFAULT)
#
# ON swaps the pipeline class for a diagnostic subclass that overrides `_forward()` only and
# reads the `token_timestamps` already returned by `model.generate()`.
# No second inference, no change to the ASR result, no text in the logs.
# The flag only takes effect with `WHISPER_RETURN_TIMESTAMPS=word` - without it `generate()`
# does not compute token timestamps at all and there is nothing to measure.
TOKEN_TIMESTAMP_PROBE_ENABLED = os.getenv(
    "TOKEN_TIMESTAMP_PROBE_ENABLED", "false"
).lower() == "true"

# =============================================================================
# SAMPLE RATE (constant)
# =============================================================================

SAMPLE_RATE = 16000
