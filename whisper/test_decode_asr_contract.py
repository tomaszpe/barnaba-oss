"""CONTRACT TESTS: our reproduction versus the REAL `_decode_asr` from the installed wheel.

WHY A SEPARATE FILE. Tests against stubs only prove that the code does what we THINK the library
does. If our idea of `_decode_asr` were wrong, they would all pass - and that very mistake would
produce numbers that LOOK like evidence. Here the ACTUAL library code is run over synthetic
tokens and timestamps (no model, no weights, no GPU) and our boundaries are required to be
IDENTICAL to it down to the fingerprint byte.

The test picks the convention matching the INSTALLED version: 4.57.5 locally, 4.47.1 in the DEV
image - so the same file validates whichever version actually runs.

STRICT MODE. In an ordinary suite a missing wheel / unsupported version / missing tokenizer give
a SKIP, so the suite ends with exit code 0 - that is convenience, not proof. The candidate image
gate MUST run this file with `ASR_CONTRACT_STRICT=1`, where each of those cases is an ERROR, and
require the result `13 passed, 0 skipped`.

THE TOKENIZER REVISION IS PINNED to `MODEL_CONFIG["model_revision"]` (a full 40-char SHA)
rather than to a moving `main`. A tokenizer from another revision is a different vocabulary, so
a different grouping of tokens into words - the contract would then describe a pipeline other
than the one computing timestamps on DEV.

NO TEXT ON THE OUTPUT. The tokenizer and the texts live in the test's memory; only a fingerprint
of numbers and counters is used for comparison.
"""
import json
import os
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from chunk_diagnostics import summarize_chunk_timestamps  # noqa: E402
from config import MODEL_CONFIG  # noqa: E402
from token_timestamp_probe import (  # noqa: E402
    DECODE_ASR_CONVENTIONS,
    WordGrouping,
    reproduce_word_boundaries,
)

# STRICT MODE. Without it a missing wheel, an unsupported version or a tokenizer absent from the
# cache produced a SKIP - and the suite still ended with exit code 0, so the claim "never a
# silent PASS" was untrue operationally. With `ASR_CONTRACT_STRICT=1` each of those cases is an
# ERROR. The candidate image gate must require `13 passed, 0 skipped` with strict mode on.
STRICT = os.environ.get("ASR_CONTRACT_STRICT") == "1"

# The model and revision are read from the PRODUCTION configuration rather than from a literal
# in the test - otherwise the test would guard a different tokenizer from the one computing
# timestamps in the container.
# This does NOT mean the test "follows a new revision automatically". A separate assertion
# requires EXACTLY the pinned full SHA, so changing the production revision BLOCKS the test until the
# baseline is updated. That is intended: the A/B is frozen, and a silent jump to another
# vocabulary would change how tokens group into words - i.e. the boundaries - without touching
# a single assertion.
MODEL = MODEL_CONFIG["model_name"]
MODEL_REVISION = MODEL_CONFIG["model_revision"]

TOKENIZER_FILES = ["tokenizer*", "vocab.json", "merges.txt", "special_tokens_map.json",
                   "added_tokens.json", "normalizer.json", "config.json"]

try:
    import transformers
    IMPORT_FAILURE = None
except Exception as exc:                                        # pragma: no cover
    transformers = None
    IMPORT_FAILURE = type(exc).__name__

VERSION = getattr(transformers, "__version__", None)


def unavailable(reason):
    """SKIP in an ordinary suite, ERROR in strict mode. Never a silent PASS in the candidate gate."""
    if STRICT:
        pytest.fail("ASR_CONTRACT_STRICT=1 — " + reason, pytrace=False)
    pytest.skip(reason)


@pytest.fixture(scope="module")
def contract_ready():
    """Preconditions without which the contract has nothing to guard. Returns the resolved full revision."""
    if transformers is None:
        unavailable("`transformers` is not installed ({})".format(IMPORT_FAILURE))
    if VERSION not in DECODE_ASR_CONVENTIONS:
        unavailable("transformers={} is outside the convention registry {}".format(
            VERSION, sorted(DECODE_ASR_CONVENTIONS)))
    from huggingface_hub import snapshot_download
    try:
        # `local_files_only=True`: the test does NOT reach the network. No snapshot = no proof.
        path = snapshot_download(MODEL, revision=MODEL_REVISION,
                                 allow_patterns=TOKENIZER_FILES, local_files_only=True)
    except Exception as exc:
        unavailable("tokenizer {} @ revision {} is not in the local cache ({})".format(
            MODEL, MODEL_REVISION, type(exc).__name__))
    resolved = Path(path).name
    # The revision is PINNED, not `main`: `main` can move at any moment, and the test would then
    # describe a different vocabulary from the one running in the container.
    assert resolved.startswith(MODEL_REVISION), (
        "snapshot {} does not come from revision {}".format(resolved, MODEL_REVISION))
    return {"path": path, "resolved_revision": resolved}


