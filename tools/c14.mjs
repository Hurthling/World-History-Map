// =============================================================================
// c14.mjs — radiocarbon dates near a map date, calibrated, with a verdict.
//
// Data: p3k14c global radiocarbon database (Bird et al. 2022, Scientific Data;
// version 2025.07, data CC0), stored in tools/c14-data/p3k14c.csv.gz.
// Calibration: IntCal20 (northern hemisphere) / SHCal20 (lat < 0), 95% HPD.
//
// Usage (examples):
//   node tools/c14.mjs --year -8000 --box -82,-20,-68,0        (lon W,S,E,N)
//   node tools/c14.mjs --year -8000 --near -17.0,-70.6 --km 80
//   node tools/c14.mjs --year -8000 --site "Asana" [--country Peru]
// Options:
//   --window N   show dates whose 95% range lies within N cal years of the
//                map date (default 2000); the verdict always uses ±1000/±250
//   --all        show every date of the selected sites
//   --brief      one line per site, no individual dates
//
// Verdict per site (rules from corrections/README.md):
//   "on date"   — a 95% range covers the map date
//   "fork"      — dates both before and after, each within 1000 cal years
//                 (by the near edge of the range) — the ±1000 rule
//   "no"        — otherwise
//   "edge ±250" — the site's first or last date (median) lies within 250 cal
//                 years of the map date: the owner decides
// Gaps inside a site's sequence are NOT detected — read the dates.
// =============================================================================

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'c14-data');

// ---------- arguments ----------
const args = process.argv.slice(2);
const opt = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (!a.startsWith('--')) continue;
  const key = a.slice(2);
  const next = args[i + 1];
  if (next === undefined || next.startsWith('--') && !/^--?\d/.test(next)) opt[key] = true;
  else { opt[key] = next; i++; }
}
if (!opt.test && (!opt.year || !(opt.box || opt.near || opt.site))) {
  console.log('Usage: node tools/c14.mjs --year -8000 (--box W,S,E,N | --near LAT,LON --km 100 | --site NAME) [--country X] [--window 2000] [--all] [--brief]');
  process.exit(1);
}
const year = Number(opt.year);
const T = year < 0 ? 1950 - year - 1 : 1950 - year;   // map date in cal BP (no year 0)
const WINDOW = Number(opt.window ?? 2000);

// ---------- CSV ----------
function parseCSV(text) {
  const rows = []; let row = []; let f = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}

// ---------- calibration curves (1-year grid) ----------
function loadCurve(name) {
  const pts = readFileSync(join(DIR, name), 'utf8').split('\n')
    .filter(l => /^\d/.test(l)).map(l => l.split(',').map(Number))
    .map(([cal, c14, sig]) => ({ cal, c14, sig })).sort((a, b) => a.cal - b.cal);
  const max = pts[pts.length - 1].cal;
  const mu = new Float64Array(max + 1), sg = new Float64Array(max + 1);
  for (let k = 0; k < pts.length - 1; k++) {
    const a = pts[k], b = pts[k + 1];
    for (let t = a.cal; t <= b.cal; t++) {
      const w = (t - a.cal) / (b.cal - a.cal || 1);
      mu[t] = a.c14 + w * (b.c14 - a.c14);
      sg[t] = a.sig + w * (b.sig - a.sig);
    }
  }
  return { pts, mu, sg, max };
}
const CURVES = { N: loadCurve('intcal20.14c'), S: loadCurve('shcal20.14c') };

// --test AGE,ERR[,S] — calibrate one date and exit (for checking against OxCal)
if (opt.test) {
  const [a, e, h] = String(opt.test).split(',');
  const c = calibrate(+a, +e, h === 'S' ? CURVES.S : CURVES.N);
  console.log(`${a} ± ${e} (${h === 'S' ? 'SHCal20' : 'IntCal20'}) → 95 %: ${c.ranges.slice().reverse().map(([y, o]) => o + '–' + y).join(', ')}; медиана ${c.median}`);
  process.exit(0);
}

