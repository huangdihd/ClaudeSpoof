$ErrorActionPreference = 'Stop'
$runtime = $PSScriptRoot
$shortcutPath = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Claude.lnk'
$backupPath = Join-Path $runtime 'Claude.start-menu-original.lnk'
$target = Join-Path $runtime 'Start-ClaudeUK.cmd'
$watcherPath = Join-Path $runtime 'Watch-ClaudeUK.ps1'

# Remove per-user logon task if registered.
$logonTaskRemoved = $false
try {
    $existingTask = Get-ScheduledTask -TaskName 'ClaudeSpoofWatcher' -ErrorAction SilentlyContinue
    if ($null -ne $existingTask) {
        Unregister-ScheduledTask -TaskName 'ClaudeSpoofWatcher' -Confirm:$false -ErrorAction SilentlyContinue
        $logonTaskRemoved = $true
    }
} catch {}

# Restoring the official entry also stops update repair, otherwise the watcher
# would put the managed environment back on the next official launch.
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object {
    $_.CommandLine -and $_.CommandLine.IndexOf($watcherPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
} | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

if (Test-Path -LiteralPath $backupPath) {
    Copy-Item -LiteralPath $backupPath -Destination $shortcutPath -Force
    $action = 'restored-original'
} elseif (Test-Path -LiteralPath $shortcutPath) {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    if ($shortcut.TargetPath -eq $target) {
        Remove-Item -LiteralPath $shortcutPath -Force
        $action = 'removed-custom-shortcut'
    } else {
        $action = 'left-unrelated-shortcut-unchanged'
    }
} else {
    $action = 'nothing-to-restore'
}
[pscustomobject]@{
    success = $true
    action = $action
    shortcut = $shortcutPath
    logonTaskRemoved = $logonTaskRemoved
} | ConvertTo-Json -Compress
