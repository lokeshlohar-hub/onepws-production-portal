<#
  ONEPWS Handover Mail Relay Agent — one-shot setup for sys160.

  Installs dependencies, writes mail-agent\.env, asks for the mailbox password
  once (hidden input), TESTS it against the internal mail server, and only then
  installs the Windows service. Nothing is installed if the login fails.

  Usage (PowerShell, from the repo root):
      .\mail-agent\setup.ps1 -AgentToken "<token from the portal>"

  Re-running is safe: it updates the config and restarts the service.
#>

param(
  [Parameter(Mandatory = $true)][string]$AgentToken,
  [string]$PortalUrl = "https://onepws-portal-207920932496.asia-south1.run.app",
  [string]$SmtpHost  = "192.168.100.5",
  [int]   $SmtpPort  = 25,
  [string]$SmtpFrom  = "portal@workspace.com",
  [string]$ProbeTo   = "production@workspace.com",
  [string]$ServiceName = "ONEPWSMailAgent"
)

$ErrorActionPreference = "Stop"
$AgentDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Host ""
Write-Host "ONEPWS Mail Relay Agent setup" -ForegroundColor Cyan
Write-Host "  folder : $AgentDir"
Write-Host "  portal : $PortalUrl"
Write-Host "  smtp   : ${SmtpHost}:${SmtpPort}"
Write-Host "  from   : $SmtpFrom"
Write-Host ""

# --- 1. Node present? -------------------------------------------------------
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) { Write-Host "ERROR: Node.js is not on PATH. Install it, then re-run." -ForegroundColor Red; exit 1 }
Write-Host "[1/6] Node $(node --version) found."

# --- 2. Dependencies --------------------------------------------------------
Write-Host "[2/6] Installing dependencies..."
Push-Location $AgentDir
try { npm install --no-audit --no-fund | Out-Null } finally { Pop-Location }
Write-Host "      done."

# --- 3. Does this machine need a login at all? ------------------------------
# production@workspace.com is a distribution group, not a mailbox — it has no
# password. Internal mail servers commonly let machines on their own subnet
# send without any login, and sys160 is on the mail server's subnet, so check
# before asking anyone for credentials. The probe sends nothing.
Write-Host "[3/6] Checking whether this machine may send without a login..."
Write-Host ""
Push-Location $AgentDir
try { & node probe.js --host $SmtpHost --port $SmtpPort --from $SmtpFrom --to $ProbeTo; $probeExit = $LASTEXITCODE }
finally { Pop-Location }
Write-Host ""

$SmtpUser = ""
$SmtpPass = ""

