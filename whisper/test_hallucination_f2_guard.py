"""F2 prose guard tests - flag HALLUCINATION_F2_PROSE_GUARD_ENABLED.

Phase-0 measurement (9 sessions 28.06-02.07): regex_comma_list (F2) caused 98% of live
gate-1 drops and ~100% of them were REAL speech (sermon enumerations/rhetoric); rep-family
had an empty numerator. The guard distinguishes prose (long, diverse comma items) from
Whisper noun-salad/phrase loops (short or repeating items).

Fixtures: whisper/fixtures_f2_prose.json — 32 SYNTHETIC comma lists generated and
self-verified by tools/s12/generate_f2_fixtures.py (private). They replaced verbatim
fragments of real sermons, which had no place in a published repository.

The substitution preserved what the fixtures are FOR. They calibrate a threshold, so
the synthetic set spans the same metric range (2.40 .. 5.20 mean words per item), keeps
the 2.5 boundary populated on both sides, and every entry is checked against the real
filter before being written. A fixture set that ignored those numbers would leave this
file green while testing nothing.
"""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))  # run from repo root or whisper/

import hallucination_filter as hf

FIXTURES_PATH = Path(__file__).resolve().parent / "fixtures_f2_prose.json"
FIXTURES = json.loads(FIXTURES_PATH.read_text(encoding="utf-8"))["fixtures"]
PROSE = [f for f in FIXTURES if f["expected_pass_with_guard"]]
BORDER = [f for f in FIXTURES if not f["expected_pass_with_guard"]]

# Loops the F2 pattern was designed for — must stay detected with the guard ON.
# Shapes preserved from the originals, wording synthetic:
#   * noun salad: many one-word items -> low mean, caught by the mean_words rule
#   * article+noun salad: two-word items (mean 2.00) -> the margin the 2.5 threshold buys
#   * phrase loop: LONG identical items -> caught by max_dup, which mean_words alone misses
LOOPS = [
    "Rasten, Kasten, Masten, Basten, Lasten, Pasten, Gasten",
    "die Erste, die Zweite, die Dritte, die Vierte, die Fuenfte",
    "was ich nicht sehe, was ich nicht sehe, was ich nicht sehe, was ich nicht sehe, bleibt fort",
]


@pytest.fixture()
def guard_on(monkeypatch):
    monkeypatch.setenv("HALLUCINATION_F2_PROSE_GUARD_ENABLED", "true")


@pytest.fixture()
def guard_off(monkeypatch):
    monkeypatch.delenv("HALLUCINATION_F2_PROSE_GUARD_ENABLED", raising=False)


def test_fixtures_loaded_and_sane():
    assert len(FIXTURES) >= 30
    assert len(PROSE) >= 29


def test_fixtures_still_calibrate_the_threshold():
    """The substitution must not have flattened the set into "all comfortably above".

    A synthetic set that sat at, say, 4.0 mean words everywhere would pass every
    assertion in this file and stop testing the threshold entirely: the boundary would
    never be approached from either side.
    """
    means = sorted(f["mean_words"] for f in FIXTURES)
    threshold = hf.F2_PROSE_GUARD_MIN_MEAN_WORDS
    assert means[0] < threshold, "no fixture below the threshold - the drop case is untested"
    assert any(m == threshold for m in means), "threshold value itself is not covered"
    assert means[-1] >= 5.0, "upper range lost - guard is only exercised near the boundary"
    assert len(BORDER) >= 1


# ---- baseline lock: flag OFF == today's behaviour (zero change) -------------

def test_flag_off_prose_fixtures_still_dropped(guard_off):
    for f in FIXTURES:
        reason = hf.detect_hallucination(f["text"])
        assert reason is not None and reason.code == "regex_comma_list", f["sha16"]


def test_flag_off_loops_detected(guard_off):
    for t in LOOPS:
        assert hf.detect_hallucination(t) is not None, t


# ---- guard ON: real prose passes, loops stay caught --------------------------

def test_flag_on_real_prose_passes(guard_on):
    for f in PROSE:
        reason = hf.detect_hallucination(f["text"])
        assert reason is None, f"{f['sha16']} still dropped: {f['text'][:80]}"
        # and the full preprocess pipeline keeps the text (this is what live gate 1 calls)
        assert hf.preprocess_transcription(f["text"]), f["sha16"]


def test_flag_on_loops_still_detected(guard_on):
    for t in LOOPS:
        reason = hf.detect_hallucination(t)
        assert reason is not None, f"loop escaped: {t}"


def test_flag_on_border_adlib_still_dropped(guard_on):
    """Known limitation: short ad-lib enumeration ('Ja, Halleluja, aber nein, nein...')
    has mean words/item 2.40 < 2.5 and stays dropped. Documented trade-off: lowering the
    threshold to rescue it would shrink the margin to 'die Anna, die Berta' salads (2.00)."""
    for f in BORDER:
        reason = hf.detect_hallucination(f["text"])
        assert reason is not None and reason.code == "regex_comma_list", f["sha16"]


# ---- unit: _comma_list_is_prose ---------------------------------------------

def test_comma_list_is_prose_unit():
    # prose: diverse items, mean well above the threshold
    assert hf._comma_list_is_prose(
        "wir legen die Karten zusammen, sie stellen die Kisten daneben, "
        "er bindet die Faeden neu, wir raeumen die Bretter beiseite")
    # noun salad: one word per item
    assert not hf._comma_list_is_prose("Rasten, Kasten, Masten, Basten, Lasten")
    # phrase loop: items long enough to pass mean_words, killed by max_dup
    assert not hf._comma_list_is_prose(
        "was ich nicht sehe, was ich nicht sehe, was ich nicht sehe, was ich nicht sehe")
    assert not hf._comma_list_is_prose("einzeln")  # <2 items


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q"]))
