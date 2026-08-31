"""Tests for the raw token timestamp probe.

Every counter here has its own assertion: removing a measurement from
`summarize_token_timestamps` must turn a specific test red rather than slip past.
"""
import json
import sys
import threading
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from chunk_diagnostics import summarize_chunk_timestamps  # noqa: E402
from token_timestamp_probe import (  # noqa: E402
    DECODE_ASR_CONVENTIONS,
    DECODE_ASR_ROUNDING_DECIMALS,
    LAYER_VERDICTS,
    MAX_MEASUREMENTS,
    SUMMABLE_FIELDS,
    SUPPORTED_DECODE_ASR_VERSIONS,
    WordGrouping,
    active_probe,
    build_probe_pipeline_class,
    classify_zero_span_layer,
    extract_token_timestamps,
    make_probe_pipeline_class,
    measure_forward_output,
    probe_scope,
    reproduce_word_boundaries,
    reproduction_matches_audit,
    sequence_fingerprint,
    summarize_token_timestamps,
)

# -- tokenizer facade stub ------------------------------------------------------
# Stub convention: `SPECIAL_IDS` are special tokens, `>= TIMESTAMP_BEGIN` are timestamp
# tokens, and a token divisible by 10 STARTS a word (the rest attach to the previous one).
# This mirrors the only property of `_combine_tokens_into_words` that matters for boundaries:
# a word takes its start from its FIRST token and its end from its LAST.
SPECIAL_IDS = {50258, 50259, 50363}
TIMESTAMP_BEGIN = 50364
LANGUAGE_TOKEN = 50259


def group_by_leading_tokens(tokens, language=None):
    groups = []
    for position, token in enumerate(tokens):
        if token % 10 == 0 or not groups:
            groups.append([position])
        else:
            groups[-1].append(position)
    return groups


_DEFAULT = object()   # sentinel: `version=None` MUST reach the code as None, not as the default


def fake_grouping(strip=0, groups=group_by_leading_tokens, version=_DEFAULT):
    version = SUPPORTED_DECODE_ASR_VERSIONS[0] if version is _DEFAULT else version
    return WordGrouping(
        strip_prompt=lambda ids: ids[strip:],
        is_special=lambda token: token in SPECIAL_IDS,
        detect_language=lambda token: "german" if token == LANGUAGE_TOKEN else None,
        combine_tokens_into_words=groups,
        timestamp_begin=TIMESTAMP_BEGIN,
        time_precision=0.02,
        library_version=version,
    )


def audit_of(spans):
    """A chunk audit computed with THE SAME function as in production - hence a comparable digest."""
    return summarize_chunk_timestamps([{"text": "x", "timestamp": span} for span in spans])

# Words from a real leak - the same ones that guard the fix in `test_chunk_diagnostics`.
LEAKED = ("Gelassenheit", "Wenn", "Minuten", "des")


class FakeTensor:
    """Tensor stub: only `tolist()` matters, because that is all the probe uses."""

    def __init__(self, values):
        self._values = list(values)

    def tolist(self):
        return list(self._values)


class ExplodingTensor:
    def tolist(self):
        raise RuntimeError("Gelassenheit")


class ExplodingOutput(dict):
    def get(self, *args, **kwargs):
        raise RuntimeError("Gelassenheit")


class FakeTokens:
    """Id tensor: indexing gives a row, `.shape` gives the shape - as in torch."""

    def __init__(self, rows):
        self._rows = [list(row) for row in rows]
        self.shape = (len(self._rows), len(self._rows[0]) if self._rows else 0)

    def __getitem__(self, index):
        return FakeTensor(self._rows[index])


def forward_output(values, stride=None, batch=1, token_ids=None):
    """`_forward` output in the 4.47.1 shape: a list of tensors (the `segments` branch)."""
    out = {
        "tokens": FakeTokens([token_ids]) if token_ids else object(),
        "token_timestamps": [FakeTensor(values)] * batch,
        "is_last": True,
    }
    if stride is not None:
        out["stride"] = stride
    return out


class FakeBasePipeline:
    """A base class in place of `AutomaticSpeechRecognitionPipeline` - no GPU and no model."""

    def __init__(self, output):
        self.output = output
        self.forward_calls = 0

    def _forward(self, model_inputs, *args, **kwargs):
        self.forward_calls += 1
        self.last_args = (args, kwargs)
        return self.output


ProbePipeline = make_probe_pipeline_class(
    FakeBasePipeline, grouping_builder=lambda pipe: getattr(pipe, "grouping", None))


def run_forward(values, decode_id=1, enabled=True, output=None, **scope_kwargs):
    pipe = ProbePipeline(forward_output(values) if output is None else output)
    with probe_scope(decode_id, enabled=enabled, **scope_kwargs) as probe:
        returned = pipe._forward({"input_features": object()})
    return pipe, probe, returned


# -- sequence counters: one assertion per measurement ---------------------------

def test_count_and_unique_count():
    s = summarize_token_timestamps([0.0, 0.2, 0.2, 0.4])
    assert s["count"] == 4
    assert s["numeric_count"] == 4
    assert s["unique_count"] == 3


def test_adjacent_equal_raw_is_counted():
    """Equal adjacent timestamps = a zero-length word range ARISING IN `generate()`."""
    s = summarize_token_timestamps([1.0, 1.0, 1.2, 1.2, 1.2])
    assert s["adjacent_equal_raw"] == 3
    assert s["adjacent_pairs"] == 4


