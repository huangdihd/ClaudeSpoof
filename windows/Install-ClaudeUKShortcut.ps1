$ErrorActionPreference = 'Stop'
$runtime = $PSScriptRoot
$package = Get-AppxPackage -Name Claude | Sort-Object Version -Descending | Select-Object -First 1
if (-not $package) { throw 'Claude MSIX package was not found.' }
$official = Join-Path $package.InstallLocation 'app\Claude.exe'
$target = Join-Path $runtime 'Start-ClaudeUK.cmd'
$watcher = Join-Path $runtime 'Watch-ClaudeUK.ps1'
if (-not (Test-Path -LiteralPath $target)) { throw "ClaudeSpoof launcher was not found: $target" }

$menuDirectory = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$shortcutPath = Join-Path $menuDirectory 'Claude.lnk'
$backupPath = Join-Path $runtime 'Claude.start-menu-original.lnk'
New-Item -ItemType Directory -Path $menuDirectory -Force | Out-Null

$shell = New-Object -ComObject WScript.Shell
if ((Test-Path -LiteralPath $shortcutPath) -and -not (Test-Path -LiteralPath $backupPath)) {
    $existing = $shell.CreateShortcut($shortcutPath)
    if ($existing.TargetPath -ne $target) {
        Copy-Item -LiteralPath $shortcutPath -Destination $backupPath
    }
}

$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $target
$shortcut.Arguments = ''
$shortcut.WorkingDirectory = $runtime
$shortcut.IconLocation = "$official,0"
$shortcut.Description = 'Claude with the configured timezone and locale (ClaudeSpoof)'
$shortcut.Save()

$saved = $shell.CreateShortcut($shortcutPath)
if ($saved.TargetPath -ne $target -or $saved.WorkingDirectory -ne $runtime) {
    throw 'The Start Menu shortcut did not retain the ClaudeSpoof launcher target.'
}

# Best-effort per-user logon Scheduled Task so the watcher is already active
# after a reboot (catching MSIX/taskbar/claude:// launches without admin rights).
$logonTaskRegistered = $false
if (Test-Path -LiteralPath $watcher) {
    try {
        $taskName = 'ClaudeSpoofWatcher'
        $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $watcher)
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force -ErrorAction Stop | Out-Null
        $logonTaskRegistered = $true
    } catch {
        $logonTaskRegistered = $false
    }
}

[pscustomobject]@{
    success = $true
    shortcut = $shortcutPath
    target = $saved.TargetPath
    backupExists = (Test-Path -LiteralPath $backupPath)
    logonTaskRegistered = $logonTaskRegistered
} | ConvertTo-Json -Compress
