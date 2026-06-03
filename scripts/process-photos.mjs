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
    quality: 82,
    // The source already has AI subject-segmentation portrait bokeh
    // applied (edited in Google Pixel Studio), so we just resize + extract
    // a landscape band centered on the kiss. No additional blur compositing.
    customPipeline: async (sharp, inFile, outFile) => {
      const resized = await sharp(inFile).rotate().resize({ width: 2400 }).toBuffer();
      const { height: resizedH } = await sharp(resized).metadata();
      // Kiss point sits at ~50% from top of the AI-edited source.
      // Place it at ~55% of the output band so faces stay in frame after
      // the hero's object-position: center 45% crop.
      const kissY = Math.round(resizedH * 0.50);
      const targetH = 1500;
      const top = Math.max(0, Math.min(resizedH - targetH, kissY - Math.round(targetH * 0.55)));
      return sharp(resized)
        .extract({ left: 0, top, width: 2400, height: targetH })
        .jpeg({ quality: 82, mozjpeg: true, progressive: true })
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
