# ONEPWS Production Portal - put the portal's database on the office server (the OnePWS Dispatch server's PostgreSQL).
#
#   First run   : creates database "onepws_portal" + login "portal_app" (separate from the dispatch database),
#                 copies schema "portal" from Supabase into it and compares every table's row count.
#   -Refresh    : the final sync right before the switch-over: backs up the office copy, then replaces it with a fresh
#                 copy from Supabase (Supabase itself is only READ, never changed).
#
# Nothing here opens a port: the portal on Google Cloud reaches this database only through the Cloudflare tunnel
# (Install-Portal-Tunnel), which connects to 127.0.0.1:5432 on this PC.
param([switch]$Refresh)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here 'portal-common.ps1')

try {
  Assert-Admin

  Write-Step 'Folder C:\OnePWS\Portal (scripts, settings, backups)'
  New-Item -ItemType Directory -Force -Path $PortalDir | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $PortalDir 'backups') | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $PortalDir 'logs') | Out-Null
  if ((Resolve-Path $here).Path -ne (Resolve-Path $PortalDir).Path) {
    Get-ChildItem -Path $here -File | Where-Object { $_.Extension -in '.ps1', '.bat', '.txt', '.md' } | ForEach-Object { Copy-Item $_.FullName -Destination $PortalDir -Force }
  }
  Protect-Path $PortalDir
  Write-Ok $PortalDir

  Write-Step 'PostgreSQL on this PC'
  $pg = Find-PgBin
  if (-not $pg) { throw 'PostgreSQL 15 or newer was not found under Program Files. This must be the OnePWS Dispatch server.' }
  Write-Ok ('PostgreSQL ' + $pg.Major + ' (' + $pg.Bin + ')')

  $envPath = Join-Path $PortalDir '.env'
  $settings = Read-EnvFile $envPath
  if (-not $settings['PORTAL_DB_PASSWORD']) { $settings['PORTAL_DB_PASSWORD'] = New-Secret 32 }
  $pw = $settings['PORTAL_DB_PASSWORD']
  $settings['PG_BIN'] = $pg.Bin
  if (-not $settings['BACKUP_DIR']) { $settings['BACKUP_DIR'] = (Join-Path $PortalDir 'backups') }

  Write-Step 'Database "onepws_portal" and login "portal_app"'
  $superPw = Read-Secret 'Password of the PostgreSQL "postgres" user (the one used when the Dispatch server was set up)'
  $env:PGHOST = '127.0.0.1'; $env:PGPORT = '5432'; $env:PGUSER = 'postgres'; $env:PGPASSWORD = $superPw; $env:PGDATABASE = 'postgres'; $env:PGSSLMODE = 'disable'
  try {
    $sql = "do `$`$ begin if not exists (select 1 from pg_roles where rolname = '" + $PortalRole + "') then create role " + $PortalRole + " login password '" + $pw + "'; else alter role " + $PortalRole + " login password '" + $pw + "'; end if; end `$`$;"
    $r = Invoke-Exe $pg.Psql @('-v', 'ON_ERROR_STOP=1', '-tAc', $sql)
    if ($r.Code -ne 0) { throw ('PostgreSQL refused the login: ' + $r.Out) }
    $r = Invoke-Exe $pg.Psql @('-tAc', "select 1 from pg_database where datname = '" + $PortalDb + "'")
    if ($r.Code -ne 0) { throw ('Cannot reach PostgreSQL as "postgres": ' + $r.Out) }
    if ($r.Out.Trim() -ne '1') {
      $r = Invoke-Exe $pg.Psql @('-v', 'ON_ERROR_STOP=1', '-tAc', ('create database ' + $PortalDb + ' owner ' + $PortalRole + " encoding 'UTF8' template template0"))
      if ($r.Code -ne 0) { throw ('Could not create the database: ' + $r.Out) }
    }
    foreach ($s in @(
        ('revoke all on database ' + $PortalDb + ' from public'),
        ('grant connect, create, temporary on database ' + $PortalDb + ' to ' + $PortalRole),
        ('alter role ' + $PortalRole + ' in database ' + $PortalDb + ' set search_path = portal'))) {
      $r = Invoke-Exe $pg.Psql @('-v', 'ON_ERROR_STOP=1', '-tAc', $s)
      if ($r.Code -ne 0) { throw ('PostgreSQL refused: ' + $r.Out) }
    }
    # Who can reach PostgreSQL from the network? Only localhost is needed (the tunnel and the Dispatch app run here).
    $listen = (Invoke-Exe $pg.Psql @('-tAc', 'show listen_addresses')).Out.Trim()
  } finally { Clear-PgEnv; $superPw = $null }
  Write-Ok ('database ' + $PortalDb + ', login ' + $PortalRole + ' (its own password, generated)')
  if ($listen -and $listen -ne 'localhost' -and $listen -ne '127.0.0.1') {
    Write-Host ('   Note: PostgreSQL listens on "' + $listen + '". The portal only needs localhost; keep Windows Firewall closing port 5432 to the network.') -ForegroundColor Yellow
  }

  $local = Local-PortalUrl $pw
  $settings['PORTAL_DB_URL'] = $local

  # ---- does the office copy already hold data? ----
  Set-PgEnvFromUrl $local
  try {
    $hr = Invoke-Exe $pg.Psql @('-tAc', "select count(*) from information_schema.tables where table_schema = 'portal'")
    if ($hr.Code -ne 0) { throw ('Cannot sign in to the new database as portal_app: ' + $hr.Out) }
    $has = $hr.Out.Trim()
  } finally { Clear-PgEnv }
  $hasData = ($has -match '^\d+$') -and ([int]$has -gt 0)

  if ($hasData -and -not $Refresh) {
    Write-Step 'Copy from Supabase'
    Write-Ok 'the office database already holds the portal data - not copied again. (Run Refresh-Portal-Database.bat for the final sync.)'
  } else {
    Write-Step ('Copy schema "portal" from Supabase' + $(if ($Refresh) { ' (final sync)' } else { '' }))
    Write-Host '   Supabase is only READ. Use the portal_app connection string of the SESSION pooler (port 5432).' -ForegroundColor DarkGray
    $src = Read-Secret 'Supabase connection string (postgresql://portal_app.<project>:<password>@...pooler.supabase.com:5432/postgres)'
    if ($src -notmatch '^postgres(ql)?://') { throw 'That is not a postgresql:// connection string.' }
    if ($src -notmatch 'sslmode=') { $src = $src + $(if ($src.Contains('?')) { '&' } else { '?' }) + 'sslmode=require' }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $dump = Join-Path $PortalDir ('backups\supabase-portal-' + $stamp + '.dump')

    Set-PgEnvFromUrl $src
    try {
      # pg_dump must be at least as new as the Supabase server (17.x in Nov 2026)
      $v = Invoke-Exe $pg.Psql @('-tAc', 'show server_version_num')
      if ($v.Code -ne 0) { throw ('Cannot sign in to Supabase with that connection string: ' + $v.Out) }
      $srcMajor = [int]([math]::Floor([int]$v.Out.Trim() / 10000))
      if ($pg.Major -lt $srcMajor) { throw ('Supabase runs PostgreSQL ' + $srcMajor + ' but this PC has ' + $pg.Major + '. Install PostgreSQL ' + $srcMajor + ' (or newer) here first.') }
      $r = Invoke-Exe $pg.PgDump @('--format=custom', '--no-owner', '--no-privileges', '--schema=portal', '--file', $dump)
      if ($r.Code -ne 0) { throw ('pg_dump from Supabase failed: ' + $r.Out) }
      $srcCounts = Get-PortalCounts $pg
    } finally { Clear-PgEnv; $src = $null }
    Write-Ok ('read ' + $srcCounts.Count + ' tables from Supabase -> ' + $dump)

    Set-PgEnvFromUrl $local
    try {
      if ($hasData) {
        $safety = Join-Path $PortalDir ('backups\office-portal-before-refresh-' + $stamp + '.dump')
        $r = Invoke-Exe $pg.PgDump @('--format=custom', '--no-owner', '--no-privileges', '--file', $safety)
        if ($r.Code -ne 0) { throw ('Safety backup of the office copy failed - nothing was changed: ' + $r.Out) }
        Write-Ok ('safety backup of the office copy: ' + $safety)
        $r = Invoke-Exe $pg.Psql @('-v', 'ON_ERROR_STOP=1', '-tAc', 'drop schema portal cascade')
        if ($r.Code -ne 0) { throw ('Could not clear the office copy: ' + $r.Out) }
      }
      $r = Invoke-Exe $pg.PgRestore @('--no-owner', '--no-privileges', '--single-transaction', '--exit-on-error', '--dbname', $PortalDb, $dump)
      if ($r.Code -ne 0) { throw ('pg_restore into the office database failed: ' + $r.Out) }
      $dstCounts = Get-PortalCounts $pg
    } finally { Clear-PgEnv }

    Write-Step 'Rows: Supabase vs office'
    $bad = 0
    foreach ($t in $srcCounts.Keys) {
      $a = $srcCounts[$t]; $b = $(if ($dstCounts.Contains($t)) { $dstCounts[$t] } else { -1 })
      $ok = ($a -eq $b)
      if (-not $ok) { $bad++ }
      Write-Host ('   {0,-32} {1,8} {2,8}  {3}' -f $t, $a, $b, $(if ($ok) { 'same' } else { 'DIFFERENT' })) -ForegroundColor $(if ($ok) { 'Gray' } else { 'Red' })
    }
    if ($bad -gt 0) { throw ($bad.ToString() + ' table(s) differ. Was the portal still being used during the copy? Run it again when it is quiet.') }
    Write-Ok ('all ' + $srcCounts.Count + ' tables have the same number of rows')
  }

  Write-EnvFile $envPath $settings
  Protect-Path $envPath

  # The value Google Cloud needs as DATABASE_URL: the same login, reached through the tunnel inside the container.
  $cloud = Join-Path $PortalDir 'cloud-run-DATABASE_URL.txt'
  [IO.File]::WriteAllText($cloud, ('postgresql://' + $PortalRole + ':' + $pw + '@127.0.0.1:' + $TunnelPort + '/' + $PortalDb), (New-Object System.Text.UTF8Encoding($false)))
  Protect-Path $cloud

  Write-Step 'Nightly backup of the portal database (01:45)'
  $script = Join-Path $PortalDir 'portal-backup.ps1'
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -File "' + $script + '"')
  $trigger = New-ScheduledTaskTrigger -Daily -At '01:45'
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $set = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2)
  Register-ScheduledTask -TaskName 'ONEPWS Portal nightly backup' -Action $action -Trigger $trigger -Principal $principal -Settings $set -Force | Out-Null
  Write-Ok 'scheduled task "ONEPWS Portal nightly backup" (30 days kept)'

  Write-Host ''
  Write-Host 'Done.' -ForegroundColor Green
  Write-Host ('  The value for Google Cloud (DATABASE_URL) is in ' + $cloud + ' (open it as Administrator; do not e-mail or paste it in chat).')
  Write-Host '  Next: Install-Portal-Tunnel.bat (after the Cloudflare tunnel is created - see README.txt).'
  exit 0
} catch {
  Write-Host ''
  Write-Host ('FAILED: ' + $_.Exception.Message) -ForegroundColor Red
  exit 1
}