@pytest.fixture(scope="module")
def tokenizer(contract_ready):
    """The REAL tokenizer of the production model, at the PINNED revision, from the local cache."""
    from transformers import WhisperTokenizer
    return WhisperTokenizer.from_pretrained(contract_ready["path"])


@pytest.fixture(scope="module")
def grouping(tokenizer):
    """A facade built from the REAL tokenizer - the same functions the library uses."""
    from transformers.models.whisper.tokenization_whisper import (
        LANGUAGES,
        _combine_tokens_into_words,
    )
    special = set(tokenizer.all_special_ids)
    prompt_id = tokenizer.convert_tokens_to_ids("<|startofprev|>")
    start_id = tokenizer.convert_tokens_to_ids("<|startoftranscript|>")
    return WordGrouping(
        strip_prompt=lambda ids: tokenizer._strip_prompt(ids, prompt_id, start_id),
        is_special=lambda token: token in special,
        detect_language=lambda token: LANGUAGES.get(tokenizer.decode([token])[2:-2], None),
        combine_tokens_into_words=lambda tokens, language: _combine_tokens_into_words(
            tokenizer, tokens, language)[2],
        timestamp_begin=tokenizer.convert_tokens_to_ids("<|notimestamps|>") + 1,
        time_precision=0.02,
        library_version=VERSION,
    )


def library_chunks(tokenizer, token_ids, timestamps):
    """Runs the library's REAL `_decode_asr` and returns its word ranges."""
    import torch
    model_outputs = [{
        "tokens": torch.tensor([token_ids]),
        "token_timestamps": torch.tensor([timestamps], dtype=torch.float32),
    }]
    _, optional = tokenizer._decode_asr(
        model_outputs, return_timestamps="word", return_language=False, time_precision=0.02)
    return optional["chunks"]


def fingerprints(tokenizer, grouping, token_ids, timestamps):
    """(library digest, our reproduction digest, counters) for the same sequence."""
    chunks = library_chunks(tokenizer, token_ids, timestamps)
    theirs = summarize_chunk_timestamps(chunks)["timestamp_fingerprint"]
    ours = reproduce_word_boundaries(token_ids, timestamps, grouping)
    return theirs, ours["reproduced_chunk_fingerprint"], ours, chunks


def sequence(tokenizer, text, with_prompt=False, closing_timestamp=True):
    """A synthetic token sequence in the shape `generate()` returns."""
    begin = tokenizer.convert_tokens_to_ids("<|notimestamps|>") + 1
    ids = []
    if with_prompt:
        ids += [tokenizer.convert_tokens_to_ids("<|startofprev|>")]
        ids += tokenizer.encode(" vorher", add_special_tokens=False)
    ids += [
        tokenizer.convert_tokens_to_ids("<|startoftranscript|>"),
        tokenizer.convert_tokens_to_ids("<|de|>"),
        tokenizer.convert_tokens_to_ids("<|transcribe|>"),
        begin,                                    # <|0.00|>
    ]
    ids += tokenizer.encode(text, add_special_tokens=False)
    if closing_timestamp:
        ids += [begin + 60]                       # <|1.20|>
    return ids


def ramp(length, step=0.06):
    """Increasing timestamps - each token gets its own time."""
    return [round(i * step, 4) for i in range(length)]


# ── the core of the contract ──────────────────────────────────────────────────────────────────────

def test_tokenizer_comes_from_the_pinned_production_revision(contract_ready, tokenizer):
    """The vocabulary must come from the revision running in the container - not from a moving `main`.

    A different vocabulary means a different grouping of tokens into words, so different
    boundaries - the contract would then describe a pipeline other than production while still
    looking green.

    The assertion on the full SHA is DELIBERATELY hard: changing the production revision must BLOCK
    this test until the frozen baseline is updated, rather than silently follow the new value.
    """
    resolved = contract_ready["resolved_revision"]
    assert resolved.startswith(MODEL_REVISION)
    assert len(resolved) == 40, "a full revision (sha1) is expected, not an abbreviation"
    assert MODEL_REVISION == "34415231e554d1e7005118264f41e287922f9218", (
        "the production revision changed - update the frozen baseline deliberately")
    assert Path(contract_ready["path"]).name == resolved
    assert tokenizer.convert_tokens_to_ids("<|notimestamps|>") + 1 == 50365


