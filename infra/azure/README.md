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
- an Azure OpenAI endpoint and key;
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
profile, an Azure Files model cache, and separate managed identities for image pulls and
control-plane operations. ACR admin credentials remain disabled.

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
16 characters. Pass secrets as secure deployment parameters or Key Vault references
according to your organization's policy.

```powershell
az deployment group create `
  --resource-group barnaba-oss-rg `
  --template-file infra/azure/apps.bicep `
  --parameters @C:\secure\barnaba.parameters.json
```

The gateway and control-plane are public HTTPS endpoints. Whisper has internal ingress
only: it has no end-user authentication and must not be exposed directly.

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
