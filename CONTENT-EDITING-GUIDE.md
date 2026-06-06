# Content Editing Guide

This guide is for changing wedding website content without needing to be a programmer. Most edits are made in small JSON files under `src\data\` or `src\i18n\`.

## A. The most common edits

| I want to... | Edit this file |
|---|---|
| Change the wedding date / time / venue | `src\data\wedding.config.json` — this is the single source of truth; all pages read from here |
| Update the RSVP deadline | `src\data\wedding.config.json`, the `rsvp.deadline` field |
| Add the Amazon registry link | `src\data\wedding.config.json`, the `registry.amazon.url` field |
| Change English copy | `src\i18n\en.json` |
| Change Spanish copy | `src\i18n\es.json` |
| Edit a specific itinerary day | `src\data\itinerary.json` |
| Update venue blurbs/tips | `src\data\venues.json` |
| Add/remove a hotel | `src\data\hotels.json` |
| Add a FAQ | `src\data\faqs.json` |
| Change a flight/hotel deep link | `src\data\travel-links.json` |

For RSVP-system internals (the SMS step-up flow, magic-link reminders,
backend storage, admin panel) see [docs\RSVP.md](docs\RSVP.md). The
RSVP is a custom flow backed by Azure Functions + Table Storage — it
no longer uses any third-party embed.

## B. Photos — drop-in instructions

Photos go in `public\images\`.

Save each photo with the exact filename listed in [public\images\README.md](public\images\README.md). The site picks it up automatically — no code change needed. Recommended image sizes are listed per slot.

Example: to replace the hero photo, save your engagement photo as `hero.jpg` in `public\images\` and reload the site.

## C. JSON editing primer for non-programmers

JSON is a structured text format the site reads for content.

1. Keys go in quotes, like `"deadline"`.
2. Text values also go in quotes, like `"2027-02-01"`.
3. Use commas between items.
4. Do **not** leave a comma after the last item in a list or object.
5. Keep the `{ }`, `[ ]`, quotes, and commas balanced.

Recommended editor: **VS Code**. It is free and highlights JSON mistakes in red. The GitHub web editor also works for quick edits if you are changing files directly on GitHub.

## D. Adding a new language (advanced)

The site is currently set up for English and Spanish. Adding a third language requires updating the `locales` array in `astro.config.mjs`, adding a new translation file, and duplicating the page tree for the new locale. Treat this as a developer task rather than a quick content edit.

## E. Preview your changes locally

```powershell
npm run dev
```

Then open http://localhost:4321 in a browser. Refresh after each edit.

To check the Spanish version, navigate to http://localhost:4321/es.

## F. Publishing changes

The site auto-deploys from `main` via GitHub Actions whenever you push.
Make your edits, then:

```powershell
git add -A
git commit -m "content: updated FAQ and Mindo itinerary"
git push origin main
```

Azure auto-deploys in about 2-3 minutes.
