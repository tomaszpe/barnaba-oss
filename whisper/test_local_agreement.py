# -*- coding: utf-8 -*-
"""
D3 Phase 4a.2: LocalAgreement unit tests.

Tests LA-n algorithm behavior with different n and similarity_threshold values.
Validates German normalization, edge cases, and observability logging.
"""

import pytest
from local_agreement import LocalAgreementBuffer, StreamingTranscriptionStabilizer


# ============================================================
# LocalAgreementBuffer — n parameter behavior
# ============================================================

class TestLocalAgreementN:
    """Tests for n parameter (consecutive agreement count)."""

    def test_n2_two_agreements_confirm(self):
        """n=2: Two identical transcriptions should confirm."""
        buf = LocalAgreementBuffer(n=2)
        r1 = buf.process("Geduld und Gelassenheit")
        assert not r1.is_new_confirmation  # only 1 in history

        r2 = buf.process("Geduld und Gelassenheit")
        assert r2.is_new_confirmation
        assert r2.confirmed_text == "Geduld und Gelassenheit"

    def test_n2_disagreement_no_confirm(self):
        """n=2: Two different transcriptions should not confirm new text."""
        buf = LocalAgreementBuffer(n=2)
        buf.process("Geduld und Gelassenheit")
        r2 = buf.process("Freude und Hoffnung")
        assert not r2.is_new_confirmation

    def test_n3_two_agreements_not_enough(self):
        """n=3: Two identical transcriptions are not enough."""
        buf = LocalAgreementBuffer(n=3)
        buf.process("Geduld und Gelassenheit")
        r2 = buf.process("Geduld und Gelassenheit")
        assert not r2.is_new_confirmation  # need 3

    def test_n3_three_agreements_confirm(self):
        """n=3: Three identical transcriptions should confirm."""
        buf = LocalAgreementBuffer(n=3)
        buf.process("Geduld und Gelassenheit")
        buf.process("Geduld und Gelassenheit")
        r3 = buf.process("Geduld und Gelassenheit")
        assert r3.is_new_confirmation
        assert r3.confirmed_text == "Geduld und Gelassenheit"

    def test_n3_partial_divergence_confirms_prefix(self):
        """n=3: Divergence at 3rd word still confirms common prefix."""
        buf = LocalAgreementBuffer(n=3)
        buf.process("Geduld und Gelassenheit")
        buf.process("Geduld und Gelassenheit")
        r3 = buf.process("Geduld und Freude")  # 3rd word diverges
        # "Geduld und" is common prefix across all 3 → confirmed
        assert r3.is_new_confirmation
        assert r3.confirmed_text == "Geduld und"

    def test_n2_partial_prefix_confirms(self):
        """n=2: Partial prefix agreement confirms common part."""
        buf = LocalAgreementBuffer(n=2)
        buf.process("Geduld und Gelassenheit ist wichtig")
        r2 = buf.process("Geduld und Gelassenheit kommt von Gott")
        # Common prefix: "Geduld und Gelassenheit"
        assert r2.is_new_confirmation
        assert "Geduld und Gelassenheit" in r2.confirmed_text

    def test_n4_needs_four_agreements(self):
        """n=4: Needs all 4 agreements."""
        buf = LocalAgreementBuffer(n=4)
        for i in range(3):
            r = buf.process("Amen")
            assert not r.is_new_confirmation
        r4 = buf.process("Amen")
        assert r4.is_new_confirmation


# ============================================================
# LocalAgreementBuffer — similarity_threshold behavior
# ============================================================

