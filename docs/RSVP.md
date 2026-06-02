# RSVP system

Custom-built native RSVP for the wedding site. No third-party redirect — guests
RSVP entirely on `johnanddianaswedding.com` (and `/es/rsvp`). Optional monthly
SMS reminders go out automatically until guests respond or the deadline passes.

## Architecture

```
Guests           SMS (ACS toll-free)        Admin (jlienus@github)
   │                     ▲                          │
   ▼                     │ X-Cron-Secret            ▼
┌─────────┐         ┌──────────────┐          ┌──────────────┐
│ /rsvp   │◀───────▶│ /api/rsvp/*  │          │ /admin       │
│ /es/rsvp│ session │ /api/cron/*  │◀────cron│ /api/admin/* │
│ form    │ cookie  │ /api/sms/*   │ daily   │ dashboard    │
└─────────┘         └──────┬───────┘          └──────┬───────┘
                           ▼                          ▼
                  ┌──────────────────────────────────────┐
                  │  Azure Table Storage (5 tables)      │
                  │  rsvpParties / rsvpMembers /         │
                  │  rsvpResponses / rsvpSmsLog /        │
                  │  rsvpSettings                        │
                  └──────────────────────────────────────┘
```

- **Frontend**: `src/components/RsvpForm.astro` — three phases (name lookup,
  edit form, confirmation), vanilla JS (no framework). EN/ES via `src/i18n/*.json`.
- **Backend**: `api/_lib/{auth,cors,ratelimit,storage,sms,reminders}.js` shared
  libs; per-route folders under `api/rsvp_*`, `api/admin_*`, `api/sms_webhook`,
  `api/cron_reminders`.
- **Data**: party-level model. One row in `rsvpParties` per household; nested
  members in `rsvpMembers`; one response per member in `rsvpResponses`.
- **SMS**: Azure Communication Services toll-free, US-only. Phone numbers are
  optional — guests without a phone simply don't get reminders.
- **Scheduling**: SWA Free Functions don't support timer triggers, so we use a
  GitHub Actions cron workflow (`.github/workflows/rsvp-reminders.yml`) that
  POSTs `/api/cron/reminders` daily with a shared secret header. The endpoint
  enforces a 30-day per-party cadence, so daily polling is safe.

## Deadlines

| When | What happens |
| --- | --- |
| **Nov 15, 2026** | Guest-facing deadline (printed on cards). After this, the form still accepts submissions but flags them `submittedByMethod='web-late'`. |
| **Jan 15, 2027** | Permanent lock. `/api/rsvp/submit` returns 410 Gone. Admin can still edit responses via `/api/admin/*`. Reminder cron stops on its own at this date. |

Both dates are env-var overridable: `RSVP_GUEST_DEADLINE_UTC` and
`RSVP_PERMANENT_LOCK_UTC` (ISO 8601).

## Azure resources required

### 1. Azure Storage account (Table Storage)

Reuse an existing storage account or create a new one (`Standard_LRS`,
locally-redundant — Table data is small and not catastrophic to lose).

```bash
# Example (adjust names + resource group)
az storage account create \
  --name stwedding... \
  --resource-group rg-wedding \
  --location eastus2 \
  --sku Standard_LRS \
  --allow-blob-public-access false
```

Copy the **connection string** from `Access keys` and set it as the SWA app
setting `RSVP_STORAGE_CONNECTION`.

Tables are created automatically on first `/api/cron/reminders` call (or
via the seed script).

### 2. Azure Communication Services + toll-free number

1. Create an ACS resource:
   ```bash
   az communication create \
     --name acs-wedding \
     --resource-group rg-wedding \
     --location global \
     --data-location UnitedStates
   ```
2. **Provision a toll-free number** in the ACS portal (Phone Numbers → Get).
   ~$2/month.
3. **Submit toll-free verification.** This is mandatory in the US — carriers
   reject unverified toll-free SMS. Approval typically takes **7–10 business
   days**. Submit as soon as possible.
   - Use case: "wedding RSVP reminders to invited guests"
   - Opt-in method: "consent collected via printed RSVP card with phone number"
   - Sample messages: copy from `api/_lib/sms.js` `buildReminderBody()`
4. Copy the ACS connection string → set as `ACS_CONNECTION`.
5. Set `ACS_SMS_FROM` to the toll-free number in E.164 (e.g. `+18885551234`).