@pytest.mark.parametrize("text", ["Der Herr ist mein Hirte", "Gelassenheit", "und dann"])
def test_our_boundaries_are_identical_to_the_library(tokenizer, grouping, text):
    """Our boundary fingerprint == the fingerprint of the ranges returned by the REAL `_decode_asr`."""
    ids = sequence(tokenizer, text)
    theirs, ours, result, chunks = fingerprints(tokenizer, grouping, ids, ramp(len(ids) + 2))
    assert result["boundary_status"] == "ok"
    assert result["boundary_convention"] == VERSION
    assert result["word_count"] == len(chunks)
    assert ours == theirs, "the reproduction drifted from library {}".format(VERSION)


def test_contract_holds_with_a_prompt_prefix(tokenizer, grouping):
    """With a prompt: `_strip_prompt` shifts the indices identically on BOTH sides."""
    ids = sequence(tokenizer, "Der Herr ist mein Hirte", with_prompt=True)
    theirs, ours, result, _ = fingerprints(tokenizer, grouping, ids, ramp(len(ids) + 2))
    assert result["prompt_tokens_stripped"] > 0
    assert ours == theirs


def test_contract_holds_without_a_closing_timestamp(tokenizer, grouping):
    """Without a closing timestamp the library takes the "leftover tokens" path - so do we."""
    ids = sequence(tokenizer, "Der Herr ist mein Hirte", closing_timestamp=False)
    theirs, ours, result, _ = fingerprints(tokenizer, grouping, ids, ramp(len(ids) + 2))
    assert result["word_count"] > 0
    assert ours == theirs


def test_contract_reproduces_zero_length_words(tokenizer, grouping):
    """Equal adjacent timestamps: the library produces zero-length ranges, and we count them the same way."""
    ids = sequence(tokenizer, "Der Herr ist mein Hirte")
    ts = ramp(len(ids) + 2)
    for i in range(4, min(9, len(ts))):        # equal timestamps in the middle of the text run
        ts[i] = 0.30
    theirs, ours, result, chunks = fingerprints(tokenizer, grouping, ids, ts)
    zero_in_library = sum(1 for c in chunks
                          if c["timestamp"][0] is not None
                          and c["timestamp"][0] == c["timestamp"][1])
    assert zero_in_library > 0, "the test did not trigger the defect it is meant to measure"
    assert result["zero_length_words"] == zero_in_library
    assert (result["raw_equal_at_word_boundary"]
            + result["rounded_equal_at_word_boundary"]) == zero_in_library
    assert ours == theirs


def test_contract_catches_rounding_only_collisions(tokenizer, grouping):
    """Values DIFFER raw and are equal after `round(...,2)` - they must come out as `rounded`, not `raw`."""
    ids = sequence(tokenizer, "Der Herr ist mein Hirte")
    ts = ramp(len(ids) + 2)
    for offset, value in enumerate([0.4001, 0.4002, 0.4003, 0.4004]):
        if 4 + offset < len(ts):
            ts[4 + offset] = value
    theirs, ours, result, _ = fingerprints(tokenizer, grouping, ids, ts)
    assert ours == theirs
    if result["zero_length_words"]:
        assert result["rounded_equal_at_word_boundary"] > 0
        assert result["raw_equal_at_word_boundary"] == 0


def test_first_token_constant_never_fires_in_production_shape(tokenizer, grouping):
    """A FINDING, verified against live code: in a real sequence the `i == 0` constant does NOT fire.

    Index 0 is always `<|startoftranscript|>`, and `_strip_prompt` returns starting FROM it - so
    the first text token sits at index 4 (`<|sot|><|lang|><|transcribe|><|0.00|>`). The
    `if i == 0` branch from 4.57.5 is dead in this shape. The test guards that explicitly, so
    that nobody "fixes" it in future on the basis of reading the sources alone.
    """
    ids = sequence(tokenizer, "Gelassenheit")
    theirs, ours, result, chunks = fingerprints(tokenizer, grouping, ids, ramp(len(ids) + 2))
    assert ours == theirs
    assert result["first_token_constant_start"] == 0
    assert chunks[0]["timestamp"][0] != 0.0, "the first word takes its time from the array, not from the constant"


