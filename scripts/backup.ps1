$ErrorActionPreference = "Stop"

$backupDir  = "C:\onepws\backups"
$timestamp  = Get-Date -Format "yyyy-MM-dd_HHmmss"
$backupFile = Join-Path $backupDir "onepws_prod_$timestamp.dump"
$logFile    = Join-Path $backupDir "backup.log"

$pgDump = "C:\Program Files\PostgreSQL\16\bin\pg_dump.exe"

# Password via env var so pg_dump doesn't prompt; cleared in finally
$env:PGPASSWORD = "lokesh.123"

try {
    & $pgDump -h localhost -U onepws_app -F c -f $backupFile onepws_prod
    if ($LASTEXITCODE -ne 0) {
        throw "pg_dump exited with code $LASTEXITCODE"
    }

    $size = (Get-Item $backupFile).Length
    Add-Content $logFile "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') SUCCESS - $backupFile ($size bytes)"

    # Purge dumps older than 30 days
    $cutoff = (Get-Date).AddDays(-30)
    $purged = Get-ChildItem -Path $backupDir -Filter "onepws_prod_*.dump" |
              Where-Object { $_.LastWriteTime -lt $cutoff }
    foreach ($f in $purged) {
        Remove-Item $f.FullName -Force
        Add-Content $logFile "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') PURGED - $($f.Name)"
    }
}
catch {
    Add-Content $logFile "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') FAILED - $_"
    exit 1
}
finally {
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
}