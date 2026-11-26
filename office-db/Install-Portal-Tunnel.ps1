# ONEPWS Production Portal - Cloudflare tunnel from this PC (outbound only) so the portal on Google Cloud can reach
# the office database at 127.0.0.1:5432. Nothing is opened on the office router or firewall.
#
# Before running: create the tunnel in the Cloudflare dashboard (README.txt, step 2) and copy its token.
# Installs cloudflared 2026.11.2 (checked against Cloudflare's published SHA-256) as the Windows service "Cloudflared".
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here 'portal-common.ps1')

$Version = '2026.11.2'
$Url = 'https://github.com/cloudflare/cloudflared/releases/download/' + $Version + '/cloudflared-windows-amd64.exe'
$Sha256 = '555b46c85582461d189cac30d14ad05480d612613801be9f110b8ce08c5b2113'

try {
  Assert-Admin
  New-Item -ItemType Directory -Force -Path $PortalDir | Out-Null
  $exe = Join-Path $PortalDir 'cloudflared.exe'

  Write-Step ('cloudflared ' + $Version)
  $need = $true
  if (Test-Path $exe) { $need = ((Get-FileHash -Algorithm SHA256 $exe).Hash.ToLower() -ne $Sha256) }
  if ($need) {
    $tmp = $exe + '.download'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $ProgressPreference = 'SilentlyContinue'   # the progress bar makes a 55 MB download crawl in Windows PowerShell
    Invoke-WebRequest -Uri $Url -OutFile $tmp -UseBasicParsing
    $got = (Get-FileHash -Algorithm SHA256 $tmp).Hash.ToLower()
    if ($got -ne $Sha256) { Remove-Item $tmp -Force; throw ('The downloaded cloudflared does not match the published checksum (' + $got + '). Nothing was installed.') }
    $svc = Get-Service -Name 'Cloudflared' -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -eq 'Running') { Stop-Service -Name 'Cloudflared' -Force }
    Move-Item -Force $tmp $exe
  }
  Write-Ok ($exe + ' (checksum verified)')

  Write-Step 'Tunnel service'
  $token = Read-Secret 'Tunnel token (Cloudflare Zero Trust > Networks > Tunnels > onepws-portal-db > install command - the long value after "install")'
  if ($token.Length -lt 50) { throw 'That does not look like a tunnel token (it is a long string, usually starting with "ey").' }
  if (Get-Service -Name 'Cloudflared' -ErrorAction SilentlyContinue) {
    $r = Invoke-Exe $exe @('service', 'uninstall')
    Start-Sleep -Seconds 3
  }
  $r = Invoke-Exe $exe @('service', 'install', $token)
  $token = $null
  if ($r.Code -ne 0) { throw ('cloudflared could not install the service: ' + $r.Out) }
  Start-Sleep -Seconds 5
  $svc = Get-Service -Name 'Cloudflared' -ErrorAction SilentlyContinue
  if (-not $svc) { throw 'The Cloudflared service was not created.' }
  if ($svc.Status -ne 'Running') { Start-Service -Name 'Cloudflared'; Start-Sleep -Seconds 5; $svc.Refresh() }
  Set-Service -Name 'Cloudflared' -StartupType Automatic
  Write-Ok ('service Cloudflared: ' + $svc.Status + ' (starts with Windows)')

  Write-Host ''
  Write-Host 'Done.' -ForegroundColor Green
  Write-Host '  In the Cloudflare dashboard the tunnel "onepws-portal-db" should now show HEALTHY.'
  exit 0
} catch {
  Write-Host ''
  Write-Host ('FAILED: ' + $_.Exception.Message) -ForegroundColor Red
  exit 1
}
