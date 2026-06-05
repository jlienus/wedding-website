<#
.SYNOPSIS
    One-time bootstrap of the RSVP field-encryption keys on the wedding SWA.

.DESCRIPTION
    Generates three fresh 32-byte AES-256 keys and writes them to the SWA's
    app settings as:

      - RSVP_FIELD_KEY_CURRENT  (encrypts/decrypts PII fields at rest)
      - RSVP_BLIND_INDEX_KEY    (HMAC master for blind-index lookups)
      - RSVP_FIELD_KEY_PREVIOUS (NOT set initially; populated by rotate-field-keys.ps1
                                 during a rotation window, then cleared afterwards)

    Refuses to overwrite an existing RSVP_FIELD_KEY_CURRENT unless -Force is
    passed -- losing the current key means losing access to every encrypted
    row, so the safety here is intentional.

    Run AFTER the api/_lib/fieldcrypto.js code is deployed but BEFORE the
    encrypt-existing-fields.cjs migration sweep.

.EXAMPLE
    pwsh ./scripts/init-field-keys.ps1 -WhatIf
    pwsh ./scripts/init-field-keys.ps1
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [string]$Subscription  = '32c8caee-4dce-4973-94f4-d1d18736ff4f',
    [string]$ResourceGroup = 'rg-wedding-swa',
    [string]$SwaName       = 'swa-wedding',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Invoke-Az {
    param([Parameter(Mandatory)][string[]]$AzArgs)
    $out = az @AzArgs 2>&1
    if ($LASTEXITCODE -ne 0) { throw "az $($AzArgs -join ' ') failed: $out" }
    return $out
}

function New-FieldKey {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    return [Convert]::ToBase64String($bytes)
}

Write-Host "RSVP field-key bootstrap" -ForegroundColor Cyan
Write-Host "  Sub:  $Subscription"
Write-Host "  RG:   $ResourceGroup"
Write-Host "  SWA:  $SwaName"

if (-not $PSCmdlet.ShouldProcess("$SwaName app settings", "Generate + set RSVP_FIELD_KEY_CURRENT + RSVP_BLIND_INDEX_KEY")) {
    Write-Host "WhatIf: no changes made." -ForegroundColor Yellow
    return
}

Write-Host "`n[1/3] Checking for existing keys..." -ForegroundColor Cyan
$existing = Invoke-Az @('staticwebapp', 'appsettings', 'list',
    '-n', $SwaName, '-g', $ResourceGroup, '--subscription', $Subscription, '-o', 'json') | ConvertFrom-Json
if ($existing.RSVP_FIELD_KEY_CURRENT -and -not $Force) {
    Write-Host "       RSVP_FIELD_KEY_CURRENT already set. Refusing to overwrite without -Force." -ForegroundColor Red
    Write-Host "       To rotate, use rotate-field-keys.ps1." -ForegroundColor Red
    exit 2
}

Write-Host "`n[2/3] Generating fresh keys..." -ForegroundColor Cyan
$fieldKey = New-FieldKey
$blindKey = New-FieldKey
Write-Host "       Generated 32-byte CURRENT field key + 32-byte blind-index key"

Write-Host "`n[3/3] Pushing settings to SWA..." -ForegroundColor Cyan
$null = Invoke-Az @('staticwebapp', 'appsettings', 'set',
    '-n', $SwaName, '-g', $ResourceGroup, '--subscription', $Subscription,
    '--setting-names',
    "RSVP_FIELD_KEY_CURRENT=$fieldKey",
    "RSVP_BLIND_INDEX_KEY=$blindKey",
    '-o', 'none')

Write-Host "`nDone. Two app settings written to $SwaName." -ForegroundColor Green
Write-Host "`nNext steps:"
Write-Host "  1. Wait ~45s for SWA to propagate the settings to the running function."
Write-Host "  2. Run the migration sweep to encrypt existing rows:"
Write-Host "       `$env:RSVP_STORAGE_CONNECTION = '<storage connection string>'"
Write-Host "       `$env:RSVP_FIELD_KEY_CURRENT  = '$fieldKey'"
Write-Host "       `$env:RSVP_BLIND_INDEX_KEY    = '$blindKey'"
Write-Host "       node scripts/encrypt-existing-fields.cjs --verbose"
Write-Host "  3. Verify https://johnanddianaswedding.com/admin/ still shows plaintext names + phones."