def test_rounding_collision_is_counted_separately_from_raw_equality():
    """Raw values DIFFER, made equal only by `round(..., 2)` - that points at `_decode_asr`."""
    s = summarize_token_timestamps([2.1841, 2.1846, 2.40])
    assert s["adjacent_equal_raw"] == 0
    assert s["adjacent_equal_rounded_only"] == 1
    assert s["unique_count"] == 3 and s["unique_rounded_count"] == 2


def test_raw_equality_is_not_double_counted_as_rounding():
    s = summarize_token_timestamps([1.0, 1.0])
    assert (s["adjacent_equal_raw"], s["adjacent_equal_rounded_only"]) == (1, 0)


def test_rounding_decimals_match_decode_asr():
    """`_decode_asr` in 4.47.1 rounds to 2 decimals. A different constant invalidates the collision counter."""
    assert DECODE_ASR_ROUNDING_DECIMALS == 2
    assert summarize_token_timestamps([0.0])["rounding_decimals"] == 2
    # 0.004 disappears under rounding, 0.006 does not - the boundary is where production puts it.
    assert summarize_token_timestamps([1.000, 1.004])["adjacent_equal_rounded_only"] == 1
    assert summarize_token_timestamps([1.000, 1.006])["adjacent_equal_rounded_only"] == 0


def test_negative_step_is_counted_and_breaks_monotonicity():
    s = summarize_token_timestamps([1.0, 0.5, 0.9])
    assert s["adjacent_negative"] == 1
    assert s["monotonic_non_decreasing"] is False
    assert summarize_token_timestamps([0.0, 1.0])["monotonic_non_decreasing"] is True


def test_non_finite_and_negative_values_are_counted():
    s = summarize_token_timestamps([float("nan"), float("inf"), -1.0, 0.5])
    assert s["non_finite"] == 2
    assert s["negative_value"] == 1
    assert s["numeric_count"] == 2  # non-finite values do NOT enter the step analysis


def test_unmeasurable_values_do_not_glue_non_neighbours_together():
    """A NaN in the middle must not turn two NON-neighbours into a pair of equal timestamps."""
    s = summarize_token_timestamps([1.0, float("nan"), 1.0])
    assert s["adjacent_equal_raw"] == 0
    assert s["adjacent_pairs"] == 0
    assert s["adjacent_unmeasurable"] == 2
    assert s["adjacent_pairs_total"] == 2
    assert s["run_length_max"] == 1          # two separate runs of one, not one run of two


def test_unmeasurable_pairs_are_counted_when_nothing_is_measurable():
    s = summarize_token_timestamps(["a", "b", "c"])
    assert s["adjacent_pairs_total"] == 2
    assert s["adjacent_unmeasurable"] == 2
    assert s["adjacent_pairs"] == 0


def test_run_lengths_describe_series_of_identical_values():
    s = summarize_token_timestamps([0.0, 0.2, 0.2, 0.2, 0.4, 0.6, 0.6])
    assert s["run_length_max"] == 3
    assert s["run_length_histogram"] == {"3": 1, "2": 1}


def test_rounded_run_lengths_see_what_decode_asr_sees():
    """Every value differs raw; after rounding - a run of three identical ones."""
    s = summarize_token_timestamps([1.001, 1.002, 1.003, 1.50])
    assert s["run_length_max"] == 1
    assert s["rounded_run_length_max"] == 3
    assert s["rounded_run_length_histogram"] == {"3": 1}


def test_min_max_and_min_positive_step():
    s = summarize_token_timestamps([0.0, 0.02, 0.02, 0.50])
    assert s["min_value"] == 0.0
    assert s["max_value"] == 0.5
    assert s["min_positive_step"] == pytest.approx(0.02)
    assert summarize_token_timestamps([1.0, 1.0])["min_positive_step"] is None


def test_empty_sequence_keeps_a_stable_shape():
    """The result shape must not depend on the data - otherwise missing data impersonates zero defects."""
    empty = summarize_token_timestamps([])
    full = summarize_token_timestamps([0.0, 1.0])
    assert set(empty) == set(full)
    assert empty["count"] == 0 and empty["adjacent_pairs"] == 0
    assert empty["monotonic_non_decreasing"] is None
    assert empty["min_value"] is None


# ── fingerprint ───────────────────────────────────────────────────────────────────────────────────

def test_fingerprint_separates_sequences_with_identical_counters():
    """Two different sequences can share counters - a counter alone would say "no change"."""
    a = summarize_token_timestamps([0.0, 0.5, 1.0])
    b = summarize_token_timestamps([7.0, 7.5, 8.0])
    counters = ("count", "unique_count", "adjacent_equal_raw", "adjacent_negative")
    assert all(a[key] == b[key] for key in counters)
    assert a["fingerprint"] != b["fingerprint"]


def test_fingerprint_is_order_sensitive():
    assert (summarize_token_timestamps([0.0, 1.0])["fingerprint"]
            != summarize_token_timestamps([1.0, 0.0])["fingerprint"])


def test_fingerprint_is_incomplete_when_a_value_cannot_be_encoded():
    """An absence of difference caused by narrowed encoding is false evidence - hence the flag."""
    s = summarize_token_timestamps([0.0, "Gelassenheit", 1.0])
    assert s["fingerprint_complete"] is False
    assert s["non_numeric"] == 1
    assert summarize_token_timestamps([0.0, 1.0])["fingerprint_complete"] is True


