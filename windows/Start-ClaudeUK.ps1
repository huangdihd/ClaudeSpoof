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
$existing = Get-OfficialClaudeProcesses $official
if ($existing.Count -ne 0) {
    throw 'Claude is already running. Exit it completely before using this launcher; no existing process was changed.'
}
if ((Get-AuthenticodeSignature -LiteralPath $official).Status -ne 'Valid') {
    throw 'The official Claude.exe signature is not valid.'
}
$hashBefore = (Get-FileHash -Algorithm SHA256 -LiteralPath $official).Hash.ToLowerInvariant()
$systemTimeZoneBefore = (Get-TimeZone).Id

$verificationPath = Join-Path $runtime 'runtime-verification.json'
$vmVerificationPath = Join-Path $runtime 'vm-service-verification.json'
$inspectorResultPath = Join-Path $runtime 'inspector-result.json'
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

    $config = [IO.File]::ReadAllText((Join-Path $runtime 'config.json')) | ConvertFrom-Json
    $failures = @()
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
        officialExe = $official
        packageVersion = (Get-AppxPackage -Name Claude | Sort-Object Version -Descending | Select-Object -First 1).Version.ToString()
        officialSha256Before = $hashBefore
        officialSha256After = $hashAfter
        officialSignature = 'Valid'
        systemTimeZone = (Get-TimeZone).Id
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
    $state | ConvertTo-Json -Depth 4
} catch {
    if ($startedOfficial) {
        Get-OfficialClaudeProcesses $official | ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
    throw
}
