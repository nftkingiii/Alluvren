param(
    [switch]$KeepRunning
)

$ErrorActionPreference = 'Stop'
$ProjectId = 'project-08dd2671-6b2a-40b1-b72'
$Zone = 'us-central1-a'
$Instance = 'alluvren-bitsafe'
$RemoteScript = '/tmp/alluvren-recover-localnet.sh'
$ScriptStartedVm = $false
$LocalScript = Join-Path $PSScriptRoot 'recover-localnet.sh'

function Invoke-Gcloud {
    param([Parameter(Mandatory)][string[]]$Arguments)
    $result = & gcloud @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "gcloud failed ($LASTEXITCODE): $($result -join [Environment]::NewLine)"
    }
    return $result
}

function Get-InstanceStatus {
    (Invoke-Gcloud @(
        'compute', 'instances', 'describe', $Instance,
        "--project=$ProjectId", "--zone=$Zone", '--format=value(status)'
    ) | Out-String).Trim()
}

try {
    if (-not (Test-Path -LiteralPath $LocalScript)) {
        throw "Recovery script not found: $LocalScript"
    }

    $status = Get-InstanceStatus
    if ($status -eq 'STOPPING' -or $status -eq 'PROVISIONING' -or $status -eq 'STAGING') {
        $deadline = (Get-Date).AddMinutes(3)
        while ((Get-Date) -lt $deadline -and $status -ne 'RUNNING' -and $status -ne 'TERMINATED') {
            Start-Sleep -Seconds 5
            $status = Get-InstanceStatus
        }
    }
    if ($status -eq 'TERMINATED') {
        Invoke-Gcloud @('compute', 'instances', 'start', $Instance, "--project=$ProjectId", "--zone=$Zone", '--quiet') | Out-Host
        $ScriptStartedVm = $true
    }

    $deadline = (Get-Date).AddMinutes(4)
    do {
        $status = Get-InstanceStatus
        if ($status -eq 'RUNNING') { break }
        if ($status -eq 'TERMINATED') { throw 'VM returned to TERMINATED while starting.' }
        if ((Get-Date) -ge $deadline) { throw "Timed out waiting for VM; last status: $status" }
        Start-Sleep -Seconds 5
    } while ($true)

    Invoke-Gcloud @(
        'compute', 'scp', $LocalScript, "${Instance}:$RemoteScript",
        "--project=$ProjectId", "--zone=$Zone", '--tunnel-through-iap', '--quiet'
    ) | Out-Host
    Invoke-Gcloud @(
        'compute', 'ssh', $Instance, "--project=$ProjectId", "--zone=$Zone",
        '--tunnel-through-iap', "--command=sudo bash $RemoteScript"
    ) | Out-Host
}
finally {
    if ($ScriptStartedVm -and -not $KeepRunning) {
        Write-Host 'Stopping the VM because this script started it.'
        Invoke-Gcloud @(
            'compute', 'instances', 'stop', $Instance,
            "--project=$ProjectId", "--zone=$Zone", '--quiet'
        ) | Out-Host

        $deadline = (Get-Date).AddMinutes(3)
        while ((Get-Date) -lt $deadline) {
            if ((Get-InstanceStatus) -eq 'TERMINATED') {
                Write-Host 'VM is TERMINATED.'
                break
            }
            Start-Sleep -Seconds 5
        }
    }
}