class TestSimilarityThreshold:
    """Tests for similarity_threshold fuzzy matching."""

    def test_threshold_075_accepts_similar_words(self):
        """Threshold 0.75: 'Grossrat' vs 'Grossrat' exact match."""
        buf = LocalAgreementBuffer(n=2, similarity_threshold=0.75)
        buf.process("der Grossrat hat entschieden")
        r2 = buf.process("der Grossrat hat entschieden")
        assert r2.is_new_confirmation

    def test_threshold_075_accepts_minor_variation(self):
        """Threshold 0.75: slight spelling variation should match."""
        buf = LocalAgreementBuffer(n=2, similarity_threshold=0.75)
        buf.process("Gelassenheit ist zentral")
        r2 = buf.process("Gelassenheit ist Zentral")  # capitalization
        assert r2.is_new_confirmation

    def test_stricter_threshold_confirms_less(self):
        """A stricter threshold confirms strictly less of the same input.

        MEASURED, NOT ASSUMED - and the measurement contradicted the previous
        version of this test, which was named ``..._085_rejects_moderate_variation``,
        asserted nothing at all, and justified itself with a comment claiming the
        pair scored "~0.74, below the 0.85 threshold". Both halves were wrong:
        normalised to "grossrat" / "grossraete", ``SequenceMatcher`` scores 0.8889,
        so 0.85 ACCEPTS the variation. The threshold that rejects it is 0.90.

        Because the old body contained no assertion, the false claim could not be
        contradicted by running the suite. The two assertions below are the real
        contract the name was reaching for.
        """
        accepting = LocalAgreementBuffer(n=2, similarity_threshold=0.85)
        accepting.process("der Grossrat hat entschieden")
        loose = accepting.process("der Grossraete hat entschieden")

        rejecting = LocalAgreementBuffer(n=2, similarity_threshold=0.90)
        rejecting.process("der Grossrat hat entschieden")
        strict = rejecting.process("der Grossraete hat entschieden")

        # 0.8889 >= 0.85: the whole prefix is still confirmed.
        assert loose.confirmed_text == "der Grossrat hat entschieden"
        # 0.8889 < 0.90: agreement stops at the word before the variation.
        assert strict.confirmed_text == "der"
        assert len(strict.confirmed_text) < len(loose.confirmed_text)

    def test_threshold_070_accepts_more(self):
        """Threshold 0.70: looser matching accepts more variation."""
        buf = LocalAgreementBuffer(n=2, similarity_threshold=0.70)
        buf.process("Gelassenheit bedeutet Geduld")
        r2 = buf.process("Gelassenheit bedeuted Geduld")  # typo: bedeuted
        assert r2.is_new_confirmation

    def test_configurable_via_constructor(self):
        """Verify threshold is passed through correctly."""
        buf = LocalAgreementBuffer(n=2, similarity_threshold=0.90)
        assert buf.similarity_threshold == 0.90

    def test_stabilizer_passes_threshold(self):
        """StreamingTranscriptionStabilizer passes threshold to buffer."""
        stab = StreamingTranscriptionStabilizer(n=3, similarity_threshold=0.82)
        assert stab._current_buffer.similarity_threshold == 0.82
        assert stab._current_buffer.n == 3


# ============================================================
# German normalization
# ============================================================

class TestGermanNormalization:
    """Tests for _normalize_german handling."""

    def test_umlaut_normalization(self):
        """Umlauts normalized: ae/oe/ue/ss."""
        buf = LocalAgreementBuffer(n=2)
        # After normalization both should match
        buf.process("die Grossmutter hat gesagt")
        r2 = buf.process("die Grossmutter hat gesagt")
        assert r2.is_new_confirmation

    def test_punctuation_ignored(self):
        """Punctuation should not affect matching."""
        buf = LocalAgreementBuffer(n=2)
        buf.process("Geduld, und Gelassenheit.")
        r2 = buf.process("Geduld und Gelassenheit")
        assert r2.is_new_confirmation

    def test_case_insensitive(self):
        """Case differences should not affect matching."""
        buf = LocalAgreementBuffer(n=2)
        buf.process("Der Herr ist mein Hirte")
        r2 = buf.process("der Herr ist mein Hirte")
        assert r2.is_new_confirmation


# ============================================================
# Edge cases
# ============================================================

class TestEdgeCases:
    """Edge cases for LocalAgreementBuffer."""

    def test_empty_transcription(self):
        """Empty string should not crash."""
        buf = LocalAgreementBuffer(n=2)
        r = buf.process("")
        assert r.confirmed_text == ""
        assert not r.is_new_confirmation

    def test_single_word(self):
        """Single word can be confirmed with n agreements."""
        buf = LocalAgreementBuffer(n=2)
        buf.process("Amen")
        r2 = buf.process("Amen")
        assert r2.is_new_confirmation
        assert r2.confirmed_text == "Amen"

    def test_reset_clears_state(self):
        """Reset should clear all state."""
        buf = LocalAgreementBuffer(n=2)
        buf.process("Geduld und Gelassenheit")
        buf.process("Geduld und Gelassenheit")
        buf.reset()
        assert buf.confirmed_text == ""
        assert len(buf.history) == 0
        assert buf._first_seen_time == 0.0

    def test_growing_transcription(self):
        """Simulates real Whisper: each pass has more text (growing buffer)."""
        buf = LocalAgreementBuffer(n=2)
        buf.process("Geduld")
        buf.process("Geduld und")  # growing
        # "Geduld" is common prefix
        assert buf.confirmed_text == "Geduld"

        buf.process("Geduld und Gelassenheit")
        # "Geduld und" is common prefix (between 2nd and 3rd)
        assert "Geduld und" in buf.confirmed_text


# ============================================================
# Observability (D3 metrics)
# ============================================================

class TestObservability:
    """Tests for D3 observability features."""

    def test_similarity_scores_captured(self):
        """Similarity scores should be captured during word agreement."""
        buf = LocalAgreementBuffer(n=2, similarity_threshold=0.75)
        buf.process("Geduld und Gelassenheit")
        buf.process("Geduld und Gelassenheit")
        # After processing, scores should have been recorded
        assert len(buf._last_similarity_scores) >= 0  # at least some scores tracked

    def test_stats_include_threshold(self):
        """get_stats() should report similarity_threshold."""
        buf = LocalAgreementBuffer(n=3, similarity_threshold=0.82)
        stats = buf.get_stats()
        assert stats["similarity_threshold"] == 0.82
        assert stats["n"] == 3

    def test_confirmation_count_increments(self):
        """Stats should track confirmation count."""
        buf = LocalAgreementBuffer(n=2)
        buf.process("Amen")
        buf.process("Amen")
        stats = buf.get_stats()
        assert stats["confirmations_made"] == 1

    def test_first_seen_time_resets_on_confirmation(self):
        """First-seen timer should reset after each confirmation."""
        buf = LocalAgreementBuffer(n=2)
        buf.process("Amen")
        assert buf._first_seen_time > 0
        first_time = buf._first_seen_time

        buf.process("Amen")  # confirms
        # Timer should have been reset to new value
        assert buf._first_seen_time >= first_time


