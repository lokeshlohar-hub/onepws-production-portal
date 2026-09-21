<#
  Temporary diagnostic — tries your password against several common SMTP
  username formats, to tell "wrong password" apart from "wrong username
  format" or "this account isn't allowed to authenticate at all". The
  password is entered fresh (hidden), never saved to disk, and cleared from
  the environment when the script exits. Delete this file and _auth-diag.js
  once you're done - they aren't part of the shipped agent.

  Usage:
      powershell -ExecutionPolicy Bypass -File .\mail-agent\_auth-diag.ps1
#>
param(
  [string]$MailboxUser = "lokesh.lohar",
  [string]$MailboxDomain = "workspace.com",
  [string]$SmtpHost = "192.168.100.5",
  [int]   $SmtpPort = 25
)

Push-Location $PSScriptRoot
try { npm install --no-audit --no-fund | Out-Null } finally { Pop-Location }

$secure = Read-Host "Password for $MailboxUser" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try   { $pass = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
if ([string]::IsNullOrWhiteSpace($pass)) { Write-Host "Empty password, aborting."; exit 1 }

$usernames = @(
  "$MailboxUser@$MailboxDomain",                          # full email address
  "$MailboxUser",                                          # bare username, no domain
  ($MailboxDomain.Split('.')[0].ToUpper() + "\$MailboxUser") # NETBIOS-style DOMAIN\user
)

foreach ($u in $usernames) {
  Write-Host ""
  Write-Host "Trying user: $u"
  $env:DIAG_USER = $u
  $env:DIAG_PASS = $pass
  $env:DIAG_HOST = $SmtpHost
  $env:DIAG_PORT = $SmtpPort
  node "$PSScriptRoot\_auth-diag.js"
}

Remove-Item Env:\DIAG_PASS -ErrorAction SilentlyContinue
Remove-Item Env:\DIAG_USER -ErrorAction SilentlyContinue
Write-Host ""
Write-Host "Done. If every line says 'fail', the password itself is very likely" -ForegroundColor Yellow
Write-Host "correct-format-wise and the account isn't permitted to authenticate at" -ForegroundColor Yellow
Write-Host "all on this server - that needs IT, not a different username format." -ForegroundColor Yellow
