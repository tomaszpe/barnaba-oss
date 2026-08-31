[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[a-z0-9]{5,50}$')]
    [string] $AcrName,

    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9a-f]{40}$')]
    [string] $ImageTag
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-AzureCli {
    param([Parameter(Mandatory)][string[]] $Arguments)

    & az @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Azure CLI failed with exit code ${LASTEXITCODE}: az $($Arguments -join ' ')"
    }
}

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    throw 'Azure CLI is required. Local Docker is not required.'
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw 'Git is required to verify image provenance.'
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$sourceStatus = (& git -C $repoRoot status --porcelain --untracked-files=all)
if ($LASTEXITCODE -ne 0) {
    throw 'Cannot read the source tree status.'
}
if ($sourceStatus) {
    throw 'Refusing to build from a dirty source tree. Commit or remove every change first.'
}

$sourceHead = (& git -C $repoRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $sourceHead -notmatch '^[0-9a-f]{40}$') {
    throw 'Cannot resolve a full source commit.'
}
if ($sourceHead -cne $ImageTag) {
    throw "ImageTag must equal source HEAD ($sourceHead)."
}

Invoke-AzureCli @('account', 'show', '--output', 'none')
$registryServer = (& az acr show --name $AcrName --query loginServer --output tsv)
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($registryServer)) {
    throw "Cannot read ACR '$AcrName'. Deploy foundation.bicep first and verify Azure access."
}

$baseImage = "$registryServer/barnaba-whisper-base:$ImageTag"

Invoke-AzureCli @(
    'acr', 'build', '--registry', $AcrName,
    '--image', "barnaba-whisper-base:$ImageTag",
    '--file', (Join-Path $repoRoot 'whisper/Dockerfile.base'),
    (Join-Path $repoRoot 'whisper')
)

Invoke-AzureCli @(
    'acr', 'build', '--registry', $AcrName,
    '--image', "barnaba-whisper:$ImageTag",
    '--build-arg', "WHISPER_BASE_IMAGE=$baseImage",
    '--file', (Join-Path $repoRoot 'whisper/Dockerfile'),
    (Join-Path $repoRoot 'whisper')
)

Invoke-AzureCli @(
    'acr', 'build', '--registry', $AcrName,
    '--image', "barnaba-gateway:$ImageTag",
    '--file', (Join-Path $repoRoot 'app/Dockerfile'),
    (Join-Path $repoRoot 'app')
)

Invoke-AzureCli @(
    'acr', 'build', '--registry', $AcrName,
    '--image', "barnaba-control-plane:$ImageTag",
    '--file', (Join-Path $repoRoot 'app/Dockerfile.control-plane'),
    (Join-Path $repoRoot 'app')
)

Write-Host "Built four Azure ACR images with immutable source tag $ImageTag."