function calibrate(age, err, curve) {
  const { pts, mu, sg, max } = curve;
  // coarse search for the relevant part of the curve
  let lo = Infinity, hi = -Infinity;
  for (const p of pts) {
    if (Math.abs(p.c14 - age) <= 6 * Math.hypot(err, p.sig) + 300) { lo = Math.min(lo, p.cal); hi = Math.max(hi, p.cal); }
  }
  if (lo === Infinity) return null;
  lo = Math.max(0, lo - 100); hi = Math.min(max, hi + 100);
  const n = hi - lo + 1, pr = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const t = lo + i, s2 = err * err + sg[t] * sg[t], d = age - mu[t];
    pr[i] = Math.exp(-d * d / (2 * s2)) / Math.sqrt(s2); sum += pr[i];
  }
  if (!(sum > 0)) return null;
  // median
  let acc = 0, median = lo;
  for (let i = 0; i < n; i++) { acc += pr[i] / sum; if (acc >= 0.5) { median = lo + i; break; } }
  // 95.4% highest posterior density
  const idx = [...pr.keys()].sort((a, b) => pr[b] - pr[a]);
  const inc = new Uint8Array(n); acc = 0;
  for (const i of idx) { inc[i] = 1; acc += pr[i] / sum; if (acc >= 0.954) break; }
  const ranges = [];
  for (let i = 0; i < n; i++) {
    if (inc[i] && (i === 0 || !inc[i - 1])) ranges.push([lo + i, lo + i]);
    if (inc[i]) ranges[ranges.length - 1][1] = lo + i;
  }
  // merge ranges separated by < 20 years (cosmetic)
  const m = [];
  for (const r of ranges) { if (m.length && r[0] - m[m.length - 1][1] < 20) m[m.length - 1][1] = r[1]; else m.push(r); }
  const big = m.filter(([y, o]) => o - y >= 5);
  const out = big.length ? big : m;   // drop 1–4-year slivers
  return { median, ranges: out, young: out[0][0], old: out[out.length - 1][1] };
}

// ---------- data ----------
const rows = parseCSV(gunzipSync(readFileSync(join(DIR, 'p3k14c.csv.gz'))).toString('utf8'));
const H = rows.shift(); const col = Object.fromEntries(H.map((h, i) => [h, i]));
const toRad = d => d * Math.PI / 180;
function km(lat1, lon1, lat2, lon2) {
  const a = Math.sin(toRad(lat2 - lat1) / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lon2 - lon1) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}
let box, near, R;
if (opt.box) box = String(opt.box).split(',').map(Number);
if (opt.near) { near = String(opt.near).split(',').map(Number); R = Number(opt.km ?? 100); }
const siteQ = opt.site ? String(opt.site).toLowerCase() : null;
const countryQ = opt.country ? String(opt.country).toLowerCase() : null;

// Pre-filter by 14C age: dates far outside the window cannot change the verdict.
const MARGIN = WINDOW + 1500;
const ageLo = CURVES.N.mu[Math.max(0, T - MARGIN)] - 1000, ageHi = CURVES.N.mu[Math.min(CURVES.N.max, T + MARGIN)] + 1000;
const sites = new Map();
for (const r of rows) {
  if (r.length < H.length) continue;
  const lat = +r[col.Lat], lon = +r[col.Long];
  if (box && !(lon >= box[0] && lon <= box[2] && lat >= box[1] && lat <= box[3])) continue;
  if (near && km(lat, lon, near[0], near[1]) > R) continue;
  if (siteQ && !r[col.SiteName].toLowerCase().includes(siteQ)) continue;
  if (countryQ && !r[col.Country].toLowerCase().includes(countryQ)) continue;
  const age = +r[col.Age], err = +r[col.Error];
  if (!(age > 0 && err > 0)) continue;
  if (!opt.all && (age + 4 * err < ageLo || age - 4 * err > ageHi)) continue;
  const c = calibrate(age, err, lat < 0 ? CURVES.S : CURVES.N);
  if (!c) continue;
  const key = (r[col.SiteName] || '?') + '|' + lat.toFixed(2) + '|' + lon.toFixed(2);
  if (!sites.has(key)) sites.set(key, { name: r[col.SiteName] || '?', lat, lon, country: r[col.Country], dates: [], refs: new Set() });
  const s = sites.get(key);
  s.dates.push({ lab: r[col.LabID], age, err, mat: r[col.Material] || r[col.Taxa] || '', period: r[col.Period], ...c });
  if (r[col.Reference] && r[col.Reference] !== 'NA') s.refs.add(r[col.Reference]);
  else if (r[col.Source]) s.refs.add('[' + r[col.Source] + ']');
}

