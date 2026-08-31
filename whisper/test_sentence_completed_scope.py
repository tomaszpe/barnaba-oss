from pathlib import Path


def test_sentence_completed_is_initialized_before_transcription_branch():
    source = Path(__file__).with_name("whisper_service.py").read_text(encoding="utf-8")

    # `do_transcribe()` now also returns an explicit `transcribe_status`, so the marker had to
    # change. The INVARIANT being guarded is the same: `sentence_completed` is initialised
    # BEFORE the `if transcription:` branch.
    await_marker = "transcription, chunks_list, transcribe_status = await loop.run_in_executor("
    init_marker = "sentence_completed = False"
    branch_marker = "if transcription:"

    await_index = source.index(await_marker)
    init_index = source.index(init_marker, await_index)
    branch_index = source.index(branch_marker, await_index)

    assert await_index < init_index < branch_index


def test_whisper_diagnostics_cover_executor_pipeline_and_trim():
    source = Path(__file__).with_name("whisper_service.py").read_text(encoding="utf-8")

    assert "[WHISPER_DIAG]" in source
    assert '"submit"' in source
    assert '"pipeline_start"' in source
    assert '"pipeline_done"' in source
    assert '"pipeline_finish"' in source
    assert '"buffer_trim"' in source
    assert "queued_ms" in source
    assert "in_flight_total" in source
    assert "realtime_factor" in source


def test_streaming_chunk_path_has_single_flight_coalescing():
    source = Path(__file__).with_name("whisper_service.py").read_text(encoding="utf-8")

    assert "self.transcription_in_progress = False" in source
    assert "self.coalesced_audio_pending = False" in source
    assert "if session.transcription_in_progress:" in source
    assert '"coalesced_skip"' in source
    assert '"coalesced_pending_after_finish"' in source
    assert "force_trim_deferred=force_trim_time is not None" in source
