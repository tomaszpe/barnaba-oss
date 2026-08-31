"""REP E0-E2 shadow observer and session-lifetime echo ledger.

The module never returns replacement text.  Its only output is privacy-safe
diagnostic data; failures are expected to be caught by the calling pipeline.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
import time
import unicodedata
from dataclasses import dataclass
from typing import Any, Iterable, Optional


WORD_RE = re.compile(r"[^\W_]+(?:['’][^\W_]+)*", re.UNICODE)
VALID_MODES = frozenset({"off", "shadow"})
NEGATIONS = frozenset({"nicht", "nie", "kein", "keine", "keinen", "nichts", "ohne"})
BOUNDARY_TOLERANCE_SAMPLES = 160


def normalize_tokens(text: str) -> list[str]:
    normalized = unicodedata.normalize("NFC", str(text or "")).casefold()
    return WORD_RE.findall(normalized)


def coordinate_space_id(session_id: str) -> str:
    return hashlib.sha256(session_id.encode("utf-8")).hexdigest()[:24]


@dataclass(frozen=True)
class LedgerEntry:
    fingerprint: str
    start_sample: int
    end_sample: int
    decode_id: int
    fuzzy_tainted: bool


class RepShadowSession:
    """One fail-open observer/ledger, scoped to one Whisper session."""

    def __init__(
        self,
        session_id: str,
        mode: str = "off",
        ngram_words: int = 8,
        max_fingerprints: int = 50_000,
        key: Optional[bytes] = None,
        protected_text_enabled: bool = False,
    ) -> None:
        normalized_mode = str(mode or "off").lower()
        self.mode = normalized_mode if normalized_mode in VALID_MODES else "off"
        self.session_id = session_id
        self.coordinate_space_id = coordinate_space_id(session_id)
        self.ngram_words = max(2, int(ngram_words))
        self.max_fingerprints = max(1, int(max_fingerprints))
        self._key = key or secrets.token_bytes(32)
        self.protected_text_enabled = bool(protected_text_enabled)
        self._ledger: dict[str, LedgerEntry] = {}
        self._event_seq = 0
        self.disabled_reason: Optional[str] = None
        self.candidate_count = 0
        self.fuzzy_replacement_count = 0

    @classmethod
    def from_env(cls, session_id: str) -> "RepShadowSession":
        return cls(
            session_id=session_id,
            mode=os.environ.get("ASR_REP_MODE", "off"),
            ngram_words=int(os.environ.get("ASR_REP_NGRAM_WORDS", "8")),
            max_fingerprints=int(
                os.environ.get("ASR_REP_LEDGER_MAX_FINGERPRINTS", "50000")
            ),
            protected_text_enabled=(
                os.environ.get("ASR_REP_PROTECTED_TEXT_ENABLED", "false").lower() == "true"
            ),
        )

    @property
    def enabled(self) -> bool:
        return self.mode == "shadow" and self.disabled_reason is None

    @property
    def fingerprint_count(self) -> int:
        return len(self._ledger)

    def _fingerprint(self, tokens: Iterable[str]) -> str:
        payload = "\x1f".join(tokens).encode("utf-8")
        return hmac.new(self._key, payload, hashlib.sha256).hexdigest()

    def observe_stage(
        self,
        stage: str,
        text: str,
        *,
        decode_id: Optional[int],
        input_start_sample: Optional[int] = None,
        input_end_sample: Optional[int] = None,
        spans: Optional[list[dict[str, Any]]] = None,
        lineage_status: Optional[str] = None,
        lineage_reason: Optional[str] = None,
        fuzzy_replacement_count: int = 0,
        queue_depth: Optional[int] = None,
        in_flight: Optional[int] = None,
    ) -> Optional[dict[str, Any]]:
        if self.mode != "shadow":
            return None
        started = time.perf_counter()
        tokens = normalize_tokens(text)
        ngram_fingerprints = [
            self._fingerprint(tokens[index:index + self.ngram_words])
            for index in range(max(0, len(tokens) - self.ngram_words + 1))
        ]
        self._event_seq += 1
        safe_spans = spans if isinstance(spans, list) else []
        starts = [span.get("start_sample") for span in safe_spans if isinstance(span, dict)]
        ends = [span.get("end_sample") for span in safe_spans if isinstance(span, dict)]
        starts = [value for value in starts if isinstance(value, int)]
        ends = [value for value in ends if isinstance(value, int)]
        event = {
            "schema_version": 1,
            "event": "rep_stage_observation",
            "stage": stage,
            "session_epoch": self.coordinate_space_id,
            "coordinate_space_id": self.coordinate_space_id,
            "decode_id": decode_id,
            "parent_decode_id": None,
            "event_seq": self._event_seq,
            "input_start_sample": input_start_sample,
            "input_end_sample": input_end_sample,
            "token_count": len(tokens),
            "token_hmac_sha256": self._fingerprint(tokens) if tokens else None,
            "ngram_hmac_sha256": ngram_fingerprints,
            "lineage_status": lineage_status,
            "lineage_reason": lineage_reason,
            "word_span_count": len(safe_spans),
            "span_start_sample": min(starts) if starts else None,
            "span_end_sample": max(ends) if ends else None,
            "fuzzy_replacement_count": int(fuzzy_replacement_count or 0),
            "executor_queue_depth": queue_depth,
            "in_flight": in_flight,
            "policy_applied": False,
            "emitted_text_changed": False,
        }
        if self.protected_text_enabled:
            event["protected_ngram_text"] = [
                " ".join(tokens[index:index + self.ngram_words])
                for index in range(max(0, len(tokens) - self.ngram_words + 1))
            ]
        event["observer_ms"] = round((time.perf_counter() - started) * 1000.0, 4)
        return event

    def classify_and_record(
        self,
        text: str,
        spans: list[dict[str, Any]],
        *,
        decode_id: int,
        fuzzy_tainted_ranges: Iterable[tuple[int, int]] = (),
    ) -> list[dict[str, Any]]:
        if not self.enabled:
            return []
        started = time.perf_counter()
        tokens = normalize_tokens(text)
        if len(tokens) != len(spans) or len(tokens) < self.ngram_words:
            return []

        tainted_ranges = list(fuzzy_tainted_ranges)
        self._mark_existing_taints(tainted_ranges)
        candidates: list[dict[str, Any]] = []
        for index in range(len(tokens) - self.ngram_words + 1):
            window = tokens[index:index + self.ngram_words]
            window_spans = spans[index:index + self.ngram_words]
            if not all(self._valid_span(span) for span in window_spans):
                continue
            start_sample = window_spans[0]["start_sample"]
            end_sample = window_spans[-1]["end_sample"]
            fuzzy_tainted = any(
                start_sample < taint_end and end_sample > taint_start
                for taint_start, taint_end in tainted_ranges
            )
            fingerprint = self._fingerprint(window)
            prior = self._ledger.get(fingerprint)
            if prior is not None:
                candidates.append(
                    self._candidate(
                        fingerprint, prior, start_sample, end_sample, decode_id,
                        fuzzy_tainted or prior.fuzzy_tainted, text, window, index,
                    )
                )
            if prior is None:
                if len(self._ledger) >= self.max_fingerprints:
                    self.disabled_reason = "rep_ledger_overflow"
                    result = candidates + [self.overflow_event(decode_id)]
                    self._stamp_observer_ms(result, started)
                    return result
                self._ledger[fingerprint] = LedgerEntry(
                    fingerprint=fingerprint,
                    start_sample=start_sample,
                    end_sample=end_sample,
                    decode_id=decode_id,
                    fuzzy_tainted=fuzzy_tainted,
                )
        self.candidate_count += len(candidates)
        self._stamp_observer_ms(candidates, started)
        return candidates

    def preview_candidates(self, text, spans, *, decode_id):
        """Read the committed ledger without registering speculative raw words."""
        if not self.enabled:
            return []
        tokens = normalize_tokens(text)
        if len(tokens) != len(spans):
            return []
        events = []
        for index in range(max(0, len(tokens) - self.ngram_words + 1)):
            fingerprint = self._fingerprint(tokens[index:index + self.ngram_words])
            prior = self._ledger.get(fingerprint)
            window_spans = spans[index:index + self.ngram_words]
            if prior is None or not all(self._valid_span(span) for span in window_spans):
                continue
            event = self._candidate(fingerprint, prior, window_spans[0]["start_sample"],
                window_spans[-1]["end_sample"], decode_id,
                prior.fuzzy_tainted, text, tokens[index:index + self.ngram_words], index)
            event["stage"] = "asr_decode_raw"
            events.append(event)
        return events

    @staticmethod
    def _stamp_observer_ms(events: list[dict[str, Any]], started: float) -> None:
        elapsed = round((time.perf_counter() - started) * 1000.0, 4)
        for event in events:
            event["observer_ms"] = elapsed

    @staticmethod
    def _valid_span(span: Any) -> bool:
        return (
            isinstance(span, dict)
            and isinstance(span.get("start_sample"), int)
            and isinstance(span.get("end_sample"), int)
            and span["end_sample"] > span["start_sample"]
        )

    def _mark_existing_taints(self, tainted_ranges: list[tuple[int, int]]) -> None:
        if not tainted_ranges:
            return
        for fingerprint, entry in list(self._ledger.items()):
            if entry.fuzzy_tainted:
                continue
            if any(
                entry.start_sample < end_sample and entry.end_sample > start_sample
                for start_sample, end_sample in tainted_ranges
            ):
                self._ledger[fingerprint] = LedgerEntry(
                    fingerprint=entry.fingerprint,
                    start_sample=entry.start_sample,
                    end_sample=entry.end_sample,
                    decode_id=entry.decode_id,
                    fuzzy_tainted=True,
                )

    def _candidate(
        self,
        fingerprint: str,
        prior: LedgerEntry,
        start_sample: int,
        end_sample: int,
        decode_id: int,
        fuzzy_tainted: bool,
        raw_text: str,
        protected_tokens: list[str],
        current_first_word: int,
    ) -> dict[str, Any]:
        same_span = (
            abs(start_sample - prior.start_sample) <= BOUNDARY_TOLERANCE_SAMPLES
            and abs(end_sample - prior.end_sample) <= BOUNDARY_TOLERANCE_SAMPLES
        )
        overlaps = start_sample < prior.end_sample and end_sample > prior.start_sample
        relation = "same_source_span" if same_span else (
            "overlapping_source_span" if overlaps else "disjoint_source_span"
        )
        signals = self._hard_negative_signals(raw_text)
        if fuzzy_tainted:
            candidate_class = "fuzzy_replacement_tainted"
        elif same_span:
            candidate_class = "timestamp_dedup_escape"
        elif signals:
            candidate_class = "intentional_repeat_possible"
        else:
            candidate_class = "stale_echo_new_audio"
        event = {
            "schema_version": 1,
            "event": "rep_candidate",
            "stage": "asr_timestamp_dedup",
            "session_epoch": self.coordinate_space_id,
            "coordinate_space_id": self.coordinate_space_id,
            "decode_id": decode_id,
            "prior_decode_id": prior.decode_id,
            "repeat_scope": "intra_emission" if prior.decode_id == decode_id else "cross_emission",
            "fingerprint_hmac_sha256": fingerprint,
            "candidate_class": candidate_class,
            "source_relation": relation,
            "current_start_sample": start_sample,
            "current_end_sample": end_sample,
            "current_first_word": current_first_word,
            "current_end_word": current_first_word + self.ngram_words,
            "prior_start_sample": prior.start_sample,
            "prior_end_sample": prior.end_sample,
            "echo_age_samples": max(0, end_sample - prior.end_sample),
            "fuzzy_tainted": fuzzy_tainted,
            "hard_negative_signals": signals,
            "policy_applied": False,
            "emitted_text_changed": False,
        }
        if self.protected_text_enabled:
            # Bounded DEV-only bridge for correlating independently keyed Whisper
            # and Gateway HMAC observations. Never emitted unless the explicit
            # protected-text experiment flag is enabled.
            event["protected_ngram_text"] = [" ".join(protected_tokens)]
        return event

    @staticmethod
    def _hard_negative_signals(text: str) -> list[str]:
        tokens = normalize_tokens(text)
        signals = []
        if any(token.isdigit() for token in tokens):
            signals.append("contains_number")
        if any(token in NEGATIONS for token in tokens):
            signals.append("contains_negation")
        if any(mark in str(text) for mark in ('"', "«", "»", "„", "“")):
            signals.append("quotation")
        return signals

    def overflow_event(self, decode_id: Optional[int]) -> dict[str, Any]:
        self._event_seq += 1
        return {
            "schema_version": 1,
            "event": "rep_ledger_overflow",
            "stage": "asr_timestamp_dedup",
            "session_epoch": self.coordinate_space_id,
            "coordinate_space_id": self.coordinate_space_id,
            "decode_id": decode_id,
            "event_seq": self._event_seq,
            "fingerprint_count": len(self._ledger),
            "max_fingerprints": self.max_fingerprints,
            "classification_disabled": True,
            "reason": self.disabled_reason,
            "policy_applied": False,
            "emitted_text_changed": False,
        }

    def close_event(self) -> Optional[dict[str, Any]]:
        if self.mode != "shadow":
            return None
        self._event_seq += 1
        return {
            "schema_version": 1,
            "event": "rep_session_closed",
            "stage": "session_end",
            "session_epoch": self.coordinate_space_id,
            "coordinate_space_id": self.coordinate_space_id,
            "event_seq": self._event_seq,
            "fingerprint_count": len(self._ledger),
            "candidate_count": self.candidate_count,
            "fuzzy_replacement_count": self.fuzzy_replacement_count,
            "classification_disabled": self.disabled_reason is not None,
            "reason": self.disabled_reason,
            "policy_applied": False,
            "emitted_text_changed": False,
        }