def test_bool_is_not_a_timestamp():
    """`True` where a time belongs is a data defect, not 1.0."""
    s = summarize_token_timestamps([True, 0.5])
    assert s["non_numeric"] == 1 and s["numeric_count"] == 1


def test_sequence_fingerprint_encodes_exact_values():
    digest_a, complete_a = sequence_fingerprint([0.1])
    digest_b, complete_b = sequence_fingerprint([0.1000000000000001])
    assert complete_a and complete_b
    assert digest_a != digest_b


# ── no text at all ────────────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("word", LEAKED)
def test_no_source_text_reaches_the_measurement(word):
    payload = json.dumps(summarize_token_timestamps([0.0, word, 1.0]), ensure_ascii=False)
    assert word not in payload


def test_no_source_text_reaches_the_probe_result():
    _, probe, _ = run_forward([0.0, "Gelassenheit", 1.0])
    payload = json.dumps(probe.result(), ensure_ascii=False, default=str)
    assert "Gelassenheit" not in payload


class ForbiddenTokens:
    """Token ids are content. Any access to their VALUES blows up the test."""

    def __init__(self, shape=None):
        if shape is not None:
            self.shape = shape

    def __getitem__(self, item):
        raise AssertionError("the probe reached for token values")

    def tolist(self):
        raise AssertionError("the probe reached for token values")

    def __iter__(self):
        raise AssertionError("the probe reached for token values")


def test_probe_never_reads_token_values():
    out = {"tokens": ForbiddenTokens(), "token_timestamps": [FakeTensor([0.0, 0.5])]}
    summary = measure_forward_output(out)
    assert summary["count"] == 2
    assert summary["sequence_length"] is None          # no `.shape` = not measured
    assert summary["length_matches_timestamps"] is None


def test_sequence_length_comes_from_shape_only():
    """Different lengths of `tokens` and `token_timestamps` = `_decode_asr` pairs two different axes."""
    matching = measure_forward_output(
        {"tokens": ForbiddenTokens(shape=(1, 2)), "token_timestamps": [FakeTensor([0.0, 0.5])]})
    assert matching["sequence_shape"] == [1, 2]
    assert matching["sequence_length"] == 2
    assert matching["length_matches_timestamps"] is True

    mismatched = measure_forward_output(
        {"tokens": ForbiddenTokens(shape=(1, 7)), "token_timestamps": [FakeTensor([0.0, 0.5])]})
    assert mismatched["sequence_length"] == 7
    assert mismatched["length_matches_timestamps"] is False


def test_length_comparison_is_none_when_the_sequence_was_not_read():
    unreadable = measure_forward_output(
        {"tokens": ForbiddenTokens(shape=(1, 3)), "token_timestamps": [ExplodingTensor()]})
    assert unreadable["sequence_length"] == 3
    assert unreadable["length_matches_timestamps"] is None


# -- reading the `_forward` output ----------------------------------------------

def test_reads_batch_position_zero_because_decode_asr_reads_it():
    out = {"token_timestamps": [FakeTensor([0.0, 0.5]), FakeTensor([9.0, 9.5, 9.9])]}
    values, meta = extract_token_timestamps(out)
    assert values == [0.0, 0.5]
    assert meta["batch_items"] == 2
    assert meta["read_status"] == "ok"


def test_container_and_element_types_are_recorded():
    """Which 4.47.1 branch returned the data: a list of tensors (`segments`) or a 2D tensor.

    A type name, not a value. Without it there is no way to check that the measurement concerns
    the same branch `_decode_asr` reads later - and that is the assumption of this whole probe.
    """
    segments_branch = extract_token_timestamps({"token_timestamps": [FakeTensor([0.0, 0.5])]})[1]
    assert segments_branch["container_type"] == "list"
    assert segments_branch["element_type"] == "FakeTensor"

    tensor_branch = extract_token_timestamps({"token_timestamps": FakeTensor([FakeTensor([0.0])])})[1]
    assert tensor_branch["container_type"] == "FakeTensor"


def test_read_status_is_explicit_for_every_failure_mode():
    assert extract_token_timestamps({})[1]["read_status"] == "missing"
    assert extract_token_timestamps({"token_timestamps": []})[1]["read_status"] == "empty"
    assert extract_token_timestamps(
        {"token_timestamps": [ExplodingTensor()]})[1]["read_status"] == "conversion_failed"
    assert extract_token_timestamps(
        {"token_timestamps": [FakeTensor([])]})[1]["read_status"] == "ok"


def test_stride_marks_the_zero_offset_assumption_as_invalid():
    """With a stride `_decode_asr` adds `time_offset` - our rounding is then computed from a different base."""
    without = measure_forward_output(forward_output([0.0, 0.5]))
    with_stride = measure_forward_output(forward_output([0.0, 0.5], stride=(30.0, 5.0, 5.0)))
    assert without["stride_present"] is False and without["zero_time_offset_assumed"] is True
    assert with_stride["stride_present"] is True and with_stride["zero_time_offset_assumed"] is False


# ── the pipeline subclass ─────────────────────────────────────────────────────────────────────────

def test_probe_does_not_run_a_second_inference():
    pipe, probe, _ = run_forward([0.0, 0.5, 1.0])
    assert pipe.forward_calls == 1
    assert probe.result()["forward_calls"] == 1


