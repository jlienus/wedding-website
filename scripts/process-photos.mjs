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
];

for (const j of jobs) {
  const inFile = path.join(src, j.in);
  await sharp(inFile)
    .rotate()
    .resize({ width: j.width, height: j.height, fit: j.fit, position: j.position })
    .jpeg({ quality: j.quality, mozjpeg: true, progressive: true })
    .toFile(j.out);
  const stat = await fs.stat(j.out);
  console.log(`${j.name.padEnd(40)} → ${j.out.replace(repo, '')}  ${(stat.size/1024).toFixed(1)} KB`);
}

console.log('\nDone. Don\'t forget to update public/images/CREDITS.md with attribution.');
