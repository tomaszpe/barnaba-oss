"""
Helpers for buffer trim context.

These functions are intentionally dependency-free so trim invariants can be
unit-tested without loading Whisper/FastAPI.
"""


def build_overlap_text_from_timestamps(
    confirmed_words: list,
    overlap_start_abs: float,
    overlap_end_abs: float,
    max_words: int = 15,
) -> str:
    """
    Build LocalAgreement warm-start text from words inside retained audio overlap.

    confirmed_words are stored as (word, absolute_start, absolute_end). After a
    trim with retained audio overlap, the duplicate audio region is
    [overlap_start_abs, overlap_end_abs]. Warm-starting with the words from that
    exact region keeps LocalAgreement and timestamp dedup aligned.
    """
    if not confirmed_words or overlap_end_abs <= overlap_start_abs:
        return ""

    overlapping = [
        (start, word)
        for word, start, end in confirmed_words
        if end > overlap_start_abs and start < overlap_end_abs
    ]
    overlapping.sort(key=lambda item: item[0])

    return " ".join(word for _, word in overlapping[-max_words:])
