<#
.SYNOPSIS
    Rotate the Azure OpenAI key consumed by the Wedding Concierge function.

.DESCRIPTION
    Two-key rotation pattern (zero-downtime):
      1. Regenerate Key2 on the AOAI account.
      2. Push Key2 into SWA app settings as AZURE_OPENAI_KEY.
      3. Wait briefly for the function to pick up the new setting.
      4. Regenerate Key1 (the old active key) — invalidates any leaked copy.
      5. Push Key1 back into SWA app settings (so Key1 is active again,
         which keeps Azure portal "primary key" view consistent).

    SWA Free tier does NOT support Managed Identity for managed functions,
    so we rotate the key on a schedule instead.

.NOTES
    Run from any machine with `az` logged in to an account that has:
      - Cognitive Services Contributor on aoai-wedding-concierge
      - Static Web Apps Contributor on swa-wedding

    Recommended cadence: every 90 days, or immediately on any suspected leak.

.EXAMPLE
    pwsh ./scripts/rotate-aoai-key.ps1 -WhatIf
    pwsh ./scripts/rotate-aoai-key.ps1
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [string]$Subscription   = $env:WEDDING_SUBSCRIPTION_ID,
    [string]$ResourceGroup  = 'rg-wedding-swa',
    [string]$AoaiAccount    = 'aoai-wedding-concierge',
    [string]$SwaName        = 'swa-wedding',
    [int]   $PropagationSec = 45
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Subscription)) {
    throw "Subscription required: pass -Subscription <guid> or set `$env:WEDDING_SUBSCRIPTION_ID."
}

function Invoke-Az {
    param([Parameter(Mandatory)][string[]]$Args)
    $out = az @Args 2>&1
    if ($LASTEXITCODE -ne 0) { throw "az $($Args -join ' ') failed: $out" }
    return $out
}

Write-Host "Wedding Concierge AOAI key rotation" -ForegroundColor Cyan
Write-Host "  Sub:     $Subscription"
Write-Host "  RG:      $ResourceGroup"
Write-Host "  AOAI:    $AoaiAccount"
Write-Host "  SWA:     $SwaName"

if (-not $PSCmdlet.ShouldProcess("$AoaiAccount + $SwaName", "Rotate AOAI key1/key2 and update SWA app setting")) {
    Write-Host "WhatIf: no changes made." -ForegroundColor Yellow
    return
}

Write-Host "`n[1/5] Regenerating Key2 on AOAI..." -ForegroundColor Cyan
$null = Invoke-Az @('cognitiveservices','account','keys','regenerate',
    '-n',$AoaiAccount,'-g',$ResourceGroup,'--subscription',$Subscription,'--key-name','Key2','-o','none')
$keys = Invoke-Az @('cognitiveservices','account','keys','list',
    '-n',$AoaiAccount,'-g',$ResourceGroup,'--subscription',$Subscription,'-o','json') | ConvertFrom-Json
$key2 = $keys.key2

Write-Host "[2/5] Updating SWA app setting AZURE_OPENAI_KEY -> Key2..." -ForegroundColor Cyan
$null = Invoke-Az @('staticwebapp','appsettings','set',
    '-n',$SwaName,'-g',$ResourceGroup,'--subscription',$Subscription,
    '--setting-names',"AZURE_OPENAI_KEY=$key2",'-o','none')

Write-Host "[3/5] Waiting $PropagationSec s for function to pick up new key..." -ForegroundColor Cyan
Start-Sleep -Seconds $PropagationSec

Write-Host "[4/5] Regenerating Key1 (invalidates the previously-active key)..." -ForegroundColor Cyan
$null = Invoke-Az @('cognitiveservices','account','keys','regenerate',
    '-n',$AoaiAccount,'-g',$ResourceGroup,'--subscription',$Subscription,'--key-name','Key1','-o','none')
$keys = Invoke-Az @('cognitiveservices','account','keys','list',
    '-n',$AoaiAccount,'-g',$ResourceGroup,'--subscription',$Subscription,'-o','json') | ConvertFrom-Json
$key1 = $keys.key1

Write-Host "[5/5] Pinning SWA app setting back to fresh Key1..." -ForegroundColor Cyan
$null = Invoke-Az @('staticwebapp','appsettings','set',
    '-n',$SwaName,'-g',$ResourceGroup,'--subscription',$Subscription,
    '--setting-names',"AZURE_OPENAI_KEY=$key1",'-o','none')

Write-Host "`nDone. Both AOAI keys have been regenerated and the SWA function is using a fresh key." -ForegroundColor Green
Write-Host "Smoke-test:  curl -X POST https://johnanddianaswedding.com/api/chat -H 'Content-Type: application/json' -H 'Origin: https://johnanddianaswedding.com' -d '{\"message\":\"hi\",\"locale\":\"en\"}'"
