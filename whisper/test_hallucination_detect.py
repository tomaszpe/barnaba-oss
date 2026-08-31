"""
Phase 0 tests for hallucination_filter.detect_hallucination (reason codes).

Goal: every detector maps to the right reason code, loop_start is set for rep-family,
and is_hallucination stays behaviour-identical (== detect_hallucination is not None).
Behaviour is UNCHANGED in Phase 0 — these tests lock the detection so Phase 1 (sanitize)
can build on a known contract.

Run:  cd whisper && python -m pytest test_hallucination_detect.py -q
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # run from repo root or whisper/
import hallucination_filter as hf


# ---- reason-code mapping --------------------------------------------------

def _code(text):
    r = hf.detect_hallucination(text)
    return r.code if r else None


def test_clean_text_returns_none():
    assert hf.detect_hallucination("Heute geht es nicht um die grossen biografischen Tsunamis") is None
    assert hf.detect_hallucination("Denn ich meinen roten Knopf, dass ich manchmal nicht schlafen kann") is None


def test_regex_subtitles():
    assert _code("Subtitles by Amara.org") == "regex_subtitles"
    assert _code("Thanks for watching this video please") == "regex_subtitles"


def test_regex_music():
    assert _code("Music playing in the background here softly") == "regex_music"


def test_regex_bracketed_annotation():
    assert _code("[Applause]") == "regex_bracketed_annotation"


def test_regex_punctuation_only():
    assert _code("...") == "regex_punctuation_only"


def test_regex_repetition_charlevel():
    # 6-char block repeated 4x -> (.{5,}?)\1{3,}
    r = hf.detect_hallucination("abcdefabcdefabcdefabcdef")
    assert r is not None and r.code == "regex_repetition"
    assert r.loop_start == 0  # match starts at offset 0


def test_regex_repetition_beats_wordlevel_on_contiguous():
    # A CONTIGUOUS 3-word loop is caught by the char-level regex first (checked before
    # word-level). This is the #5 insight: char-level = contiguous loops, word-level = scattered.
    r = hf.detect_hallucination("guten morgen alle the cat sat the cat sat the cat sat the cat sat")
    assert r is not None and r.code == "regex_repetition"


def test_excessive_trigram_scattered_sets_loop_start():
    # NON-contiguous repeat: char-level regex does NOT match, word-level count>2 does.
    text = "the cat sat on a mat then the cat sat by a wall then the cat sat near here ok"
    r = hf.detect_hallucination(text)
    assert r is not None and r.code == "excessive_trigram"
    assert r.loop_start == text.find("the cat sat")  # word-level loop_start (offset 0 here)


def test_single_word_repeat():
    text = "also wow wow wow wow this is a long enough sentence here ok"
    r = hf.detect_hallucination(text)
    assert r is not None and r.code == "single_word_repeat"
    assert r.loop_start == text.find("wow")


def test_comma_burst_embedded_3_commas():
    # 3 commas -> bypasses F2 regex ({4,} needs 4) but hits F6 _has_comma_burst (>=3).
    assert _code("die Gemeinde, die Gemeinden, die Sachen, also weiter") == "comma_burst"


def test_guillemet():
    toks = " ".join(f"«{n}»" for n in range(11, 24))  # 13 guillemet tokens
    assert _code(toks) == "guillemet"


# ---- documented PRE-EXISTING false-positive (target of Phase 1, NOT a Phase-0 regression) ----

def test_neutral_enumeration_flagged_by_f2_regex_PREEXISTING():
    # The F2 comma-list REGEX (config.py, checked before F6) flags this as regex_comma_list,
    # even though F6's docstring claims neutral enumerations are "safe". This is a pre-existing
    # false-positive (F2 pre-empts F6) — Phase 1/2 territory. Phase 0 only LOCKS the behaviour.
    r = hf.detect_hallucination("Klarheit, Ruhe, Mut, Geduld, Hoffnung")
    assert r is not None and r.code == "regex_comma_list"


# ---- classification stability: catch drift if a new config pattern is added ----

def test_all_config_patterns_classified_no_other():
    from config import HALLUCINATION_PATTERNS
    codes = [hf._classify_pattern(p) for p in HALLUCINATION_PATTERNS]
    # Every current pattern must map to a known code; a new unclassified pattern -> regex_other
    # fails here, forcing an explicit classification decision instead of a silent wrong reason.
    assert "regex_other" not in codes, dict(zip(HALLUCINATION_PATTERNS, codes))
    assert codes.count("regex_comma_list") == 1
    assert codes.count("regex_repetition") == 1


# ---- backward compat: is_hallucination == (detect is not None) ------------

def test_is_hallucination_backward_compat():
    samples = [
        "",
        "ok",
        "Subtitles by Amara.org",
        "Music playing in the background here softly",
        "[Applause]",
        "...",
        "abcdefabcdefabcdefabcdef",
        "guten morgen alle the cat sat the cat sat the cat sat the cat sat",
        "er ist a er ist b er ist c er ist d also weiter",
        "also wow wow wow wow this is a long enough sentence here ok",
        "die Anna, die Berta, die Clara, die Dora, die Emma",
        "Klarheit, Ruhe, Mut, Geduld, Hoffnung",
        "Heute geht es nicht um die grossen biografischen Tsunamis",
    ]
    for s in samples:
        assert hf.is_hallucination(s) == (hf.detect_hallucination(s) is not None), s


# ---- known false positives (documented, NOT desired behaviour) -------------

def test_known_fp_rhetorical_bigram_er_ist_reference_session():
    """KNOWN FALSE POSITIVE — locks CURRENT behaviour, not desired behaviour.

    Real sermon rhetoric from a reference session window: "er ist" x4 is genuine anaphora, yet
    C3_BIGRAM_REP classifies the window as hallucination and preprocess nukes it to None. That
    None crashed /transcribe (fixed: coerced to "") and on LIVE gate 1 it drops the
    whole window's text — measure scale via Phase-0 hallucination_detected
    events (reason_code=excessive_bigram) before any filter tuning.
    When the filter is tuned to spare rhetorical repetition, THIS TEST SHOULD
    FLIP — update it deliberately, do not paper over it.
    """
    text = (
        "So zu sagen, er ist eigentlich eine Manifestation der besten Form der Menschheit. "
        "Er ist der Repräsentant des «Mensch par excellence». Er hat alles, er ist absolut reich "
        "und ist absolut vollkommen und einzigartig. In Kapitel 4, er ist in Staub und Asche, "
        "hat sieben Tage lang einfach geschwiegen."
    )
    reason = hf.detect_hallucination(text)
    assert reason is not None and reason.code == "excessive_bigram"  # the FP classification
    assert reason.matched_span == "er ist"
    assert hf.preprocess_transcription(text) is None  # whole-window nuke -> the /transcribe 500 trigger


if __name__ == "__main__":
    import sys
    import pytest
    sys.exit(pytest.main([__file__, "-q"]))
