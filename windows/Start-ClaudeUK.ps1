$ErrorActionPreference = 'Stop'
$runtime = $PSScriptRoot
$env:CLAUDE_SPOOF_CONFIG = Join-Path $runtime 'config.json'
$startedOfficial = $false

function Get-RuntimeKeyHash {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $hashBytes = [Security.Cryptography.SHA256]::Create().ComputeHash(
        [Text.Encoding]::UTF8.GetBytes(($identity + '|' + $runtime).ToLowerInvariant())
    )
    return ([BitConverter]::ToString($hashBytes).Replace('-', '').Substring(0, 20))
}

function Get-OfficialClaudePackage {
    $package = Get-AppxPackage -Name Claude | Sort-Object Version -Descending | Select-Object -First 1
    if (-not $package) { throw 'Claude MSIX package was not found.' }
    return $package
}

function Get-OfficialClaudePath($package) {
    $executable = Join-Path $package.InstallLocation 'app\Claude.exe'
    if (-not (Test-Path -LiteralPath $executable)) { throw "Official Claude.exe was not found: $executable" }
    return $executable
}

function Assert-OfficialSignature([string]$executable) {
    $sig = Get-AuthenticodeSignature -LiteralPath $executable
    if ($sig.Status -ne 'Valid') {
        throw "The official Claude.exe signature is not valid (Status=$($sig.Status))."
    }
    $subject = if ($sig.SignerCertificate) { [string]$sig.SignerCertificate.Subject } else { '' }
    if ($subject -notmatch 'Anthropic') {
        throw "The official Claude.exe signer is not Anthropic (Subject=$subject)."
    }
    return $sig
}

function Get-OfficialClaudeProcesses([string]$executable) {
    $quick = @(Get-Process -Name 'Claude' -ErrorAction SilentlyContinue)
    if ($quick.Count -eq 0) { return @() }
    return @(Get-CimInstance Win32_Process -Filter "Name='Claude.exe'" | Where-Object {
        $_.ExecutablePath -eq $executable
    })
}

function Read-JsonFile([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    try { return ([IO.File]::ReadAllText($path) | ConvertFrom-Json) } catch { return $null }
}

function Write-JsonAtomic([string]$path, $obj) {
    $json = ($obj | ConvertTo-Json -Depth 5)
    $tmp = "$path.tmp-$PID"
    [IO.File]::WriteAllText($tmp, $json)
    Move-Item -LiteralPath $tmp -Destination $path -Force
}

function Test-TcpPortOpen([int]$port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect('127.0.0.1', $port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne(200, $false)) { return $false }
        $client.EndConnect($async)
        return $true
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

function Test-RunningVerification($verification, $config, $processes, [string]$officialExe) {
    if ($null -eq $verification -or $null -eq $verification.main) { return $false }
    $mainProcessId = 0
    if (-not [int]::TryParse([string]$verification.main.processId, [ref]$mainProcessId)) { return $false }
    if ($mainProcessId -notin @($processes | ForEach-Object { $_.ProcessId })) { return $false }
    if ($verification.main.officialExe -and ($verification.main.officialExe -ne $officialExe)) { return $false }
    if ($verification.main.envTZ -ne $config.timezone) { return $false }
    if ($verification.main.timeZone -ne $config.timezone) { return $false }
    if ($verification.main.electronLocale -ne $config.language) { return $false }
    if ($verification.sharedTimezoneProvider.resolvedTimeZone -ne $config.timezone) { return $false }
    if (@($verification.errors).Count -ne 0) { return $false }
    if (@($verification.renderers).Count -lt 1) { return $false }
    foreach ($renderer in @($verification.renderers)) {
        if ($renderer.timeZone -ne $config.timezone) { return $false }
        if ($renderer.locale -ne $config.language -or $renderer.language -ne $config.language) { return $false }
    }
    return $true
}

function Stop-OfficialClaudeProcesses([string]$executable) {
    $processIds = @(Get-OfficialClaudeProcesses $executable | ForEach-Object { $_.ProcessId })
    foreach ($processId in $processIds) {
        $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if ($null -ne $process -and $process.MainWindowHandle -ne 0) {
            [void]$process.CloseMainWindow()
        }
    }

    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        $remaining = Get-OfficialClaudeProcesses $executable
        if ($remaining.Count -eq 0) { return }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)

    $remaining | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
        $remaining = Get-OfficialClaudeProcesses $executable
        if ($remaining.Count -eq 0) { return }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'The existing Claude processes did not exit; no new instance was started.'
}

function Wait-JsonFile([string]$path, [int]$timeoutSeconds) {
    $deadline = [DateTime]::UtcNow.AddSeconds($timeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-Path -LiteralPath $path) {
            try { return ([IO.File]::ReadAllText($path) | ConvertFrom-Json) } catch {}
        }
        Start-Sleep -Milliseconds 200
    }
    throw "Timed out waiting for verification file: $path"
}

