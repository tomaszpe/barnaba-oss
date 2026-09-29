# Azure reference deployment

Azure is the only deployment path maintained by the Barnaba project. The reference
topology uses Azure Container Registry and three Azure Container Apps:

- Whisper on an NVIDIA A100 consumption GPU workload profile;
- gateway on the Consumption workload profile;
- control-plane on the Consumption workload profile, with a managed identity scoped to
  starting and stopping the gateway and Whisper apps.

No local Docker installation is required. Azure Container Registry builds the OCI images
from the repository's Dockerfiles. The Dockerfiles are build inputs, not a supported
local runtime.

## Prerequisites

- an Azure subscription and Azure CLI;
- the `containerapp` Azure CLI extension;
- A100 quota in a region that supports `Consumption-GPU-NC24-A100`;
- an Azure OpenAI endpoint and key, with a `gpt-4.1` deployment of about 50,000 tokens per
  minute for each language listeners will use (see
  [docs/GETTING_STARTED.md](../../docs/GETTING_STARTED.md#2-before-you-start));
- an Azure Speech resource and key.

Check profile availability before spending anything:

```powershell
az containerapp env workload-profile list-supported --location swedencentral --output table
```

GPU availability and quota change independently of this repository. If the A100 profile
is absent, stop. Do not silently substitute a T4 and call the reference deployment
qualified; its latency has not been measured by this project.

## 1. Deploy the foundation

Choose names that contain no customer or congregation identifier.

```powershell
az group create --name barnaba-oss-rg --location swedencentral `
  --tags project=barnaba environment=dev owner=<owner> managed-by=bicep system=oss-reference
az deployment group create `
  --resource-group barnaba-oss-rg `
  --template-file infra/azure/foundation.bicep `
  --parameters prefix=barnaba acrName=<globally-unique-acr-name> ownerTag=<owner> environmentTag=dev
```

The foundation contains ACR, a workload-profile Container Apps environment, the A100
profile, an Azure Files model cache, an Azure Files share for listener feedback, and
separate managed identities for image pulls and control-plane operations. ACR admin
credentials remain disabled.

## 2. Build in ACR

Use the full source commit as the image tag. The script fails closed on abbreviated tags
and dirty source trees, requires the tag to equal `HEAD`, and builds all four images
remotely. It may be invoked from any working directory.

```powershell
$sha = git rev-parse HEAD
./infra/azure/build-images.ps1 -AcrName <globally-unique-acr-name> -ImageTag $sha
```

This builds the Whisper base first and passes its ACR reference explicitly into the
Whisper build. No image comes from a Barnaba-owned private registry.

## 3. Deploy the apps

Copy `parameters.example.json` outside the repository, replace every placeholder and
empty secure value, and do not commit the resulting file. The template rejects empty
keys, a PIN that is not exactly six characters, and a broadcaster password shorter than
13 characters. Pass secrets as secure deployment parameters or Key Vault references
according to your organization's policy.

The example file already contains the starter broadcaster password `Barnaba2026&!`.
It is public, because it is printed in this repository. Change it right after the
first successful start, as described in
[docs/GETTING_STARTED.md](../../docs/GETTING_STARTED.md#8-change-the-broadcaster-password).

```powershell
az deployment group create `
  --resource-group barnaba-oss-rg `
  --template-file infra/azure/apps.bicep `
  --parameters @C:\secure\barnaba.parameters.json
```

The gateway and control-plane are public HTTPS endpoints. Whisper has internal ingress
only: it has no end-user authentication and must not be exposed directly.

Azure creates every Container App running. The template ends with a deployment script
(`stopServiceApps`) that stops Whisper and the gateway with the control-plane identity, so no
A100 replica runs until the operator starts the system. The script runs only on the first
deployment; redeploying with a new password or PIN does not stop a running service.

For congregations in Switzerland, [docs/GETTING_STARTED.md](../../docs/GETTING_STARTED.md#churches-and-organisations-in-switzerland)
recommends Switzerland North for Azure OpenAI and Azure Speech. The apps stay in a region
with an A100, because Switzerland North offers none.

### Pipeline settings

`reference-settings.json` holds the settings of the project's reference environment:
sentence buffering, parallel translation and speech delivery, duplicate removal,
fallbacks for late text, and the listener features. `apps.bicep` passes the `gateway`
group to the gateway and the `listener` group to both the gateway and the control-plane,
because the listener app reads its features from whichever of the two served it. The
defaults in the code are more conservative. Removing a setting changes latency and
translation behaviour, not only logging. Logging that stores sermon text on the container
disk (`EVAL_LOGGING_ENABLED`) is not part of the reference settings and stays off.

### Listener feedback

Listeners can report problems from their phone. The control-plane appends each report as
one JSON line to the `listener-feedback` Azure Files share, mounted at `/app/feedback`,
under a directory named by `feedbackEnvironment` (default: the prefix). The control-plane
does not start without `FEEDBACK_STORAGE_ROOT` and `FEEDBACK_ENVIRONMENT`, and it refuses
to save a report when the share is not mounted. It is the only writer of these files, so
it must keep exactly one replica. Reports can contain free text and an optional email
address typed by listeners: limit access to the storage account accordingly.

## 4. Qualification smoke test

The deployment is not qualified merely because ARM reports `Succeeded`.

1. Open the control-plane URL returned by the deployment.
2. Start the system and wait for Whisper readiness. Allow up to 12 minutes for GPU
   allocation, image pull, model download, and warm-up.
3. Confirm that the gateway becomes ready only after Whisper reports `model_loaded=true`.
4. Run `smoke-test.ps1`. It creates a neutral, synthetic speech sample through the
   configured Azure Speech resource, sends it through the authenticated gateway and
   requires a non-empty transcription. The distributed `silent-noise.wav` is a browser
   keep-alive asset and is deliberately not a transcription fixture.
5. Stop the system and confirm that the Whisper and gateway Container Apps report
   `Stopped` while control-plane remains running.
6. Record the source SHA, ACR image digests, Azure region, workload profile, readiness
   time, and result. This evidence is the `AZURE_REFERENCE_DEPLOYMENT_PASS` gate.

The templates and static tests cannot close that gate. It requires a real Azure A100
deployment built from the public export.

The smoke script reads `BROADCASTER_PASSWORD` and `AZURE_SPEECH_KEY` from the process
environment. It does not accept either secret as a command-line parameter. It attempts
`stop-all` in a `finally` block even when synthesis, transcription or an assertion fails.

```powershell
$env:BROADCASTER_PASSWORD = '<secret>'
$env:AZURE_SPEECH_KEY = '<secret>'
./infra/azure/smoke-test.ps1 `
  -ControlPlaneUrl <control-plane-url> `
  -GatewayUrl <gateway-url> `
  -AzureSpeechRegion swedencentral `
  -AcrName <acr-name> `
  -ResourceGroup barnaba-oss-rg
```