def test_forward_output_is_returned_unchanged():
    output = forward_output([0.0, 0.5])
    pipe, _, returned = run_forward(None, output=output)
    assert returned is output


def test_arguments_are_passed_through_untouched():
    pipe = ProbePipeline(forward_output([0.0, 0.5]))
    with probe_scope(1):
        pipe._forward({"input_features": object()}, "word", num_beams=3)
    assert pipe.last_args == (("word",), {"num_beams": 3})


def overridden_names(cls):
    """Names defined IN THE SUBCLASS. No dunders and no `abc` machinery from the base class."""
    return {name for name in vars(cls) if not name.startswith("__")} - {"_abc_impl"}


def test_subclass_overrides_only_forward():
    assert overridden_names(ProbePipeline) == {"_forward"}


def test_disabled_scope_records_nothing():
    """Flag OFF: no probe, no measurement - even when the subclass sits in the pipeline."""
    pipe, probe, _ = run_forward([0.0, 0.5], enabled=False)
    assert probe is None
    assert pipe.forward_calls == 1
    assert active_probe() is None


def test_measurement_outside_any_scope_is_a_no_op():
    pipe = ProbePipeline(forward_output([0.0, 0.5]))
    pipe._forward({"input_features": object()})   # without `probe_scope`
    assert active_probe() is None


def test_probe_exception_is_fail_open():
    """A diagnostics exception must not interrupt the decode nor leak through its message."""
    exploding = ExplodingOutput()
    pipe, probe, returned = run_forward(None, output=exploding)
    result = probe.result()
    assert returned is exploding
    assert result["probe_status"] == "failed"
    assert result["probe_failures"] == ["RuntimeError"]
    assert "Gelassenheit" not in json.dumps(result, default=str)


def test_probe_status_distinguishes_no_measurement_from_zeros():
    """A missing measurement is a different state from "measured, zero defects" - the same zeros would lie."""
    with probe_scope(7) as probe:
        pass
    result = probe.result()
    assert result["probe_status"] == "no_measurement"
    assert result["forward_calls"] == 0
    assert all(result["totals"][field] is None for field in SUMMABLE_FIELDS)


def test_totals_sum_across_forward_calls():
    pipe = ProbePipeline(forward_output([1.0, 1.0, 2.0]))
    with probe_scope(3) as probe:
        pipe._forward({})
        pipe._forward({})
    totals = probe.result()["totals"]
    assert totals["sequences"] == 2
    assert totals["adjacent_equal_raw"] == 2
    assert totals["all_sequences_read"] is True
    assert totals["all_fingerprints_complete"] is True


def test_measurements_are_capped_but_call_count_is_not():
    pipe = ProbePipeline(forward_output([0.0, 0.5]))
    with probe_scope(4) as probe:
        for _ in range(MAX_MEASUREMENTS + 3):
            pipe._forward({})
    result = probe.result()
    assert result["forward_calls"] == MAX_MEASUREMENTS + 3
    assert result["measurements_recorded"] == MAX_MEASUREMENTS


def test_environment_carries_runtime_versions():
    env = {"transformers_version": "4.47.1", "model_revision": "3441523"}
    _, probe, _ = run_forward([0.0, 0.5], environment=env)
    assert probe.result()["environment"] == env


def test_decode_id_stays_with_its_own_result():
    _, probe, _ = run_forward([0.0, 0.5], decode_id=42)
    assert probe.result()["decode_id"] == 42


# -- concurrency: four executor threads, zero shared state ----------------------

def test_concurrent_decodes_do_not_share_state():
    """A global `last_result` would mix decodes here - `contextvars` keeps the threads apart."""
    barrier = threading.Barrier(4)
    results = {}
    errors = []

    def decode(decode_id):
        values = [float(decode_id)] * (decode_id + 1)
        pipe = ProbePipeline(forward_output(values))
        try:
            with probe_scope(decode_id) as probe:
                barrier.wait(timeout=5)          # all threads inside an open scope at once
                pipe._forward({})
                barrier.wait(timeout=5)          # nobody closes a scope before the others measure
                results[decode_id] = probe.result()
        except Exception as exc:                 # pragma: no cover
            errors.append(exc)

    threads = [threading.Thread(target=decode, args=(i,)) for i in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=10)

    assert not errors
    assert set(results) == {0, 1, 2, 3}
    for decode_id, result in results.items():
        assert result["decode_id"] == decode_id
        assert result["forward_calls"] == 1
        assert result["measurements"][0]["count"] == decode_id + 1
    fingerprints = {r["measurements"][0]["fingerprint"] for r in results.values()}
    assert len(fingerprints) == 4


def test_scope_is_restored_after_nested_use():
    with probe_scope(1) as outer:
        with probe_scope(2) as inner:
            assert active_probe() is inner
        assert active_probe() is outer
    assert active_probe() is None


# -- layer verdict: two measurement points joined by `decode_id` ----------------

def totals_of(values, token_ids=None, grouping=None):
    """The probe result for one `_forward`. Without `token_ids` the boundaries cannot be reproduced."""
    pipe = ProbePipeline(forward_output(values, token_ids=token_ids))
    if grouping is not None:
        pipe.grouping = grouping
    with probe_scope(1) as probe:
        pipe._forward({})
    return probe.result()["totals"]


def chunks_with_zero_length(count):
    return {"zero_length": count}


# -- CORRELATIONAL family: without reproduced boundaries the verdict carries a suffix --

