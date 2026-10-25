$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('vrc-log-test-' + [Guid]::NewGuid().ToString('N'))
$source = Join-Path $temporary 'source'; $output = Join-Path $temporary 'output'
[void][IO.Directory]::CreateDirectory($source)
$path = Join-Path $source 'output_log_fixture.txt'
$fixture = @'
2026.10.25 10:00:00 Log - [API] authToken=SECRET_AUTH email=SECRET_EMAIL
2026.10.25 10:00:01 Log - [Behaviour] Joining wrld_fixture0001:123~region(jp)~nonce(SECRET_JOIN)
2026.10.25 10:00:02 Log - [Behaviour] OnPlayerJoined Visitor (usr_visitor0001)
2026.10.25 10:00:03 Log - [Chat] SECRET_CHAT
2026.10.25 10:00:04 Log - [Video] https://example.invalid/SECRET_URL
'@
try {
  [IO.File]::WriteAllText($path, $fixture + "`n", (New-Object Text.UTF8Encoding($false)))
  & (Join-Path $root 'windows/Watch-VRChatLogs.ps1') -SourceDirectory $source -OutputDirectory $output -Once
  $target = Join-Path $output 'output_log_fixture.txt'; $text = [IO.File]::ReadAllText($target)
  if ($text.Contains('SECRET') -or -not $text.Contains('OnPlayerJoined Visitor') -or -not $text.Contains('10:00:04 Log - [Observer]')) { throw 'Filtered output failed.' }
  if ([IO.File]::ReadAllText($path) -ne ($fixture + "`n")) { throw 'Source log changed.' }
  [IO.File]::AppendAllText($path, "2026.10.25 10:05:00 Log - [Behaviour] OnPlayerLeft Visitor (usr_visitor0001)")
  & (Join-Path $root 'windows/Watch-VRChatLogs.ps1') -SourceDirectory $source -OutputDirectory $output -Once
  if ([IO.File]::ReadAllText($target).Contains('OnPlayerLeft')) { throw 'Partial line was processed.' }
  [IO.File]::AppendAllText($path, "`n")
  & (Join-Path $root 'windows/Watch-VRChatLogs.ps1') -SourceDirectory $source -OutputDirectory $output -Once
  if (-not [IO.File]::ReadAllText($target).Contains('OnPlayerLeft')) { throw 'Appended exit was not captured.' }
  $blocked = $false
  try { & (Join-Path $root 'windows/Watch-VRChatLogs.ps1') -SourceDirectory $source -OutputDirectory $source -Once } catch { $blocked = $true }
  if (-not $blocked) { throw 'Source overwrite was not blocked.' }
  Write-Host 'PASS: filtered logs, timestamps, partial append, source protection'
} finally { if ([IO.Directory]::Exists($temporary)) { [IO.Directory]::Delete($temporary,$true) } }
