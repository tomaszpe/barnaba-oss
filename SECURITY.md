# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.**

Use one of these, in order of preference:

1. **GitHub Private Vulnerability Reporting** — the "Report a vulnerability" button on the
   Security tab of this repository. This is the preferred channel: it keeps the report,
   the discussion and the fix in one place, privately.
2. **Email: tomaszpe@barnaba.ch** — if private reporting is unavailable to you.

Please include what you did, what you expected, and what happened, plus anything needed to
reproduce it. A proof of concept is welcome but not required.

## What to expect

This project is **maintained part-time by one person**. Being honest about that is more
useful than publishing a response time nobody can hold to:

- We aim to acknowledge a report within **7 days**.
- We will tell you whether we consider it a vulnerability, and why, rather than going
  quiet.
- If a fix is warranted we will agree a disclosure timeline with you. If we cannot fix
  something, we will say so and explain what a deployer can do instead.

There is **no bug bounty** and no payment.

## Scope

**In scope** — the code in this repository:

- The gateway (`app/`), including authentication, session handling, the WebSocket
  transport, and the CSRF and rate-limiting logic.
- The ASR service (`whisper/`), including its HTTP surface.
- Anything that causes source audio, transcripts or translated text to reach a place it
  should not — that is the confidentiality property this project cares about most.
- The container definitions and `docker-compose.yml` in this repository.

**Out of scope:**

- **Third-party services and models.** Azure OpenAI, Azure Speech, Hugging Face and the
  ASR model itself are configured, not bundled. Report those to their owners.
- **Any deployment you or a third party run.** This repository is application code; a
  specific instance is not ours.
- **The reference deployment's infrastructure.** It is not part of this repository and its
  configuration is not published here.
- Missing hardening that the documentation already calls out as the deployer's
  responsibility — for example running without TLS in front of the gateway. If the
  documentation is what is wrong, that is a valid documentation issue.

## Things worth knowing before you report

These are known properties of the design, not undiscovered bugs:

- **`ACCESS_PIN` is a single shared six-digit PIN** for all listeners of a deployment. It
  is a low-friction gate for a congregation, not an identity system. Rate limiting exists;
  a six-digit shared secret is still a six-digit shared secret.
- **`BROADCASTER_PASSWORD` is a single shared password** for broadcaster and admin access.
- **`app/config/churches.json` is deployment data** and names real congregations. It is
  gitignored, mounted read-only, and deliberately kept out of the container image. If you
  find a path where it can leak, that is very much in scope.
- **Transcripts and translations are the sensitive payload.** Log lines are written to
  avoid carrying source text; if you find one that does, please report it — several such
  leaks have been fixed and the sanitisation is allowlist-based for that reason.
