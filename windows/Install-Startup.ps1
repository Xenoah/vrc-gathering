[CmdletBinding()]
param(
  [string]$ProfileDirectory = 'Default',
  [string]$ChromePath = ''
)
$ErrorActionPreference = 'Stop'
if ($ProfileDirectory -notmatch '^[a-zA-Z0-9 _.-]+$' -or $ProfileDirectory -in @('.', '..')) {
  throw 'ProfileDirectory must be a Chrome profile folder name, such as Default or Profile 1.'
}
if (-not $ChromePath) {
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe')
  )
  if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe') }
  $ChromePath = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}
if (-not $ChromePath -or -not (Test-Path -LiteralPath $ChromePath -PathType Leaf)) { throw 'Chrome was not found. Pass -ChromePath with the full path to chrome.exe.' }
$startup = [Environment]::GetFolderPath('Startup')
$linkPath = Join-Path $startup 'VRC Friends Observer - Chrome.lnk'
if (Test-Path -LiteralPath $linkPath) {
  throw "The startup shortcut already exists. Review or remove it first: $linkPath"
}
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($linkPath)
$link.TargetPath = (Resolve-Path -LiteralPath $ChromePath).Path
$link.Arguments = '--profile-directory="' + $ProfileDirectory + '" --no-startup-window'
$link.WorkingDirectory = Split-Path -Parent $ChromePath
$link.Description = 'Start Chrome for VRC Friends Observer after this Windows user logs on.'
$link.Save()
Write-Host 'Created the current-user Startup shortcut:'
Write-Host $linkPath
Write-Host 'Enable Chrome Settings > System > Continue running background apps when Google Chrome is closed.'
Write-Host 'The extension must be installed and collection enabled in the selected Chrome profile.'
Write-Host 'No service, scheduled task, registry entry or security-policy change was made.'
