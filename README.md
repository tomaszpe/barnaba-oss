# Barnaba

Live sermon or speech translation. Speech in Swiss German is transcribed, translated into
multiple languages, and delivered as speech in real time. Built to serve
Christian churches, municipal assemblies, hospitals, schools, integration services and other non-commercial use cases.
.

## Status

Barnaba is **under active development**. It has been run in internal tests with one
congregation in Switzerland. There is **no public release, no public preview, and no
commercial offering**. Quality and delivery work is ongoing and measured against sealed
recordings; this README deliberately carries no numbers, because a number without its
measurement protocol is not evidence.

Please read the [third-party model licensing](#third-party-models-and-services) section
before deploying this anywhere. It is the part most people miss.

## Requirements

Read this before you start. The hardware requirement is real and it is the first thing
most people hit.

| | |
|---|---|
| **GPU** | **Required.** NVIDIA, CUDA 12.x, fp16. **CPU is not supported** — not "slower", but the streaming pipeline stops keeping up with speech, which makes the product pointless. There is no CPU deployment, on purpose. |
| **VRAM** | Minimum **8 GB**. **16 GB or more** recommended with `WHISPER_NUM_WORKERS>1`. (large-v3-turbo weights in fp16 are ≈1.6 GB, the rest is activations.) |
| **Reference hardware** | A single **NVIDIA A100**. Everything below was measured there. |
| **Measured latency** | Whisper **p50 2.5–2.8 s** on that A100; the dominant end-to-end mode is ≈4.4 s. On a weaker card this **grows** — we have not measured by how much, so no multiplier is given here. |
| **Model weights** | **Not in this repository.** The first start downloads ≈1.6 GB into `WHISPER_DOWNLOAD_ROOT`. The Azure template mounts an Azure Files cache so scale-to-zero does not force another download. |
| **Cold start** | **Minutes, not seconds.** In the reference deployment a Whisper start took **7+ minutes**, most of it waiting for a free GPU node; timeouts are set to 12 minutes accordingly. |
| **Node.js** | **22.12 or newer**, and **24 (LTS) is what CI runs**. Node 20 is deliberately excluded even though the lockfile would tolerate it: it reached end of life on **30 April 2026** and no longer receives security fixes. `app/package.json` declares `^22.12.0 \|\| >=24.0.0` — the lower bound is `vite` 8.2.2's, not a preference. |
| **Python** | 3.11 (the image ships 3.11; the test suite also runs on 3.12+). |
| **Azure** | The maintained reference deployment uses Azure Container Registry and Azure Container Apps. Local Docker is not required or supported. ACR builds the OCI images remotely from the repository's Dockerfiles. |

### Cost, order of magnitude

A single A100 on demand at a large provider is **roughly 2–4 USD/hour** (2026,
pay-as-you-go). For a ~40-minute sermon/speech translation including cold start that is **ca. 10 CHF**, *including* translation and text-to-speech. Note: costs grow **linearly with
the number of target languages** but they're pretty low anyway. **Check your own provider** — GPU pricing moves fast.
These are third-party list prices, not a measurement of ours, and this project publishes
no cost-per-minute figure of its own.

This is affordable only because the GPU is **started before a service and stopped after
it**. Running an A100 around the clock is a different order of cost, and the architecture
assumes you will not.

### Working on Barnaba without a GPU

**The unit tests do not need a GPU.** `whisper/mock_whisper.py` stands in for the model,
so the full Python and JavaScript suites run on an ordinary machine and in CI. A GPU is
needed to *run the service*, not to *work on the code* — all three areas open to
contributions in [CONTRIBUTING.md](CONTRIBUTING.md) are reachable without one.

```bash
cd app && npm ci && npx vitest run
```

```bash
cd whisper
pip install torch==2.5.1 torchaudio==2.5.1 --index-url https://download.pytorch.org/whl/cpu
pip install -r requirements-test.txt
python -m pytest -q
```

The Torch line is not optional and not a convenience. `requirements.txt` leaves
`torch` and `torchaudio` commented out, because the image installs CUDA builds
from a different index; without the first command `pip install -r requirements-test.txt`
succeeds and then `pytest` cannot import the modules under test. The versions are
the ones `whisper/Dockerfile.base` builds and the ones CI installs, so a green run
here means the same thing a green run there does.

## Quick start on Azure

**New here? Follow the step-by-step guide with screenshots:
[docs/GETTING_STARTED.md](docs/GETTING_STARTED.md).** It covers deployment, the first
start with the starter broadcaster password `Barnaba2026&!`, broadcasting, the listener
app, stopping, and changing that password.

Barnaba has one maintained deployment path: Azure Container Registry plus Azure Container
Apps. Whisper runs on the `Consumption-GPU-NC24-A100` workload profile; gateway and
control-plane run on the Consumption profile. Local Docker and local runtime deployment
are deliberately outside the supported surface.

Before starting, obtain A100 quota in a supported Azure region and prepare Azure OpenAI
and Azure Speech resources. Give the `gpt-4.1` deployment about 50,000 tokens per minute for
each language listeners will use; too little shows up as silences, not as an error
([details](docs/GETTING_STARTED.md#2-before-you-start)). Then, from a clean clone:

```powershell
az group create --name barnaba-oss-rg --location swedencentral
az deployment group create `
  --resource-group barnaba-oss-rg `
  --template-file infra/azure/foundation.bicep `
  --parameters prefix=barnaba acrName=<globally-unique-acr-name>
```

Build all images remotely in ACR, using the full source commit as their immutable tag:

```powershell
$sha = git rev-parse HEAD
./infra/azure/build-images.ps1 -AcrName <globally-unique-acr-name> -ImageTag $sha
```

Finally, copy `infra/azure/parameters.example.json` outside the repository, replace every
placeholder, and deploy `infra/azure/apps.bicep`. The parameters include the church
whitelist, a six-digit `ACCESS_PIN`, `BROADCASTER_PASSWORD`, and your Azure provider
credentials; never commit the completed file.

The complete procedure, security boundaries, and required live smoke test are in
[infra/azure/README.md](infra/azure/README.md). A successful ARM deployment is not enough:
the release gate requires a real A100 start, Whisper readiness, a synthetic audio
transcription through the gateway, and a verified stop of the two on-demand apps.

## Data handling and logs

Barnaba processes live speech and sermon-preparation material. Audio is sent to the
Whisper endpoint you configure; source text and sermon context are sent to the configured
translation service; text-to-speech output is requested from the configured speech
service. Those services have their own data-processing and retention terms. The operator
is responsible for access control, participant notice or consent where required, and an
appropriate retention policy.

Normal gateway and ASR process logs contain operational metadata such as lengths, timing
and reason codes, not sermon or translation text. Two opt-in features are intentionally
different:

- `EVAL_LOGGING_ENABLED=true` writes full source text and translations to
  `app/logs/eval-*.jsonl` for controlled quality evaluation. It is **off by default**.
- listener feedback can store the congregation id, language, selected reason and an
  optional free-text note in `app/logs/feedback-*.jsonl`.

Treat `app/logs` as sensitive, access-controlled data. Do not commit it, and delete or
archive it according to your retention policy. The repository's `.gitignore` excludes it,
but that does not protect a mounted volume or external log collector.

The Whisper API has no end-user authentication. The Azure reference template therefore
uses internal Container Apps ingress: the gateway and control-plane can reach Whisper,
but the public internet cannot. Do not change Whisper ingress to `external: true` or
otherwise expose this service directly.

## Map of the code

`app/server.js` is 8 500 lines, so here is where to start reading.

**Gateway (`app/`, Node.js — 77 modules, 112 test files)**

| Path | What it is |
|---|---|
| `server.js` | HTTP + WebSocket entry point, session state, and the emission path. The big one. |
| `whisperClient.js` | Calls the Whisper service; owns the streaming session and request tracking. |
| `translationService.js` | Prompt construction and the translation provider call. |
| `ttsService.js` | Text-to-speech, SSML construction, voice selection. |
| `sentenceService.js`, `sentenceSplitter.js` | Sentence accumulation and splitting. |
| `emissionController.js`, `flowGovernor.js`, `playbackPolicy.js` | When a translated unit is released to listeners. |
| `intraEmissionDedupService.js`, `hgDedupService.js`, `t5DedupPolicy.js` | The de-duplication filter chain. |
| `glossary/` | Theological glossary and per-congregation term configuration. |
| `public/` | The listener PWA (`index.html`), broadcaster (`node.html`) and admin panel (`admin.html`). |
| `control-plane.js` | Always-on Azure service that starts and stops the on-demand gateway and Whisper Container Apps. |

**ASR service (`whisper/`, Python — 30 modules, 36 test files, all run)**

| Path | What it is |
|---|---|
| `whisper_service.py` | FastAPI service, the decode loop, and session state. |
| `local_agreement.py` | The LocalAgreement stabiliser: which prefix is considered confirmed. |
| `ring_buffer.py` | Growing audio buffer and the absolute sample axis. |
| `vad_processor.py` | Silero voice activity detection (pinned to a commit SHA). |
| `hallucination_filter.py` | Rejects Whisper loop and boilerplate output. |
| `provenance.py`, `chunk_diagnostics.py`, `token_timestamp_probe.py` | Evidence that a piece of emitted text came from a specific span of audio. |
| `mock_whisper.py` | Stand-in for the model, so tests need no GPU. |
| `test_startup_safety.py` | The two refusals: an unverified model, and a model that will not load. |

The counts above are of this repository, and are meant to be checkable rather
than impressive: 77 = `app/**/*.js|mjs` excluding `__tests__/`; 111 =
`app/__tests__/**/*.test.mjs`; 30 = `whisper/*.py` excluding `test_*.py`; 36 =
the public `whisper/test_*.py` files, all collected by pytest. Three stale
operator scripts from the private tree are deliberately not exported: they
depended on the retired faster-whisper CPU pipeline and no longer represented
the service documented here. Earlier revisions of this section quoted numbers
from the private tree, which is larger.

## License

Except for the separately licensed logo files identified in
[TRADEMARKS.md](TRADEMARKS.md), Barnaba is licensed under the **GNU Affero General
Public License v3.0 or later (AGPL-3.0-or-later)** — see [LICENSE](LICENSE). In
short: you are free to use, study, modify, and share it, but if you run a modified
version as a network service, you must make your modified source available to its
users under the same license.

## No commercial license

Barnaba is a **non-commercial project**. There is no commercial edition, no proprietary
variant, and none is offered for sale. The AGPL-3.0 above is the only license under which
this code is made available.

This is not merely a preference. The speech-recognition model used by the reference
deployment is published under a **NonCommercial** license (see below), so a commercial
deployment would have to substitute a different model regardless of how this code were
licensed.

Questions about use, deployment, or licensing: **tomaszpe@barnaba.ch**.

## Third-party models and services

Barnaba is application code. **It does not contain and does not redistribute** the
machine-learning models or cloud services it calls — they are configured, not bundled.
Each carries its own license and terms, and complying with them is your responsibility.

One of these matters more than the rest. The speech-recognition model configured by
default, `Flurin17/whisper-large-v3-turbo-swiss-german`, is **currently published under
CC BY-NC 4.0** — Creative Commons Attribution-**NonCommercial** 4.0. Running Barnaba
commercially with that model is not permitted by the model's license, independently of the
terms of this project's own license. A commercial deployment must substitute a model whose
license permits commercial use.

To be precise, because the difference is easy to misuse: this project pins a **specific
revision**, and the model card *at that revision* declares `apache-2.0`. The repository was
relicensed to CC BY-NC 4.0 afterwards. **The code does pull exactly that snapshot — what it
does not do is read a commercial right into the licence string on it.** The distinction
matters: we rely on the revision for reproducibility, and decline to rely on its old
licence metadata as a grant. Treat the model as non-commercial and check the terms at the
revision you actually deploy — the licence a model repository carries is a property of the
revision you pull, not a fact about the name.

### Substituting the model is gated in code

Because the paragraph above tells a commercial deployment to use a different
model, and because a licence change is not a security review, the substitution
is deliberately not silent. `whisper/config.py` refuses to start on any
model/revision pair other than the one whose `config.json` was inspected, unless
`WHISPER_ALLOW_UNVERIFIED_MODEL=true` is set.

The reason is `transformers` 4.57.5, pinned in `whisper/requirements.txt`. Every
version before 5.3.0 is affected by **CVE-2026-4372**
([GHSA-29pf-2h5f-8g72](https://github.com/advisories/GHSA-29pf-2h5f-8g72)): a
crafted `config.json` can execute code from an attacker-controlled repository
*even with* `trust_remote_code=False`. The pin is accepted only because the
`config.json` at that exact revision was read and contains no
`_attn_implementation_internal`, no `auto_map` and no `trust_remote_code`.

**A full 40-character SHA guarantees immutability, not trustworthiness.** It
proves you get the same bytes every time; it says nothing about whose bytes they
are. Before setting the flag, read the `config.json` of the revision you intend
to pin and confirm those three keys are absent. Upgrading to `transformers`
>= 5.3.0 removes the vulnerability and is the real fix; `whisper/requirements.txt`
describes what qualifying 5.x involves.

We make no claim about the licensing of any third-party model or dataset beyond
pointing at the terms published by their owners. See [NOTICE](NOTICE).

## Trademark and logo

The two Barnaba logo files are excluded from the AGPL and carry a separate,
limited permission: they may be redistributed **unmodified** only as part of this
repository and its forks. No trademark license or right to imply endorsement is
granted. The AGPL does not grant rights in project names or trademarks. See
[NOTICE](NOTICE) and [TRADEMARKS.md](TRADEMARKS.md) for the exact terms.

## Contributing

Contributions are welcome. There is no Contributor License Agreement. Contributors keep
their copyright and submit changes for distribution under this project's
AGPL-3.0-or-later license; no separate relicensing grant is requested.

Read [CONTRIBUTING.md](CONTRIBUTING.md) first. It states which areas of the project
are open to contributions and which are not, so that you do not spend an evening on
a pull request that will be closed.

Security issues: please do **not** open a public issue. See [SECURITY.md](SECURITY.md).

## Release rhythm

This repository is an **export**. Development happens in a private repository and lands
here in batches rather than commit by commit. A gap between commits is the normal rhythm
of the project, not an abandoned repository.

[Full GNU Affero General Public License v3.0 terms](https://www.gnu.org/licenses/agpl-3.0.html)
