from concurrent.futures import ThreadPoolExecutor

from rep_pipeline import install_result_transfer
from test_rep_result_transfer import Model, invoke
import whisper_service as ws


class Pipe:
    model = None
    def __init__(self):
        self.model = Model()
        self.result = {"text": "a", "chunks": [{"text": "a", "timestamp": (0, 1)}]}
        self.observed = []
    def __call__(self, *args, **kwargs):
        value = invoke(self.model)
        self.observed.append("encoder_attentions" in value[1][0])
        return self.result


def test_live_wrapper_scopes_every_call_inside_worker(monkeypatch):
    monkeypatch.setenv("ASR_REP_EXPORT_OPTIMIZATION_ENABLED", "true")
    pipe = Pipe()
    assert install_result_transfer(pipe) is True
    adapter = pipe._rep_result_transfer
    assert install_result_transfer(pipe) is True and pipe._rep_result_transfer is adapter
    monkeypatch.setattr(ws, "_run_pipeline_impl", lambda p, a, k, c: p(a))
    try:
        with ThreadPoolExecutor(max_workers=1) as executor:
            result = executor.submit(ws._run_pipeline, pipe, [], {}, False).result()
        assert result is pipe.result
        assert pipe.observed == [False]
        assert "encoder_attentions" in invoke(pipe.model)[1][0]
        measured = ws._run_pipeline(pipe, [], {}, False, capture_quality=True)
        assert measured["rep_quality"]["validated_measurement"] is True
        assert "rep_quality" not in pipe.result
    finally:
        adapter.close()


def test_off_does_not_install_or_change_output(monkeypatch):
    monkeypatch.delenv("ASR_REP_EXPORT_OPTIMIZATION_ENABLED", raising=False)
    pipe = Pipe()
    assert install_result_transfer(pipe) is False
    monkeypatch.setattr(ws, "_run_pipeline_impl", lambda p, a, k, c: p(a))
    assert ws._run_pipeline(pipe, [], {}) is pipe.result
    assert pipe.observed == [True]
