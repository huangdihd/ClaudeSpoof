$ErrorActionPreference = 'Stop'
$runtime = $PSScriptRoot
$configPath = Join-Path $runtime 'config.json'
$verificationPath = Join-Path $runtime 'runtime-verification.json'
$statusPath = Join-Path $runtime 'watcher-status.json'
$launchLogPath = Join-Path $runtime 'watcher-launch.log'

function Read-JsonFile([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    try { return ([IO.File]::ReadAllText($path) | ConvertFrom-Json) } catch { return $null }
}

function Write-Status($state) {
    try {
        $json = ($state | ConvertTo-Json -Depth 5)
        $tmp = "$statusPath.tmp-$PID"
        [IO.File]::WriteAllText($tmp, $json)
        Move-Item -LiteralPath $tmp -Destination $statusPath -Force
    } catch {}
}

function Get-OfficialClaudePath {
    $package = Get-AppxPackage -Name Claude | Sort-Object Version -Descending | Select-Object -First 1
    if ($null -eq $package) { return $null }
    $executable = Join-Path $package.InstallLocation 'app\Claude.exe'
    if (-not (Test-Path -LiteralPath $executable)) { return $null }
    return $executable
}

function Test-VerifiedProcess($verification, $config, $processes, [string]$officialExe) {
    if ($null -eq $verification -or $null -eq $verification.main) { return $false }
    $mainProcessId = 0
    if (-not [int]::TryParse([string]$verification.main.processId, [ref]$mainProcessId)) { return $false }
    if ($mainProcessId -notin @($processes | ForEach-Object { $_.ProcessId })) { return $false }
    if ($verification.main.officialExe -and ($verification.main.officialExe -ne $officialExe)) { return $false }
    if ($verification.main.envTZ -ne $config.timezone -or $verification.main.timeZone -ne $config.timezone) { return $false }
    if ($verification.main.electronLocale -ne $config.language) { return $false }
    if ($verification.sharedTimezoneProvider.resolvedTimeZone -ne $config.timezone) { return $false }
    if (@($verification.errors).Count -ne 0 -or @($verification.renderers).Count -lt 1) { return $false }
    foreach ($renderer in @($verification.renderers)) {
        if ($renderer.timeZone -ne $config.timezone) { return $false }
        if ($renderer.locale -ne $config.language -or $renderer.language -ne $config.language) { return $false }
    }
    return $true
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$hashBytes = [Security.Cryptography.SHA256]::Create().ComputeHash(
    [Text.Encoding]::UTF8.GetBytes(($identity + '|' + $runtime).ToLowerInvariant())
)
$runtimeKey = [BitConverter]::ToString($hashBytes).Replace('-', '').Substring(0, 20)
$mutexName = 'Local\ClaudeSpoofWatcher-' + $runtimeKey
$launchMutexName = 'Local\ClaudeSpoofLaunch-' + $runtimeKey

$created = $false
$mutex = New-Object System.Threading.Mutex($true, $mutexName, [ref]$created)
if (-not $created) { exit 0 }

function Test-LaunchInProgress {
    $probe = $null
    $acquired = $false
    try {
        if ([System.Threading.Mutex]::TryOpenExisting($launchMutexName, [ref]$probe)) {
            try {
                $acquired = $probe.WaitOne(0)
                return (-not $acquired)
            } catch [System.Threading.AbandonedMutexException] {
                $acquired = $true
                return $false
            }
        }
        return $false
    } catch {
        return $false
    } finally {
        if ($null -ne $probe) {
            if ($acquired) { try { $probe.ReleaseMutex() } catch {} }
            $probe.Dispose()
        }
    }
}

$pendingRepairKey = $null
$retryAfter = [DateTime]::UtcNow
try {
    while ($true) {
        try {
            $config = Read-JsonFile $configPath
            if ($null -eq $config -or -not $config.enabled) {
                Write-Status ([ordered]@{ running = $false; reason = 'disabled'; checkedAtUtc = [DateTime]::UtcNow.ToString('o') })
                exit 0
            }

            # Lightweight idle check: avoid querying Appx & WMI when Claude is not running.
            $quickProcs = @(Get-Process -Name 'Claude' -ErrorAction SilentlyContinue)
            if ($quickProcs.Count -eq 0) {
                $pendingRepairKey = $null
                $retryAfter = [DateTime]::UtcNow
                Write-Status ([ordered]@{ running = $true; watching = $false; checkedAtUtc = [DateTime]::UtcNow.ToString('o') })
                Start-Sleep -Seconds 5
                continue
            }

            if (Test-LaunchInProgress) {
                $pendingRepairKey = $null
                Write-Status ([ordered]@{ running = $true; watching = $true; action = 'launchInProgress'; checkedAtUtc = [DateTime]::UtcNow.ToString('o') })
                Start-Sleep -Seconds 5
                continue
            }

            $official = Get-OfficialClaudePath
            $processes = @()
            if ($null -ne $official) {
                $processes = @(Get-CimInstance Win32_Process -Filter "Name='Claude.exe'" | Where-Object {
                    $_.ExecutablePath -eq $official
                })
            }

            # Never start Claude just because the watcher is running. It only
            # intervenes after the official client has started itself.
            if ($processes.Count -eq 0) {
                $pendingRepairKey = $null
                $retryAfter = [DateTime]::UtcNow
                Write-Status ([ordered]@{ running = $true; watching = $false; checkedAtUtc = [DateTime]::UtcNow.ToString('o') })
            } else {
                $verification = Read-JsonFile $verificationPath
                if (Test-VerifiedProcess $verification $config $processes $official) {
                    $pendingRepairKey = $null
                    $retryAfter = [DateTime]::UtcNow
                    Write-Status ([ordered]@{
                        running = $true
                        watching = $true
                        verified = $true
                        mainProcessId = [int]$verification.main.processId
                        officialExe = $official
                        checkedAtUtc = [DateTime]::UtcNow.ToString('o')
                    })
                } else {
                    $processIds = @($processes | ForEach-Object { $_.ProcessId })
                    $root = $processes | Where-Object { $_.ParentProcessId -notin $processIds } |
                        Sort-Object CreationDate | Select-Object -First 1
                    $attemptKey = $official + '|' + $(if ($null -ne $root) { $root.ProcessId } else { 'unknown' })

                    if ([DateTime]::UtcNow -lt $retryAfter) {
                        Write-Status ([ordered]@{
                            running = $true
                            watching = $true
                            verified = $false
                            action = 'repairFailedBackoff'
                            officialExe = $official
                            retryAfterUtc = $retryAfter.ToString('o')
                            checkedAtUtc = [DateTime]::UtcNow.ToString('o')
                        })
                    } elseif ($pendingRepairKey -ne $attemptKey) {
                        # Two-consecutive-checks confirmation avoids racing with a fresh launch or shutdown.
                        $pendingRepairKey = $attemptKey
                        Write-Status ([ordered]@{
                            running = $true
                            watching = $true
                            verified = $false
                            action = 'pendingRepairConfirmation'
                            officialExe = $official
                            attemptKey = $attemptKey
                            checkedAtUtc = [DateTime]::UtcNow.ToString('o')
                        })
                    } else {
                        $pendingRepairKey = $null
                        Write-Status ([ordered]@{
                            running = $true
                            watching = $true
                            verified = $false
                            action = 'repairingUnverifiedInstance'
                            officialExe = $official
                            detectedAtUtc = [DateTime]::UtcNow.ToString('o')
                        })
                        try {
                            $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $runtime 'Start-ClaudeUK.ps1') 2>&1 | Out-String
                            [IO.File]::WriteAllText($launchLogPath, $output)
                            if ($LASTEXITCODE -ne 0) { throw $output }
                            $retryAfter = [DateTime]::UtcNow.AddSeconds(30)
                        } catch {
                            [IO.File]::WriteAllText($launchLogPath, [string]($_ | Out-String))
                            # A newly released incompatible build must not cause
                            # a kill/restart loop. Back off and leave a local error.
                            $retryAfter = [DateTime]::UtcNow.AddMinutes(5)
                            Write-Status ([ordered]@{
                                running = $true
                                watching = $true
                                verified = $false
                                action = 'repairFailedBackoff'
                                error = $_.Exception.Message
                                retryAfterUtc = $retryAfter.ToString('o')
                            })
                        }
                    }
                }
            }
        } catch {
            $retryAfter = [DateTime]::UtcNow.AddSeconds(30)
            Write-Status ([ordered]@{
                running = $true
                action = 'watcherIterationFailed'
                error = $_.Exception.Message
                retryAfterUtc = $retryAfter.ToString('o')
            })
        }
        Start-Sleep -Seconds 5
    }
} finally {
    try { $mutex.ReleaseMutex() } catch {}
    $mutex.Dispose()
}
