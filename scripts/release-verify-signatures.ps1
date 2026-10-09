param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Directory = 'dist',
  [Parameter(Mandatory = $true)][string]$Publisher
)
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') { throw 'Invalid stable version' }
if ([string]::IsNullOrWhiteSpace($Publisher) -or $Publisher.Trim() -cne $Publisher) { throw 'Exact publisher common name required' }
$extracted = Join-Path $Directory 'release-zip-check'
if (Test-Path $extracted) { throw 'ZIP verification directory must not already exist' }
Expand-Archive -LiteralPath (Join-Path $Directory "TaskContinuum-$Version-win-x64.zip") -DestinationPath $extracted
$files = @(
  (Join-Path $Directory "TaskContinuum-$Version-win-x64-setup.exe"),
  (Join-Path $Directory 'win-unpacked\TaskContinuum.exe'),
  (Join-Path $extracted 'TaskContinuum.exe')
)
foreach ($file in $files) {
  $signature = Get-AuthenticodeSignature -LiteralPath $file
  if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) { throw "Authenticode verification failed: $file" }
  $commonName = $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
  if ($commonName -cne $Publisher) { throw "Authenticode publisher mismatch: $file" }
}
foreach ($root in @((Join-Path $Directory 'win-unpacked'), $extracted)) {
  if (Test-Path (Join-Path $root 'taskcontinuum-install.json')) { throw 'Installer marker leaked into shared build/ZIP' }
  $policy = Get-Content -Raw -LiteralPath (Join-Path $root 'resources\update-policy.json') | ConvertFrom-Json
  if ($policy.schemaVersion -ne 1 -or $policy.publisherNames.Count -ne 1 -or $policy.publisherNames[0] -cne $Publisher) {
    throw 'Signed resource policy mismatch'
  }
  $env:TASKCONTINUUM_VERIFY_RESOURCES = Join-Path $root 'resources'
  & node scripts/release-verify-config.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Packaged update configuration verification failed' }
}
Remove-Item Env:\TASKCONTINUUM_VERIFY_RESOURCES
Write-Output 'Installer, unpacked application and ZIP application Authenticode signatures verified.'