def test_without_reproduced_boundaries_the_verdict_is_only_a_candidate():
    """A bare counter in a decode proves CO-OCCURRENCE, not causation - and is named accordingly."""
    verdict = classify_zero_span_layer(totals_of([1.0, 1.0, 2.0]), chunks_with_zero_length(1))
    assert verdict["layer_verdict"] == "generation_candidate"
    assert verdict["attribution_basis"] == "sequence_candidate"
    assert verdict["reproduction_matches"] is None
    assert verdict["raw_equal_adjacent"] == 1


def test_rounding_candidate_when_boundaries_are_not_reproduced():
    verdict = classify_zero_span_layer(totals_of([2.1841, 2.1846, 2.40]),
                                       chunks_with_zero_length(1))
    assert verdict["layer_verdict"] == "rounding_candidate"
    assert (verdict["raw_equal_adjacent"], verdict["rounding_only_adjacent"]) == (0, 1)


def test_both_layers_are_reported_separately_not_in_one_bucket():
    verdict = classify_zero_span_layer(totals_of([1.0, 1.0, 2.1841, 2.1846]),
                                       chunks_with_zero_length(2))
    assert verdict["layer_verdict"] == "generation_and_rounding_candidate"
    assert (verdict["raw_equal_adjacent"], verdict["rounding_only_adjacent"]) == (1, 1)


def test_unexplained_candidate_when_no_pair_explains_anything():
    verdict = classify_zero_span_layer(totals_of([0.0, 0.5, 1.0]), chunks_with_zero_length(1))
    assert verdict["layer_verdict"] == "unexplained_candidate"


# -- CAUSAL family: the boundary of a specific zero-length word ----------------

def causal_case(values, token_ids, spans, grouping=None):
    totals = totals_of(values, token_ids=token_ids, grouping=grouping or fake_grouping())
    return classify_zero_span_layer(totals, audit_of(spans)), totals


def test_reproduced_boundaries_upgrade_the_verdict_to_causal():
    """The reproduced-boundary digest matches the audit of real chunks => causation, not correlation."""
    verdict, totals = causal_case(
        [0.0, 0.5, 0.5, 1.2], [10, 20, 30],
        [(0.0, 0.5), (0.5, 0.5), (0.5, 1.2)])
    assert verdict["reproduction_matches"] is True
    assert verdict["attribution_basis"] == "word_boundary"
    assert verdict["layer_verdict"] == "generation"
    assert verdict["raw_equal_at_word_boundary"] == 1
    assert totals["zero_length_words"] == 1


def test_valid_token_timestamps_plus_zero_word_span_blame_post_processing():
    """The heart of it: the numbers before `_decode_asr` are fine, the zero-length word is not => the defect is there."""
    verdict, _ = causal_case(
        [2.1841, 2.1846, 2.40], [10, 20],
        [(2.18, 2.18), (2.18, 2.4)])
    assert verdict["attribution_basis"] == "word_boundary"
    assert verdict["layer_verdict"] == "rounding"
    assert verdict["rounded_equal_at_word_boundary"] == 1
    assert verdict["raw_equal_at_word_boundary"] == 0


def test_equal_pair_inside_a_word_does_not_blame_generation():
    """THE CORE CLAIM: a RAW equal pair sits inside a word, so it creates no zero-length range.

    Tokens 0-2 form one word (boundary `ts[0]` -> `ts[3]`), and the equal pair `ts[1] == ts[2]`
    lies in its interior, never touching the boundary. The SECOND word is the zero-length one,
    and solely because of rounding. The sequence counter would say
    `generation_and_rounding_candidate`; the reproduced boundary says `rounding` - and that is
    the true one.
    """
    values = [0.0, 0.5, 0.5, 1.0001, 1.0002]
    verdict, totals = causal_case(values, [10, 11, 12, 20], [(0.0, 1.0), (1.0, 1.0)])

    assert totals["adjacent_equal_raw"] == 1               # the equal pair in the sequence IS there
    assert totals["adjacent_equal_rounded_only"] == 1
    sequence_only = classify_zero_span_layer(
        dict(totals, all_boundaries_reproduced=False), audit_of([(0.0, 1.0), (1.0, 1.0)]))
    assert sequence_only["layer_verdict"] == "generation_and_rounding_candidate"

    assert verdict["reproduction_matches"] is True
    assert verdict["layer_verdict"] == "rounding"
    assert verdict["raw_equal_at_word_boundary"] == 0
    assert verdict["rounded_equal_at_word_boundary"] == 1


def test_multi_token_word_takes_first_start_and_last_end():
    """A word of three tokens: the boundary is `ts[first]` and `ts[last + 1]`, not the neighbours."""
    boundaries = reproduce_word_boundaries(
        [10, 11, 12, 20], [0.0, 0.3, 0.6, 0.9, 0.9], fake_grouping())
    assert boundaries["word_count"] == 2
    assert boundaries["boundary_status"] == "ok"
    # word 1: 0.0 -> 0.9 (across three tokens), word 2: 0.9 -> 0.9 (zero-length, equal raw)
    assert boundaries["zero_length_words"] == 1
    assert boundaries["raw_equal_at_word_boundary"] == 1
    assert boundaries["reproduced_chunk_fingerprint"] == audit_of(
        [(0.0, 0.9), (0.9, 0.9)])["timestamp_fingerprint"]


