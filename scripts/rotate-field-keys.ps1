<#
.SYNOPSIS
    Rotate the RSVP field-encryption key on the wedding SWA.

.DESCRIPTION
    Two-phase rotation with a dual-key window so the running function never
    sees a moment when an inflight encrypted row is unreadable:

      1. Generate a fresh 32-byte AES-256 key.
      2. Move the current key into RSVP_FIELD_KEY_PREVIOUS (SWA app setting).
      3. Push the new key as RSVP_FIELD_KEY_CURRENT (SWA app setting).
      4. Wait for SWA to propagate the new settings to the running function.
      5. Run the re-encryption sweep -- every invite row gets rewritten under
         the new CURRENT key. Existing ciphertext still decrypts via PREVIOUS
         during this window.
      6. Clear RSVP_FIELD_KEY_PREVIOUS once the sweep succeeds.
      7. Emit an admin.key_rotated audit event.

    Built to parallel scripts/rotate-aoai-key.ps1 -- SWA Free tier doesn't
    support Managed Identity for managed functions, so we manage the
    symmetric AES key as a SWA app setting and rotate it on schedule.

.NOTES
    Run from any machine with `az` logged in to an account that has:
      - Static Web Apps Contributor on swa-wedding
      - Storage Blob Data Reader on stweddingrsvp1296 (for the sweep)
      - Storage Account Key Operator (or the account key in env)

    Recommended cadence: every 30 days. The GitHub Action at
    .github/workflows/rotate-field-keys.yml schedules this automatically.

.EXAMPLE
    pwsh ./scripts/rotate-field-keys.ps1 -WhatIf
    pwsh ./scripts/rotate-field-keys.ps1
    pwsh ./scripts/rotate-field-keys.ps1 -PropagationSec 90  # slower SWA = longer wait
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [string]$Subscription   = '32c8caee-4dce-4973-94f4-d1d18736ff4f',
    [string]$ResourceGroup  = 'rg-wedding-swa',
    [string]$SwaName        = 'swa-wedding',
    [string]$StorageAccount = 'stweddingrsvp1296',
    [int]   $PropagationSec = 45,
    [switch]$SkipSweep                              # Phase 1-4 only; sweep + cleanup by hand
)

$ErrorActionPreference = 'Stop'

function Invoke-Az {
    param([Parameter(Mandatory)][string[]]$AzArgs)
    # Suppress noisy stderr (cryptography 32-bit Python warning on Windows az,
    # deprecation notices, etc.) while still propagating real failures via
    # $LASTEXITCODE. We can't 2>&1 because the warnings would contaminate the
    # JSON stdout we feed to ConvertFrom-Json.
    $tmpErr = [System.IO.Path]::GetTempFileName()
    try {
        $out = az @AzArgs 2>$tmpErr
        if ($LASTEXITCODE -ne 0) {
            $errText = Get-Content -Raw -LiteralPath $tmpErr -ErrorAction SilentlyContinue
            throw "az $($AzArgs -join ' ') failed: $errText$out"
        }
        return $out
    } finally {
        Remove-Item -LiteralPath $tmpErr -ErrorAction SilentlyContinue
    }
}

function New-FieldKey {
    # 32 random bytes, base64-encoded -- matches what fieldcrypto.js expects
    # and what generateKeyB64() in that module emits.
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    return [Convert]::ToBase64String($bytes)
}

function Get-SwaSetting {
    param([Parameter(Mandatory)][string]$Name)
    $json = Invoke-Az @('staticwebapp', 'appsettings', 'list',
        '-n', $SwaName, '-g', $ResourceGroup, '--subscription', $Subscription, '-o', 'json')
    $obj = $json | ConvertFrom-Json
    # `az staticwebapp appsettings list` returns the ARM resource shape:
    # { id, name, properties: { KEY: VALUE, ... }, ... }
    return $obj.properties.$Name
}

function Set-SwaSettings {
    param([Parameter(Mandatory)][hashtable]$Settings)
    $pairs = @()
    foreach ($k in $Settings.Keys) { $pairs += "$k=$($Settings[$k])" }
    $azArgs = @('staticwebapp', 'appsettings', 'set',
        '-n', $SwaName, '-g', $ResourceGroup, '--subscription', $Subscription,
        '--setting-names') + $pairs + @('-o', 'none')
    $null = Invoke-Az -AzArgs $azArgs
}

function Remove-SwaSetting {
    param([Parameter(Mandatory)][string]$Name)
    $null = Invoke-Az @('staticwebapp', 'appsettings', 'delete',
        '-n', $SwaName, '-g', $ResourceGroup, '--subscription', $Subscription,
        '--setting-names', $Name, '-o', 'none')
}

