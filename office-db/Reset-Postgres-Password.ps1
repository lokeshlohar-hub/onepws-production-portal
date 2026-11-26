# ONEPWS - give the PostgreSQL "postgres" user a NEW password when nobody remembers the old one.
#
# Run on the OnePWS Dispatch server (192.168.114.39) as Administrator. What it does:
#   1. saves a copy of pg_hba.conf (PostgreSQL's "who may sign in" file)
#   2. for a few seconds lets ONLY the "postgres" user sign in WITHOUT a password, and ONLY from this PC itself
#      (127.0.0.1 / ::1 - never from the network)
#   3. sets a new, generated password for "postgres"
#   4. puts the original pg_hba.conf back (always - also when something fails) and checks that a sign-in without
#      a password is refused again
# No data, no database and no other login (the Dispatch app's, the portal's) is changed. The new password is saved in
# C:\OnePWS\Portal\postgres-superuser-password.txt (Administrators and SYSTEM only); Setup-Portal-Database reads it
# from there. Keep a copy in the company password manager.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here 'portal-common.ps1')

$hba = $null; $backup = $null; $changedHba = $false; $svc = $null; $dataDir = $null; $pg = $null

function Reload-Postgres {
  $r = Invoke-Exe (Join-Path $pg.Bin 'pg_ctl.exe') @('reload', '-D', $dataDir)
  if ($r.Code -eq 0) { Start-Sleep -Seconds 2; return }
  # pg_ctl could not signal the server: restart the service (a few seconds; the Dispatch app reconnects by itself)
  Write-Host '   (reload refused - restarting the PostgreSQL service for a few seconds)' -ForegroundColor DarkGray
  $deps = @(Get-Service -Name $svc.Name -DependentServices | Where-Object { $_.Status -eq 'Running' })
  Restart-Service -Name $svc.Name -Force
  foreach ($d in $deps) { try { Start-Service -Name $d.Name } catch { Write-Host ('   Start the service "' + $d.DisplayName + '" again by hand (services.msc).') -ForegroundColor Yellow } }
  Start-Sleep -Seconds 3
}

function Test-NoPasswordLogin {
  # $true when "postgres" gets in WITHOUT a password from this PC
  $env:PGHOST = '127.0.0.1'; $env:PGPORT = '5432'; $env:PGUSER = 'postgres'; $env:PGDATABASE = 'postgres'; $env:PGSSLMODE = 'disable'
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
  $env:PGPASSFILE = Join-Path $env:TEMP 'onepws-no-such-pgpass'
  try { $r = Invoke-Exe $pg.Psql @('-w', '-tAc', 'select 1'); return ($r.Code -eq 0 -and $r.Out.Trim() -eq '1') }
  finally { Clear-PgEnv; Remove-Item Env:\PGPASSFILE -ErrorAction SilentlyContinue }
}

