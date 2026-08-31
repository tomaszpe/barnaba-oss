"""Contract test (Phase 2 part 1, 28.06.2026): delta-to-emit != cumulative-stable-prefix.

The pacing bug: on a stall the gateway received confirmed_text="" (the per-step DELTA) and
treated stablePrefix as empty, even though LocalAgreement still holds a confirmed prefix.
This locks the invariant that whisper now exports the cumulative stable prefix SEPARATELY:

  at has_new_transcription=False -> confirmed_text == "" BUT stable_text MAY be non-empty.

If this contract breaks (e.g. someone wires confirmed_text back to the cumulative text, or
drops stable_text), the gateway loses the stable prefix again and pauses return.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # run from repo root or whisper/

from local_agreement import StreamingTranscriptionStabilizer
from whisper_service import StreamChunkResponse


def test_stabilizer_holds_stable_prefix_when_no_new_confirmation():
    # n=2: a word is confirmed once it agrees across 2 consecutive transcriptions.
    s = StreamingTranscriptionStabilizer(n=2, similarity_threshold=0.75)
    s.process("der herr spricht")          # 1st pass: not yet confirmed
    stable2, _, _ = s.process("der herr spricht")  # 2nd pass: agreement -> confirm
    assert stable2.strip() != "", "prefix should be confirmed after 2 agreeing passes"

    # Re-feed the SAME text: nothing NEW to confirm -> is_new False, but stable persists.
    stable3, _, is_new3 = s.process("der herr spricht")
    assert is_new3 is False, "no new confirmation expected on identical re-feed"
    assert stable3.strip() != "", "CONTRACT: stable prefix must persist when is_new=False"


def test_response_model_delta_and_stable_are_independent():
    # The exact shape the gateway relies on: empty delta + non-empty stable coexist.
    r = StreamChunkResponse(
        session_id="t",
        partial_text="der herr spricht zu",
        confirmed_text="",                 # DELTA: nothing new this step (stall)
        is_speech=True,
        has_new_transcription=False,
        stable_text="der herr spricht",     # cumulative LA stable prefix
        la_confirmed_word_count=3,
        la_confirmed_char_count=len("der herr spricht"),
    )
    assert r.confirmed_text == "" and r.has_new_transcription is False
    assert r.stable_text == "der herr spricht" and r.la_confirmed_word_count == 3


def test_response_model_defaults_are_backward_compatible():
    # Old callers that don't set the new fields must still construct (defaults empty/0).
    r = StreamChunkResponse(
        session_id="t", partial_text="", confirmed_text="x",
        is_speech=True, has_new_transcription=True,
    )
    assert r.stable_text == "" and r.la_confirmed_word_count == 0 and r.la_confirmed_char_count == 0
