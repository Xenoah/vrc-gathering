[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$linkPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'VRC Friends Observer - Chrome.lnk'
if (Test-Path -LiteralPath $linkPath -PathType Leaf) {
  Remove-Item -LiteralPath $linkPath
  Write-Host 'Removed only the VRC Friends Observer startup shortcut. Chrome and extension data were not changed.'
} else {
  Write-Host 'The VRC Friends Observer startup shortcut does not exist.'
}