### 3. (Optional) Event Grid subscription for SMS events

To handle STOP keywords and delivery receipts, subscribe Event Grid to the
ACS resource and forward to `https://johnanddianaswedding.com/api/sms/webhook`.

**Recommended: also set the optional `ACS_WEBHOOK_SECRET` SWA app setting and
append it to the endpoint URL as `?s=<secret>`.** The webhook endpoint is
anonymous (Event Grid cannot authenticate to SWA), so without the shared
secret anyone who finds the URL could spoof STOP messages or corrupt delivery
status. If `ACS_WEBHOOK_SECRET` is not set, the endpoint accepts unauthenticated
requests (back-compat).

```bash
# Generate a secret first
SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
# Set it on SWA: Configuration -> Application settings -> ACS_WEBHOOK_SECRET=$SECRET

az eventgrid event-subscription create \
  --name rsvp-sms-events \
  --source-resource-id "/subscriptions/<sub>/resourceGroups/rg-wedding/providers/Microsoft.Communication/CommunicationServices/acs-wedding" \
  --endpoint "https://johnanddianaswedding.com/api/sms/webhook?s=$SECRET" \
  --included-event-types Microsoft.Communication.SMSReceived Microsoft.Communication.SMSDeliveryReportReceived
```

The endpoint auto-handles Event Grid validation handshakes (both legacy and
CloudEvents 1.0).

## SWA app settings (required)

Set these on the Static Web App resource (`Configuration` → `Application
settings`):

| Name | Description | How to generate |
| --- | --- | --- |
| `RSVP_STORAGE_CONNECTION` | Full Azure Storage connection string. | From Storage account → Access keys. |
| `RSVP_MAGIC_SECRET` | 32+ char random secret for magic-link HMAC. | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `RSVP_SESSION_SECRET` | (Optional) Separate secret for session cookies. Defaults to `RSVP_MAGIC_SECRET`. | Same generator. |
| `RSVP_CRON_SECRET` | 32+ char random secret guarding `/api/cron/reminders`. | Same generator. **Also set as GitHub repo secret with the same name.** |
| `ACS_CONNECTION` | ACS connection string. | From ACS resource → Keys. |
| `ACS_SMS_FROM` | Toll-free number in E.164. | The number you provisioned. |
| `ACS_WEBHOOK_SECRET` | (Optional but recommended) Shared secret required as `?s=<value>` on the SMS webhook URL. Without it the webhook is anonymous. | Same `randomBytes(32).toString('hex')` generator. |
| `ADMIN_GITHUB_USERNAME` | (Optional) GitHub username allowed to access `/admin`. Defaults to `jlienus`. | |
| `RSVP_SITE_ORIGIN` | (Optional) Canonical site URL used in SMS links. Defaults to `https://johnanddianaswedding.com`. | |
| `RSVP_GUEST_DEADLINE_UTC` | (Optional) Override guest deadline. Default `2026-11-15T23:59:59-05:00`. | |
| `RSVP_PERMANENT_LOCK_UTC` | (Optional) Override permanent lock. Default `2027-01-15T23:59:59-05:00`. | |

## GitHub repo secrets (for the cron workflow)

| Name | Description |
| --- | --- |
| `RSVP_CRON_SECRET` | **Must match the SWA app setting of the same name.** Cron workflow sends this in the `X-Cron-Secret` header. |

The workflow at `.github/workflows/rsvp-reminders.yml` runs daily at 16:00 UTC
(11 AM ET) and is also manually triggerable from the Actions tab.

## Seed starter data

```powershell
$env:RSVP_STORAGE_CONNECTION = "<connection string>"
# Optional: real phone for SMS testing
node scripts/seed-rsvp.cjs --phone +15551234567

# Reset (delete + reinsert) just the seeded parties:
node scripts/seed-rsvp.cjs --reset --phone +15551234567
```

Creates three test parties:

- `p_johndiana` — John + Diana (with phone)
- `p_testfam_garcia` — placeholder family of 3 (no phone — tests silent path)
- `p_testsolo_smith` — placeholder solo with plus-one allowed

Replace these with the real guest list when you import it.

## Admin walkthrough

1. Sign in: visit `https://johnanddianaswedding.com/admin`. SWA redirects to
   GitHub OAuth. Use the `jlienus` account.
