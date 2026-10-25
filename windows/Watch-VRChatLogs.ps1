[CmdletBinding()]
param(
  [string]$SourceDirectory = '',
  [string]$OutputDirectory = '',
  [ValidateRange(5,300)][int]$PollSeconds = 15,
  [switch]$Once
)
$ErrorActionPreference = 'Stop'
if (-not $SourceDirectory) { $SourceDirectory = Join-Path (Split-Path $env:LOCALAPPDATA -Parent) 'LocalLow\VRChat\VRChat' }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'VRCFriendsObserverLogs' }
$SourceDirectory = [IO.Path]::GetFullPath($SourceDirectory)
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if ($SourceDirectory.TrimEnd('\','/') -eq $OutputDirectory.TrimEnd('\','/')) { throw 'The output folder must differ from the VRChat log folder.' }
if (-not [IO.Directory]::Exists($SourceDirectory)) { throw 'VRChat log folder not found. Run the PC version first, or pass -SourceDirectory.' }
[void][IO.Directory]::CreateDirectory($OutputDirectory)
$encoding = New-Object System.Text.UTF8Encoding($false)
$seen = @{}
$prefix = '# VRC Friends Observer filtered log: '
$linePattern = '^(\d{4}\.\d{2}\.\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)\s+(?:Log|Warning|Error)\s+-\s+(.*)$'
$allowed = '^(?:\[(?:Behaviour|RoomManager)\] (?:Joining wrld_[a-zA-Z0-9-]{8,64}:[^\s]+|Entering Room: .{1,256})|\[(?:Behaviour|NetworkManager)\] (?:OnPlayer(?:Joined|Left) .{1,256}|OnPlayerLeftRoom)|\[(?:Behaviour|Player)\] Initialized PlayerAPI ".{1,128}" is local|(?:\[(?:Behaviour|APIUser)\]\s*)?User Authenticated: .{1,128} \(usr_[a-zA-Z0-9-]{8,64}\)|VRCApplication: (?:OnApplicationQuit|HandleApplicationQuit) at [0-9.]+)\s*$'
Write-Host ('Filtered logs: ' + $OutputDirectory)
Write-Host 'Select this folder in the extension. Keep this window open; Ctrl+C stops it.'
do {
  foreach ($file in Get-ChildItem -LiteralPath $SourceDirectory -Filter 'output_log_*.txt' -File) {
    $stamp = [string]$file.Length + ':' + [string]$file.LastWriteTimeUtc.Ticks
    if ($seen[$file.FullName] -eq $stamp) { continue }
    if ($file.Length -gt 128MB) { Write-Warning ($file.Name + ': exceeds 128 MiB; skipped.'); continue }
    $stream = $null; $reader = $null
    try {
      $stream = New-Object IO.FileStream($file.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
      $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8, $true)
      $content = $reader.ReadToEnd()
      $lines = $content -split "`n"
      $result = New-Object Text.StringBuilder
      [void]$result.AppendLine($prefix + $file.Name)
      $lastStamp = ''
      # Ignore a final incomplete line; it will be retried after the next append.
      for ($i = 0; $i -lt ($lines.Length - 1); $i++) {
        $line = $lines[$i].TrimEnd("`r")
        if ($line -notmatch $linePattern) { continue }
        $lastStamp = $Matches[1]; $body = $Matches[2]
        if ($body -match $allowed) {
          if ($body -match '^(\[(?:Behaviour|RoomManager)\] Joining wrld_[a-zA-Z0-9-]{8,64}:)(.+)$') {
            $joining = $Matches[1]; $parts = $Matches[2] -split '~'
            $safe = @($parts[0]) + @($parts | Select-Object -Skip 1 | Where-Object { $_ -match '^(?:(?:private|hidden|friends)\(usr_[a-zA-Z0-9-]{8,64}\)|group\(grp_[a-zA-Z0-9-]{8,64}\)|region\([a-z0-9-]{1,20}\)|groupAccessType\((?:public|plus|members)\)|canRequestInvite)$' })
            $body = $joining + ($safe -join '~')
          }
          [void]$result.AppendLine($lastStamp + ' Log - ' + $body)
        }
      }
      if ($lastStamp) { [void]$result.AppendLine($lastStamp + ' Log - [Observer] Log checkpoint') }
      $target = Join-Path $OutputDirectory $file.Name
      $text = $result.ToString()
      if ([IO.File]::Exists($target)) {
        $old = [IO.File]::ReadAllText($target)
        if (-not $old.StartsWith($prefix)) { throw 'Refusing to overwrite a file not created by this script.' }
        if ($old -eq $text) { $seen[$file.FullName] = $stamp; continue }
      }
      $temporary = $target + '.tmp'
      [IO.File]::WriteAllText($temporary, $text, $encoding)
      if ([IO.File]::Exists($target)) { [IO.File]::Replace($temporary, $target, [NullString]::Value) } else { [IO.File]::Move($temporary, $target) }
      $seen[$file.FullName] = $stamp
    } catch { Write-Warning ($file.Name + ': ' + $_.Exception.Message) }
    finally { if ($reader) { $reader.Dispose() } elseif ($stream) { $stream.Dispose() } }
  }
  if (-not $Once) { Start-Sleep -Seconds $PollSeconds }
} while (-not $Once)
