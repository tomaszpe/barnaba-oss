"""Conservative boundary-retry policy. Similarity alone never permits replacement.

The runtime supplies real alignment and generation-quality measurements. Missing
quality or an unaccepted corpus gate leaves the original unchanged. The policy
cannot certify the corpus used to validate itself.
"""
from dataclasses import dataclass
import math
import zlib

from provenance import (
    ProvenanceError,
    align_text_to_spans,
    canonical_tokens,
    relative_timestamp_to_samples,
)
from rep_retry_budget import RetrySkipped
from rep_shadow import RepShadowSession


@dataclass(frozen=True)
class RetryRegion:
    start_sample: int
    end_sample: int
    first_word: int
    suspect_first: int
    suspect_end: int


def project_parent_spans(text, chunks, snapshot, *, sample_rate=16000):
    """Project exact raw tokens while leaving only invalid timestamps sparse.

    The retry replaces everything from its proven left boundary to snapshot end, so
    an invalid timestamp in that replaced suffix need not invalidate an otherwise
    exact candidate window. Token order is still all-or-nothing, and every retained
    prefix/candidate span is validated separately before admission.
    """
    tokens = canonical_tokens(text)
    if len(tokens) != len(chunks or []):
        raise RetrySkipped("token_projection_ambiguous")
    spans = []
    for index, (token, chunk) in enumerate(zip(tokens, chunks)):
        if not isinstance(chunk, dict):
            raise RetrySkipped("token_projection_ambiguous")
        chunk_tokens = canonical_tokens(chunk.get("text", ""))
        if chunk_tokens != [token]:
            raise RetrySkipped("token_projection_ambiguous")
        timestamp = chunk.get("timestamp") or (None, None)
        try:
            start, end = relative_timestamp_to_samples(
                timestamp[0], timestamp[1], snapshot.start_sample, sample_rate,
                input_end_sample=snapshot.end_sample,
            )
            spans.append({"text": token, "start_sample": start, "end_sample": end})
        except (ProvenanceError, IndexError, TypeError):
            spans.append(None)
    return spans


def choose_region(text, chunks, snapshot, events, committed_end_sample):
    if RepShadowSession._hard_negative_signals(text):
        raise RetrySkipped("protected_content")
    words = project_parent_spans(text, chunks, snapshot)
    eligible = [event for event in events if (
        event.get("candidate_class") == "stale_echo_new_audio"
        and event.get("source_relation") == "disjoint_source_span"
        and not event.get("fuzzy_tainted")
        and event.get("current_start_sample", -1) >= committed_end_sample
        and event.get("prior_end_sample", math.inf) < event.get("current_start_sample", -1))]
    if not eligible:
        raise RetrySkipped("no_eligible_echo")
    ranges = sorted((
        event["current_start_sample"], event["current_end_sample"],
        event.get("current_first_word"), event.get("current_end_word"),
    ) for event in eligible)
    start, end, first, last = ranges[0]
    if any(type(value) is not int for value in (first, last)):
        raise RetrySkipped("candidate_boundary_unproven")
    for other_start, other_end, other_first, other_last in ranges[1:]:
        if other_start > end:
            raise RetrySkipped("multiple_disjoint_echoes")
        if any(type(value) is not int for value in (other_first, other_last)):
            raise RetrySkipped("candidate_boundary_unproven")
        end = max(end, other_end)
        first = min(first, other_first)
        last = max(last, other_last)
    if (first < 0 or last > len(words) or last <= first
            or words[first] is None or words[last - 1] is None
            or words[first]["start_sample"] != start
            or words[last - 1]["end_sample"] != end):
        raise RetrySkipped("candidate_boundary_unproven")
    # Keep context on both sides, and change only the left input boundary. No
    # guessed seconds or clipped source spans. Require a nonempty unique suffix.
    if first < 2 or last >= len(words):
        raise RetrySkipped("insufficient_unique_context")
    left = first - 1
    if words[left] is None or any(word is None for word in words[:left]):
        raise RetrySkipped("retry_boundary_unproven")
    boundary = words[left]["start_sample"]
    if (boundary <= snapshot.start_sample or boundary < committed_end_sample
            or any(word["end_sample"] > boundary for word in words[:left])
            or any(
                current["start_sample"] < prior["start_sample"]
                or current["end_sample"] < prior["end_sample"]
                for prior, current in zip(words[:left], words[1:left + 1])
            )):
        raise RetrySkipped("retry_boundary_overlaps_committed_content")
    if snapshot.end_sample - boundary > 10 * 16000:
        raise RetrySkipped("slice_outside_measured_duration")
    return RetryRegion(boundary, snapshot.end_sample, left, first, last)


def validate_replacement(original, candidate, region, *, sample_rate=16000):
    """Require exact preservation outside the suspect, not fuzzy/LLM similarity."""
    quality = candidate.get("rep_quality")
    if not isinstance(quality, dict) or quality.get("validated_measurement") is not True:
        return False
    logprob = quality.get("avg_logprob")
    if type(logprob) not in (int, float) or not math.isfinite(logprob) or logprob < -1.0:
        return False
    text = candidate.get("text", "")
    if not isinstance(text, str) or not text.strip():
        return False
    encoded = text.encode("utf-8")
    if len(encoded) / len(zlib.compress(encoded)) > 2.4:
        return False
    aligned = align_text_to_spans(text, candidate.get("chunks", []), region.start_sample,
                                 sample_rate, input_end_sample=region.end_sample)
    if not aligned.is_exact:
        return False
    original_words = canonical_tokens(original["text"])
    expected = (original_words[region.first_word:region.suspect_first]
                + original_words[region.suspect_end:])
    # Reject added, missing or reordered unique words, changed numbers/negations,
    # punctuation changes and a retry that retains any of the suspect text.
    return canonical_tokens(text) == expected


def compose_replacement(original, candidate, region, parent_start_sample):
    offset = (region.start_sample - parent_start_sample) / 16000
    prefix = original["chunks"][:region.first_word]
    shifted = [{**chunk, "timestamp": (chunk["timestamp"][0] + offset,
                                        chunk["timestamp"][1] + offset)}
               for chunk in candidate["chunks"]]
    chunks = prefix + shifted
    return {"text": " ".join(canonical_tokens(original["text"])[:region.first_word]
                              + canonical_tokens(candidate["text"])), "chunks": chunks}