2. **Toggle reminders ON** to start the monthly cadence (or leave OFF for now).
3. **Send test SMS** — verifies ACS provisioning by texting any number you
   specify. Doesn't touch guest data.
4. **Send reminder** (per-row button) — fires an immediate SMS to that party,
   overriding the 30-day cadence. Useful for individual nudges.
5. **Clear opt-out / hard-fail** — if a guest changes their mind after STOPing,
   or if you fixed a wrong phone number on their party record, clear the flag.
6. **Click a row** — drill down to see member-level responses and recent SMS
   history.

## Privacy & data retention

- Stored: name, optional phone, optional meal + dietary + song + notes.
- Used for: meal counts, seating, accessibility planning, reminder texts.
- Retention: deleted within 60 days after the wedding (Mar 13, 2027).
- Opt-out: SMS recipients can reply STOP at any time; future reminders skip
  the party. The admin can also flip the global toggle off.

The privacy disclosure on the form (`rsvp.privacyBody` in i18n) summarizes
this for guests.

## Magic links

After a guest submits via name lookup, future reminder texts include a magic
link in the form `https://johnanddianaswedding.com/api/rsvp/magic?t=<token>`.
Clicking it:

1. Verifies the HMAC signature.
2. Sets a 60-day session cookie scoped to the party.
3. Redirects to `/rsvp` or `/es/rsvp` (based on the party's locale) with
   `?magic=ok` so the page shows a "we signed you in" banner.

Tokens have no expiry. The threat model assumes a guest forwarding their SMS
to a friend has implicitly delegated RSVP power; we accept that trade-off in
exchange for friction-free return visits.

## Local development

Local Functions emulation requires the Azure Functions Core Tools and a way
to inject env vars. Easiest path:

```powershell
cd api
"@" + (Get-Content local.settings.example.json -Raw) | Out-File local.settings.json -Encoding utf8
# Edit local.settings.json with real connection strings, magic secret, etc.
func start
```

For UI dev:

```powershell
npm install
npm run dev
# Open http://localhost:4321/rsvp
```

The form will call `http://localhost:4321/api/*` which Vite proxies to a
running Functions host on port 7071 (configure in `astro.config.mjs` if you
don't already have a proxy set up — current setup may need adjustment for
local API testing). For most iteration, deploy to a SWA staging slot and
test against the real APIs.

## Troubleshooting

- **`/api/rsvp/lookup` always returns `{found:false}`** — Check that members
  were created with normalized name fields. Re-run the seed script or
  re-import. The lookup is exact-match after normalization (NFD-strip-accents,
  lowercase, alphanumeric only).
- **Magic link returns "invalid"** — `RSVP_MAGIC_SECRET` was changed without
  also rotating all outstanding links. Set up env-var rotation deliberately
  (use `RSVP_SESSION_SECRET` for cookies separately from magic-link secret
  if you need rotation flexibility).
- **`/api/cron/reminders` returns 401** — `RSVP_CRON_SECRET` env var on SWA
  doesn't match the `RSVP_CRON_SECRET` GitHub repo secret. They must be
  identical strings.
- **ACS send returns HTTP_4xx** — Toll-free number isn't verified yet, or
  the destination number is invalid. Check the `errorMessage` in the SMS log
  table.
- **`/admin` shows "Not authorized"** — You're signed in as a GitHub user
  that isn't `jlienus`. Sign out via `/.auth/logout` and sign in as the
  correct account, or update `ADMIN_GITHUB_USERNAME` env var.
- **STOP keyword isn't honored** — Verify the Event Grid subscription on the
  ACS resource is forwarding `Microsoft.Communication.SMSReceived` events to
  `/api/sms/webhook`. Check the SWA function logs for `sms_webhook inbound`
  entries.

## Costs

Rough monthly costs assuming ~150 guests, ~50 with phone numbers:

- Storage: ~$0.10 (well under 1 GB Table Storage)
- ACS toll-free number: $2.00
- ACS SMS: ~$0.015 per reminder (2 segments × $0.0075). With 4–5 reminders
  per guest over the campaign, total ≈ **$3–5** for the entire RSVP period.
- SWA Free tier covers the Functions usage.
- GitHub Actions cron uses ~3 free minutes/month.

**Total RSVP-system cost over the entire campaign: < $10.**