// ---------- verdict ----------
function verdict(s) {
  let on = false, before = Infinity, after = Infinity;   // before = older than T
  for (const d of s.dates) {
    if (d.ranges.some(([y, o]) => y <= T && T <= o)) on = true;
    else if (d.young > T) before = Math.min(before, d.young - T);
    else if (d.old < T) after = Math.min(after, T - d.old);
  }
  const meds = s.dates.map(d => d.median);
  const first = Math.max(...meds), last = Math.min(...meds);
  const edges = [];
  if (first >= T - 250 && first <= T + 250) edges.push('начало');
  if (last >= T - 250 && last <= T + 250) edges.push('конец');
  let v;
  if (on) v = 'на дату';
  else if (before <= 1000 && after <= 1000) v = 'вилка ±1000';
  else v = 'нет';
  return { v, before, after, edges };
}

const fmt = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const rel = n => n === Infinity ? '—' : fmt(n);
// Hazelnut shell ('nutshell', 'hazelnut') is a terrestrial sample, not a marine one (item 3-110)
const marine = m => !/nut|hazel/i.test(m) && /shell|marine|mollus|coquill|concha/i.test(m);

const list = [...sites.values()].map(s => ({ ...s, ...verdict(s) }))
  .filter(s => opt.all || s.dates.some(d => d.old >= T - WINDOW && d.young <= T + WINDOW))
  .sort((a, b) => ({ 'на дату': 0, 'вилка ±1000': 1, 'нет': 2 }[a.v] - { 'на дату': 0, 'вилка ±1000': 1, 'нет': 2 }[b.v]) || b.lat - a.lat);

console.log(`# Радиоуглерод: карта ${year < 0 ? -year + ' г. до н. э.' : year + ' г.'} = ${fmt(T)} кал. л. н.`);
console.log('Отбор: ' + [opt.box && 'прямоугольник ' + opt.box, opt.near && `в ${R} км от ${opt.near}`, siteQ && 'стоянка «' + opt.site + '»', countryQ && 'страна ' + opt.country].filter(Boolean).join(', ') + `; окно показа ±${WINDOW}.`);
console.log(`Источник: p3k14c 2025.07 (Bird et al. 2022, Scientific Data 9:27); калибровка IntCal20 / SHCal20 (южнее экватора), 95 %.`);
console.log(`Стоянок: ${list.length} (на дату: ${list.filter(s => s.v === 'на дату').length}, по вилке: ${list.filter(s => s.v === 'вилка ±1000').length}, нет: ${list.filter(s => s.v === 'нет').length}).\n`);

for (const s of list) {
  const edge = s.edges.length ? ` · **окно ±250: ${s.edges.join(', ')}**` : '';
  console.log(`## ${s.name} (${s.country}) — ${s.lat.toFixed(3)}, ${s.lon.toFixed(3)} — **${s.v}**${edge} · ближайшая до: ${rel(s.before)} л., после: ${rel(s.after)} л.`);
  if (opt.brief) continue;
  const ds = s.dates.filter(d => opt.all || (d.old >= T - WINDOW && d.young <= T + WINDOW)).sort((a, b) => b.median - a.median);
  for (const d of ds) {
    const r = d.ranges.slice().reverse().map(([y, o]) => `${fmt(o)}–${fmt(y)}`).join(', ');
    console.log(`- ${d.lab}: ${fmt(d.age)} ± ${d.err} ¹⁴C → ${r} кал. л. н. (медиана ${fmt(d.median)})${d.mat ? ' · ' + d.mat : ''}${marine(d.mat) ? ' · ⚠ морской/раковина — резервуарный эффект не учтён' : ''}`);
  }
  const hidden = s.dates.length - ds.length;
  if (hidden > 0) console.log(`- (ещё ${hidden} дат вне окна; --all — показать)`);
  if (s.refs.size) console.log(`- Источники: ${[...s.refs].slice(0, 4).join('; ')}${s.refs.size > 4 ? ' …' : ''}`);
  console.log('');
}
