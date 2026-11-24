$ErrorActionPreference = 'Stop'
$runtime = $PSScriptRoot
$env:CLAUDE_SPOOF_CONFIG = Join-Path $runtime 'config.json'
$port = 19229
$startedOfficial = $false

function Get-OfficialClaudePath {
    $package = Get-AppxPackage -Name Claude | Sort-Object Version -Descending | Select-Object -First 1
    if (-not $package) { throw 'Claude MSIX package was not found.' }
    $executable = Join-Path $package.InstallLocation 'app\Claude.exe'
    if (-not (Test-Path -LiteralPath $executable)) { throw "Official Claude.exe was not found: $executable" }
    return $executable
}

function Get-OfficialClaudeProcesses([string]$executable) {
    return @(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -eq 'Claude.exe' -and $_.ExecutablePath -eq $executable
    })
}

function Read-JsonFile([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    try { return ([IO.File]::ReadAllText($path) | ConvertFrom-Json) } catch { return $null }
}

function Test-RunningVerification($verification, $config, $processes) {
    if ($null -eq $verification -or $null -eq $verification.main) { return $false }
    $mainProcessId = 0
    if (-not [int]::TryParse([string]$verification.main.processId, [ref]$mainProcessId)) { return $false }
    if ($mainProcessId -notin @($processes | ForEach-Object { $_.ProcessId })) { return $false }
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
        Start-Sleep -Milliseconds 250
    }
    throw "Timed out waiting for verification file: $path"
}

$official = Get-OfficialClaudePath
$config = Read-JsonFile (Join-Path $runtime 'config.json')
if ($null -eq $config -or -not $config.enabled) { throw 'config.json is missing, invalid, or disabled.' }
if ((Get-AuthenticodeSignature -LiteralPath $official).Status -ne 'Valid') {
    throw 'The official Claude.exe signature is not valid.'
}
$hashBefore = (Get-FileHash -Algorithm SHA256 -LiteralPath $official).Hash.ToLowerInvariant()
$systemTimeZoneBefore = (Get-TimeZone).Id

$verificationPath = Join-Path $runtime 'runtime-verification.json'
$vmVerificationPath = Join-Path $runtime 'vm-service-verification.json'
$inspectorResultPath = Join-Path $runtime 'inspector-result.json'
$existing = Get-OfficialClaudeProcesses $official
$launchAction = 'freshStart'

if ($existing.Count -ne 0) {
    $existingVerification = Read-JsonFile $verificationPath
    if (Test-RunningVerification $existingVerification $config $existing) {
        # Claude's official second-instance handler restores, shows and focuses
        # the existing primary window, then the short-lived second process exits.
        # Do not inject this second process and do not replace the primary.
        Start-Process -FilePath $official -ErrorAction Stop
        Start-Sleep -Seconds 2
        $mainProcessId = [int]$existingVerification.main.processId
        $mainProcess = Get-Process -Id $mainProcessId -ErrorAction SilentlyContinue
        if ($null -eq $mainProcess) { throw 'The verified Claude main process exited during activation.' }
        if ($mainProcess.MainWindowHandle -ne 0) {
            Add-Type -Namespace ClaudeSpoof -Name WindowActivation -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
'@
            [void][ClaudeSpoof.WindowActivation]::ShowWindowAsync($mainProcess.MainWindowHandle, 9)
            [void][ClaudeSpoof.WindowActivation]::SetForegroundWindow($mainProcess.MainWindowHandle)
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
        [IO.File]::WriteAllText((Join-Path $runtime 'last-invocation.json'), ($state | ConvertTo-Json -Depth 4))
        $state | ConvertTo-Json -Depth 4
        exit 0
    }

    $launchAction = 'restartedUnverifiedInstance'
    Stop-OfficialClaudeProcesses $official
}

Remove-Item -LiteralPath $verificationPath,$vmVerificationPath,$inspectorResultPath -Force -ErrorAction SilentlyContinue

# Keep the ordinary Start Menu entry pointed at this fail-closed launcher.
# The original shortcut is backed up once inside the runtime directory.
& (Join-Path $runtime 'Install-ClaudeUKShortcut.ps1') | Out-Null

try {
    $launchOutput = (& (Join-Path $runtime 'MemoryFuseLauncher.exe') $official $port | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw "MemoryFuseLauncher failed: $launchOutput" }
    $startedOfficial = $true

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
        $verification = [IO.File]::ReadAllText($verificationPath) | ConvertFrom-Json
    }

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
    if (@($vmVerification.errors).Count -ne 0) { $failures += 'Cowork service identity probe reported errors.' }
    if ($null -eq $vmVerification.isRunning.running -or $null -eq $vmVerification.isGuestConnected.connected) {
        $failures += 'Cowork service did not return normal status objects.'
    }
    if ($failures.Count -ne 0) { throw ($failures -join ' ') }

    $inspectorDeadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
        $portOpen = Test-NetConnection -ComputerName 127.0.0.1 -Port $port -InformationLevel Quiet -WarningAction SilentlyContinue
        if (-not $portOpen) { break }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $inspectorDeadline)
    if ($portOpen) { throw 'The temporary local inspector is still open.' }

    $hashAfter = (Get-FileHash -Algorithm SHA256 -LiteralPath $official).Hash.ToLowerInvariant()
    if ($hashAfter -ne $hashBefore) { throw 'Official Claude.exe hash changed during launch.' }
    if ((Get-AuthenticodeSignature -LiteralPath $official).Status -ne 'Valid') {
        throw 'Official Claude.exe signature changed during launch.'
    }
    if ((Get-TimeZone).Id -ne $systemTimeZoneBefore) { throw 'Windows system time zone changed during launch.' }

    $state = [ordered]@{
        success = $true
        action = $launchAction
        officialExe = $official
        packageVersion = (Get-AppxPackage -Name Claude | Sort-Object Version -Descending | Select-Object -First 1).Version.ToString()
        officialSha256Before = $hashBefore
        officialSha256After = $hashAfter
        officialSignature = 'Valid'
        systemTimeZone = (Get-TimeZone).Id
        mainProcessId = [int]$verification.main.processId
        processTimeZone = $verification.main.timeZone
        processEnvTZ = $verification.main.envTZ
        rendererCount = @($verification.renderers).Count
        sharedTimezoneProvider = $verification.sharedTimezoneProvider.resolvedTimeZone
        coworkServiceIdentityAccepted = $true
        coworkRunning = $vmVerification.isRunning.running
        coworkGuestConnected = $vmVerification.isGuestConnected.connected
        inspectorPortOpen = $false
        vmInternalDateVerified = $false
        verifiedAtUtc = [DateTime]::UtcNow.ToString('o')
    }
    [IO.File]::WriteAllText((Join-Path $runtime 'last-launch-verification.json'), ($state | ConvertTo-Json -Depth 4))
    [IO.File]::WriteAllText((Join-Path $runtime 'last-invocation.json'), ($state | ConvertTo-Json -Depth 4))
    $state | ConvertTo-Json -Depth 4
} catch {
    if ($startedOfficial) {
        Get-OfficialClaudeProcesses $official | ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
    throw
}