function Start-UpdateWatcher {
    $watcher = Join-Path $runtime 'Watch-ClaudeUK.ps1'
    if (-not (Test-Path -LiteralPath $watcher)) { return }
    Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $watcher)
    ) | Out-Null
}

function Activate-WindowHandle([IntPtr]$hwnd) {
    if ($hwnd -eq [IntPtr]::Zero) { return }
    if (-not ('ClaudeSpoof.WindowActivation' -as [type])) {
        Add-Type -Namespace ClaudeSpoof -Name WindowActivation -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
'@
    }
    [void][ClaudeSpoof.WindowActivation]::ShowWindowAsync($hwnd, 9)
    [void][ClaudeSpoof.WindowActivation]::SetForegroundWindow($hwnd)
}

# Shared per-user/per-directory launch mutex prevents concurrent double-clicks
# and stops Watch-ClaudeUK.ps1 from interfering while a launch is in progress.
$launchMutexName = 'Local\ClaudeSpoofLaunch-' + (Get-RuntimeKeyHash)
$launchMutex = New-Object System.Threading.Mutex($false, $launchMutexName)
$hasLaunchLock = $false
try {
    try {
        $hasLaunchLock = $launchMutex.WaitOne(15000)
    } catch [System.Threading.AbandonedMutexException] {
        $hasLaunchLock = $true
    }
    if (-not $hasLaunchLock) {
        throw 'Another ClaudeSpoof launch is already in progress. Please wait a moment and retry.'
    }

    $package = Get-OfficialClaudePackage
    $official = Get-OfficialClaudePath $package
    $config = Read-JsonFile (Join-Path $runtime 'config.json')
    if ($null -eq $config -or -not $config.enabled) { throw 'config.json is missing, invalid, or disabled.' }
    if ([string]::IsNullOrWhiteSpace([string]$config.timezone) -or [string]::IsNullOrWhiteSpace([string]$config.language)) {
        throw 'config.json must specify non-empty timezone and language.'
    }
    [void](Assert-OfficialSignature $official)
    $hashBefore = (Get-FileHash -Algorithm SHA256 -LiteralPath $official).Hash.ToLowerInvariant()
    $systemTimeZoneBefore = (Get-TimeZone).Id

    $verificationPath = Join-Path $runtime 'runtime-verification.json'
    $vmVerificationPath = Join-Path $runtime 'vm-service-verification.json'
    $inspectorResultPath = Join-Path $runtime 'inspector-result.json'
    $existing = Get-OfficialClaudeProcesses $official
    $launchAction = 'freshStart'

    if ($existing.Count -ne 0) {
        $existingVerification = Read-JsonFile $verificationPath
        if (Test-RunningVerification $existingVerification $config $existing $official) {
            $mainProcessId = [int]$existingVerification.main.processId
            $mainProcess = Get-Process -Id $mainProcessId -ErrorAction SilentlyContinue
            if ($null -eq $mainProcess) { throw 'The verified Claude main process exited before activation.' }
            if ($mainProcess.MainWindowHandle -ne 0) {
                Activate-WindowHandle $mainProcess.MainWindowHandle
            } else {
                # Window is hidden in tray; use official second-instance activation only while primary PID is confirmed alive.
                Start-Process -FilePath $official -ErrorAction Stop
                Start-Sleep -Milliseconds 1200
                $mainProcess = Get-Process -Id $mainProcessId -ErrorAction SilentlyContinue
                if ($null -eq $mainProcess) { throw 'The verified Claude main process exited during activation.' }
                if ($mainProcess.MainWindowHandle -ne 0) {
                    Activate-WindowHandle $mainProcess.MainWindowHandle
                }
            }
            if ((Get-TimeZone).Id -ne $systemTimeZoneBefore) { throw 'Windows system time zone changed during activation.' }
            $state = [ordered]@{
                success = $true
                action = 'alreadyRunning'
                officialExe = $official
                mainProcessId = $mainProcessId
                processTimeZone = $existingVerification.main.timeZone
                processEnvTZ = $existingVerification.main.envTZ
                rendererCount = @($existingVerification.renderers).Count
                sharedTimezoneProvider = $existingVerification.sharedTimezoneProvider.resolvedTimeZone
                systemTimeZone = (Get-TimeZone).Id
                activatedAtUtc = [DateTime]::UtcNow.ToString('o')
            }
            Write-JsonAtomic (Join-Path $runtime 'last-invocation.json') $state
            Start-UpdateWatcher
            $state | ConvertTo-Json -Depth 4
            exit 0
        }

        $launchAction = 'restartedUnverifiedInstance'
        Stop-OfficialClaudeProcesses $official
    }

    Remove-Item -LiteralPath $verificationPath,$vmVerificationPath,$inspectorResultPath -Force -ErrorAction SilentlyContinue

    # Keep the Start Menu entry pointed at this fail-closed launcher.
    & (Join-Path $runtime 'Install-ClaudeUKShortcut.ps1') | Out-Null

    try {
        # Set TZ before process creation so main & child processes inherit it from millisecond 0.
        $env:TZ = [string]$config.timezone
        $langArg = "--lang=$($config.language)"

        # Port 0 asks MemoryFuseLauncher.exe to allocate a free ephemeral loopback port.
        $launchOutput = (& (Join-Path $runtime 'MemoryFuseLauncher.exe') $official 0 $langArg | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) { throw "MemoryFuseLauncher failed: $launchOutput" }
        $startedOfficial = $true
        $launchInfo = $launchOutput | ConvertFrom-Json
        $port = [int]$launchInfo.port
        if ($port -le 0) { throw "MemoryFuseLauncher did not return a valid inspector port: $launchOutput" }

        $inspectorOutput = (& node (Join-Path $runtime 'inspect_client.js') $port (Join-Path $runtime 'runtime-probe.js') $inspectorResultPath | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) { throw "Runtime injection failed: $inspectorOutput" }
        $inspectorResult = [IO.File]::ReadAllText($inspectorResultPath) | ConvertFrom-Json
        if (-not $inspectorResult.resumed -or $inspectorResult.evaluation.exceptionDetails) {
            throw 'The official process was not resumed after a successful injection.'
        }

        $verification = Wait-JsonFile $verificationPath 20
        $vmVerification = Wait-JsonFile $vmVerificationPath 15
        $deadline = [DateTime]::UtcNow.AddSeconds(15)
        while ([DateTime]::UtcNow -lt $deadline -and @($verification.renderers).Count -lt 1) {
            Start-Sleep -Milliseconds 250
            $nextVer = Read-JsonFile $verificationPath
            if ($null -ne $nextVer) { $verification = $nextVer }
        }

        $requireCoworkVm = [bool]$config.requireCoworkVm
        $coworkAvailable = ($vmVerification.serviceAvailable -ne $false)

        $failures = @()
        $mainProcessId = 0
        if (-not [int]::TryParse([string]$verification.main.processId, [ref]$mainProcessId)) {
            $failures += 'Main process PID was not recorded.'
        } elseif ($mainProcessId -notin @(Get-OfficialClaudeProcesses $official | ForEach-Object { $_.ProcessId })) {
            $failures += 'Main process PID does not match the new official instance.'
        }
        if ($verification.main.envTZ -ne $config.timezone) { $failures += 'Main process TZ mismatch.' }
        if ($verification.main.timeZone -ne $config.timezone) { $failures += 'Main process Intl time zone mismatch.' }
        if ($verification.main.electronLocale -ne $config.language) { $failures += 'Electron locale mismatch.' }
        if (@($verification.renderers).Count -lt 1) { $failures += 'No renderer verification was recorded.' }
        foreach ($renderer in @($verification.renderers)) {
            if ($renderer.timeZone -ne $config.timezone) {
                $failures += "Renderer $($renderer.rendererId) time zone mismatch."
            }
            if ($renderer.locale -ne $config.language -or $renderer.language -ne $config.language) {
                $failures += "Renderer $($renderer.rendererId) locale mismatch."
            }
        }
        if ($verification.sharedTimezoneProvider.resolvedTimeZone -ne $config.timezone) {
            $failures += 'Shared Code/Cowork/Computer Use time-zone provider mismatch.'
        }
        if (@($verification.errors).Count -ne 0) { $failures += 'Runtime probe reported errors.' }

        if ($coworkAvailable -or $requireCoworkVm) {
            if (@($vmVerification.errors).Count -ne 0) { $failures += 'Cowork service identity probe reported errors.' }
            if ($null -eq $vmVerification.isRunning.running -or $null -eq $vmVerification.isGuestConnected.connected) {
                $failures += 'Cowork service did not return normal status objects.'
            }
        }
        if ($failures.Count -ne 0) { throw ($failures -join ' ') }

        $inspectorDeadline = [DateTime]::UtcNow.AddSeconds(5)
        $portOpen = $false
        do {
            $portOpen = Test-TcpPortOpen $port
            if (-not $portOpen) { break }
            Start-Sleep -Milliseconds 150
        } while ([DateTime]::UtcNow -lt $inspectorDeadline)
        if ($portOpen) { throw "The temporary local inspector on port $port is still open." }

        $hashAfter = (Get-FileHash -Algorithm SHA256 -LiteralPath $official).Hash.ToLowerInvariant()
        if ($hashAfter -ne $hashBefore) { throw 'Official Claude.exe hash changed during launch.' }
        [void](Assert-OfficialSignature $official)
        if ((Get-TimeZone).Id -ne $systemTimeZoneBefore) { throw 'Windows system time zone changed during launch.' }

        $state = [ordered]@{
            success = $true
            action = $launchAction
            officialExe = $official
            packageVersion = $package.Version.ToString()
            officialSha256Before = $hashBefore
            officialSha256After = $hashAfter
            officialSignature = 'Valid (Anthropic)'
            systemTimeZone = (Get-TimeZone).Id
            mainProcessId = [int]$verification.main.processId
            processTimeZone = $verification.main.timeZone
            processEnvTZ = $verification.main.envTZ
            processLocale = $verification.main.electronLocale
            rendererCount = @($verification.renderers).Count
            sharedTimezoneProvider = $verification.sharedTimezoneProvider.resolvedTimeZone
            coworkServiceAvailable = $coworkAvailable
            coworkServiceIdentityAccepted = ($coworkAvailable -and @($vmVerification.errors).Count -eq 0)
            coworkRunning = if ($coworkAvailable) { $vmVerification.isRunning.running } else { $null }
            coworkGuestConnected = if ($coworkAvailable) { $vmVerification.isGuestConnected.connected } else { $null }
            inspectorPort = $port
            inspectorPortOpen = $false
            vmInternalDateVerified = $false
            verifiedAtUtc = [DateTime]::UtcNow.ToString('o')
        }
        Write-JsonAtomic (Join-Path $runtime 'last-launch-verification.json') $state
        Write-JsonAtomic (Join-Path $runtime 'last-invocation.json') $state
        Start-UpdateWatcher
        $state | ConvertTo-Json -Depth 4
    } catch {
        if ($startedOfficial) {
            Get-OfficialClaudeProcesses $official | ForEach-Object {
                Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
            }
        }
        throw
    }
} finally {
    if ($hasLaunchLock) {
        try { $launchMutex.ReleaseMutex() } catch {}
    }
    $launchMutex.Dispose()
}
