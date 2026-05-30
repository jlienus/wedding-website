# Next Steps: Go Live at johnanddianawedding.com

Follow this walkthrough to go from "code on my laptop" to a live wedding website at `johnanddianawedding.com`.

> **Two-subscription setup.** Visual Studio / MSDN Azure subscriptions (the monthly-credit kind) are blocked from Marketplace purchases, including Azure App Service Domains. To stay fully inside Azure, this guide uses **two of your Azure subscriptions**:
>
> | What | Subscription | How it's billed |
> |---|---|---|
> | App Service Domain (registration) | Pay-As-You-Go (PAYG) | Credit card on PAYG (~$12/yr) |
> | Azure DNS zone (auto-created with the domain) | PAYG | Credit card on PAYG (~$6/yr; optional to move to VS — see Phase 4b) |
> | Azure Static Web App (hosting) | Visual Studio | VS Azure credits ($0 on Free tier) |
> | GitHub Actions deploy pipeline | n/a (GitHub) | Free |
>
> Cross-subscription DNS → SWA works natively; you'll be switching subscription context in the Azure portal a few times.

## Phase 1: Buy the domain through Azure App Service Domains (PAYG sub, ~10 min, ~$12/yr)

1. Sign in to https://portal.azure.com.
2. In the top-right subscription/directory filter (or the global subscription picker on whatever blade you open), make sure you're operating in your **Pay-As-You-Go subscription**.
3. Search the portal for **App Service Domains** → click **Create**.
4. Fill in:
   - Subscription: **Pay-As-You-Go**
   - Resource group: create new, name `rg-wedding-domain`
   - Domain name: search for `johnanddianawedding.com`
   - Privacy protection: **enable** (free, hides your personal info from WHOIS)
   - Auto-renew: **enable** (so you don't lose the domain mid-event-planning)
   - Hostname assignment: skip / "Configure later" — we'll point it at the SWA in Phase 4
5. Fill in contact info (registrar requirement — use whatever is fine for WHOIS even with privacy on).
6. Review + create. Confirm the ~$11.99/yr charge to your credit card.
7. After purchase (~2-5 minutes), check `rg-wedding-domain`. It will contain two resources:
   - The **App Service Domain** registration record
   - An **Azure DNS zone** named `johnanddianawedding.com` with four assigned Azure nameservers

That's it for the PAYG side until Phase 4.

## Phase 2: Push code to GitHub (~10 min)

1. Create a new GitHub repo: https://github.com/new
   - Name it `wedding-website`.
   - Set it as **Public** or **Private**. Private is fine and does not affect Azure Static Web Apps Free tier.
2. From PowerShell:

```powershell
cd C:\Users\johnlien\Development\wedding-website
git remote add origin https://github.com/<your-username>/wedding-website.git
git push -u origin main
```

## Phase 3: Create the Azure Static Web App on the VS subscription (~15 min, FREE)

1. Back in https://portal.azure.com, **switch the subscription context to your Visual Studio subscription**.
2. Search for **Static Web Apps** → **Create**.
3. Fill in:
   - Subscription: **Visual Studio** (uses credits)
   - Resource Group: create new, name `rg-wedding` (separate from `rg-wedding-domain` because they're in different subs)
   - Name: `swa-wedding-jd`
   - Plan type: **Free**
   - Region: **East US 2** or closest available region
   - Source: **GitHub** → authorize → select your repo + `main` branch
   - Build presets: **Astro**
   - App location: `/`
   - Output location: `dist`
4. Review + create. After about 2 minutes, Azure provisions the app and triggers the GitHub Actions workflow.
5. Wait for the GitHub Action to complete (~3-5 minutes). Your site goes live at a default URL like `https://<random-words>.azurestaticapps.net`. **Note this default hostname — you'll need it in Phase 4.**

## Phase 4: Connect the custom domain (cross-subscription, ~15 min)

This is where the two subscriptions meet: the DNS zone lives in PAYG, the SWA lives in VS. Azure handles this fine — you just bounce between subscription contexts.

### 4a. Add the www subdomain

1. In Azure portal → switch to **Visual Studio** sub → open your Static Web App → **Custom domains** → **Add** → choose **Custom domain on other DNS**.
2. Enter `www.johnanddianawedding.com` first (subdomains validate faster than apex).
3. Azure shows you a CNAME target (like `polite-sea-123456.1.azurestaticapps.net`) and a TXT validation token. Leave this tab open.
4. In a new tab, switch portal context to **Pay-As-You-Go** sub → open the **DNS zone** `johnanddianawedding.com` (in `rg-wedding-domain`) → **+ Record set**:
   - **CNAME** record: name = `www`, alias = the SWA target, TTL = 3600.
   - **TXT** record: name = `_dnsauth.www` (or whatever Azure's prompt shows), value = the validation token.
5. Back on the VS-sub SWA Custom-domains blade, click **Validate**. Usually takes 1-5 minutes. Once validated, Azure issues a free managed TLS certificate automatically.

### 4b. Add the apex domain

1. In VS sub → SWA → **Custom domains** → **Add** → repeat with `johnanddianawedding.com` (no `www`).
2. Azure prompts for an apex record. In the PAYG DNS zone:
   - Add an **A record** with the **Alias record set toggle ON** → point it at your Static Web App resource (use the resource picker — it will let you pick the SWA from the VS subscription). This is Azure DNS's native way to handle apex → SWA without CNAME-flattening workarounds.
   - Add the second TXT validation record as Azure instructs.
3. Validate in the SWA blade.
4. Site is now live at both `https://johnanddianawedding.com` and `https://www.johnanddianawedding.com` with TLS.

### 4c. (Optional) Move the DNS zone to VS sub to bill it against credits

If you want the ~$6/yr DNS hosting cost on VS credits instead of the PAYG card, you can move just the DNS zone resource (the App Service Domain registration record itself must stay in PAYG):

1. PAYG sub → `rg-wedding-domain` → click the DNS zone → **Move** → **Move to another subscription**.
2. Pick VS sub + a resource group in VS sub (e.g., `rg-wedding`).
3. Confirm. The Azure nameservers do **not** change when a zone moves, so DNS keeps working. The records you added in step 4a/4b carry along automatically.

Skip this step if you'd rather not touch it — $6/yr is a rounding error.

## Phase 5: Set up RSVPify and wire it in (~20 min, $35-75 one-time)

1. Sign up at https://www.rsvpify.com and pick the **Event** plan, one-time for your wedding.
2. Create a new event:
   - Date: `2027-03-13`
   - Add custom RSVP questions: meal choice (TBD), dietary restrictions (free text), +1 based on your invite policy, and song requests
3. Import your guest list as a CSV. RSVPify supports a unique link per household.
4. Get the embed snippet: **Settings** → **Embed** → copy the URL inside the `src="..."` of their iframe code.
5. Also copy the public URL for the fallback link.
6. Edit `src\data\wedding.config.json`:
   - Replace `RSVPIFY_EMBED_URL_GOES_HERE` with the embed URL.
   - Replace `RSVPIFY_PUBLIC_URL_GOES_HERE` with the public URL.
7. Commit + push:

```powershell
git add -A
git commit -m "config: wire up RSVPify embed"
git push
```

8. Azure auto-deploys.

## Phase 6: Drop in real photos (~10 min)

See [public\images\README.md](public\images\README.md) for the full photo slot list.

Quickest start: save your engagement photo as `public\images\hero.jpg` at about 1920×1080, JPG around 85% quality. Then commit and push to deploy.

## Phase 7: Generate QR codes for printed invites (~15 min)

For your "fully public" model, the same RSVP URL works for everyone, so one QR code is enough.

1. Go to a free QR generator like https://www.qr-code-generator.com/.
2. Enter your RSVP URL: `https://johnanddianawedding.com/rsvp`.
3. Download as SVG. SVG is vector format, so it stays sharp at any print size.
4. Send the SVG to your invitation designer.

If you later switch to per-guest unique URLs through RSVPify's invitation list feature, you will generate one QR per envelope. RSVPify can do this in bulk.

## Phase 8: Pre-wedding QA

A week before the wedding, do a final pass:

- All photos are real, not placeholders.
- RSVPify embed loads and submits successfully.
- Itinerary is still accurate.
- Re-verify that the Hotel Plaza Grande shuttle is confirmed.
- Spanish version reads naturally to a native speaker; ask Diana.
- Test on mobile and desktop.
- Run a Lighthouse audit: `npm run build`, then serve `dist\` locally.

## Optional v1.5 / v2 enhancements

- Add Sanity CMS for true point-and-click content editing; about 4 hours of work.
- Add an AI chatbot via Azure OpenAI for guest FAQ; about 6 hours.
- Add a printable map / PDF guest welcome packet; about 2 hours.
- Add a gallery upload-from-guests feature after the wedding.

## Cost summary (annual)

| Item | Cost | Billed to |
|---|---|---|
| App Service Domain (PAYG sub) | ~$12/yr | PAYG credit card |
| Azure DNS zone hosting | ~$6/yr | PAYG credit card (or VS credits if you do Phase 4c) |
| Azure DNS queries (at our traffic) | effectively $0 | n/a |
| Azure Static Web Apps Free (VS sub) | $0 | VS Azure credits |
| RSVPify (Event plan) | $35-75 one-time | Credit card |
| GitHub | $0 | n/a |
| **Total** | **~$18/yr + $35-75 once** | |

No external registrar, no Cloudflare, no third-party DNS. Domain + DNS + hosting all sit in Azure, split across the two subscriptions to respect the Marketplace rules on VS credits.
