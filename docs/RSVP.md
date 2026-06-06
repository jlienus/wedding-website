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
                  │  Azure Table Storage (3 tables)      │
                  │  rsvpInvites / rsvpSmsLog /          │
                  │  rsvpSettings                        │
                  └──────────────────────────────────────┘
```

- **Frontend**: `src/components/RsvpForm.astro` — three phases (name lookup,
  edit form, confirmation), vanilla JS (no framework). EN/ES via `src/i18n/*.json`.
- **Backend**: `api/_lib/{auth,cors,ratelimit,storage,sms,reminders}.js` shared
  libs; per-route folders under `api/rsvp_*`, `api/admin_*`, `api/sms_webhook`,
  `api/cron_reminders`.
- **Data**: **invitation-level model** (v2 — see migration note below). One row
  in `rsvpInvites` per invitation; the entire RSVP response (primary's answer
  plus a self-managed list of additional guests they add at submit time) lives
  in a single JSON `payload` blob on that row. There is no `members` or
  `responses` side-table — the invitation IS the unit of identity, and the
  primary invitee owns the full response payload.
- **SMS**: Azure Communication Services toll-free, US-only. Phone numbers are
  optional — guests without a phone simply don't get reminders.
- **Scheduling**: SWA Free Functions don't support timer triggers, so we use a
  GitHub Actions cron workflow (`.github/workflows/rsvp-reminders.yml`) that
  POSTs `/api/cron/reminders` daily with a shared secret header. The endpoint
  enforces a 30-day per-invite cadence, so daily polling is safe.

### Data model (v2)

Single table `rsvpInvites`. Partition key = invite id (e.g. `i_johndiana`),
row key = `'invite'`. Schema:

| Field | Type | Notes |
| --- | --- | --- |
| `inviteId` | string | Stable id, `i_<10char>`. Never reused (see Operational rules). |
| `primaryFirstName`, `primaryLastName` | string | The single person who looks up this invitation. Lookup is exact-match, case-insensitive, accent-stripped. |
| `phone`, `phoneNorm` | string | Optional. `phoneNorm` is digits-only US E.164. |
| `locale` | `'en'` \| `'es'` | Drives SMS language + magic-link redirect target. |
| `payload` | JSON | `{ schemaVersion: 1, primary: { attending, isKid?, entradaChoice?, sorbetChoice?, mealChoice?, postreChoice?, dietary?, songRequest? }, additionalGuests: [{ id, name, attending, isKid?, entradaChoice?, sorbetChoice?, mealChoice?, postreChoice?, dietary? }], notes? }`. Per-course choices map to the 4-tiempos menu (entrada/sorbet/plato fuerte/postre) — old responses predating the migration may only carry `mealChoice`. |
| `responded`, `respondedAt` | bool / iso8601 | Server auto-derives `responded` from `payload` completeness at submit time. |
| `optedOutOfSms`, `smsHardFailedAt` | bool / iso8601 | Suppress reminder fan-out. |
| `lastReminderSentAt`, `reminderCount` | iso8601 / int | Cadence accounting. |
| `adminNotes` | string | Admin-only free text. |

The `publicInvite()` projection in `api/_lib/storage.js` strips `adminNotes`,
raw `phone`, and any non-public flags before returning to the browser.

## Migration from v1 (3-table) to v2 (single-table)

The original system used `rsvpParties` + `rsvpMembers` + `rsvpResponses`. v2
collapses those into the single `rsvpInvites` table above. The obsolete tables
are dropped by `node scripts/seed-rsvp.cjs --drop-old`. **There is no
in-place migration** — v1 data is wiped, v2 seeds fresh.

## Operational rules

- **Never rename a primary invitee to a different real person.** Session
  cookies and magic-link tokens are bearer credentials keyed only on
  `inviteId` — they don't carry the primary name. If you rename
  `i_johndiana` from "John Lien" to "Bob Smith", any cookie or magic link
  previously issued to John will continue to open Bob's invitation. Always
  Delete + Create New Invitation instead. The admin UI will warn you with
  a confirm dialog if you change the primary name on an existing invite.
- **Spelling fixes are fine** ("Jon" → "John"), as long as the invite still
  belongs to the same person.
- **Same-phone households**: STOP/START SMS keywords apply to *all*
  invitations sharing that `phoneNorm`. Cron-fan-out dedupes by
  `phoneNorm` so a household with one shared phone only gets one reminder
  text per cycle.

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

### 2. SMS provider

The runtime supports two providers. Pick one and set `SMS_PROVIDER` on
the SWA accordingly:

| Provider | `SMS_PROVIDER` | When to use |
| --- | --- | --- |
| Twilio | `twilio` | **Current production.** Provisioning takes ~1 day. Long-code 10DLC or toll-free both work. |
| Azure Communication Services | `acs` (default) | Long-term destination. Toll-free verification takes 7–10 business days (often 2–3 months end-to-end). |

#### 2a. Twilio setup (current production path)

1. Create a Twilio account; upgrade out of trial so messages don't carry
   the "Sent from your Twilio trial account" prefix.
2. **Buy a number** (Console → Phone Numbers → Buy). Long-code 10DLC is
   fastest; toll-free is slower (carrier registration).
3. Copy the **Account SID** and **Auth Token** from Console → Account.
4. Set the SWA app settings:
   - `TWILIO_ACCOUNT_SID` — from Twilio console.
   - `TWILIO_AUTH_TOKEN` — from Twilio console.
   - `TWILIO_FROM` — the purchased number in E.164 (e.g. `+18555551234`).
   - `TWILIO_STATUS_CALLBACK_URL` — *optional.* Defaults to
     `${RSVP_SITE_ORIGIN}/api/twilio/webhook`. Set explicitly if you need
     callbacks routed to a different host.
   - `SMS_PROVIDER=twilio`
5. The Twilio number's **A MESSAGE COMES IN** webhook is auto-pointed at
   `/api/twilio/webhook` by `scripts/configure-twilio-webhook.ps1`. The
   webhook validates `X-Twilio-Signature` against `TWILIO_AUTH_TOKEN`.

STOP / START / HELP keywords are handled at the Twilio platform level
(automatic replies). NO and YES keywords are interpreted by
`api/twilio_webhook` — see [SMS step-up auth and inbound actions]
documented inline in the relevant Function folders.

#### 2b. Azure Communication Services setup (long-term)

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
3. **Submit toll-free verification.** Mandatory in the US — carriers
   reject unverified toll-free SMS. Approval typically takes **7–10
   business days** but in practice has been running 2–3 months.
   - Use case: "wedding RSVP reminders to invited guests"
   - Opt-in method: "consent collected via printed RSVP card with phone number"
   - Sample messages: copy from `api/_lib/sms.js` `buildReminderBody()`
4. Set the SWA app settings:
   - `ACS_CONNECTION` — ACS connection string.
   - `ACS_SMS_FROM` — toll-free number in E.164 (e.g. `+18885551234`).
   - `SMS_PROVIDER=acs`

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
| `RSVP_FIELD_KEY_CURRENT` | Base64-encoded 32-byte AES-256 key. Encrypts `primaryFirstName`, `primaryLastName`, `phone` at rest. **Lose this and you lose access to every encrypted row.** | `pwsh scripts/init-field-keys.ps1` (one-time) then `pwsh scripts/rotate-field-keys.ps1` every 30 days. |
| `RSVP_FIELD_KEY_PREVIOUS` | (Auto-managed) Second base64 key used only during a rotation window so old ciphertext stays decryptable while the re-encrypt sweep runs. Cleared automatically when the sweep completes. | Set + cleared by `rotate-field-keys.ps1`. Don't touch manually. |
| `RSVP_BLIND_INDEX_KEY` | Base64-encoded 32-byte HMAC master. Per-field subkeys are HKDF-derived; used to build deterministic lookup hashes for phone / first / last name. Not rotated (rotation would require re-indexing every row). | `pwsh scripts/init-field-keys.ps1` (one-time). |
| `RSVP_MAGIC_SECRET` | 32+ char random secret for magic-link HMAC. | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `RSVP_SESSION_SECRET` | (Optional) Separate secret for session cookies. Defaults to `RSVP_MAGIC_SECRET`. | Same generator. |
| `RSVP_CRON_SECRET` | 32+ char random secret guarding `/api/cron/reminders`. | Same generator. **Also set as GitHub repo secret with the same name.** |
| `SMS_PROVIDER` | `twilio` or `acs`. Picks which provider `api/_lib/sms.js` uses. **Must be set explicitly** — `sms.sendSms` throws `CONFIG_MISSING_SMS_PROVIDER` if unset, so the operator can't accidentally ship messages from the wrong provider after a cutover. | Set on the SWA. |
| `TWILIO_ACCOUNT_SID` | Twilio account SID. Required when `SMS_PROVIDER=twilio`. | From Twilio Console → Account. |
| `TWILIO_AUTH_TOKEN` | Twilio auth token. Also used to validate `X-Twilio-Signature` on inbound webhooks. | From Twilio Console → Account. |
| `TWILIO_FROM` | Twilio sending number in E.164. | The number you purchased. |
| `TWILIO_STATUS_CALLBACK_URL` | (Optional) URL Twilio POSTs delivery receipts to. Defaults to `${RSVP_SITE_ORIGIN}/api/twilio/webhook`. | |
| `ACS_CONNECTION` | ACS connection string. Required when `SMS_PROVIDER=acs`. | From ACS resource → Keys. |
| `ACS_SMS_FROM` | Toll-free number in E.164. Required when `SMS_PROVIDER=acs`. | The number you provisioned. |
| `ACS_WEBHOOK_SECRET` | (Optional but recommended when `SMS_PROVIDER=acs`) Shared secret required as `?s=<value>` on the SMS webhook URL. Without it the webhook is anonymous. | Same `randomBytes(32).toString('hex')` generator. |
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

# Default: create the i_johndiana invite (John Lien, en)
node scripts/seed-rsvp.cjs

# With a real phone for SMS testing:
node scripts/seed-rsvp.cjs --phone +15551234567

# Reset (delete + recreate) just the seeded invite:
node scripts/seed-rsvp.cjs --reset --phone +15551234567

# Drop the obsolete v1 tables (rsvpParties / rsvpMembers / rsvpResponses).
# Safe to re-run; idempotent.
node scripts/seed-rsvp.cjs --drop-old

# Preview without writing:
node scripts/seed-rsvp.cjs --dry-run --reset --drop-old --phone +15551234567
```

Seeds a single starter invite (`i_johndiana` — John Lien). Use the admin
dashboard at `/admin` to create additional invitations for real guests.

## Admin walkthrough

1. Sign in: visit `https://johnanddianaswedding.com/admin`. SWA redirects to
   GitHub OAuth. Use the `jlienus` account.
2. **Toggle reminders ON** to start the monthly cadence (or leave OFF for now).
3. **Send test SMS** — verifies ACS provisioning by texting any number you
   specify. Doesn't touch guest data.
4. **+ New invitation** — adds a row for one primary invitee (the person whose
   name guests will type to look up). They can self-add their own guests at
   submit time, so you only need to know the head-of-household.
5. **Edit a row** — change phone, locale, notes, opted-out flag. You can also
   hand-edit the raw payload JSON (skips re-derivation if you don't touch
   the textarea). **Don't rename the primary invitee to a different person**
   — use Delete + New instead. The UI will confirm before any rename.
6. **Send reminder** (per-row button) — fires an immediate SMS to that
   invitation, overriding the 30-day cadence. Useful for individual nudges.
7. **Clear hard-fail** — if you fixed a wrong phone number on a row, edit it
   and check "Clear SMS hard-fail" to let reminders resume.
8. **Click a row's "View"** — drill down to see the primary + each additional
   guest from the payload + recent SMS history.

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
2. Sets a 60-day session cookie scoped to the invite.
3. Redirects to `/rsvp` or `/es/rsvp` (based on the invite's locale) with
   `?magic=ok` so the page shows a "we signed you in" banner.

Tokens have no expiry. The threat model assumes a guest forwarding their SMS
to a friend has implicitly delegated RSVP power; we accept that trade-off in
exchange for friction-free return visits.

**Caveat:** the token + cookie are bearer credentials over `inviteId` only.
They survive a primary-name change on the invite. See **Operational rules**
above — never rename a primary invitee to a different real person.

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