try {
  Assert-Admin

  Write-Step 'PostgreSQL on this PC'
  $pg = Find-PgBin
  if (-not $pg) { throw 'PostgreSQL 15 or newer was not found under Program Files. Run this on the OnePWS Dispatch server (192.168.114.39).' }
  $services = @(Get-CimInstance Win32_Service | Where-Object { $_.Name -like 'postgresql*' -and $_.PathName })
  $svc = $services | Where-Object { $_.PathName.ToLower().Contains($pg.Bin.ToLower()) } | Select-Object -First 1
  if (-not $svc) { $svc = $services | Select-Object -First 1 }
  if (-not $svc) { throw 'The PostgreSQL Windows service was not found.' }
  if ($svc.State -ne 'Running') { throw ('The service "' + $svc.Name + '" is not running. Start it in services.msc, then run this again.') }
  $m = [regex]::Match($svc.PathName, '-D\s+"([^"]+)"')
  if (-not $m.Success) { $m = [regex]::Match($svc.PathName, '-D\s+(\S+)') }
  $dataDir = $(if ($m.Success) { $m.Groups[1].Value } else { Join-Path (Split-Path -Parent $pg.Bin) 'data' })
  $hba = Join-Path $dataDir 'pg_hba.conf'
  if (-not (Test-Path $hba)) { throw ('pg_hba.conf not found at ' + $hba) }
  Write-Ok ('PostgreSQL ' + $pg.Major + ', service "' + $svc.Name + '", data folder ' + $dataDir)

  if (Test-NoPasswordLogin) { throw 'This PostgreSQL already lets "postgres" in without a password from this PC - pg_hba.conf has a "trust" line. Nothing was changed; ask for help before going on.' }

  Write-Host ''
  Write-Host 'This sets a NEW password for the PostgreSQL "postgres" user. For about 10 seconds "postgres" can sign in' -ForegroundColor Yellow
  Write-Host 'without a password from THIS PC only; then the original rules are put back. No data is changed.' -ForegroundColor Yellow
  $ok = Read-Host 'Type YES to go on'
  if ($ok -cne 'YES') { Write-Host 'Stopped - nothing was changed.'; exit 1 }

  New-Item -ItemType Directory -Force -Path $PortalDir | Out-Null
  Protect-Path $PortalDir
  $newPw = New-Secret 24

  Write-Step 'Allowing "postgres" from this PC only, for a moment'
  $orig = [IO.File]::ReadAllBytes($hba)
  $backup = $hba + '.onepws-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
  [IO.File]::WriteAllBytes($backup, $orig)
  $bom = ($orig.Length -ge 3 -and $orig[0] -eq 0xEF -and $orig[1] -eq 0xBB -and $orig[2] -eq 0xBF)
  $add = [Text.Encoding]::ASCII.GetBytes("# ONEPWS temporary (Reset-Postgres-Password) - removed again by the script`r`nhost all postgres 127.0.0.1/32 trust`r`nhost all postgres ::1/128 trust`r`n")
  $ms = New-Object IO.MemoryStream
  if ($bom) { $ms.Write($orig, 0, 3); $ms.Write($add, 0, $add.Length); $ms.Write($orig, 3, $orig.Length - 3) }
  else { $ms.Write($add, 0, $add.Length); $ms.Write($orig, 0, $orig.Length) }
  [IO.File]::WriteAllBytes($hba, $ms.ToArray())
  $changedHba = $true
  Reload-Postgres
  $waited = 0
  while (-not (Test-NoPasswordLogin)) {
    if ($waited -ge 15) { throw 'PostgreSQL did not take the temporary rule (it is being removed again).' }
    Start-Sleep -Seconds 1; $waited++
  }
  Write-Ok 'temporary rule active'

  Write-Step 'Setting the new password'
  $env:PGHOST = '127.0.0.1'; $env:PGPORT = '5432'; $env:PGUSER = 'postgres'; $env:PGDATABASE = 'postgres'; $env:PGSSLMODE = 'disable'
  $env:PGPASSFILE = Join-Path $env:TEMP 'onepws-no-such-pgpass'
  try {
    # the SQL goes in on standard input, so the password never appears on a command line
    $sql = "alter role postgres with password '" + $newPw + "';"
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    $out = ($sql | & $pg.Psql -w -v ON_ERROR_STOP=1 -q -f - 2>&1 | ForEach-Object { '' + $_ }) -join ' '
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prev
    if ($code -ne 0) { throw ('PostgreSQL refused the new password: ' + $out) }
  } finally { Clear-PgEnv; Remove-Item Env:\PGPASSFILE -ErrorAction SilentlyContinue; $sql = $null }
  $pwFile = Join-Path $PortalDir 'postgres-superuser-password.txt'
  [IO.File]::WriteAllText($pwFile, $newPw, (New-Object System.Text.UTF8Encoding($false)))
  Protect-Path $pwFile
  Write-Ok ('saved in ' + $pwFile + ' (Administrators only)')
} catch {
  Write-Host ''
  Write-Host ('FAILED: ' + $_.Exception.Message) -ForegroundColor Red
  $failed = $true
} finally {
  if ($changedHba) {
    Write-Step 'Putting the original pg_hba.conf back'
    try {
      [IO.File]::WriteAllBytes($hba, [IO.File]::ReadAllBytes($backup))
      Reload-Postgres
      $still = $true
      for ($i = 0; $i -lt 15 -and $still; $i++) { $still = Test-NoPasswordLogin; if ($still) { Start-Sleep -Seconds 1 } }
      if ($still) {
        Write-Host ('   WARNING: "postgres" still gets in without a password. Restart the service "' + $svc.Name + '" in services.msc now, and check that') -ForegroundColor Red
        Write-Host ('   ' + $hba + ' has no "ONEPWS temporary" lines.') -ForegroundColor Red
        $failed = $true
      } else { Write-Ok ('original rules back (copy kept: ' + $backup + '); a sign-in without a password is refused again') }
    } catch {
      Write-Host ('   WARNING: could not put pg_hba.conf back automatically: ' + $_.Exception.Message) -ForegroundColor Red
      Write-Host ('   Copy ' + $backup + ' over ' + $hba + ' and restart the service "' + $svc.Name + '".') -ForegroundColor Red
      $failed = $true
    }
  }
}

if ($failed) { exit 1 }

# the new password really works?
Set-PgEnvFromUrl ('postgresql://postgres:' + $newPw + '@127.0.0.1:5432/postgres?sslmode=disable')
try { $r = Invoke-Exe $pg.Psql @('-tAc', 'select 1') } finally { Clear-PgEnv; $newPw = $null }
if ($r.Code -ne 0) { Write-Host ('FAILED: the new password does not sign in: ' + $r.Out) -ForegroundColor Red; exit 1 }
Write-Host ''
Write-Host 'Done. The "postgres" user has a new password and it works.' -ForegroundColor Green
Write-Host '  Setup-Portal-Database.bat will use it by itself. To keep a copy: open Notepad as Administrator, open'
Write-Host ('  ' + (Join-Path $PortalDir 'postgres-superuser-password.txt') + ' and save the password in the company password manager.')
Write-Host '  Do not e-mail it or paste it in chat.'
exit 0
