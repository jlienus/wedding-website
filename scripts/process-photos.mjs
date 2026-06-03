#!/usr/bin/env node
// One-off image processor: take downloaded Wikimedia source files and produce
// optimized JPEGs at the slot names the site expects. Run after dropping the
// source photos in $TEMP/wedding-photos/.

import sharp from 'sharp';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

const src = path.join(os.tmpdir(), 'wedding-photos');
const repo = path.resolve(import.meta.dirname, '..');
const out = path.join(repo, 'public');
const outImg = path.join(out, 'images');

await fs.mkdir(outImg, { recursive: true });

const jobs = [
  {
    name: 'og-image (Basilica wide)',
    in: 'basilica-og.jpg',
    out: path.join(out, 'og-image.jpg'),
    width: 1200,
    height: 630,
    fit: 'cover',
    position: 'attention',
    quality: 82,
  },
  {
    name: 'hero (Basilica from Calle Venezuela)',
    in: 'basilica-hero.jpg',
    out: path.join(outImg, 'hero.jpg'),
    width: 2400,
    height: 1600,
    fit: 'cover',
    position: 'attention',
    quality: 78,
  },
  {
    name: 'basilica-exterior (venue card)',
    in: 'basilica-hero.jpg',
    out: path.join(outImg, 'basilica-exterior.jpg'),
    width: 1600,
    height: 1067,
    fit: 'cover',
    position: 'attention',
    quality: 80,
  },
  {
    name: 'plaza-grande-hotel (venue card)',
    in: 'plaza-grande.jpg',
    out: path.join(outImg, 'plaza-grande-hotel.jpg'),
    width: 1200,
    height: 1500,
    fit: 'cover',
    position: 'attention',
    quality: 80,
  },
  {
    name: 'cotopaxi (itinerary hero)',
    in: 'cotopaxi-source.jpg',
    out: path.join(outImg, 'cotopaxi.jpg'),
    width: 2000,
    height: 1100,
    fit: 'cover',
    position: 'center',
    quality: 78,
  },
  {
    name: 'quito-panorama (travel hero)',
    in: 'quito-source.jpg',
    out: path.join(outImg, 'quito-panorama.jpg'),
    width: 2000,
    height: 1100,
    fit: 'cover',
    position: 'center',
    quality: 70,
  },
  {
    name: 'our-story-hero (our story page hero)',
    in: 'our-story-hero-source.jpg',
    out: path.join(outImg, 'our-story-hero.jpg'),
    width: 2400,
    height: 1500,
    fit: 'cover',
    position: 'attention',
    quality: 78,
    // Override: portrait source (2722×3629) needs explicit extract to keep
    // faces in frame AND retain enough vertical context that the hero's
    // cover-fit doesn't crop to faces-only. After extract, we approximate
    // a portrait/shallow-DoF effect: composite a heavily-blurred copy of
    // the image on top of the sharp original, masked by an elliptical
    // radial gradient centered on the kiss. The mask is transparent in
    // the center (sharp original shows through) and opaque at the edges
    // (blurred copy wins). Not true AI subject-segmentation — close
    // enough for a centered subject and reads as natural bokeh.
    customPipeline: async (sharp, inFile, outFile) => {
      const resized = await sharp(inFile).rotate().resize({ width: 2400 }).toBuffer();
      const { height: resizedH } = await sharp(resized).metadata();
      const kissY = Math.round(resizedH * 0.47);
      const W = 2400;
      const H = 1500;
      const top = Math.max(0, Math.min(resizedH - H, kissY - Math.round(H * 0.55)));
      const sharpExtract = await sharp(resized)
        .extract({ left: 0, top, width: W, height: H })
        .toBuffer();

      const blurred = await sharp(sharpExtract).blur(28).png().toBuffer();

      // Elliptical mask centered on the kiss (50% x, 55% y).
      // Transparent center (radius 0-45% sharp), soft falloff (45-100% blur).
      const maskSvg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <radialGradient id="g" cx="50%" cy="55%" r="65%" fx="50%" fy="55%">
            <stop offset="0%" stop-color="white" stop-opacity="0"/>
            <stop offset="38%" stop-color="white" stop-opacity="0"/>
            <stop offset="72%" stop-color="white" stop-opacity="0.65"/>
            <stop offset="100%" stop-color="white" stop-opacity="1"/>
          </radialGradient>
        </defs>
        <rect width="100%" height="100%" fill="url(#g)"/>
      </svg>`;

      const blurredMasked = await sharp(blurred)
        .composite([{ input: Buffer.from(maskSvg), blend: 'dest-in' }])
        .png()
        .toBuffer();

      return sharp(sharpExtract)
        .composite([{ input: blurredMasked, blend: 'over' }])
        .jpeg({ quality: 80, mozjpeg: true, progressive: true })
        .toFile(outFile);
    },
  },
];

for (const j of jobs) {
  const inFile = path.join(src, j.in);
  if (j.customPipeline) {
    await j.customPipeline(sharp, inFile, j.out);
  } else {
    await sharp(inFile)
      .rotate()
      .resize({ width: j.width, height: j.height, fit: j.fit, position: j.position })
      .jpeg({ quality: j.quality, mozjpeg: true, progressive: true })
      .toFile(j.out);
  }
  const stat = await fs.stat(j.out);
  console.log(`${j.name.padEnd(40)} → ${j.out.replace(repo, '')}  ${(stat.size/1024).toFixed(1)} KB`);
}

console.log('\nDone. Don\'t forget to update public/images/CREDITS.md with attribution.');
