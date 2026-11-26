# ONEPWS Production Portal - backup of the office database "onepws_portal" (nightly at 01:45, or Backup-Portal-Now.bat).
# Keeps 30 days of nightly backups in BACKUP_DIR. Tip: copy that folder to a NAS too.
param([string]$Reason = 'nightly')
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here 'portal-common.ps1')
$settings = Read-EnvFile (Join-Path $PortalDir '.env')
$log = Join-Path $PortalDir 'logs\backup.log'
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
function Log([string]$t) { Add-Content -Path $log -Value ((Get-Date -Format 's') + '  ' + $t) }
try {
  if (-not $settings['PORTAL_DB_URL']) { throw 'no PORTAL_DB_URL in C:\OnePWS\Portal\.env - run Setup-Portal-Database first' }
  $bin = $settings['PG_BIN']
  if (-not $bin -or -not (Test-Path (Join-Path $bin 'pg_dump.exe'))) { $p = Find-PgBin; if (-not $p) { throw 'pg_dump not found' }; $bin = $p.Bin }
  $dir = $(if ($settings['BACKUP_DIR']) { $settings['BACKUP_DIR'] } else { Join-Path $PortalDir 'backups' })
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $file = Join-Path $dir ('onepws-portal-' + (Get-Date -Format 'yyyyMMdd-HHmm') + '-' + $Reason + '.dump')
  Set-PgEnvFromUrl $settings['PORTAL_DB_URL']
  try { $r = Invoke-Exe (Join-Path $bin 'pg_dump.exe') @('--format=custom', '--no-owner', '--no-privileges', '--file', $file) }
  finally { Clear-PgEnv }
  if ($r.Code -ne 0) { throw ('pg_dump failed: ' + $r.Out) }
  if ((Get-Item $file).Length -lt 1024) { throw ('backup file is suspiciously small: ' + $file) }
  Log ('OK ' + $file + ' (' + [math]::Round((Get-Item $file).Length / 1MB, 2) + ' MB)')
  Get-ChildItem -Path $dir -Filter 'onepws-portal-*-nightly.dump' |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } |
    ForEach-Object { Remove-Item $_.FullName; Log ('removed old ' + $_.Name) }
  Write-Output $file
  exit 0
} catch {
  Log ('FAILED: ' + $_.Exception.Message)
  Write-Host ('Backup FAILED: ' + $_.Exception.Message) -ForegroundColor Red
  exit 1
}