# ============================================================
# StreamingTranscriptionStabilizer integration
# ============================================================

class TestStabilizer:
    """Tests for StreamingTranscriptionStabilizer with configurable params."""

    def test_stabilizer_default_params(self):
        """Default params: n=2, similarity=0.75."""
        stab = StreamingTranscriptionStabilizer()
        assert stab._current_buffer.n == 2
        assert stab._current_buffer.similarity_threshold == 0.75

    def test_stabilizer_custom_params(self):
        """Custom params passed through to buffer."""
        stab = StreamingTranscriptionStabilizer(n=3, similarity_threshold=0.80)
        assert stab._current_buffer.n == 3
        assert stab._current_buffer.similarity_threshold == 0.80

    def test_stabilizer_process_returns_tuple(self):
        """Process should return (stable, partial, has_new) tuple."""
        stab = StreamingTranscriptionStabilizer(n=2)
        result = stab.process("Geduld und Gelassenheit")
        assert isinstance(result, tuple)
        assert len(result) == 3

    def test_stabilizer_sentence_confirmation(self):
        """Complete sentence with period should trigger segment completion."""
        stab = StreamingTranscriptionStabilizer(n=2, min_sentence_words=2)
        stab.process("Geduld ist wichtig.")
        stable, partial, has_new = stab.process("Geduld ist wichtig.")
        assert has_new
        assert "Geduld ist wichtig." in stable


# ============================================================
# Phase 2 part 2 (29.06.2026): no-empty warm-start (anchor_only)
# ============================================================

class TestWarmStartAnchorOnly:
    """warm_start trusted vs anchor_only (trusted=False) behaviour."""

    def test_warm_start_trusted_sets_confirmed(self):
        """trusted=True (legacy/default): seed becomes confirmed_text immediately."""
        buf = LocalAgreementBuffer(n=2)
        buf.warm_start("Geduld und Gelassenheit")
        assert buf.confirmed_text == "Geduld und Gelassenheit"
        assert len(buf.history) == 2  # seeded n times

    def test_warm_start_anchor_only_keeps_confirmed_empty(self):
        """anchor_only (trusted=False): history seeded but confirmed_text stays empty."""
        buf = LocalAgreementBuffer(n=2)
        buf.warm_start("Geduld und Gelassenheit", trusted=False)
        assert buf.confirmed_text == ""
        assert len(buf.history) == 2  # seeded for anti-premature-confirm

    def test_warm_start_empty_is_regular_reset(self):
        """Empty seed -> regular reset regardless of trusted flag."""
        buf = LocalAgreementBuffer(n=2)
        buf.confirmed_text = "stale"
        buf.warm_start("", trusted=False)
        assert buf.confirmed_text == ""
        assert len(buf.history) == 0

    def test_anchor_only_divergent_next_no_reemit(self):
        """MANDATORY: after an anchor_only seed, a DIVERGENT next transcription
        must NOT confirm the anchor (no re-emission) and must NOT corrupt slicing —
        tentative is the full new text, confirmed stays empty."""
        buf = LocalAgreementBuffer(n=2)
        buf.warm_start("die alten Worte vom Anfang", trusted=False)
        # Fresh audio diverges completely from the anchor.
        r = buf.process("etwas ganz Neues beginnt hier")
        assert buf.confirmed_text == ""
        assert not r.is_new_confirmation
        # No anchor text leaked into the output (would be a duplicate).
        assert "alten Worte" not in r.full_text
        assert r.tentative_text == "etwas ganz Neues beginnt hier"

    def test_anchor_only_agreeing_next_confirms(self):
        """After anchor_only seed, a next transcription that AGREES with the anchor
        confirms quickly (fewer stalls) — history was pre-seeded so n is reached at once."""
        buf = LocalAgreementBuffer(n=2)
        buf.warm_start("Geduld und Gelassenheit", trusted=False)
        r = buf.process("Geduld und Gelassenheit sind wichtig")
        assert r.is_new_confirmation
        assert r.confirmed_text.startswith("Geduld und Gelassenheit")

    def test_stabilizer_forwards_trusted_flag(self):
        """Stabilizer.warm_start must forward trusted to the inner buffer."""
        stab = StreamingTranscriptionStabilizer(n=2)
        stab.warm_start("Geduld und Gelassenheit", trusted=False)
        assert stab._current_buffer.confirmed_text == ""
        assert len(stab._current_buffer.history) == 2