def test_special_and_timestamp_tokens_are_masked_out_like_in_decode_asr():
    """Special and timestamp tokens create no words, but they SHIFT the timestamp indices."""
    token_ids = [50258, LANGUAGE_TOKEN, 50364, 10, 20, 50400]
    timestamps = [0.0, 0.0, 0.0, 1.0, 1.0, 2.0, 2.0]
    boundaries = reproduce_word_boundaries(token_ids, timestamps, fake_grouping())
    assert boundaries["word_count"] == 2
    # word "10" takes ts[3]=1.0 and ts[4]=1.0 -> zero-length, equal raw
    assert boundaries["zero_length_words"] == 1
    assert boundaries["raw_equal_at_word_boundary"] == 1


def test_missing_last_end_is_counted_not_silently_dropped():
    """The `end_time = None` branch from the source ("should never happen") has its own counter."""
    boundaries = reproduce_word_boundaries([10, 20], [0.0, 0.5], fake_grouping())
    assert boundaries["word_count"] == 2
    assert boundaries["word_end_missing"] == 1        # the last word has no `ts[i+1]`
    assert boundaries["zero_length_words"] == 0


def test_unmeasurable_word_boundary_is_counted_not_dropped():
    """A NaN on the boundary is the ABSENCE of a boundary, not a range - without the counter the word would fall out of every bucket."""
    boundaries = reproduce_word_boundaries(
        [10, 20], [0.0, float("nan"), 1.0], fake_grouping())
    assert boundaries["word_count"] == 2
    assert boundaries["word_boundary_unmeasurable"] == 2
    assert boundaries["zero_length_words"] == 0


def test_prompt_tokens_are_stripped_and_counted():
    boundaries = reproduce_word_boundaries(
        [99, 98, 10, 20], [0.0, 0.5, 1.0, 1.5, 2.0], fake_grouping(strip=2))
    assert boundaries["prompt_tokens_stripped"] == 2
    assert boundaries["word_count"] == 2


@pytest.mark.parametrize("version", ["4.57.4", "4.48.0", "4.57", "4.57.5+cu121", None])
def test_version_outside_the_registry_blocks_the_reproduction(version):
    """Fail-closed: EVERY version outside the registry refuses to reproduce, including a
    neighbouring patch release.

    Reproducing under the wrong convention does not "crash", it lies with consistent numbers - so
    the guard has to be explicit and name the cause, instead of leaving it as a fingerprint
    mismatch. Ranges (`>=4.57`) are forbidden, hence `4.57.4` and `4.57.5+cu121` on the list.
    """
    boundaries = reproduce_word_boundaries(
        [10, 20], [0.0, 0.5, 1.0], fake_grouping(version=version))
    assert boundaries["boundary_status"] == "unverified_decode_asr_version"
    assert boundaries["word_count"] is None
    assert boundaries["boundary_convention"] is None


def test_registry_holds_exactly_the_verified_versions():
    assert set(SUPPORTED_DECODE_ASR_VERSIONS) == {"4.47.1", "4.57.5"}
    for version, convention in DECODE_ASR_CONVENTIONS.items():
        assert convention.version == version, "the registry key must match the convention version"


# -- 4.57.5 convention: `(ts[i-1], ts[i])` plus the CONSTANT 0.0 for the first token --

def grouping_4575(**kwargs):
    return fake_grouping(version="4.57.5", **kwargs)


def test_4575_takes_start_from_the_previous_timestamp():
    """A word from token `i` takes `ts[i-1]` -> `ts[i]`, not `ts[i]` -> `ts[i+1]`."""
    ts = [0.0, 0.4, 0.9, 1.5]
    b = reproduce_word_boundaries([10, 20, 30], ts, grouping_4575())
    assert b["boundary_convention"] == "4.57.5"
    assert b["word_count"] == 3
    # word 0: (CONSTANT 0.0, ts[0]=0.0) -> zero-length; word 1: (ts[0]=0.0, ts[1]=0.4);
    # word 2: (ts[1]=0.4, ts[2]=0.9)
    assert b["reproduced_chunk_fingerprint"] == audit_of(
        [(0.0, 0.0), (0.0, 0.4), (0.4, 0.9)])["timestamp_fingerprint"]


def test_4575_first_token_start_is_a_constant_not_a_lookup():
    """`i == 0` takes its start from the CONSTANT 0.0 - never from `ts[-1]`, i.e. the end of the array."""
    ts = [0.5, 0.9]
    b = reproduce_word_boundaries([10, 20], ts, grouping_4575())
    assert b["first_token_constant_start"] == 1
    # If `ts[-1]` were used as `ts[i-1]`, the first word would be (0.9, 0.5) - reversed.
    assert b["reproduced_chunk_fingerprint"] == audit_of(
        [(0.0, 0.5), (0.5, 0.9)])["timestamp_fingerprint"]
    assert b["zero_length_words"] == 0


def test_4575_zero_length_from_the_constant_start_is_still_attributed():
    """When `ts[0]` is exactly 0.0, the first word has a zero-length range because of the CONSTANT."""
    b = reproduce_word_boundaries([10, 20], [0.0, 0.6], grouping_4575())
    assert b["zero_length_words"] == 1
    assert b["raw_equal_at_word_boundary"] == 1
    assert b["first_token_constant_start"] == 1


