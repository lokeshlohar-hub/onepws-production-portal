# ONEPWS Production Portal - office database helpers (Windows PowerShell 5.1, ASCII only).
# Used by Setup-Portal-Database.ps1, Install-Portal-Tunnel.ps1 and portal-backup.ps1.
# Same habits as the OnePWS Dispatch server scripts: no password ever on a command line (PG* environment
# variables instead), hidden prompts, settings file readable by Administrators and SYSTEM only.

$PortalDir = 'C:\OnePWS\Portal'
$PortalDb = 'onepws_portal'
$PortalRole = 'portal_app'
$TunnelPort = 15432   # only inside the Cloud Run container; listed here for the instructions

function Write-Step([string]$t) { Write-Host ''; Write-Host ('== ' + $t) -ForegroundColor Cyan }
function Write-Ok([string]$t) { Write-Host ('   OK  ' + $t) -ForegroundColor Green }

function Invoke-Exe([string]$Exe, [string[]]$Arguments) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & $Exe @Arguments 2>&1 | ForEach-Object { '' + $_ }
    return [pscustomobject]@{ Code = $LASTEXITCODE; Out = (($out | Where-Object { $_ -ne $null }) -join [Environment]::NewLine) }
  } finally { $ErrorActionPreference = $prev }
}

function Assert-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p = New-Object Security.Principal.WindowsPrincipal($id)
  if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this as Administrator (right-click the .bat file > Run as administrator).'
  }
}

# Random letters + digits (safe in a URL and an SQL string literal).
function New-Secret([int]$Length) {
  $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'.ToCharArray()
  $rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
  $out = New-Object System.Text.StringBuilder
  while ($out.Length -lt $Length) {
    $bytes = New-Object byte[] 64
    $rng.GetBytes($bytes)
    foreach ($b in $bytes) {
      if ($out.Length -ge $Length) { break }
      if ($b -lt (256 - (256 % $chars.Length))) { [void]$out.Append($chars[$b % $chars.Length]) }
    }
  }
  return $out.ToString()
}

# A hidden prompt. Pasting does not work in every Windows console: copy the value, then press Enter on an empty prompt.
function Read-Secret([string]$Prompt) {
  Write-Host ($Prompt + ':')
  Write-Host '   Copy it, then just press Enter here (it is taken from the clipboard) - or type it and press Enter. Nothing is shown.' -ForegroundColor DarkGray
  $s = Read-Host -Prompt '  ' -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { $v = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
  if (-not ('' + $v).Trim()) {
    try { $v = ('' + (Get-Clipboard -Raw)).Trim() } catch { $v = '' }
    if ($v) {
      Write-Host ('   Taken from the clipboard (' + $v.Length + ' characters); the clipboard is now cleared.') -ForegroundColor DarkGray
      try { Set-Clipboard -Value ' ' } catch { }
    } else { Write-Host '   The clipboard is empty.' -ForegroundColor Yellow }
  }
  return ('' + $v).Trim()
}

function Read-EnvFile([string]$Path) {
  $h = [ordered]@{}
  if (-not (Test-Path $Path)) { return $h }
  foreach ($line in Get-Content -Path $Path) {
    $t = $line.Trim()
    if (-not $t -or $t.StartsWith('#')) { continue }
    $i = $t.IndexOf('=')
    if ($i -lt 1) { continue }
    $h[$t.Substring(0, $i).Trim()] = $t.Substring($i + 1).Trim()
  }
  return $h
}
function Write-EnvFile([string]$Path, $Settings) {
  $lines = @('# ONEPWS Production Portal - office database settings. Keep this file private.')
  foreach ($k in $Settings.Keys) { $lines += ($k + '=' + $Settings[$k]) }
  [IO.File]::WriteAllLines($Path, [string[]]$lines, (New-Object System.Text.UTF8Encoding($false)))
}

# Administrators and SYSTEM only.
function Protect-Path([string]$Path) {
  if ((Get-Item $Path).PSIsContainer) {
    $r = Invoke-Exe 'icacls.exe' @($Path, '/inheritance:r', '/grant:r', '*S-1-5-32-544:(OI)(CI)F', '*S-1-5-18:(OI)(CI)F')
  } else {
    $r = Invoke-Exe 'icacls.exe' @($Path, '/inheritance:r', '/grant:r', '*S-1-5-32-544:F', '*S-1-5-18:F')
  }
  if ($r.Code -ne 0) { throw ('Could not restrict access to ' + $Path + ': ' + $r.Out) }
}

# The newest PostgreSQL (15+) under Program Files - the one the OnePWS Dispatch server already uses.
function Find-PgBin {
  $found = @()
  foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if (-not $root) { continue }
    $base = Join-Path $root 'PostgreSQL'
    if (-not (Test-Path $base)) { continue }
    foreach ($d in Get-ChildItem -Path $base -Directory) {
      $psql = Join-Path $d.FullName 'bin\psql.exe'
      $major = 0
      if ((Test-Path $psql) -and [int]::TryParse(($d.Name -split '\.')[0], [ref]$major) -and $major -ge 15) {
        $found += [pscustomobject]@{ Major = $major; Bin = (Join-Path $d.FullName 'bin') }
      }
    }
  }
  if (-not $found) { return $null }
  $best = $found | Sort-Object Major -Descending | Select-Object -First 1
  return [pscustomobject]@{
    Major = $best.Major; Bin = $best.Bin
    Psql = (Join-Path $best.Bin 'psql.exe'); PgDump = (Join-Path $best.Bin 'pg_dump.exe'); PgRestore = (Join-Path $best.Bin 'pg_restore.exe')
  }
}

