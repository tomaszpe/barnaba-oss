# Contributing to Barnaba

Thank you for considering a contribution. Please read this page before you write code —
it exists so that you do not spend an evening on a pull request that will be closed.

## License of contributions

Barnaba does not require a Contributor License Agreement. You keep the copyright to your
work. By intentionally submitting a contribution for inclusion in Barnaba, you agree
that it may be distributed under the project's AGPL-3.0-or-later license. No separate
right to relicense your contribution is requested.

Only submit work that you have the right to contribute. Identify third-party material
and its license in the pull request; do not assume that public availability means that a
file can be copied into this project.

## What we are looking for

Contributions are welcome in **three areas**:

**1. Language coverage.** Theological and liturgical terminology for the supported target
languages, the liturgical phrase cache, and UI localization. This is where a native
speaker with a church background is worth more than any amount of engineering. If you
speak one of the target languages and have sat through services in it, we want to hear
from you.

**2. Reproducibility and measurement.** Tests, evaluation tooling, and anything that makes
a claim about the system checkable by someone who did not write it.

**3. Azure deployment reproducibility.** ACR builds, Azure Container Apps templates,
managed identity, secret handling, observability, and checks that make the documented
A100 reference deployment reproducible without access to Barnaba's private Azure
resources.

## What we are not looking for

The following areas are **closed to outside contributions**, and PRs touching them will be
closed with a pointer back to this page. This is not a judgment about the code or about
you; it is that a change in these areas cannot be reviewed by reading it.

- **The ASR and streaming core** — voice activity detection, the LocalAgreement stabilizer,
  the deduplication filter chain, and the emission/fallback policy. These parameters are
  empirically tuned against sealed recordings, and several intuitively-better values have
  been measured and rejected. Changing them requires a sealed A/B run, not a code review.
- **The translation model and prompt.** The model choice and prompt structure are fixed by
  a blind A/B protocol. A prompt that reads better is not evidence.
- **The latency-critical delivery path** — the audio queue, playback scheduling, and the
  listener transport. This path has an open quality investigation with its own measurement
  protocol.
- **Alternative cloud deployment stacks.** Azure is the only maintained reference path.
  You may adapt the AGPL code elsewhere, but this project does not accept AWS, GCP,
  Kubernetes, or local-runtime deployment definitions as maintained product surface.

If you believe you have a real improvement in one of these areas, **open an issue with the
measurement**, not a pull request with the change. If the measurement holds up, we will run
it through the protocol ourselves and credit you.

## Practical notes

- **Start with an issue** for anything larger than a typo. It costs you five minutes and
  can save you a weekend.
- **One logical change per pull request.** Mixed PRs are hard to review and harder to
  revert.
- **Tests are expected** for behavioral changes. Look at the existing tests to see the
  level of detail we work at.
- **Never commit secrets**, including in test fixtures. Configuration goes through
  environment variables; see `.env.example`.
- **Be plain about what you did not verify.** A PR that says "unit tests pass; I did not
  run the Azure A100 path" is more useful than one that implies full deployment coverage.

## Reporting a security issue

Please do **not** open a public issue for a security vulnerability. Write to
**tomaszpe@barnaba.ch** with the details and give us a reasonable window to respond
before disclosing.

## Code of conduct

Be decent to each other. This project serves congregations, and people from many
traditions and none are welcome to work on it. Disagreement about technical matters is
expected and healthy; contempt is not.
