# Operational scripts

Helpers for maintaining the wedding site infrastructure. All are idempotent and safe to run from any machine with `az` logged in.

## `seed-rsvp.js` — Seed RSVP test data

Inserts three starter parties (John + Diana, a placeholder family, a placeholder
solo guest) into the Azure Table Storage tables backing the RSVP system. Safe
to run repeatedly. See [`docs/RSVP.md`](../docs/RSVP.md) for the full system
overview.

```powershell
$env:RSVP_STORAGE_CONNECTION = "<connection string>"
node scripts/seed-rsvp.js                          # add (or upsert) the test parties
node scripts/seed-rsvp.js --reset                  # wipe + reinsert just the seeded parties
node scripts/seed-rsvp.js --phone +15551234567     # use a real phone for John (live SMS test)
```

## `rotate-aoai-key.ps1` — Azure OpenAI key rotation

Two-key (zero-downtime) rotation of the `AZURE_OPENAI_KEY` consumed by the `/api/chat` Static Web App function.

**Why this script exists:** Azure Static Web Apps Free tier doesn't support Managed Identity for managed functions, so the function authenticates to Azure OpenAI with an API key. We rotate that key on a schedule rather than letting it live forever.

**Recommended cadence:** every 90 days, or immediately on any suspected leak (e.g., key visible in a screenshot, terminal log shared with a third party).

**Prerequisites:** the signed-in `az` account needs

- `Cognitive Services Contributor` on `aoai-wedding-concierge`
- `Static Web Apps Contributor` on `swa-wedding`

**Usage:**

```powershell
# Dry-run
pwsh ./scripts/rotate-aoai-key.ps1 -WhatIf

# Actually rotate
pwsh ./scripts/rotate-aoai-key.ps1
```

**What it does (each run takes ~1 minute):**

1. Regenerates Key2 on the AOAI account.
2. Updates the SWA app setting `AZURE_OPENAI_KEY` to the new Key2.
3. Waits 45 seconds for the function host to pick up the new value.
4. Regenerates Key1 — invalidates the previously-active key everywhere.
5. Sets the SWA app setting back to the fresh Key1 (keeps the portal "primary key" view consistent).

After step 2 the function is already using a brand-new key; step 4 invalidates the old one so any leaked copy stops working. The site has zero downtime because the function only refreshes its settings between cold starts; the in-flight key is still valid throughout the swap.

## Automating rotation (optional)

If you'd like quarterly auto-rotation without manual intervention, wire this script into a GitHub Actions cron workflow:

1. Create a least-privilege service principal:

   ```powershell
   az ad sp create-for-rbac --name wedding-key-rotator --role "Cognitive Services Contributor" --scopes /subscriptions/32c8caee-4dce-4973-94f4-d1d18736ff4f/resourceGroups/rg-wedding-swa/providers/Microsoft.CognitiveServices/accounts/aoai-wedding-concierge
   az role assignment create --role "Website Contributor" --assignee <appId-from-above> --scope /subscriptions/32c8caee-4dce-4973-94f4-d1d18736ff4f/resourceGroups/rg-wedding-swa/providers/Microsoft.Web/staticSites/swa-wedding
   ```

2. Save the JSON output as the GitHub secret `AZURE_CREDENTIALS` on the `jlienus/wedding-website` repo.

3. Add `.github/workflows/rotate-aoai-key.yml` with a `schedule: cron: '0 8 1 */3 *'` (first of every 3rd month at 08:00 UTC) trigger that runs `azure/login@v2` then `pwsh ./scripts/rotate-aoai-key.ps1`.

Left unimplemented for now because (a) the wedding site is short-lived and (b) the service principal needs `Owner`/`User Access Administrator` to create, which is a human decision. Add it later if the manual cadence becomes annoying.