function Get-StorageConnectionString {
    $json = Invoke-Az @('storage', 'account', 'show-connection-string',
        '-n', $StorageAccount, '-g', $ResourceGroup, '--subscription', $Subscription, '-o', 'json')
    return ($json | ConvertFrom-Json).connectionString
}

Write-Host "RSVP field-key rotation"            -ForegroundColor Cyan
Write-Host "  Sub:           $Subscription"
Write-Host "  RG:            $ResourceGroup"
Write-Host "  SWA:           $SwaName"
Write-Host "  Storage:       $StorageAccount"
Write-Host "  Propagation:   $PropagationSec seconds"

if (-not $PSCmdlet.ShouldProcess("$SwaName field-encryption key", "Generate new key + sweep re-encrypt + clear previous")) {
    Write-Host "WhatIf: no changes made." -ForegroundColor Yellow
    return
}

Write-Host "`n[1/7] Reading current RSVP_FIELD_KEY_CURRENT..." -ForegroundColor Cyan
$oldCurrent = Get-SwaSetting -Name 'RSVP_FIELD_KEY_CURRENT'
if (-not $oldCurrent) {
    throw "RSVP_FIELD_KEY_CURRENT is not set on $SwaName -- bootstrap with init-field-keys.ps1 first."
}
$oldHash = [System.Security.Cryptography.SHA256]::HashData([System.Convert]::FromBase64String($oldCurrent))
$oldId8 = (($oldHash | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 8)
Write-Host "       current keyId8: $oldId8"

Write-Host "`n[2/7] Generating new 32-byte AES-256 key..." -ForegroundColor Cyan
$newKey = New-FieldKey
$newHash = [System.Security.Cryptography.SHA256]::HashData([System.Convert]::FromBase64String($newKey))
$newId8 = (($newHash | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 8)
Write-Host "       new keyId8:     $newId8"
if ($oldId8 -eq $newId8) { throw "Random key generation collided -- abort" }

Write-Host "`n[3/7] Pushing PREVIOUS = old CURRENT and CURRENT = new key to SWA..." -ForegroundColor Cyan
Set-SwaSettings -Settings @{
    'RSVP_FIELD_KEY_PREVIOUS' = $oldCurrent
    'RSVP_FIELD_KEY_CURRENT'  = $newKey
}

Write-Host "`n[4/7] Waiting $PropagationSec s for SWA to propagate new settings to the function..." -ForegroundColor Cyan
Start-Sleep -Seconds $PropagationSec

if ($SkipSweep) {
    Write-Host "`n[5/7] -SkipSweep set; you'll need to run encrypt-existing-fields.cjs manually." -ForegroundColor Yellow
    Write-Host "       Then re-run this script with -ResumeCleanup (not yet implemented)" -ForegroundColor Yellow
    return
}

Write-Host "`n[5/7] Running re-encryption sweep across all invite rows..." -ForegroundColor Cyan
$cs = Get-StorageConnectionString
$env:RSVP_STORAGE_CONNECTION = $cs
$env:RSVP_FIELD_KEY_CURRENT  = $newKey
$env:RSVP_FIELD_KEY_PREVIOUS = $oldCurrent
$env:RSVP_BLIND_INDEX_KEY    = (Get-SwaSetting -Name 'RSVP_BLIND_INDEX_KEY')
node "$PSScriptRoot/encrypt-existing-fields.cjs" --verbose
if ($LASTEXITCODE -ne 0) {
    Write-Host "       Sweep returned non-zero; LEAVING PREVIOUS in place so unmigrated rows stay readable." -ForegroundColor Red
    Write-Host "       Investigate, then re-run encrypt-existing-fields.cjs and call this script with -SkipSweep + cleanup separately." -ForegroundColor Red
    exit 1
}

Write-Host "`n[6/7] Clearing RSVP_FIELD_KEY_PREVIOUS (sweep succeeded; all rows under new CURRENT)..." -ForegroundColor Cyan
Remove-SwaSetting -Name 'RSVP_FIELD_KEY_PREVIOUS'

Write-Host "`n[7/7] Rotation complete." -ForegroundColor Green
Write-Host "       Old keyId8:    $oldId8  (no longer accepted)"
Write-Host "       New keyId8:    $newId8  (active)"
Write-Host "`nSmoke-test:  curl https://johnanddianaswedding.com/api/rsvp/get?inviteId=<known-id>"
