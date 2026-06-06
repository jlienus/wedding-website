# John & Diana Wedding Website

## Project

Wedding website for **John Michael Lien & Diana Duchicela Guajan**.

- Wedding date: **Saturday, March 13, 2027**
- Location: **Quito, Ecuador**

## Stack

- **Astro + TypeScript** for the website
- **Azure Static Web Apps** for hosting (Free tier, on Visual Studio subscription)
- **Azure App Service Domains** for the custom domain (on Pay-As-You-Go subscription)
- **Azure DNS** for record hosting
- **Custom RSVP flow** backed by Azure Functions + Azure Table Storage with SMS step-up auth (see [docs/RSVP.md](docs/RSVP.md))
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
| RSVP system internals (SMS step-up, reminders, admin panel) | [docs/RSVP.md](docs/RSVP.md) |
| Add or replace website photos | [public\images\README.md](public\images\README.md) |
| Operational scripts (key rotation, smoke tests, deploy helpers) | [scripts/README.md](scripts/README.md) |
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
├─ ARCHITECTURE.md       Architecture and operations reference
├─ CONTENT-EDITING-GUIDE.md
└─ docs\RSVP.md          RSVP system internals
```

## Build & deploy

```powershell
npm run build
```

This produces the production site in `dist\`.

After GitHub and Azure Static Web Apps are connected, pushing to `main` on GitHub triggers the Azure Static Web Apps workflow automatically. Azure builds the Astro site and deploys the contents of `dist\`.

## Links

- [Content Editing Guide](CONTENT-EDITING-GUIDE.md)
- [RSVP System Internals](docs/RSVP.md)
- [Architecture & Operations](ARCHITECTURE.md)
- [Photo Slot Guide](public\images\README.md)
- [Operational Scripts](scripts/README.md)
