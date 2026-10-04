#!/usr/bin/env node
// Renders the OpenVids featured card with the live GitHub star count.
//
//   GITHUB_TOKEN=... node scripts/openvids-card.mjs [output/openvids.svg]
//   node scripts/openvids-card.mjs [output/openvids.svg] --stars 42   # offline, no network
//
// Reads assets/openvids.template.svg and replaces its <!--STARS--> marker with a star chip
// placed to the left of the "EARLY STAGE" chip. Zero dependencies, Node 20+. Exits non-zero
// on any API/template error; never renders a placeholder count.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'bazodev/open-vids';
const TEMPLATE = resolve(dirname(fileURLToPath(import.meta.url)), '../assets/openvids.template.svg');
const MARKER = '<!--STARS-->';

// Geometry of the existing "EARLY STAGE" chip in the template: left edge 684.5, y 44.5–70.5.
const CHIP_RIGHT = 676.5;
const CHIP_TOP = 44.5;
const CHIP_H = 26;
const MID_Y = CHIP_TOP + CHIP_H / 2;
// Monospace 11px with letter-spacing 1: ~0.6em advance + 1px across SF Mono/Menlo/Consolas/DejaVu.
const CHAR_W = 7.6;

function parseArgs(argv) {
  let out = 'output/openvids.svg';
  let stars = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--stars') {
      stars = Number(argv[++i]);
      if (!Number.isInteger(stars) || stars < 0) throw new Error('--stars requires a non-negative integer');
    } else if (a.startsWith('--')) {
      throw new Error(`Unknown option: ${a}`);
    } else {
      out = a;
    }
  }
  return { out, stars };
}

async function fetchStars(token) {
  if (!token) throw new Error('GITHUB_TOKEN is not set');
  const res = await fetch(`https://api.github.com/repos/${REPO}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'bazodev-profile-stats',
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub API ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
  const stars = JSON.parse(text).stargazers_count;
  if (!Number.isInteger(stars)) throw new Error(`stargazers_count missing in response for ${REPO}`);
  return stars;
}

/** Five-point star polygon centred on (cx, cy). */
function starPoints(cx, cy, outer, inner) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? inner : outer;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(' ');
}

function renderChip(stars) {
  const count = new Intl.NumberFormat('en-US').format(stars);
  const word = stars === 1 ? 'STAR' : 'STARS';
  const textW = (count.length + 1 + word.length) * CHAR_W - 1;
  const width = Math.round(12 + 11 + 7 + textW + 13);
  const left = CHIP_RIGHT - width;
  const starCx = left + 12 + 5.5;
  const textX = left + 12 + 11 + 7;
  return [
    `<g>`,
    `<title>${count} GitHub ${word.toLowerCase()}</title>`,
    `<rect x="${left}" y="${CHIP_TOP}" width="${width}" height="${CHIP_H}" rx="13" fill="#16171a" stroke="#34363b"/>`,
    `<polygon points="${starPoints(starCx, MID_Y - 0.5, 5.6, 2.4)}" fill="#F48D3C"/>`,
    `<text class="mono" x="${textX.toFixed(1)}" y="61.5" font-size="11" letter-spacing="1" fill="#ebecef">${count}<tspan fill="#9a9ca3"> ${word}</tspan></text>`,
    `</g>`,
  ].join('\n');
}

async function main() {
  const { out, stars: fixed } = parseArgs(process.argv.slice(2));
  const template = readFileSync(TEMPLATE, 'utf8');
  if (template.split(MARKER).length !== 2) throw new Error(`${TEMPLATE} must contain exactly one ${MARKER} marker`);
  const stars = fixed ?? (await fetchStars(process.env.GITHUB_TOKEN));
  const path = resolve(out);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, template.replace(MARKER, renderChip(stars)));
  console.log(`${path}: ${REPO} ${stars} star${stars === 1 ? '' : 's'}${fixed === null ? '' : ' (fixed)'}`);
}

main().catch((err) => {
  console.error(`openvids-card: ${err.message}`);
  process.exit(1);
});