def test_4575_has_no_missing_end_branch():
    """4.47.1 has an explicit `end = None`; 4.57.5 does not - a missing end is INCOMPATIBILITY, not "end unknown"."""
    assert DECODE_ASR_CONVENTIONS["4.47.1"].library_returns_none_end is True
    assert DECODE_ASR_CONVENTIONS["4.57.5"].library_returns_none_end is False
    # the last token has index 1 and the array has 2 positions -> `ts[1]` exists, no end is missing
    assert reproduce_word_boundaries([10, 20], [0.0, 0.5], grouping_4575())["word_end_missing"] == 0
    # in 4.47.1 the same sequence has no `ts[last+1]` for the final word
    assert reproduce_word_boundaries([10, 20], [0.0, 0.5], fake_grouping())["word_end_missing"] == 1


def test_4575_multi_token_word_spans_from_before_first_to_last():
    """A word from tokens 1..3 has the range `(ts[0], ts[3])`."""
    b = reproduce_word_boundaries(
        [10, 20, 21, 22], [0.2, 0.4, 0.6, 0.8, 1.0], grouping_4575())
    assert b["word_count"] == 2
    assert b["reproduced_chunk_fingerprint"] == audit_of(
        [(0.0, 0.2), (0.2, 0.8)])["timestamp_fingerprint"]


def test_4575_with_prompt_uses_indices_after_strip():
    """After `_strip_prompt` the indices are counted afresh - including the constant for `i == 0`."""
    b = reproduce_word_boundaries(
        [99, 98, 10, 20], [0.1, 0.2, 0.3, 0.4], grouping_4575(strip=2))
    assert b["prompt_tokens_stripped"] == 2
    assert b["first_token_constant_start"] == 1
    assert b["reproduced_chunk_fingerprint"] == audit_of(
        [(0.0, 0.1), (0.1, 0.2)])["timestamp_fingerprint"]


def test_leading_zero_timestamps_are_measured():
    """Trace of the DTW prefix cut: 4.57.x has as many zeros as there are forced tokens."""
    assert summarize_token_timestamps([0.0, 0.0, 0.0, 0.0, 0.3, 0.6])["leading_zero_timestamps"] == 4
    assert summarize_token_timestamps([0.0, 0.3, 0.0])["leading_zero_timestamps"] == 1
    assert summarize_token_timestamps([0.3, 0.0])["leading_zero_timestamps"] == 0


def test_boundary_status_is_explicit_for_every_unavailable_case():
    assert reproduce_word_boundaries([10], [0.0, 0.5], None)["boundary_status"] == "no_grouping"
    assert reproduce_word_boundaries(None, [0.0], fake_grouping())["boundary_status"] == "no_tokens"
    assert reproduce_word_boundaries([10], [0.0, 0.5], fake_grouping(),
                                     stride_present=True)["boundary_status"] == "unsupported_stride"
    # The result shape is FIXED here too - zeros must not impersonate a measurement.
    unavailable = reproduce_word_boundaries([10], [0.0], None)
    assert set(unavailable) == set(reproduce_word_boundaries([10], [0.0, 0.5], fake_grouping()))
    assert unavailable["word_count"] is None


def test_reproduction_mismatch_falls_back_to_candidate():
    """The digest does not match => the reproduction describes something other than production => candidate only."""
    verdict, _ = causal_case(
        [1.0, 1.0, 2.0], [10, 20],
        [(9.0, 9.0), (9.0, 9.5)])                     # an audit built from DIFFERENT spans
    assert verdict["reproduction_matches"] is False
    assert verdict["attribution_basis"] == "sequence_candidate"
    assert verdict["layer_verdict"] == "generation_candidate"


def test_stride_blocks_the_causal_verdict():
    """With a stride `_decode_asr` adds `time_offset` - reproducing blind would be pretending."""
    pipe = ProbePipeline(forward_output([1.0, 1.0, 2.0], stride=(30.0, 5.0, 5.0),
                                        token_ids=[10, 20]))
    pipe.grouping = fake_grouping()
    with probe_scope(1) as probe:
        pipe._forward({})
    totals = probe.result()["totals"]
    assert totals["boundary_statuses"] == ["unsupported_stride"]
    assert classify_zero_span_layer(totals, audit_of([(1.0, 1.0)]))["attribution_basis"] == \
        "sequence_candidate"


def test_incomplete_fingerprint_never_proves_a_match():
    totals = totals_of([1.0, 1.0], token_ids=[10], grouping=fake_grouping())
    audit = dict(audit_of([(1.0, 1.0)]), fingerprint_complete=False)
    assert reproduction_matches_audit(totals, audit) is None


def test_multiple_forward_calls_have_nothing_to_compare():
    """The audit describes the concatenation of the calls; a partial digest has nothing to equal."""
    pipe = ProbePipeline(forward_output([1.0, 1.0], token_ids=[10]))
    pipe.grouping = fake_grouping()
    with probe_scope(1) as probe:
        pipe._forward({})
        pipe._forward({})
    totals = probe.result()["totals"]
    assert totals["reproduced_chunk_fingerprint"] is None
    assert reproduction_matches_audit(totals, audit_of([(1.0, 1.0)])) is None


def test_no_word_zero_spans_has_nothing_to_attribute():
    verdict = classify_zero_span_layer(totals_of([1.0, 1.0]), chunks_with_zero_length(0))
    assert verdict["layer_verdict"] == "no_word_zero_spans"


