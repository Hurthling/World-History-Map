// =============================================================================
// check-anchors.mjs — are the sites that hold a zone's outline still alive at
// the map date? (item С-13, point 11)
//
//   node tools/check-anchors.mjs --year -5000 [--keys a,b,c] [--km 25]
//
// For every zone of that map in corrections/zone-maps.tsv the coordinates are
// taken from the "Контур" column of all rows of the zone, and the p3k14c dates
// within --km of each point are asked from c14.mjs. A point is reported as
//   "кончился"    — every date there is older than the map date: the part of the
//                   outline it holds may not live to this map (check by hand);
//   "нет в базе"  — the base has nothing there (see the queue record / opis);
//   "держит"      — dates on the map date or younger ones.
// It only reports; it changes nothing. Regional base points and sites missing
// from the base give false alarms — read the sources before shrinking a zone.
// =============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map(s => { const [k, ...v] = s.trim().split(' '); return [k, v.join(' ')]; }));
if (!args.year) { console.log('Usage: node tools/check-anchors.mjs --year -5000 [--keys a,b] [--km 25]'); process.exit(1); }
const R = Number(args.km || 25);
const tsv = fs.readFileSync(path.join(ROOT, 'corrections/zone-maps.tsv'), 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean).map(l => l.split('\t'));
const H = tsv.shift(); const I = Object.fromEntries(H.map((h, i) => [h, i]));
let keys = [...new Set(tsv.filter(r => r[I['Карта']] === String(args.year)).map(r => r[I.key]))];
if (args.keys) keys = args.keys.split(',');

const NUM = '[−-]?\\d{1,3}[.,]\\d+';
const PAIR = new RegExp(`(${NUM})(?:\\s*[;/]\\s*|,\\s+)(${NUM})`, 'g');
const num = s => Number(s.replace('−', '-').replace(',', '.'));
const km = (a, b, c, d) => { const r = Math.PI / 180; const h = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2; return 12742 * Math.asin(Math.sqrt(h)); };

const noCoords = []; let ended = 0, empty = 0, held = 0;
for (const key of keys) {
  const rows = tsv.filter(r => r[I.key] === key);
  const pts = [];
  for (const r of rows) for (const m of (r[I['Контур']] || '').matchAll(PAIR)) {
    const lat = num(m[1]), lon = num(m[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !pts.some(p => km(p[0], p[1], lat, lon) < 5)) pts.push([lat, lon]);
  }
  if (!pts.length) { noCoords.push(key); continue; }
  const d = R / 100;
  const lats = pts.map(p => p[0]), lons = pts.map(p => p[1]);
  const dl = d / Math.max(0.2, Math.cos(Math.max(...lats.map(Math.abs)) * Math.PI / 180));
  const box = [Math.min(...lons) - dl, Math.min(...lats) - d, Math.max(...lons) + dl, Math.max(...lats) + d].map(x => x.toFixed(3)).join(',');
  const out = execFileSync('node', [path.join(ROOT, 'tools/c14.mjs'), '--year', args.year, '--box', box, '--all', '--brief'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const sites = [...out.matchAll(/^## (.+?) \([^()]*\) — (-?[\d.]+), (-?[\d.]+) — \*\*(.+?)\*\*.*?после: ([\d —]+) ?л?\.?/gm)]
    .map(m => ({ name: m[1], lat: +m[2], lon: +m[3], v: m[4], after: m[5].trim() }));
  const lines = [];
  for (const [lat, lon] of pts) {
    const near = sites.filter(s => km(lat, lon, s.lat, s.lon) <= R);
    if (!near.length) { empty++; lines.push(`  нет в базе: ${lat}, ${lon}`); }
    else if (near.some(s => s.v !== 'нет' || !s.after.startsWith('—'))) held++;
    else { ended++; lines.push(`  КОНЧИЛСЯ:  ${lat}, ${lon} — ${near.map(s => s.name).slice(0, 5).join('; ')}`); }
  }
  if (lines.length) console.log(`${key} (точек ${pts.length})\n${lines.join('\n')}`);
}
console.log(`\nЗон: ${keys.length}; точек: держат ${held}, кончились ${ended}, нет в базе ${empty}.`);
console.log(`Без координат в записи «Контур» (край смотреть в чате), ${noCoords.length}: ${noCoords.join(', ') || '—'}`);
