#!/usr/bin/env node
// Generates a minimal dark GitHub activity card (SVG) from the contribution calendar.
//
//   GITHUB_TOKEN=... [GH_USER=bazodev] node scripts/stats.mjs [output/stats.svg]
//   node scripts/stats.mjs [output/stats.svg] --fixture response.json   # offline, no network
//
// Zero dependencies, Node 20+. Exits non-zero on any API/data error; never renders placeholder data.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const QUERY = `query($login: String!) {
  user(login: $login) {
    contributionsCollection {
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount } }
      }
    }
  }
}`;

const C = {
  bg: '#0b0c0e', surface: '#16171a', cell0: '#1b1c20', fg: '#ebecef', muted: '#9a9ca3',
  line: '#26282d', accent: '#F48D3C',
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---------- args ----------

function parseArgs(argv) {
  let out = 'output/stats.svg';
  let fixture = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fixture') {
      fixture = argv[++i];
      if (!fixture) throw new Error('--fixture requires a file path');
    } else if (a.startsWith('--')) {
      throw new Error(`Unknown option: ${a}`);
    } else {
      out = a;
    }
  }
  return { out, fixture };
}

// ---------- data ----------

async function fetchResponse(login, token) {
  if (!token) throw new Error('GITHUB_TOKEN is not set');
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'bazodev-profile-stats',
    },
    body: JSON.stringify({ query: QUERY, variables: { login } }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub API ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`GitHub API returned non-JSON: ${text.slice(0, 200)}`);
  }
}

function extractDays(json) {
  if (json.errors?.length) {
    throw new Error(`GitHub GraphQL errors: ${json.errors.map((e) => e.message).join('; ')}`);
  }
  const cal = json.data?.user?.contributionsCollection?.contributionCalendar;
  if (!cal) throw new Error('Response has no data.user.contributionsCollection.contributionCalendar');
  const days = cal.weeks.flatMap((w) => w.contributionDays);
  if (days.length === 0) throw new Error('Contribution calendar is empty');
  days.sort((a, b) => a.date.localeCompare(b.date));
  const sum = days.reduce((s, d) => s + d.contributionCount, 0);
  if (sum !== cal.totalContributions) {
    throw new Error(`Calendar inconsistent: days sum to ${sum}, API says ${cal.totalContributions}`);
  }
  return { days, total: cal.totalContributions };
}

const dayMs = 86_400_000;
const toMs = (date) => Date.parse(`${date}T00:00:00Z`);

/** Runs of consecutive days with >0 contributions, as {start, end, length} (dates inclusive). */
function streaks(days) {
  const runs = [];
  let cur = null;
  for (const d of days) {
    if (d.contributionCount > 0) {
      if (cur && toMs(d.date) - toMs(cur.end) === dayMs) {
        cur.end = d.date;
        cur.length++;
      } else {
        cur = { start: d.date, end: d.date, length: 1 };
        runs.push(cur);
      }
    }
  }
  return runs;
}

function computeStats(days, total) {
  const runs = streaks(days);
  const last = days[days.length - 1].date;
  // Current streak: a run that ends today, or yesterday (today may simply not have happened yet).
  const current = runs.find((r) => toMs(last) - toMs(r.end) <= dayMs) ?? null;
  const longest = runs.reduce((b, r) => (!b || r.length > b.length ? r : b), null);
  const best = days.reduce((b, d) => (d.contributionCount > b.contributionCount ? d : b), days[0]);
  return {
    total,
    first: days[0].date,
    last,
    spanDays: days.length,
    activeDays: days.filter((d) => d.contributionCount > 0).length,
    current,
    longest,
    best: best.contributionCount > 0 ? best : null,
  };
}

// ---------- rendering ----------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const nf = new Intl.NumberFormat('en-US');
const shortDate = (d) => `${MONTHS[+d.slice(5, 7) - 1]} ${+d.slice(8, 10)}`;
const longDate = (d) => `${shortDate(d)}, ${d.slice(0, 4)}`;
const monthYear = (d) => `${MONTHS[+d.slice(5, 7) - 1]} ${d.slice(0, 4)}`;
const range = (a, b) => (a === b ? longDate(a) : `${shortDate(a)} – ${shortDate(b)}`);
const plural = (n, w) => `${nf.format(n)} ${w}${n === 1 ? '' : 's'}`;

function mix(hex, over, t) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const a = p(hex), b = p(over);
  return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, '0')).join('');
}
const LEVELS = [C.cell0, ...[0.26, 0.5, 0.75, 1].map((t) => mix(C.cell0, C.accent, t))];

/** Level 1–4 by quartile of the user's own non-zero days, so the map is meaningful for any activity volume. */
function levelFn(days) {
  const nz = days.map((d) => d.contributionCount).filter((n) => n > 0).sort((a, b) => a - b);
  const q = (p) => nz[Math.floor(p * (nz.length - 1))];
  const [t1, t2, t3] = [q(0.25), q(0.5), q(0.75)];
  return (n) => (n <= 0 ? 0 : n <= t1 ? 1 : n <= t2 ? 2 : n <= t3 ? 3 : 4);
}

function render(stats, days, updated) {
  const W = 840, PAD = 24, CELL = 12, GAP = 3, PITCH = CELL + GAP;
  const gridX = PAD, gridY = 176;
  const level = levelFn(days);

  // Column = week (Sunday-based, as GitHub draws it), row = weekday.
  const firstMs = toMs(days[0].date);
  const firstDow = new Date(firstMs).getUTCDay();
  const weekOf = (date) => Math.floor((toMs(date) - firstMs + firstDow * dayMs) / (7 * dayMs));
  const cols = weekOf(days[days.length - 1].date) + 1;
  const gridW = cols * PITCH - GAP;
  if (gridW > W - 2 * PAD) throw new Error(`Calendar has ${cols} weeks; card layout fits ${Math.floor((W - 2 * PAD + GAP) / PITCH)}`);

  let cells = '';
  let monthLabels = '';
  let lastMonth = -1;
  let lastLabelCol = -Infinity;
  for (const d of days) {
    const dow = new Date(toMs(d.date)).getUTCDay();
    const col = weekOf(d.date);
    const x = gridX + col * PITCH, y = gridY + dow * PITCH;
    cells += `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2.5" fill="${LEVELS[level(d.contributionCount)]}"><title>${esc(longDate(d.date))}: ${d.contributionCount}</title></rect>`;
    const m = +d.date.slice(5, 7) - 1;
    if (dow === 0 && m !== lastMonth) {
      // Skip a label if it would collide with the previous one, or hang off the right edge.
      if ((col - lastLabelCol) * PITCH >= 40 && x + 26 <= gridX + gridW + GAP) {
        monthLabels += `<text class="mono" x="${x}" y="${gridY - 10}" font-size="11" fill="${C.muted}">${MONTHS[m]}</text>`;
        lastLabelCol = col;
      }
      lastMonth = m;
    }
  }

  const cur = stats.current, lon = stats.longest;
  const colW = (W - 2 * PAD) / 5;
  const items = [
    [nf.format(stats.total), 'contributions', `${monthYear(stats.first)} – ${monthYear(stats.last)}`],
    [cur ? plural(cur.length, 'day') : '0 days', 'current streak', cur ? range(cur.start, cur.end) : 'no active streak'],
    [lon ? plural(lon.length, 'day') : '0 days', 'longest streak', lon ? range(lon.start, lon.end) : '–'],
    [nf.format(stats.activeDays), 'active days', `of ${nf.format(stats.spanDays)}`],
    [stats.best ? nf.format(stats.best.contributionCount) : '0', 'best day', stats.best ? longDate(stats.best.date) : '–'],
  ];
  let head = '';
  items.forEach(([value, label, sub], i) => {
    const x = PAD + i * colW;
    head += `<text class="serif" x="${x}" y="84" font-size="30" fill="${C.fg}">${esc(value)}</text>`;
    head += `<text class="sans" x="${x}" y="106" font-size="13" fill="${C.fg}">${esc(label)}</text>`;
    head += `<text class="mono" x="${x}" y="124" font-size="11" fill="${C.muted}">${esc(sub)}</text>`;
  });

  const gridBottom = gridY + 7 * PITCH - GAP;
  const legendY = gridBottom + 24;
  const H = legendY + 4 + PAD - 8;
  const right = gridX + gridW;
  const sqX = right - 4 * 7 - 8 - (5 * PITCH - GAP); // squares sit left of "More"
  let legend = `<text class="mono" x="${sqX - 8}" y="${legendY}" font-size="11" fill="${C.muted}" text-anchor="end">Less</text>`;
  LEVELS.forEach((c, i) => {
    legend += `<rect x="${sqX + i * PITCH}" y="${legendY - 10}" width="${CELL}" height="${CELL}" rx="2.5" fill="${c}"/>`;
  });
  legend += `<text class="mono" x="${right}" y="${legendY}" font-size="11" fill="${C.muted}" text-anchor="end">More</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t d">
<title id="t">GitHub activity</title>
<desc id="d">${esc(`${nf.format(stats.total)} contributions between ${range(stats.first, stats.last)}; current streak ${plural(cur?.length ?? 0, 'day')}, longest streak ${plural(lon?.length ?? 0, 'day')}, ${nf.format(stats.activeDays)} active days.`)}</desc>
<style>
.serif{font-family:ui-serif,"New York","Iowan Old Style",Charter,Georgia,"Times New Roman",serif}
.sans{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
.mono{font-family:ui-monospace,"SF Mono",Menlo,Consolas,"DejaVu Sans Mono",monospace}
</style>
<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="15.5" fill="${C.bg}" stroke="${C.line}"/>
<circle cx="${PAD + 4}" cy="${PAD + 7}" r="4" fill="${C.accent}"/>
<text class="mono" x="${PAD + 16}" y="${PAD + 12}" font-size="13" letter-spacing="1" fill="${C.muted}">contribution activity · last year</text>
<text class="mono" x="${W - PAD}" y="${PAD + 12}" font-size="11" fill="${C.muted}" text-anchor="end">Updated ${esc(updated)}</text>
${head}
<path d="M${PAD} 142H${W - PAD}" stroke="${C.line}"/>
${monthLabels}
${cells}
${legend}
</svg>
`;
}

// ---------- main ----------

async function main() {
  const { out, fixture } = parseArgs(process.argv.slice(2));
  const login = process.env.GH_USER || 'bazodev';
  const json = fixture
    ? JSON.parse(readFileSync(fixture, 'utf8'))
    : await fetchResponse(login, process.env.GITHUB_TOKEN);
  const { days, total } = extractDays(json);
  const stats = computeStats(days, total);
  const svg = render(stats, days, new Date().toISOString().slice(0, 10));
  const path = resolve(out);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, svg);
  console.log(`${path}: ${stats.total} contributions, current streak ${stats.current?.length ?? 0}, longest ${stats.longest?.length ?? 0}, ${stats.activeDays} active days${fixture ? ' (fixture)' : ''}`);
}

main().catch((err) => {
  console.error(`stats: ${err.message}`);
  process.exit(1);
});