def test_missing_or_unreadable_probe_is_undetermined_not_clean():
    """A gap in the data has no right to look like a clean result."""
    with probe_scope(9) as probe:
        pass
    assert classify_zero_span_layer(probe.result()["totals"],
                                    chunks_with_zero_length(3))["layer_verdict"] == "undetermined"
    assert classify_zero_span_layer(None, chunks_with_zero_length(3))["layer_verdict"] == "undetermined"
    assert classify_zero_span_layer(totals_of([0.0, 0.5]), None)["layer_verdict"] == "undetermined"

    unreadable = ProbePipeline({"token_timestamps": [ExplodingTensor()]})
    with probe_scope(10) as probe:
        unreadable._forward({})
    assert classify_zero_span_layer(probe.result()["totals"],
                                    chunks_with_zero_length(3))["layer_verdict"] == "undetermined"


def hand_made_totals(audit, raw_boundary, rounded_boundary):
    """Boundary counters written by HAND - to check the classifier's accounting alone."""
    return {
        "adjacent_equal_raw": 1, "adjacent_equal_rounded_only": 1, "all_sequences_read": True,
        "all_boundaries_reproduced": True, "reproduced_fingerprint_complete": True,
        "reproduced_chunk_fingerprint": audit["timestamp_fingerprint"],
        "raw_equal_at_word_boundary": raw_boundary,
        "rounded_equal_at_word_boundary": rounded_boundary,
    }


def test_underaccounted_zero_words_force_the_unexplained_verdict():
    """The boundaries explain FEWER zero-length words than the audit sees - that has to be visible."""
    audit = audit_of([(1.0, 1.0)])
    verdict = classify_zero_span_layer(hand_made_totals(audit, 0, 0), audit)
    assert verdict["attribution_basis"] == "word_boundary"
    assert verdict["boundary_accounting_matches"] is False
    assert verdict["layer_verdict"] == "unexplained_post_processing"


def test_mixed_result_does_not_swallow_an_unexplained_word():
    """One hit on each route plus a THIRD zero-length word with no explanation.

    The previous version left `generation_and_rounding` here - a mixed result swallowed the
    unexplained case, even though the comment promised otherwise.
    """
    audit = audit_of([(1.0, 1.0), (2.0, 2.0), (3.0, 3.0)])
    verdict = classify_zero_span_layer(hand_made_totals(audit, 1, 1), audit)
    assert verdict["word_zero_length"] == 3
    assert verdict["boundary_accounting_matches"] is False
    assert verdict["layer_verdict"] == "unexplained_post_processing"


def test_overaccounting_is_not_hidden_either():
    """The boundaries explain MORE than there are zero-length words - `max(0, ...)` would hide it in a zero."""
    audit = audit_of([(1.0, 1.0)])
    verdict = classify_zero_span_layer(hand_made_totals(audit, 2, 1), audit)
    assert verdict["boundary_accounting_matches"] is False
    assert verdict["layer_verdict"] == "unexplained_post_processing"


def test_accounting_matches_on_the_causal_path():
    verdict, _ = causal_case([0.0, 0.5, 0.5, 1.2], [10, 20, 30],
                             [(0.0, 0.5), (0.5, 0.5), (0.5, 1.2)])
    assert verdict["boundary_accounting_matches"] is True
    assert classify_zero_span_layer(totals_of([1.0, 1.0]),
                                    chunks_with_zero_length(1))["boundary_accounting_matches"] is None


def test_every_declared_verdict_is_reachable():
    produced = {
        classify_zero_span_layer(None, None)["layer_verdict"],
        classify_zero_span_layer(totals_of([1.0, 1.0]), chunks_with_zero_length(0))["layer_verdict"],
        classify_zero_span_layer(totals_of([1.0, 1.0]), chunks_with_zero_length(1))["layer_verdict"],
        classify_zero_span_layer(totals_of([2.1841, 2.1846]), chunks_with_zero_length(1))["layer_verdict"],
        classify_zero_span_layer(totals_of([1.0, 1.0, 2.1841, 2.1846]),
                                 chunks_with_zero_length(2))["layer_verdict"],
        classify_zero_span_layer(totals_of([0.0, 0.5]), chunks_with_zero_length(1))["layer_verdict"],
        causal_case([0.0, 0.5, 0.5, 1.2], [10, 20, 30],
                    [(0.0, 0.5), (0.5, 0.5), (0.5, 1.2)])[0]["layer_verdict"],
        causal_case([2.1841, 2.1846, 2.40], [10, 20],
                    [(2.18, 2.18), (2.18, 2.4)])[0]["layer_verdict"],
        causal_case([2.1841, 2.1846, 3.0, 4.0, 4.0], [10, 20, 30, 40],
                    [(2.18, 2.18), (2.18, 3.0), (3.0, 4.0), (4.0, 4.0)])[0]["layer_verdict"],
        "unexplained_post_processing",   # reachable only through the guard above
    }
    assert produced == set(LAYER_VERDICTS)


# ── the real base class from the image ────────────────────────────────────────────────────────────

def test_real_pipeline_subclass_builds_and_overrides_only_forward():
    probe_cls = build_probe_pipeline_class()
    if probe_cls is None:
        pytest.skip("transformers is not available in this environment")
    from transformers.pipelines.automatic_speech_recognition import (
        AutomaticSpeechRecognitionPipeline,
    )
    assert issubclass(probe_cls, AutomaticSpeechRecognitionPipeline)
    assert overridden_names(probe_cls) == {"_forward"}
