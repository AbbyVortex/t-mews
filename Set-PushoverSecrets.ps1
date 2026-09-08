$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$nodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodePath) {
  throw 'Node.js is required on PATH.'
}
try {
  Write-Host 'T-MEWS: secure Pushover setup. Input is hidden. Nothing is saved locally.'
  $userInput = Read-Host 'Paste Pushover User Key, then Enter' -AsSecureString
  $appInput = Read-Host 'Paste T-MEWS Application/API Token, then Enter' -AsSecureString
  $userPlain = [System.Net.NetworkCredential]::new('', $userInput).Password
  $appPlain = [System.Net.NetworkCredential]::new('', $appInput).Password
  $payload = @{user=$userPlain;token=$appPlain} | ConvertTo-Json -Compress
  $payload | & $nodePath scripts/secure-setup.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Setup did not complete. Tell Codex the non-secret error message.' }
  Write-Host 'Done. Worker secrets saved and the one-time test was accepted by Pushover.' -ForegroundColor Green
} catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
} finally {
  $userPlain=$null; $appPlain=$null; $payload=$null
  if ($userInput) { $userInput.Dispose() }
  if ($appInput) { $appInput.Dispose() }
  Read-Host 'Press Enter to close'
}
