param(
    [string]$Python = $env:MEDICAL_PYTHON,
    [string]$NodeHome = $env:MEDICAL_NODE_HOME,
    [string]$Config = $env:MEDICAL_CONFIG
)

$ErrorActionPreference = "Stop"
$ProductRoot = Split-Path -Parent $PSScriptRoot
$RepoRoot = Resolve-Path (Join-Path $ProductRoot "..\..")
$SidecarRoot = Join-Path $ProductRoot "sidecar"
$UiRoot = Join-Path $RepoRoot "ui"

if (-not $Python) {
    $portablePython = Join-Path $HOME ".pilotdeck-runtime\python-3.11.9-embed-amd64\python.exe"
    if (Test-Path $portablePython) {
        $Python = $portablePython
    } else {
        $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
        if ($pythonCommand) {
            $Python = $pythonCommand.Source
        }
    }
}
if (-not $Python -or -not (Test-Path $Python)) {
    throw "Python 3.11+ was not found. Set MEDICAL_PYTHON to python.exe."
}

if (-not $NodeHome) {
    $portableNode = Join-Path $HOME ".pilotdeck-runtime\node-v22.23.2-win-x64"
    if (Test-Path (Join-Path $portableNode "node.exe")) {
        $NodeHome = $portableNode
    }
}
if ($NodeHome) {
    $env:PATH = "$NodeHome;$env:PATH"
}

$nodeVersion = (& node --version).Trim()
if ($nodeVersion -notmatch "^v22\.") {
    throw "PilotDeck requires Node.js 22.13+ and below 23. Current: $nodeVersion"
}

$env:PILOTDECK_MEDICAL_SIDECAR_URL = "http://127.0.0.1:8765/"
$env:PILOTDECK_MEDICAL_SIDECAR_ALLOWED_PORTS = "8765"

if (-not $Config) {
    $candidateConfig = Join-Path $ProductRoot "config\medical.yaml"
    if (Test-Path $candidateConfig) {
        $Config = $candidateConfig
    }
}
$apiArguments = @("-m", "medical_sidecar.api")
$mcpArguments = @("-m", "medical_sidecar.mcp")
if ($Config) {
    $resolvedConfig = (Resolve-Path $Config).Path
    $apiArguments += @("--config", $resolvedConfig)
    $mcpArguments += @("--config", $resolvedConfig)
}

function Test-LocalPort([int]$Port) {
    return [bool](Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}

$ownedProcesses = @()
try {
    if (Test-LocalPort 8765) {
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:8765/v1/health" -TimeoutSec 3
            if ($health.service -ne "pilotdeck-medical-sidecar") {
                throw "Port 8765 belongs to a different service."
            }
        } catch {
            throw "Port 8765 is occupied but the PilotDeck medical sidecar health check failed."
        }
    } else {
        $ownedProcesses += Start-Process -FilePath $Python `
            -ArgumentList $apiArguments `
            -WorkingDirectory $SidecarRoot `
            -PassThru `
            -NoNewWindow
    }
    if (-not (Test-LocalPort 8766)) {
        $ownedProcesses += Start-Process -FilePath $Python `
            -ArgumentList $mcpArguments `
            -WorkingDirectory $SidecarRoot `
            -PassThru `
            -NoNewWindow
    }

    Push-Location $UiRoot
    try {
        & npm.cmd run dev
    } finally {
        Pop-Location
    }
} finally {
    foreach ($process in $ownedProcesses) {
        if ($process -and -not $process.HasExited) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
    }
}
