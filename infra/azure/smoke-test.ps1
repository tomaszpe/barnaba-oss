[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^https://')]
    [string] $ControlPlaneUrl,

    [Parameter(Mandatory)]
    [ValidatePattern('^https://')]
    [string] $GatewayUrl,

    [Parameter(Mandatory)]
    [ValidatePattern('^[a-z0-9]+$')]
    [string] $AzureSpeechRegion,

    [Parameter(Mandatory)]
    [ValidatePattern('^[a-z0-9]{5,50}$')]
    [string] $AcrName,

    [Parameter(Mandatory)]
    [string] $ResourceGroup,

    [string] $WhisperName = 'barnaba-whisper',

    [string] $GatewayName = 'barnaba-gateway',

    [ValidateRange(60, 1200)]
    [int] $StartupTimeoutSeconds = 900
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-AzureCliText {
    param([Parameter(Mandatory)][string[]] $Arguments)

    $output = (& az @Arguments)
    if ($LASTEXITCODE -ne 0) {
        throw "Azure CLI failed: az $($Arguments -join ' ')"
    }
    return ($output | Out-String).Trim()
}

function Get-RequiredEnvironmentValue {
    param([Parameter(Mandatory)][string] $Name)

    $value = [Environment]::GetEnvironmentVariable($Name)
    if ([string]::IsNullOrWhiteSpace($value)) {
        throw "Required environment variable $Name is missing."
    }
    return $value
}

function Invoke-ControlJson {
    param(
        [Parameter(Mandatory)][ValidateSet('GET', 'POST')][string] $Method,
        [Parameter(Mandatory)][string] $Path,
        [Parameter(Mandatory)][Microsoft.PowerShell.Commands.WebRequestSession] $Session,
        [string] $CsrfToken,
        [object] $Body
    )

    $headers = @{}
    if ($CsrfToken) {
        $headers['x-barnaba-csrf'] = $CsrfToken
    }
    $request = @{
        Method = $Method
        Uri = "${ControlPlaneUrl}${Path}"
        WebSession = $Session
        Headers = $headers
        TimeoutSec = $StartupTimeoutSeconds
    }
    if ($null -ne $Body) {
        $request.ContentType = 'application/json'
        $request.Body = ($Body | ConvertTo-Json -Compress)
    }
    return Invoke-RestMethod @request
}

function Invoke-Transcription {
    param(
        [Parameter(Mandatory)][string] $AudioPath,
        [Parameter(Mandatory)][string] $Password
    )

    $client = [System.Net.Http.HttpClient]::new()
    $form = [System.Net.Http.MultipartFormDataContent]::new()
    $stream = $null
    $audio = $null
    try {
        $client.DefaultRequestHeaders.Add('x-broadcaster-password', $Password)
        $stream = [System.IO.File]::OpenRead($AudioPath)
        $audio = [System.Net.Http.StreamContent]::new($stream)
        $audio.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::new('audio/wav')
        $form.Add($audio, 'audio', 'synthetic-smoke.wav')
        $response = $client.PostAsync("${GatewayUrl}/api/transcribe", $form).GetAwaiter().GetResult()
        $payload = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        if (-not $response.IsSuccessStatusCode) {
            throw "Gateway transcription failed with HTTP $([int]$response.StatusCode)."
        }
        return $payload | ConvertFrom-Json
    }
    finally {
        if ($audio) { $audio.Dispose() }
        if ($stream) { $stream.Dispose() }
        $form.Dispose()
        $client.Dispose()
    }
}

function Wait-ForStoppedApps {
    param([ValidateRange(10, 300)][int] $TimeoutSeconds = 120)

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $whisperState = Invoke-AzureCliText @(
            'containerapp', 'show', '--resource-group', $ResourceGroup,
            '--name', $WhisperName, '--query', 'properties.runningStatus', '--output', 'tsv'
        )
        $gatewayState = Invoke-AzureCliText @(
            'containerapp', 'show', '--resource-group', $ResourceGroup,
            '--name', $GatewayName, '--query', 'properties.runningStatus', '--output', 'tsv'
        )
        if ($whisperState -eq 'Stopped' -and $gatewayState -eq 'Stopped') {
            return
        }
        Start-Sleep -Seconds 5
    } while ([DateTimeOffset]::UtcNow -lt $deadline)

    throw "Container Apps did not stop in time (Whisper=$whisperState, Gateway=$gatewayState)."
}

$broadcasterPassword = Get-RequiredEnvironmentValue 'BROADCASTER_PASSWORD'
$speechKey = Get-RequiredEnvironmentValue 'AZURE_SPEECH_KEY'
$session = [Microsoft.PowerShell.Commands.WebRequestSession]::new()
$audioPath = Join-Path ([System.IO.Path]::GetTempPath()) "barnaba-oss-smoke-$([guid]::NewGuid().ToString('N')).wav"
$startedAt = [DateTimeOffset]::UtcNow
$csrfToken = $null
$startAttempted = $false
$shutdownConfirmed = $false
$smokePassed = $false

