from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest
import torch
from transformers.generation.utils import GenerateEncoderDecoderOutput
from transformers.models.whisper.generation_whisper import WhisperGenerationMixin

from rep_result_transfer import WhisperResultTransfer


class Model(WhisperGenerationMixin):
    config = SimpleNamespace(decoder_layers=1, median_filter_width=3)


def outputs():
    generator = torch.Generator().manual_seed(42)
    return GenerateEncoderDecoderOutput(
        sequences=torch.tensor([[1, 10, 11]]),
        scores=(torch.rand(1, 20, generator=generator),) * 2,
        encoder_attentions=(torch.rand(1, 2, 6, 6, generator=generator),),
        cross_attentions=tuple((torch.rand(1, 2, 1, 6, generator=generator),) for _ in range(2)),
    )


def invoke(model, *, short=True, timestamps=True):
    return model._postprocess_outputs(
        outputs(), torch.tensor([[1]]), timestamps,
        SimpleNamespace(alignment_heads=[(0, 0)], num_frames=None), short,
        torch.tensor([0]), [0])


def test_real_pinned_postprocessor_preserves_tokens_timestamps_scores_cross_attention():
    model = Model()
    baseline = invoke(model)
    adapter = WhisperResultTransfer(model)
    try:
        with adapter.scope(True) as stats:
            optimized = invoke(model)
        assert torch.equal(baseline[0], optimized[0])
        for key in ("sequences", "token_timestamps"):
            assert torch.equal(baseline[1][0][key], optimized[1][0][key])
        for a, b in zip(baseline[1][0]["scores"], optimized[1][0]["scores"]):
            assert torch.equal(a, b)
        for a, b in zip(baseline[1][0]["cross_attentions"], optimized[1][0]["cross_attentions"]):
            assert all(torch.equal(x, y) for x, y in zip(a, b))
        assert "encoder_attentions" not in optimized[1][0]
        assert stats["optimized_calls"] == 1
        assert stats["encoder_attention_bytes"] == 288
        assert "encoder_attentions" in invoke(model)[1][0]
    finally:
        adapter.close()


@pytest.mark.parametrize("short,timestamps", [(False, True), (True, False)])
def test_other_paths_are_unchanged(short, timestamps):
    model = Model()
    adapter = WhisperResultTransfer(model)
    try:
        with adapter.scope(True) as stats:
            result = invoke(model, short=short, timestamps=timestamps)
        assert "encoder_attentions" in result[1][0]
        assert stats["optimized_calls"] == 0
    finally:
        adapter.close()


def test_context_does_not_leak_to_other_workers_and_resets_on_error():
    model = Model()
    adapter = WhisperResultTransfer(model)
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            with pytest.raises(ValueError):
                with adapter.scope(True):
                    result = pool.submit(invoke, model).result()
                    assert "encoder_attentions" in result[1][0]
                    raise ValueError("abort")
        assert "encoder_attentions" in invoke(model)[1][0]
    finally:
        adapter.close()


def test_source_drift_refuses_installation(monkeypatch):
    import rep_result_transfer
    monkeypatch.setattr(rep_result_transfer.inspect, "getsource", lambda fn: "changed")
    with pytest.raises(RuntimeError, match="source mismatch"):
        WhisperResultTransfer(Model())


def test_version_drift_refuses_installation(monkeypatch):
    import transformers
    monkeypatch.setattr(transformers, "__version__", "4.58.0")
    with pytest.raises(RuntimeError, match="4.57.5"):
        WhisperResultTransfer(Model())
