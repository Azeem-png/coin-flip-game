param(
  [string]$BackupDir = (Join-Path $PSScriptRoot "..\backups"),
  [int]$RetentionDays = 30
)

$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$backupPath = Join-Path $BackupDir "backup_$timestamp"

Write-Host "[Backup] Starting..." -ForegroundColor Cyan

# Run Node.js backup script
$nodeScript = Join-Path $PSScriptRoot "auto-backup.js"
node $nodeScript 2>&1

if ($LASTEXITCODE -eq 0) {
  Write-Host "[Backup] Completed!" -ForegroundColor Green

  # Remove old backups
  $cutoff = (Get-Date).AddDays(-$RetentionDays)
  Get-ChildItem $BackupDir -Directory -Filter "backup_*" | Where-Object { $_.LastWriteTime -lt $cutoff } | ForEach-Object {
    Remove-Item -Recurse -Force $_.FullName
    Write-Host "[Backup] Removed old: $($_.Name)" -ForegroundColor Yellow
  }
} else {
  Write-Host "[Backup] FAILED!" -ForegroundColor Red
  exit 1
}