try {
    $health = Invoke-RestMethod -Method Get -Uri "${ControlPlaneUrl}/health" -TimeoutSec 30
    if ($health.status -ne 'ok') {
        throw 'Control-plane health endpoint did not report ok.'
    }

    Invoke-ControlJson -Method POST -Path '/api/control/login' -Session $session -Body @{
        password = $broadcasterPassword
    } | Out-Null
    $csrfCookie = $session.Cookies.GetCookies([uri]$ControlPlaneUrl)['barnaba_csrf']
    if (-not $csrfCookie -or [string]::IsNullOrWhiteSpace($csrfCookie.Value)) {
        throw 'Control-plane login did not issue a CSRF cookie.'
    }
    $csrfToken = $csrfCookie.Value

    $startAttempted = $true
    $startResult = Invoke-ControlJson -Method POST -Path '/api/control/start-system' `
        -Session $session -CsrfToken $csrfToken
    if (-not $startResult.success) {
        throw 'Control-plane did not complete start-system successfully.'
    }

    $status = Invoke-ControlJson -Method GET -Path '/api/control/status' -Session $session
    if (-not $status.systemReady -or -not $status.whisper.health.model_loaded) {
        throw 'System status is not ready with model_loaded=true after start-system.'
    }
    $readyAt = [DateTimeOffset]::UtcNow

    $speechUri = "https://${AzureSpeechRegion}.tts.speech.microsoft.com/cognitiveservices/v1"
    $ssml = "<speak version='1.0' xml:lang='de-DE'><voice name='de-DE-KatjaNeural'>Guten Morgen. Klarheit, Ruhe und Hoffnung.</voice></speak>"
    Invoke-WebRequest -Method Post -Uri $speechUri -OutFile $audioPath -TimeoutSec 120 -Headers @{
        'Ocp-Apim-Subscription-Key' = $speechKey
        'X-Microsoft-OutputFormat' = 'riff-16khz-16bit-mono-pcm'
        'User-Agent' = 'barnaba-oss-reference-smoke'
    } -ContentType 'application/ssml+xml' -Body $ssml | Out-Null
    if ((Get-Item -LiteralPath $audioPath).Length -le 44) {
        throw 'Azure Speech produced an empty or invalid WAV payload.'
    }

    $transcription = Invoke-Transcription -AudioPath $audioPath -Password $broadcasterPassword
    if (-not $transcription.success -or [string]::IsNullOrWhiteSpace($transcription.text)) {
        throw 'The A100 smoke test returned an empty transcription.'
    }

    $stopResult = Invoke-ControlJson -Method POST -Path '/api/control/stop-all' `
        -Session $session -CsrfToken $csrfToken
    if (-not $stopResult.success) {
        throw 'Control-plane did not accept stop-all after the transcription check.'
    }
    Wait-ForStoppedApps
    $shutdownConfirmed = $true

    $sourceCommit = (& git -C (Join-Path $PSScriptRoot '..\..') rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $sourceCommit -notmatch '^[0-9a-f]{40}$') {
        throw 'Cannot resolve the full public candidate commit.'
    }
    $digests = [ordered]@{}
    foreach ($repository in @(
        'barnaba-whisper-base',
        'barnaba-whisper',
        'barnaba-gateway',
        'barnaba-control-plane'
    )) {
        $digest = Invoke-AzureCliText @(
            'acr', 'repository', 'show-manifests', '--name', $AcrName,
            '--repository', $repository,
            '--query', "[?tags[?@=='$sourceCommit']].digest | [0]",
            '--output', 'tsv'
        )
        if ($digest -notmatch '^sha256:[0-9a-f]{64}$') {
            throw "No immutable digest found for ${repository}:$sourceCommit."
        }
        $digests[$repository] = $digest
    }

    $smokePassed = $true
    [pscustomobject]@{
        gate = 'AZURE_REFERENCE_DEPLOYMENT_PASS'
        passed = $true
        publicCommit = $sourceCommit
        startedAtUtc = $startedAt.ToString('o')
        completedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
        readinessSeconds = [math]::Round(($readyAt - $startedAt).TotalSeconds, 1)
        region = $AzureSpeechRegion
        workloadProfile = 'Consumption-GPU-NC24-A100'
        transcriptionCharacters = $transcription.text.Length
        model = $transcription.model
        imageDigests = $digests
        shutdownConfirmed = $shutdownConfirmed
    } | ConvertTo-Json
}
finally {
    if ($startAttempted -and -not $shutdownConfirmed -and $csrfToken) {
        try {
            Invoke-ControlJson -Method POST -Path '/api/control/stop-all' `
                -Session $session -CsrfToken $csrfToken | Out-Null
        }
        catch {
            Write-Error 'Emergency shutdown through control-plane failed. Stop the gateway and Whisper Container Apps manually.'
        }
    }
    if (Test-Path -LiteralPath $audioPath) {
        Remove-Item -LiteralPath $audioPath -Force
    }
    if (-not $smokePassed) {
        Write-Error 'AZURE_REFERENCE_DEPLOYMENT_PASS was not achieved.'
    }
}
