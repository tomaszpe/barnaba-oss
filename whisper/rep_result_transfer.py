"""Scoped ASR-only export optimization for the exact Transformers 4.57.5 method.

Omit encoder self-attention *exports*, not computation. Cross-attention, scores,
beam indices, cache and token timestamp extraction are unchanged. Not for callers
requesting raw generate() diagnostics. Default installed behavior is passthrough.
"""
from contextlib import contextmanager
from contextvars import ContextVar
from functools import wraps
import hashlib
import inspect
import math
import time


POSTPROCESS_SHA256 = "9864a06db5a16c2fa1288d7ae32e9d4dbb12766de8b41d884c9cd8a5e024c323"


class WhisperResultTransfer:
    def __init__(self, model):
        import transformers
        if transformers.__version__ != "4.57.5":
            raise RuntimeError("REP export optimization requires Transformers 4.57.5")
        original = model._postprocess_outputs
        digest = hashlib.sha256(inspect.getsource(original).rstrip().encode()).hexdigest()
        if digest != POSTPROCESS_SHA256:
            raise RuntimeError("REP postprocess source mismatch; optimization refused")
        self._model, self._original = model, original
        self._scope = ContextVar("rep_asr_export_scope", default=None)

        @wraps(original)
        def postprocess(seek_outputs, decoder_input_ids, return_token_timestamps,
                        generation_config, is_shortform, seek, batch_idx_map):
            state = self._scope.get()
            eligible = (state is not None and is_shortform and return_token_timestamps
                        and hasattr(generation_config, "alignment_heads")
                        and hasattr(seek_outputs, "items"))
            if eligible:
                attentions = seek_outputs.get("encoder_attentions")
                if attentions is not None:
                    state["encoder_attention_bytes"] += sum(
                        tensor.numel() * tensor.element_size() for tensor in attentions)
                    state["observed_calls"] += 1
                    if state["enabled"]:
                        # Reconstruct ModelOutput: dict() would break attribute access
                        # in the unchanged token timestamp extractor.
                        seek_outputs = type(seek_outputs)(**{
                            key: value for key, value in seek_outputs.items()
                            if key != "encoder_attentions"})
                        state["optimized_calls"] += 1
            if state is not None and state["synchronize"] is not None:
                started = time.monotonic()
                state["synchronize"]()
                state["pre_postprocess_sync_ms"] += (time.monotonic() - started) * 1000
            started = time.monotonic()
            result = original(seek_outputs, decoder_input_ids, return_token_timestamps,
                              generation_config, is_shortform, seek, batch_idx_map)
            if state is not None:
                state["postprocess_ms"] += (time.monotonic() - started) * 1000
                if state["capture_quality"]:
                    # Read the exact pinned library's selected-beam scores AFTER
                    # postprocessing. No extra model call, no guessed confidence.
                    try:
                        tokens, rows = result
                        if len(rows) == 1 and rows[0].get("scores"):
                            avg = float(model._retrieve_avg_logprobs(
                                rows[0]["scores"], tokens[0], 0.0).item())
                            if math.isfinite(avg):
                                state["quality"] = {"validated_measurement": True,
                                    "avg_logprob": avg,
                                    "source": "transformers_4.57.5_selected_beam_scores"}
                    except Exception:
                        state["quality"] = None
            return result

        self._wrapper = postprocess
        model._postprocess_outputs = postprocess

    @contextmanager
    def scope(self, enabled=False, *, synchronize=None, capture_quality=False):
        state = {"enabled": enabled, "encoder_attention_bytes": 0,
                 "observed_calls": 0, "optimized_calls": 0,
                 "synchronize": synchronize, "pre_postprocess_sync_ms": 0,
                 "postprocess_ms": 0, "capture_quality": capture_quality, "quality": None}
        token = self._scope.set(state)
        try:
            yield state
        finally:
            self._scope.reset(token)

    def close(self):
        if self._model._postprocess_outputs is not self._wrapper:
            raise RuntimeError("REP wrapper changed concurrently; refuse to overwrite")
        self._model._postprocess_outputs = self._original