if ($probeExit -eq 0) {
  Write-Host "      No login required from this machine." -ForegroundColor Green
}
else {
  if ($probeExit -eq 10) {
    Write-Host "      This server wants a login." -ForegroundColor Yellow
  } else {
    Write-Host "      The probe was inconclusive; falling back to a login." -ForegroundColor Yellow
  }
  Write-Host "      Enter a real MAILBOX account (not the distribution group)."
  Write-Host "      Leave the address blank to abort and go ask IT for one."
  $SmtpUser = Read-Host "      Mailbox address"
  if ([string]::IsNullOrWhiteSpace($SmtpUser)) {
    Write-Host ""
    Write-Host "Aborted - nothing was installed." -ForegroundColor Red
    Write-Host "Ask IT for a mailbox the portal can send as (e.g. portal@workspace.com)," -ForegroundColor Yellow
    Write-Host "then re-run this script." -ForegroundColor Yellow
    exit 1
  }
  Write-Host "      (typing is hidden; stored only in mail-agent\.env on this machine)"
  $secure = Read-Host "      Password" -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try   { $SmtpPass = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  if ([string]::IsNullOrWhiteSpace($SmtpPass)) { Write-Host "ERROR: empty password." -ForegroundColor Red; exit 1 }
}

# --- 4. Write .env ----------------------------------------------------------
$envPath = Join-Path $AgentDir ".env"
$envText = @"
PORTAL_URL=$PortalUrl
MAIL_AGENT_TOKEN=$AgentToken
POLL_SECONDS=20
SMTP_HOST=$SmtpHost
SMTP_PORT=$SmtpPort
SMTP_SECURE=false
SMTP_USER=$SmtpUser
SMTP_PASS=$SmtpPass
SMTP_FROM=ONEPWS Production Portal <$SmtpFrom>
"@
Set-Content -Path $envPath -Value $envText -Encoding utf8
Write-Host "[4/6] Wrote $envPath"

# --- 5. Verify BEFORE installing anything -----------------------------------
Write-Host "[5/6] Verifying the mail server connection..."
Push-Location $AgentDir
try { & node agent.js --check; $checkExit = $LASTEXITCODE } finally { Pop-Location }
if ($checkExit -ne 0) {
  Write-Host ""
  Write-Host "Verification FAILED - nothing was installed." -ForegroundColor Red
  Write-Host "Fix the settings and re-run this script." -ForegroundColor Red
  Write-Host "The .env has been left in place so you can edit it directly if you prefer." -ForegroundColor Yellow
  exit 1
}
Write-Host "      mail server OK." -ForegroundColor Green

# --- 6. Install / restart the Windows service -------------------------------
Write-Host "[6/6] Installing the Windows service..."
$nssm = (Get-Command nssm -ErrorAction SilentlyContinue)
if ($nssm) { $nssmExe = $nssm.Source }
else {
  $repoRoot = Split-Path -Parent $AgentDir
  $candidates = @("C:\onepws\nssm\nssm.exe", "C:\onepws\nssm\win64\nssm.exe",
                  "C:\nssm\nssm.exe", "C:\Program Files\nssm\nssm.exe",
                  (Join-Path $repoRoot "nssm\nssm.exe"),
                  (Join-Path $repoRoot "nssm\win64\nssm.exe"))
  $nssmExe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  # Last resort: the existing services were installed with some copy of nssm —
  # find it rather than making the operator hunt for it.
  if (-not $nssmExe) {
    $found = Get-ChildItem -Path "C:\onepws" -Filter "nssm.exe" -Recurse -ErrorAction SilentlyContinue |
             Select-Object -First 1
    if ($found) { $nssmExe = $found.FullName }
  }
}

if (-not $nssmExe) {
  Write-Host ""
  Write-Host "nssm.exe was not found, so the service was not installed." -ForegroundColor Yellow
  Write-Host "Everything else is ready and verified. Either run the agent in a window with:" -ForegroundColor Yellow
  Write-Host "    cd `"$AgentDir`"; npm start" -ForegroundColor Yellow
  Write-Host "or install the service manually with nssm (see mail-agent\README.md)." -ForegroundColor Yellow
  exit 0
}

# Prefer the existing ops log folder if this machine has one; otherwise keep
# logs beside the agent rather than creating a stray C:\onepws on a dev box.
if (Test-Path "C:\onepws") { $logDir = "C:\onepws\logs" } else { $logDir = Join-Path $AgentDir "logs" }
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "      service exists - restarting it with the new settings."
  & $nssmExe stop $ServiceName | Out-Null
} else {
  & $nssmExe install $ServiceName $node.Source (Join-Path $AgentDir "agent.js") | Out-Null
}
& $nssmExe set $ServiceName AppDirectory $AgentDir | Out-Null
& $nssmExe set $ServiceName AppStdout (Join-Path $logDir "mail-agent-stdout.log") | Out-Null
& $nssmExe set $ServiceName AppStderr (Join-Path $logDir "mail-agent-stderr.log") | Out-Null
& $nssmExe set $ServiceName Start SERVICE_AUTO_START | Out-Null
& $nssmExe start $ServiceName | Out-Null
Start-Sleep -Seconds 4

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
Write-Host ""
if ($svc -and $svc.Status -eq "Running") {
  Write-Host "DONE - $ServiceName is running." -ForegroundColor Green
  Write-Host ""
  Write-Host "Last few log lines:" -ForegroundColor Cyan
  $out = Join-Path $logDir "mail-agent-stdout.log"
  if (Test-Path $out) { Get-Content $out -Tail 8 }
  Write-Host ""
  Write-Host "A service reporting Running does not by itself prove the app did not crash -" -ForegroundColor Yellow
  Write-Host "the log above should end with 'SMTP connection OK'." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Now tell Claude the agent is running so the portal side can be switched on." -ForegroundColor Cyan
} else {
  Write-Host "The service did not start. Check C:\onepws\logs\mail-agent-stderr.log" -ForegroundColor Red
  exit 1
}
