# Photo Slots

Put finished photos in this folder: `public\images\`.

Use the exact filenames below. The site looks for these names automatically, so replacing an image usually means saving a new file with the same name and refreshing the page.

| Slot filename | Where it appears | Recommended size | Notes |
|---|---|---|---|
| `hero.jpg` | Home page hero | 1920×1080, landscape | Show the couple or the Basílica; will be partially overlaid with text |
| `couple-portrait.jpg` | Our Story top | 1200×1500, portrait | Engagement portrait recommended |
| `couple-gallery-1.jpg` ... `couple-gallery-6.jpg` | Our Story gallery | 1200×1500, portrait | Six photos, all roughly same orientation |
| `basilica-exterior.jpg` | Venues page, ceremony card | 1600×1200, landscape | Wide exterior shot |
| `plaza-grande-hotel.jpg` | Venues page, reception card | 1600×1200, landscape | Hotel exterior or interior |
| `og-image.jpg` | Social-media share preview | 1200×630, landscape | First impression when shared on iMessage, WhatsApp, or Facebook |
| `favicon.svg` | Browser tab icon | Vector | Already provided as `J⚭D` monogram |

Until John & Diana drop in real photos, the components render with subtle CSS gradient fallbacks — the site will not break.

## Photo prep notes

- Use JPG for photographs, around 85% quality.
- Use PNG for graphics with transparency.
- Use SVG for vector art.
- Compress with TinyPNG or Squoosh.app before committing.
- Keep each photo under 500 KB if possible.
- The Astro build does **not** auto-optimize images by default in this scaffold. You can install `@astrojs/image` later if desired.
