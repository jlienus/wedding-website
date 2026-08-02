# Operational scripts

Helpers for maintaining the wedding site infrastructure. All are idempotent and safe to run from any machine with `az` logged in.

## `seed-rsvp.cjs` — Seed RSVP test data

Inserts three starter parties (John + Diana, a placeholder family, a placeholder
solo guest) into the Azure Table Storage tables backing the RSVP system. Safe
to run repeatedly. See [`docs/RSVP.md`](../docs/RSVP.md) for the full system
overview.

`.cjs` extension is intentional — the repo root is an ES module project
(`"type": "module"` in `package.json`) but this script imports the
CommonJS-based `api/_lib/*` modules, so it has to be loaded as CJS.

```powershell
$env:RSVP_STORAGE_CONNECTION = "<connection string>"
node scripts/seed-rsvp.cjs                          # add (or upsert) the test parties
node scripts/seed-rsvp.cjs --reset                  # wipe + reinsert just the seeded parties
node scripts/seed-rsvp.cjs --phone +15551234567     # use a real phone for John (live SMS test)
```

## `test-rsvp-lookup.cjs` — Smoke-test the lookup endpoint

In-process test that mocks the storage + auth + ratelimit layers and exercises
every branch of `api/rsvp_lookup/index.js`: name-only success/miss, ambiguous
(with and without phones on file), phone-last-4 disambiguation (match,
mismatch, wrong length), phone-only fallback (match, miss, shared phone),
legacy `{firstName, lastName}` compat, precedence rules, accent / case
normalization, and validation errors.

Requires no Azure connection; run before any change to the lookup endpoint.

```powershell
node scripts/test-rsvp-lookup.cjs    # exit 0 on all pass, 1 on any failure
```


## `smoke-sms.cjs` — Send one real SMS via the active provider

End-to-end test of `api/_lib/sms.js`: loads `api/local.settings.json`,
dispatches through whichever provider `SMS_PROVIDER` selects (`acs` or
`twilio`), and prints the result. Useful when wiring a new provider or
verifying credentials without spinning up the SWA dev server.

```powershell
# Requires api/local.settings.json with the provider's env vars set
node scripts/smoke-sms.cjs +15551234567
```

For Twilio trial accounts the destination must already be on your
**Verified Caller IDs** list in the Twilio console.


## `test-classify-inbound.cjs` — Smoke-test the SMS keyword classifier

In-process check that `api/_lib/sms_actions.classifyInbound` maps the keyword
aliases we care about (STOP/START/HELP/NO/YES/other) to the right canonical
action. No Azure connection required — run before any change to the keyword
set.

```powershell
node scripts/test-classify-inbound.cjs    # exit 0 on all pass, 1 on any failure
```


## `diag-invite-by-phone.cjs` — Look up invite reminder-state by phone number

One-shot diagnostic that prints the reminder-relevant flags
(`responded`, `optedOutOfSms`, `smsHardFailedAt`, `phoneNorm`, `reminderCount`)
for every invite matching a given phone. Useful when "Send reminder" doesn't
seem to do anything — most skips happen silently.

Loads env vars from `api/local.settings.json` if present; otherwise reads from
process env. Requires `RSVP_STORAGE_CONNECTION`, `RSVP_BLIND_INDEX_KEY`,
`RSVP_FIELD_KEY_CURRENT`.

```powershell
# Easiest: pull current prod settings inline
$env:RSVP_STORAGE_CONNECTION = az staticwebapp appsettings list -n swa-wedding -g rg-wedding-swa --query "properties.RSVP_STORAGE_CONNECTION" -o tsv
$env:RSVP_BLIND_INDEX_KEY    = az staticwebapp appsettings list -n swa-wedding -g rg-wedding-swa --query "properties.RSVP_BLIND_INDEX_KEY" -o tsv
$env:RSVP_FIELD_KEY_CURRENT  = az staticwebapp appsettings list -n swa-wedding -g rg-wedding-swa --query "properties.RSVP_FIELD_KEY_CURRENT" -o tsv
node scripts/diag-invite-by-phone.cjs +15551234567
```


## `mask-sms-log-phones.cjs` — One-time mask of full numbers in `rsvpSmsLog`

Companion to the field-encryption work. Existing rows in the SMS audit log
(`rsvpSmsLog.toPhone`) carry full E.164 numbers; new writes have always
masked since the encryption change. This sweep retro-fits the old rows in
place.

Idempotent — already-masked rows (`***NNNN`) are skipped. Empty rows are
skipped. Writes go through `updateEntity('Merge')` so no other columns
move. Emits an `admin.sms_log_mask_sweep` audit event on success.