# postgresql://user:pass@host:port/db?sslmode=x  ->  PG* environment variables.
function Set-PgEnvFromUrl([string]$Url) {
  $u = [Uri]$Url
  if ($u.Scheme -ne 'postgresql' -and $u.Scheme -ne 'postgres') { throw 'Not a postgresql:// connection string.' }
  $info = $u.UserInfo.Split(':', 2)
  $env:PGHOST = $u.Host
  $env:PGPORT = $(if ($u.Port -gt 0) { [string]$u.Port } else { '5432' })
  $env:PGUSER = [Uri]::UnescapeDataString($info[0])
  $env:PGPASSWORD = $(if ($info.Count -gt 1) { [Uri]::UnescapeDataString($info[1]) } else { '' })
  $env:PGDATABASE = [Uri]::UnescapeDataString($u.AbsolutePath.TrimStart('/'))
  $mode = 'prefer'
  foreach ($part in $u.Query.TrimStart('?').Split('&')) { if ($part -like 'sslmode=*') { $mode = $part.Substring(8) } }
  $env:PGSSLMODE = $mode
}
function Clear-PgEnv { foreach ($n in 'PGHOST','PGPORT','PGUSER','PGPASSWORD','PGDATABASE','PGSSLMODE') { Remove-Item ('Env:\' + $n) -ErrorAction SilentlyContinue } }

function Local-PortalUrl([string]$Password) {
  return ('postgresql://' + $PortalRole + ':' + $Password + '@127.0.0.1:5432/' + $PortalDb + '?sslmode=disable')
}

# Row count of every table in schema portal, as "table=count" lines (current PG* environment).
function Get-PortalCounts($Pg) {
  $sql = "select string_agg(t || '=' || (xpath('/row/n/text()', query_to_xml('select count(*) as n from portal.' || quote_ident(t), false, true, '')))[1]::text, chr(10) order by t) from (select table_name::text t from information_schema.tables where table_schema = 'portal' and table_type = 'BASE TABLE') x"
  $r = Invoke-Exe $Pg.Psql @('-v', 'ON_ERROR_STOP=1', '-tAc', $sql)
  if ($r.Code -ne 0) { throw ('Could not count rows: ' + $r.Out) }
  $h = [ordered]@{}
  foreach ($line in ($r.Out -split "`r?`n")) { $t = $line.Trim(); if ($t -and $t.Contains('=')) { $p = $t.Split('='); $h[$p[0]] = [long]$p[1] } }
  return $h
}