def test_first_token_constant_fires_without_a_prefix(tokenizer, grouping):
    """Without a prefix the constant IS used. Leading zeros force a zero-length range.

    The zeros are written EXPLICITLY rather than derived from tokenisation: "Gelassenheit" splits
    into several tokens merged into ONE word, so the end would come from `ts[3]` rather than
    `ts[0]` - and the zero-length assertion would depend on the vocabulary instead of the
    convention.
    """
    ids = tokenizer.encode("Gelassenheit", add_special_tokens=False)
    ts = [0.0] * (len(ids) + 1) + [0.3, 0.36]
    theirs, ours, result, chunks = fingerprints(tokenizer, grouping, ids, ts)
    assert ours == theirs
    assert chunks[0]["timestamp"][0] == 0.0
    if VERSION == "4.57.5":
        assert result["first_token_constant_start"] == 1
        assert result["zero_length_words"] >= 1
        assert result["raw_equal_at_word_boundary"] >= 1
    else:
        assert result["first_token_constant_start"] == 0   # 4.47.1: `ts[0]`, not the constant


def test_wrong_convention_would_be_caught_not_silently_wrong(tokenizer, grouping):
    """The guard is only worth anything if the WRONG convention really gives a different result."""
    other = [v for v in DECODE_ASR_CONVENTIONS if v != VERSION]
    if not other:                                              # pragma: no cover
        pytest.skip("the registry holds a single convention")
    ids = sequence(tokenizer, "Der Herr ist mein Hirte")
    ts = ramp(len(ids) + 2)
    theirs, ours, _, _ = fingerprints(tokenizer, grouping, ids, ts)
    assert ours == theirs

    wrong = reproduce_word_boundaries(ids, ts, grouping._replace(library_version=other[0]))
    assert wrong["boundary_status"] == "ok", "the stub must USE the other convention, not refuse"
    assert wrong["reproduced_chunk_fingerprint"] != theirs, (
        "conventions {} and {} give the same result - the version guard would be pointless".format(
            VERSION, other[0]))


def test_prefix_removal_from_dtw_matches_the_installed_source(tokenizer):
    """Cutting the prefix out of DTW is a property of `generate()`, so it is pinned AT THE SOURCE.

    Running `_extract_token_timestamps` would require a model and cross-attentions, which this
    test deliberately does not do. Rather than fake a measurement, the text of the installed
    wheel is inspected, and it is stated outright that this is a SOURCE check, not a runtime one.
    """
    from transformers.models.whisper import generation_whisper
    source = Path(generation_whisper.__file__).read_text(encoding="utf-8")
    slices_prefix = bool(re.search(r"weights\s*=\s*weights\[:,\s*:,\s*num_input_ids:", source))
    if VERSION == "4.57.5":
        assert slices_prefix, "4.57.5 should cut the prefix out of DTW - the source says otherwise"
        assert "torch.zeros(num_input_ids)" in source
    elif VERSION == "4.47.1":
        assert not slices_prefix, "4.47.1 does NOT cut the prefix - the source says otherwise"


def test_no_source_text_or_token_ids_in_the_reproduction_result(tokenizer, grouping):
    """The tokenizer and the texts live in memory; ONLY counters, a status and a digest are emitted.

    The check is STRUCTURAL rather than a substring search: a two-digit token id would land in
    the fingerprint hex by chance and raise a false alarm. Instead every field must be a counter,
    a boolean, a known status or a hex digest - and no counter may equal a token id.
    """
    ids = sequence(tokenizer, "Gelassenheit Minuten")
    result = reproduce_word_boundaries(ids, ramp(len(ids) + 2), grouping)

    STATUSY = set(DECODE_ASR_CONVENTIONS) | {"ok", "no_grouping", "no_tokens",
                                             "unsupported_stride", "failed",
                                             "unverified_decode_asr_version"}
    for key, value in result.items():
        if value is None or isinstance(value, (bool, int)):
            continue
        assert isinstance(value, str), "field {} carries a type outside the contract: {!r}".format(key, value)
        assert value in STATUSY or re.fullmatch(r"[0-9a-f]{64}", value), (
            "field {} carries text outside the contract: {!r}".format(key, value))

    # no counter may accidentally reveal a token id
    counters = {v for v in result.values() if isinstance(v, int) and not isinstance(v, bool)}
    assert not (counters & set(ids)), "a counter coincides with a token id"

    payload = json.dumps(result, ensure_ascii=False, default=str)
    for word in ("Gelassenheit", "Minuten", "transcribe", "startoftranscript"):
        assert word not in payload
