# Next Steps: Go Live at johnanddianawedding.com

Follow this walkthrough to go from “code on my laptop” to a live wedding website at `johnanddianawedding.com`.

## Phase 1: Register the domain (~10 min, ~$9.15)

1. Go to https://dash.cloudflare.com/sign-up — create a free Cloudflare account if you do not have one.
2. Click **Registrar** → **Register Domains** → search for `johnanddianawedding.com`.
3. Confirm the price, around **$9.15/year** at-cost, then check out.
4. Cloudflare auto-creates a DNS zone for the domain. You will add records in Phase 4.

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

## Phase 3: Create the Azure Static Web App (~15 min, FREE)

1. Sign in to https://portal.azure.com.
2. Search for **Static Web Apps** → **Create**.
3. Fill in:
   - Resource Group: create new, name e.g. `rg-wedding`
   - Name: `swa-wedding-jd`
   - Plan type: **Free**
   - Region: **East US 2** or closest available region
   - Source: **GitHub** → authorize → select your repo + `main` branch
   - Build presets: **Astro**
   - App location: `/`
   - Output location: `dist`
4. Review + create. After about 2 minutes, Azure provisions the app and triggers a GitHub Actions run.
5. Wait for the GitHub Action to complete. Your site will be live at a URL like `https://<random-words>.azurestaticapps.net`.

## Phase 4: Connect the custom domain (~15 min)

1. In Azure portal → Static Web App → **Custom domains** → **Add** → choose **Custom domain on other DNS**.
2. Enter `www.johnanddianawedding.com` first. The `www` subdomain is easier to validate.
3. Azure gives you a CNAME target like `polite-sea-123456.1.azurestaticapps.net`.
4. In Cloudflare dashboard → DNS for your domain:
   - Add CNAME: `www` → `<azure-target>`
   - Proxy: **DNS-only / gray cloud** initially
5. Back in Azure, click **Validate**. This usually takes 1-5 minutes. Once validated, Azure issues a free TLS certificate.
6. Repeat for the apex `johnanddianawedding.com`:
   - In Cloudflare DNS, add CNAME: `@` → `<azure-target>`
   - Cloudflare's CNAME flattening makes this work at the apex.
   - In Azure, add the apex custom domain and validate it.
7. Optional: turn the Cloudflare proxy back on for both records once validation is complete.

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

For your “fully public” model, the same RSVP URL works for everyone, so one QR code is enough.

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

| Item | Cost |
|---|---|
| Domain (Cloudflare Registrar) | $9.15/yr |
| Azure Static Web Apps (Free tier) | $0 |
| Cloudflare DNS | $0 |
| RSVPify (Event plan) | $35-75 one-time |
| GitHub | $0 Public or $0 Private under user limits |
| **Total** | **~$45-85 for the year** |