```powershell
$env:RSVP_STORAGE_CONNECTION = "<connection string>"
node scripts/mask-sms-log-phones.cjs --dry-run     # preview
node scripts/mask-sms-log-phones.cjs --verbose     # actually mask
```

## `init-field-keys.ps1` — One-time bootstrap of PII field-encryption keys

Generates and pushes the two SWA app settings that `api/_lib/fieldcrypto.js`
needs to encrypt `primaryFirstName`, `primaryLastName`, and `phone` in the
`rsvpInvites` table:

- `RSVP_FIELD_KEY_CURRENT` — base64 32-byte AES-256 key (rotates on schedule)
- `RSVP_BLIND_INDEX_KEY`  — base64 32-byte HMAC master for blind-index lookups

```powershell
pwsh ./scripts/init-field-keys.ps1 -WhatIf
pwsh ./scripts/init-field-keys.ps1
```

Refuses to overwrite an existing `RSVP_FIELD_KEY_CURRENT` without `-Force` —
overwriting it makes every encrypted row unreadable. To rotate the key on an
already-bootstrapped SWA, use `rotate-field-keys.ps1` instead.

## `encrypt-existing-fields.cjs` — Encrypt-or-rotate sweep across all invites

Reads every invite, decrypts its PII fields (legacy plaintext passes through),
then writes them back through `storage.upsertInvite` so each row ends up
ciphertext-at-rest + blind-indexed under whatever `RSVP_FIELD_KEY_CURRENT` is
loaded at the time. Used both for the one-time migration after the first
`init-field-keys.ps1` run and as the re-encrypt half of every rotation.

```powershell
$env:RSVP_STORAGE_CONNECTION = "<connection string>"
$env:RSVP_FIELD_KEY_CURRENT  = "<base64 32 bytes>"
$env:RSVP_FIELD_KEY_PREVIOUS = "<base64 32 bytes>"  # only during a rotation window
$env:RSVP_BLIND_INDEX_KEY    = "<base64 32 bytes>"
node scripts/encrypt-existing-fields.cjs --verbose
node scripts/encrypt-existing-fields.cjs --dry-run    # preview only
```

Idempotent — encrypted rows still get re-emitted under the loaded CURRENT key,
which is exactly the behavior the rotation sweep relies on. Logs an
`admin.encrypt_sweep` event into the audit table on success.

## `rotate-field-keys.ps1` — Two-phase rotation of `RSVP_FIELD_KEY_CURRENT`

Mirrors the AOAI rotation pattern but for a self-managed AES-256 key (Azure
doesn't generate the key for us, so we generate it locally and manage both
sides of the rotation window):

1. Generate a fresh 32-byte AES-256 key
2. Push the old `CURRENT` into `RSVP_FIELD_KEY_PREVIOUS` and the new key as
   `RSVP_FIELD_KEY_CURRENT` (both live simultaneously)
3. Wait for SWA propagation (default 45s)
4. Run the `encrypt-existing-fields.cjs` sweep → every row rewritten under
   the new `CURRENT` key
5. Clear `RSVP_FIELD_KEY_PREVIOUS` once the sweep succeeds

If the sweep fails, `PREVIOUS` is left in place so the partially-migrated
data stays readable. **The script refuses to start while `PREVIOUS` is set** —
rotating again would discard it and permanently orphan every row still
encrypted under it. Finish the interrupted rotation by hand first:

```powershell
# 1. Pull CURRENT + PREVIOUS + blind-index key off the SWA, plus the storage conn string
$p  = (az staticwebapp appsettings list -n swa-wedding -g rg-wedding-swa -o json 2>$null | ConvertFrom-Json).properties
$env:RSVP_STORAGE_CONNECTION = (az storage account show-connection-string -n stweddingrsvp1296 `
                                  -g rg-wedding-swa -o json 2>$null | ConvertFrom-Json).connectionString
$env:RSVP_FIELD_KEY_CURRENT  = $p.RSVP_FIELD_KEY_CURRENT
$env:RSVP_FIELD_KEY_PREVIOUS = $p.RSVP_FIELD_KEY_PREVIOUS
$env:RSVP_BLIND_INDEX_KEY    = $p.RSVP_BLIND_INDEX_KEY

# 2. Dry run first — confirms every row decrypts under the current pair
node scripts/encrypt-existing-fields.cjs --dry-run --verbose

# 3. Only if "Errors: 0", run it for real
node scripts/encrypt-existing-fields.cjs --verbose

