"""Tests for `generate()` call compatibility - reproducing the 4.57.5 failure WITHOUT a GPU
and without a model.

The finding (a smoke run on the 4.57 arm, 30/30 `TypeError`): `WhisperTimeStampLogitsProcessor`
in 4.57.x uses `eos_token_id` as a slice boundary (`logits_process.py:2030`), while the
`generation_config` of our pinned revision carries `[50257]` - a single-element list.

The reproduction goes through the REAL processor from the installed wheel, not through a stub.
A stub would only prove that the code does what we THINK the library does - and that is exactly
the mistake which cost a GPU run.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from generation_compat import (  # noqa: E402
    GenerationCompatError,
    eos_singleton,
    normalized_generation_config,
    should_retry_with_chunking,
)

EOS = 50257


class FakeConfig:
    """A minimal `eos_token_id` carrier - `deepcopy` must copy it like a real config."""

    def __init__(self, eos_token_id):
        self.eos_token_id = eos_token_id
        self.other_field = "untouched"


def torch_or_skip():
    torch = pytest.importorskip("torch", reason="tensor shapes need torch")
    return torch


# ── detecting the single-element list ─────────────────────────────────────────────────────────────

def test_scalar_is_recognised_without_change():
    assert eos_singleton(EOS) == (EOS, "scalar")


@pytest.mark.parametrize("value", [[EOS], (EOS,)])
def test_single_element_sequence_is_normalised(value):
    assert eos_singleton(value) == (EOS, "sequence")


def test_single_element_tensor_is_normalised():
    torch = torch_or_skip()
    assert eos_singleton(torch.tensor([EOS])) == (EOS, "tensor")


def test_zero_dim_tensor_is_normalised():
    torch = torch_or_skip()
    assert eos_singleton(torch.tensor(EOS)) == (EOS, "tensor")


@pytest.mark.parametrize("value,fragment", [
    ([EOS, EOS + 1], "sequence_len_2"),
    ([], "sequence_len_0"),
    (True, "bool"),
    (50257.0, "not_an_int"),
    (0, "non_positive"),
    (-1, "non_positive"),
    (None, "missing"),
    ("50257", "not_an_int"),
])
def test_other_shapes_are_refused(value, fragment):
    """Fail-closed: a known library error is preferable to a silent guess that changes semantics."""
    scalar, reason = eos_singleton(value)
    assert scalar is None and fragment in reason


def test_multi_element_tensor_is_refused():
    torch = torch_or_skip()
    scalar, reason = eos_singleton(torch.tensor([EOS, EOS + 1]))
    assert scalar is None and reason == "tensor_len_2"


def test_empty_tensor_is_refused():
    torch = torch_or_skip()
    scalar, reason = eos_singleton(torch.tensor([], dtype=torch.long))
    assert scalar is None and reason == "tensor_len_0"


def test_float_tensor_is_refused():
    """A float where a token id belongs is a defect, not a value to round."""
    torch = torch_or_skip()
    scalar, reason = eos_singleton(torch.tensor([float(EOS)]))
    assert scalar is None and "not_an_int" in reason


# ── the decision to inject the config ─────────────────────────────────────────────────────────────

def test_scalar_config_is_a_noop():
    """The 4.47.1 path: no copy, no injection - behaviour character-identical."""
    config = FakeConfig(EOS)
    patched, report = normalized_generation_config(config)
    assert patched is None
    assert report["action"] == "noop" and report["eos_scalar"] == EOS


def test_singleton_config_is_normalised_into_a_copy():
    config = FakeConfig([EOS])
    patched, report = normalized_generation_config(config)
    assert report["action"] == "normalized" and report["eos_scalar"] == EOS
    assert patched is not config
    assert patched.eos_token_id == EOS
    # THE ORIGINAL IS UNTOUCHED - the object is shared between executor threads.
    assert config.eos_token_id == [EOS]


def test_no_global_mutation_across_repeated_calls():
    config = FakeConfig([EOS])
    for _ in range(3):
        patched, _ = normalized_generation_config(config)
        patched.eos_token_id = 1  # dirt in the copy must not travel back to the source
    assert config.eos_token_id == [EOS]


def test_parallel_calls_are_isolated():
    """Four executor threads decode in parallel - each call must get its OWN object."""
    import threading
    config = FakeConfig([EOS])
    seen = []
    lock = threading.Lock()

    def worker():
        patched, _ = normalized_generation_config(config)
        with lock:
            # OBJECTS, not `id()`: CPython recycles identifiers after memory is freed, so a
            # list of bare `id` values can produce a false duplicate.
            seen.append(patched)

    threads = [threading.Thread(target=worker) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len({id(patched) for patched in seen}) == 4
    assert all(patched.eos_token_id == EOS for patched in seen)
    assert config.eos_token_id == [EOS]


def test_copy_preserves_other_fields():
    config = FakeConfig([EOS])
    patched, _ = normalized_generation_config(config)
    assert patched.other_field == "untouched"


@pytest.mark.parametrize("value", [[EOS, EOS + 1], [], True, None])
def test_refused_shapes_do_not_inject_anything(value):
    patched, report = normalized_generation_config(FakeConfig(value))
    assert patched is None and report["action"] == "refused"


def test_missing_config_is_refused():
    patched, report = normalized_generation_config(None)
    assert patched is None and report["action"] == "refused"


# ── reproduction on the REAL processor from the installed wheel ───────────────────────────────────

def _real_processor(eos_value):
    transformers = pytest.importorskip("transformers")
    torch = torch_or_skip()
    from transformers.generation.logits_process import WhisperTimeStampLogitsProcessor

    class GenerateConfig:
        no_timestamps_token_id = 50363
        eos_token_id = None
        bos_token_id = 50257
        _detect_timestamp_from_logprob = False

    config = GenerateConfig()
    config.eos_token_id = eos_value
    processor = WhisperTimeStampLogitsProcessor(config, begin_index=4)
    # A sequence ending in a timestamp token whose predecessor is NOT a timestamp -
    # exactly the `else` branch at line 2030.
    input_ids = torch.tensor([[50258, 50259, 50360, 50364, 1000, 50400]])
    scores = torch.zeros(1, 51866)
    return processor, input_ids, scores, torch


def test_scalar_eos_works_on_the_installed_transformers():
    """A condition that MUST hold in every version: a scalar does not blow up the processor."""
    processor, input_ids, scores, _ = _real_processor(EOS)
    processor(input_ids, scores)


@pytest.mark.skipif(
    pytest.importorskip("transformers").__version__ != "4.57.5",
    reason="the reproduction is pinned to 4.57.5 - on another version it would describe other code",
)
def test_list_eos_reproduces_the_typeerror_on_4_57_5():
    """Exactly the smoke failure on the 4.57 arm: `[50257]` as a slice boundary."""
    processor, input_ids, scores, _ = _real_processor([EOS])
    with pytest.raises(TypeError, match="slice indices"):
        processor(input_ids, scores)


@pytest.mark.skipif(
    pytest.importorskip("transformers").__version__ != "4.57.5",
    reason="the fix is proven on the version that exhibits the defect",
)
def test_normalisation_fixes_the_real_processor_on_4_57_5():
    """The same path passes after normalising `[50257] -> 50257`."""
    config_like = FakeConfig([EOS])
    patched, report = normalized_generation_config(config_like)
    assert report["action"] == "normalized"
    processor, input_ids, scores, _ = _real_processor(patched.eos_token_id)
    processor(input_ids, scores)


# -- retry with chunking: DISABLED ---------------------------------------------──────────

def _raise_from(marker_path):
    """Builds a `TypeError` with a frame at a given file path - without hand-faking a traceback."""
    source = "def f():\n    raise TypeError('slice indices must be integers or None')\n"
    namespace = {}
    exec(compile(source, marker_path, "exec"), namespace)
    try:
        namespace["f"]()
    except TypeError as exc:
        return exc


@pytest.mark.parametrize("origin", [
    "/usr/lib/python3.11/site-packages/transformers/generation/logits_process.py",
    "/usr/lib/python3.11/site-packages/transformers/pipelines/base.py",
    # Any non-transformers origin; the point is that provenance does not matter.
    "/opt/barnaba/whisper/whisper_service.py",
])
def test_no_typeerror_is_ever_retried(origin):
    """NO `TypeError` triggers a second decode - regardless of where it came from.

    NEGATIVE recognition (any `slice indices` message from outside `generation/`) would still let
    foreign errors through, and the chunked path returns SEGMENT timestamps instead of word
    timestamps - a silent change to the output shape that alignment rests on.
    """
    retry, reason = should_retry_with_chunking(_raise_from(origin))
    assert retry is False and "no_historical_signature" in reason


def test_other_typeerror_is_not_retried():
    retry, reason = should_retry_with_chunking(TypeError("unsupported operand type(s)"))
    assert retry is False


# -- `_run_pipeline` end to end: what reaches the pipeline, and how often --------

class FakeModel:
    def __init__(self):
        self.config = type("C", (), {"_attn_implementation": "sdpa"})()
        self.hf_device_map = None
        self.generation_config = None

    def parameters(self):
        return iter(())


class FakePipe:
    """A pipeline stub that counts calls and remembers the EXACT kwargs."""

    def __init__(self, eos_value, raises=None):
        self.model = FakeModel()
        self.device = "cpu"
        self.generation_config = FakeConfig(eos_value)
        self.calls = []
        self.raises = raises

    def __call__(self, audio, **kwargs):
        self.calls.append(kwargs)
        if self.raises is not None and len(self.calls) <= len(self.raises):
            raise self.raises[len(self.calls) - 1]
        return {"text": "x", "chunks": []}

    @property
    def call_count(self):
        return len(self.calls)


def _run(pipe):
    import whisper_service as ws  # noqa: WPS433 - heavy import only in these tests
    return ws._run_pipeline(pipe, [0.0] * 16, {"language": "de"}, use_chunking=False)


def test_scalar_config_reaches_pipeline_unchanged():
    """The 4.47.1 path: NO `generation_config` in kwargs - behaviour character-identical to before."""
    pipe = FakePipe(EOS)
    _run(pipe)
    assert pipe.call_count == 1
    assert "generation_config" not in pipe.calls[0]["generate_kwargs"]


def test_singleton_config_is_injected_as_a_copy():
    """The 4.57.5 path: a copy carrying a scalar reaches the pipeline, the ORIGINAL stays a list."""
    pipe = FakePipe([EOS])
    _run(pipe)
    assert pipe.call_count == 1
    injected = pipe.calls[0]["generate_kwargs"]["generation_config"]
    assert injected.eos_token_id == EOS
    assert injected is not pipe.generation_config
    assert pipe.generation_config.eos_token_id == [EOS]


@pytest.mark.parametrize("eos", [None, [EOS, EOS + 1], True, 50257.0, []])
def test_refused_shapes_never_reach_the_pipeline(eos):
    """A refusal MUST stop inference, not merely log itself."""
    pipe = FakePipe(eos)
    with pytest.raises(GenerationCompatError):
        _run(pipe)
    assert pipe.call_count == 0


def test_generation_typeerror_is_raised_after_exactly_one_call():
    """The observed failure: one call, zero retries, exception propagated."""
    boom = _raise_from("/usr/lib/python3.11/site-packages/transformers/generation/logits_process.py")
    pipe = FakePipe([EOS], raises=[boom])
    with pytest.raises(TypeError, match="slice indices"):
        _run(pipe)
    assert pipe.call_count == 1


def test_stride_like_typeerror_also_gets_exactly_one_call():
    """Even the historical bug's message does not trigger a second call."""
    boom = _raise_from("/usr/lib/python3.11/site-packages/transformers/pipelines/base.py")
    pipe = FakePipe(EOS, raises=[boom])
    with pytest.raises(TypeError):
        _run(pipe)
    assert pipe.call_count == 1
