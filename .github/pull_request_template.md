## What this changes

<!-- One paragraph. If it takes more, it is probably more than one pull request. -->

## Why

<!-- Link the issue. For anything larger than a typo, an issue should exist first. -->

## What I did NOT verify

<!--
The most useful section here. "Works locally, could not test the GPU path" is
more valuable than silence that implies full coverage.
-->

## Checklist

<!-- Absolute URLs on purpose. This text is rendered in a pull request body,
     whose base URL is .../pull/<n>, so a relative link like ../CONTRIBUTING.md
     resolves to a path that does not exist and 404s for the contributor. -->
- [ ] I have read [CONTRIBUTING.md](https://github.com/tomaszpe/barnaba-oss/blob/main/CONTRIBUTING.md) and this change is in one of the three open areas.
- [ ] This is **one logical change**.
- [ ] Tests are included for behavioural changes, or I have said why not.
- [ ] `npx vitest run` (in `app/`) and `python -m pytest -q` (in `whisper/`) pass locally, or I have said which I could not run.
- [ ] No secrets, credentials, real congregation names, or sermon transcript text in the diff — including in test fixtures.

<!--
If this touches the ASR/streaming core, the translation prompt, or the
latency-critical delivery path, please open a "Measurement claim" issue instead.
Those areas are closed to pull requests and this one will be closed with a
pointer back to CONTRIBUTING.md - not as a judgement, but because the change
cannot be reviewed by reading it.
-->