# 4. Only after a clean sweep, drop the stale key
az staticwebapp appsettings delete -n swa-wedding -g rg-wedding-swa `
  --setting-names RSVP_FIELD_KEY_PREVIOUS
```

Then re-run the script normally. Never delete `PREVIOUS` before a clean
sweep — that is the one action that loses data irrecoverably.

```powershell
pwsh ./scripts/rotate-field-keys.ps1 -WhatIf       # preview
pwsh ./scripts/rotate-field-keys.ps1               # actually rotate
pwsh ./scripts/rotate-field-keys.ps1 -PropagationSec 90   # slower SWA = wait longer
```

**Automating monthly rotation:** `.github/workflows/rotate-field-keys.yml`
runs this script on the 1st of every month at 07:00 UTC (plus
`workflow_dispatch` for manual runs).

It authenticates with **GitHub OIDC federated credentials** — there is no
long-lived client secret to expire. Repo secrets required (all three are
non-sensitive identifiers, not credentials):

| Secret | Value |
|---|---|
| `AZURE_CLIENT_ID` | appId of the `gh-wedding-rotate-keys` Entra app |
| `AZURE_TENANT_ID` | tenant hosting the wedding subscription |
| `AZURE_SUBSCRIPTION_ID` | subscription holding `rg-wedding-swa` (also passed to the script as `WEDDING_SUBSCRIPTION_ID`) |

The app has a federated credential with subject
`repo:jlienus/wedding-website:ref:refs/heads/main`, issuer
`https://token.actions.githubusercontent.com`, audience
`api://AzureADTokenExchange`.

RBAC the service principal actually needs (all four — each covers a
distinct call the script makes):

| Role | Scope | Why |
|---|---|---|
| `Contributor` | the `swa-wedding` static site resource | read/set/delete SWA app settings |
| `Reader` | the `stweddingrsvp1296` storage account | `az storage account show-connection-string` needs control-plane `read` |
| `Storage Account Key Operator Service Role` | `rg-wedding-swa` | `listKeys` for that connection string |
| `Storage Blob Data Reader` | `rg-wedding-swa` | data-plane read during the sweep |

> There is **no** built-in "Static Web Apps Contributor" role, and
> `Website Contributor` grants `Microsoft.Web/sites/*` but **not**
> `Microsoft.Web/staticSites/*` — it does not work here. Use `Contributor`
> scoped to the single SWA resource.

Do **not** use `az ad sp create-for-rbac --sdk-auth` / an `AZURE_CREDENTIALS`
secret. A key-rotation job whose own credential silently expires after ~12
months is precisely the failure this workflow exists to prevent.

## `test-field-encryption.cjs` / `test-storage-encryption.cjs` — Crypto tests

Pure-Node round-trip tests for `api/_lib/fieldcrypto.js` and the encryption
wiring in `api/_lib/storage.js`. No Azure required; run before any change
under either file.

```powershell
node scripts/test-field-encryption.cjs       # 12 unit tests (cipher + blind index)
node scripts/test-storage-encryption.cjs     #  6 round-trip tests (entityToInvite path)
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
   az ad sp create-for-rbac --name wedding-key-rotator --role "Cognitive Services Contributor" --scopes /subscriptions/<SUBSCRIPTION_ID_VSE>/resourceGroups/rg-wedding-swa/providers/Microsoft.CognitiveServices/accounts/aoai-wedding-concierge
   az role assignment create --role "Contributor" --assignee <appId-from-above> --scope /subscriptions/<SUBSCRIPTION_ID_VSE>/resourceGroups/rg-wedding-swa/providers/Microsoft.Web/staticSites/swa-wedding
   ```

   > Use `Contributor` scoped to the SWA resource, **not** `Website Contributor` —
   > the latter covers `Microsoft.Web/sites/*` but not `Microsoft.Web/staticSites/*`.

2. Prefer OIDC federated credentials over a stored `--sdk-auth` blob, exactly as
   `rotate-field-keys.yml` now does (see the automation table above). A rotation
   job authenticating with a secret that itself expires defeats the purpose.

3. Add `.github/workflows/rotate-aoai-key.yml` with a `schedule: cron: '0 8 1 */3 *'` (first of every 3rd month at 08:00 UTC) trigger that runs `azure/login@v3` then `pwsh ./scripts/rotate-aoai-key.ps1`.

Left unimplemented for now because (a) the wedding site is short-lived and (b) the service principal needs `Owner`/`User Access Administrator` to create, which is a human decision. Add it later if the manual cadence becomes annoying.
