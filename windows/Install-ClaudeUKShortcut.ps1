$ErrorActionPreference = 'Stop'
$runtime = $PSScriptRoot
$package = Get-AppxPackage -Name Claude | Sort-Object Version -Descending | Select-Object -First 1
if (-not $package) { throw 'Claude MSIX package was not found.' }
$official = Join-Path $package.InstallLocation 'app\Claude.exe'
$target = Join-Path $runtime 'Start-ClaudeUK.cmd'
if (-not (Test-Path -LiteralPath $target)) { throw "Claude UK launcher was not found: $target" }

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
$shortcut.Description = 'Claude with the configured timezone and locale'
$shortcut.Save()

$saved = $shell.CreateShortcut($shortcutPath)
if ($saved.TargetPath -ne $target -or $saved.WorkingDirectory -ne $runtime) {
    throw 'The Start Menu shortcut did not retain the Claude UK launcher target.'
}
[pscustomobject]@{
    success = $true
    shortcut = $shortcutPath
    target = $saved.TargetPath
    backupExists = (Test-Path -LiteralPath $backupPath)
} | ConvertTo-Json -Compress
