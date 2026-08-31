from rep_shadow import RepShadowSession, coordinate_space_id, normalize_tokens


def spans(start, count, step=320):
    return [
        {"text": f"w{index}", "start_sample": start + index * step,
         "end_sample": start + (index + 1) * step}
        for index in range(count)
    ]


TEXT = "eins zwei drei vier fünf sechs sieben acht"


def test_normalization_is_unicode_and_language_neutral():
    assert normalize_tokens("Ärger, L’Amour 42") == ["ärger", "l’amour", "42"]


def test_coordinate_space_is_stable_and_anonymous():
    assert coordinate_space_id("session-a") == coordinate_space_id("session-a")
    assert len(coordinate_space_id("session-a")) == 24
    assert "session" not in coordinate_space_id("session-a")


def test_off_mode_is_observationally_silent():
    rep = RepShadowSession("s", mode="off", key=b"k" * 32)
    assert rep.observe_stage("asr_decode_raw", TEXT, decode_id=1) is None
    assert rep.classify_and_record(TEXT, spans(0, 8), decode_id=1) == []


def test_same_audio_repeat_is_timestamp_dedup_escape():
    rep = RepShadowSession("s", mode="shadow", key=b"k" * 32)
    assert rep.classify_and_record(TEXT, spans(0, 8), decode_id=1) == []
    result = rep.classify_and_record(TEXT, spans(100, 8), decode_id=2)
    assert result[0]["candidate_class"] == "timestamp_dedup_escape"
    assert result[0]["source_relation"] == "same_source_span"
    assert result[0]["policy_applied"] is False


def test_disjoint_repeat_is_stale_echo_new_audio():
    rep = RepShadowSession("s", mode="shadow", key=b"k" * 32)
    rep.classify_and_record(TEXT, spans(0, 8), decode_id=1)
    result = rep.classify_and_record(TEXT, spans(160_000, 8), decode_id=2)
    assert result[0]["candidate_class"] == "stale_echo_new_audio"
    assert result[0]["echo_age_samples"] > 0


def test_fuzzy_taint_blocks_escape_classification():
    rep = RepShadowSession("s", mode="shadow", key=b"k" * 32)
    rep.classify_and_record(TEXT, spans(0, 8), decode_id=1)
    result = rep.classify_and_record(
        TEXT, spans(100, 8), decode_id=2, fuzzy_tainted_ranges=[(0, 4000)]
    )
    assert result[0]["candidate_class"] == "fuzzy_replacement_tainted"


def test_later_fuzzy_replace_taints_existing_ledger_entry():
    rep = RepShadowSession("s", mode="shadow", key=b"k" * 32)
    rep.classify_and_record(TEXT, spans(0, 8), decode_id=1)
    result = rep.classify_and_record(
        TEXT, spans(160_000, 8), decode_id=2, fuzzy_tainted_ranges=[(0, 4000)]
    )
    assert result[0]["candidate_class"] == "fuzzy_replacement_tainted"


def test_overflow_disables_session_without_eviction():
    rep = RepShadowSession(
        "s", mode="shadow", ngram_words=2, max_fingerprints=1, key=b"k" * 32
    )
    result = rep.classify_and_record("a b c", spans(0, 3), decode_id=1)
    assert result[-1]["event"] == "rep_ledger_overflow"
    assert rep.disabled_reason == "rep_ledger_overflow"
    assert rep.fingerprint_count == 1


def test_observer_contains_no_plaintext():
    rep = RepShadowSession("s", mode="shadow", key=b"k" * 32)
    event = rep.observe_stage("asr_decode_raw", TEXT, decode_id=1, spans=spans(0, 8))
    assert TEXT not in str(event)
    assert event["token_count"] == 8
    assert event["emitted_text_changed"] is False


def test_protected_text_requires_explicit_experiment_flag():
    rep = RepShadowSession(
        "s", mode="shadow", key=b"k" * 32, protected_text_enabled=True,
    )
    event = rep.observe_stage("asr_decode_raw", TEXT, decode_id=1)
    assert event["protected_ngram_text"] == [TEXT]


def test_candidate_protected_text_is_bounded_to_matched_ngram_and_opt_in():
    protected = RepShadowSession(
        "s", mode="shadow", key=b"k" * 32, protected_text_enabled=True,
    )
    protected.classify_and_record(TEXT, spans(0, 8), decode_id=1)
    event = protected.classify_and_record(TEXT, spans(160_000, 8), decode_id=2)[0]
    assert event["protected_ngram_text"] == [TEXT]

    private = RepShadowSession("s", mode="shadow", key=b"k" * 32)
    private.classify_and_record(TEXT, spans(0, 8), decode_id=1)
    private_event = private.classify_and_record(TEXT, spans(160_000, 8), decode_id=2)[0]
    assert "protected_ngram_text" not in private_event


def test_shadow_classification_preserves_emitted_bytes():
    rep = RepShadowSession("s", mode="shadow", key=b"k" * 32)
    emitted = TEXT.encode("utf-8")
    rep.classify_and_record(TEXT, spans(0, 8), decode_id=1)
    rep.classify_and_record(TEXT, spans(160_000, 8), decode_id=2)
    assert TEXT.encode("utf-8") == emitted
