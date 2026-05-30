# John & Diana Wedding Website

## Project

Wedding website for **John Michael Lien & Diana Duchicela Guajan**.

- Wedding date: **Saturday, March 13, 2027**
- Location: **Quito, Ecuador**

## Stack

- **Astro + TypeScript** for the website
- **Azure Static Web Apps** for hosting
- **Cloudflare DNS** for the custom domain
- **RSVPify** embedded for RSVP collection
- **Bilingual English + Spanish** content

## Quick start

```powershell
cd C:\Users\johnlien\Development\wedding-website
npm install
npm run dev
# opens http://localhost:4321
```

## Common tasks

| Task | Where to go |
|---|---|
| Change wedding details, copy, itinerary, hotels, FAQs, links, or photos | [CONTENT-EDITING-GUIDE.md](CONTENT-EDITING-GUIDE.md) |
| Get the site live at `johnanddianawedding.com` | [NEXT-STEPS.md](NEXT-STEPS.md) |
| Add or replace website photos | [public\images\README.md](public\images\README.md) |
| Build the site before deployment | Run `npm run build` |
| Preview the site while editing | Run `npm run dev` |

## Project structure

```text
wedding-website\
├─ .github\              GitHub Actions workflows for Azure deployment
├─ public\               Static files copied directly to the website
│  └─ images\            Drop-in photo slots for the site
├─ src\                  Website source code, pages, components, data, and translations
├─ dist\                 Generated production build output; created by npm run build
├─ astro.config.mjs      Astro configuration
├─ package.json          npm scripts and dependencies
├─ README.md             Project overview
├─ CONTENT-EDITING-GUIDE.md
└─ NEXT-STEPS.md
```

## Build & deploy

```powershell
npm run build
```

This produces the production site in `dist\`.

After GitHub and Azure Static Web Apps are connected, pushing to `main` on GitHub triggers the Azure Static Web Apps workflow automatically. Azure builds the Astro site and deploys the contents of `dist\`.

## Cost summary

- Domain through Cloudflare Registrar: about **$9/year**
- Azure Static Web Apps Free tier: **$0**
- Cloudflare DNS: **$0**
- RSVPify Event plan: about **$35-75 one-time**

Rough total: **$10-30/year + $35-75 once.**

## Links

- [Content Editing Guide](CONTENT-EDITING-GUIDE.md)
- [Next Steps to Go Live](NEXT-STEPS.md)
- [Photo Slot Guide](public\images\README.md)

## Credits

Built with help from Copilot CLI.
