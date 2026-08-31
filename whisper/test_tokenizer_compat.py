"""Tests for the Flix Transformers-5 tokenizer metadata adapter."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import whisper_service as ws  # noqa: E402


def _config(tmp_path: Path, extra_special_tokens):
    path = tmp_path / "tokenizer_config.json"
    path.write_text(
        json.dumps({"extra_special_tokens": extra_special_tokens}),
        encoding="utf-8",
    )
    return str(path)


def test_list_schema_is_mapped_to_additional_special_tokens(tmp_path, monkeypatch):
    config_path = _config(tmp_path, ["<|de|>", "<|translate|>"])
    calls = []
    tokenizer = object()

    monkeypatch.setattr(ws.transformers.utils.hub, "cached_file", lambda *a, **k: config_path)
    monkeypatch.setattr(
        ws.transformers.AutoTokenizer,
        "from_pretrained",
        lambda *args, **kwargs: calls.append((args, kwargs)) or tokenizer,
    )

    result = ws._load_compatible_pipeline_tokenizer("Flix-AI/model", "full-sha", "cache")

    assert result is tokenizer
    assert calls == [
        (
            ("Flix-AI/model",),
            {
                "revision": "full-sha",
                "cache_dir": "cache",
                "extra_special_tokens": {},
                "additional_special_tokens": ["<|de|>", "<|translate|>"],
            },
        )
    ]


def test_legacy_dictionary_schema_keeps_pipeline_default(tmp_path, monkeypatch):
    config_path = _config(tmp_path, {"language": "<|de|>"})
    monkeypatch.setattr(ws.transformers.utils.hub, "cached_file", lambda *a, **k: config_path)

    def unexpected_load(*args, **kwargs):
        raise AssertionError("legacy tokenizer must stay on the pipeline default path")

    monkeypatch.setattr(ws.transformers.AutoTokenizer, "from_pretrained", unexpected_load)

    assert ws._load_compatible_pipeline_tokenizer("legacy/model", "rev", "cache") is None
