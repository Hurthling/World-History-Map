// =============================================================================
// zones-registry.mjs — the zone registry: an inventory of our zones
// (owner decision 15.11; plan — docs/zones-registry.md, CLAUDE.md item 25).
//
// Two tables (TSV, UTF-8, open in Excel):
//   corrections/zones.tsv      — one row per zone: years of existence, predecessor,
//                                successor, status ("Зоны");
//   corrections/zone-maps.tsv  — one row per zone × map: rule id, name, area,
//                                outline, source of the area ("Зона на карте").
// The main data stays corrections/corrections.json; the registry describes it,
// and tools/check-zones.mjs compares the two at build time (warnings only).
//
// Usage:
//   node tools/zones-registry.mjs init [--out DIR]
//       build the first draft of both tables from corrections.json
//       (refuses to overwrite existing tables; --out writes elsewhere).
//   node tools/zones-registry.mjs add-missing
//       append "zone × map" rows for add-rules that are not in the registry yet
//       (key left empty when no zone with that NAME/AREA exists — fill it by hand).
//
// Linking one zone across maps (init): rules of different years are the same
// zone when they share NAME and AREA, or are linked by the outline file, by the
// rule id (m8-xxx → m6-xxx) or by a rule id named in "why" ("carried from map
// 8000 (m8-xxx)") and have the same NAME and AREA. If the names
// differ, the rules stay separate zones and the pair is reported as
// "disputed" — the owner decides (renamed zone or successor culture).
// Map 1 (-123000) is never linked to other maps.
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORR = path.join(ROOT, 'corrections');
export const ZONES_FILE = path.join(CORR, 'zones.tsv');
export const MAPS_FILE = path.join(CORR, 'zone-maps.tsv');
export const REGISTRY_YEARS = [-123000, -10000, -8000, -6000, -5000];

export const ZONE_COLS = ['key', 'Название', 'Русское', 'Тип', 'Начало', 'Начало — надёжность', 'Конец', 'Конец — надёжность',
  'Источник дат', 'Предшественник', 'Преемник', 'Статус', 'Карты', 'Пункты', 'Примечание'];
export const MAP_COLS = ['key', 'Карта', 'id правила', 'NAME', 'Русское', 'AREA', 'GROUP', 'Ареал', 'Контур', 'Файл контура',
  'Источник ареала', 'Карточка', 'Пункты'];

// ---- TSV helpers (no quoting: tabs and line breaks inside a value are replaced) ----
const clean = v => String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim();
export function writeTsv(file, cols, rows) {
  const lines = [cols.join('\t'), ...rows.map(r => cols.map(c => clean(r[c])).join('\t'))];
  fs.writeFileSync(file, '﻿' + lines.join('\r\n') + '\r\n'); // BOM + CRLF: Excel opens UTF-8 correctly
}
export function readTsv(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const lines = text.split(/\r?\n/).filter(l => l.length);
  const cols = lines[0].split('\t');
  return lines.slice(1).map((l, i) => {
    const v = l.split('\t'), row = { _line: i + 2 };
    cols.forEach((c, j) => { row[c] = v[j] ?? ''; });
    return row;
  });
}

export function loadRules() {
  const rules = JSON.parse(fs.readFileSync(path.join(CORR, 'corrections.json'), 'utf8'));
  return rules.filter(r => r.action === 'add' && r.years.some(y => REGISTRY_YEARS.includes(y)));
}
function loadRu() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'translations', 'names', 'ru.json'), 'utf8')); } catch { return {}; }
}

// Queue item numbers mentioned in "why": 3-115, 6-166, 1-24, and bare numbers of map 10 000 ("item 26" → "п. 26")
export function itemsOf(why) {
  const out = [];
  for (const m of why.matchAll(/\b([136]-\d+)\b/g)) out.push(m[1]);
  for (const m of why.matchAll(/\bitems?\s+((?:(?:\d-)?\d+(?:\s*\([^)]*\))?\s*(?:,|and|…|\.\.\.)?\s*)+)/g)) {
    const list = m[1].replace(/\([^)]*\)/g, ' ');
    for (const n of list.matchAll(/(?<![\d-])(\d{1,3})(?![\d-])/g)) out.push(`п. ${n[1]}`);
  }
  return [...new Set(out)];
}

const slug = id => id.replace(/^m\d*[a-z]?-/, '');
const sameName = (a, b) => a.properties.NAME === b.properties.NAME && (a.properties.AREA || '') === (b.properties.AREA || '');

function zoneType(r) {
  const p = r.properties;
  if (r.years.includes(-123000)) return p.KIND === 'uninhabited' ? 'Не заселено' : 'ареал вида';
  if (/ice sheet/i.test(p.NAME)) return 'ледник';
  if (p.KIND === 'uninhabited' || /^Uninhabited/.test(p.NAME)) return 'Не заселено';
  if (p.AREA) return 'область группы';
  return 'культура';
}

function mapRow(r, year, key, ru) {
  const p = r.properties;
  const rus = [ru[p.NAME], p.AREA ? ru[p.AREA] : ''].filter(Boolean).join(' — ');
  return {
    key, 'Карта': year, 'id правила': r.id, NAME: p.NAME, 'Русское': rus, AREA: p.AREA || '', GROUP: p.GROUP || '',
    'Файл контура': `shapes/${r.shape}.geojson`, 'Карточка': p.NOTE || '', 'Пункты': itemsOf(r.why).join(', '),
  };
}

// ---- init: first draft of both tables ----
function init(outDir) {
  const zf = path.join(outDir, 'zones.tsv'), mf = path.join(outDir, 'zone-maps.tsv');
  if (fs.existsSync(zf) || fs.existsSync(mf)) {
    console.error(`${zf} or ${mf} already exists — init does not overwrite. Use add-missing.`);
    process.exit(1);
  }
  const rules = loadRules(), ru = loadRu();
  const byId = new Map(rules.map(r => [r.id, r]));
  const parent = new Map(rules.map(r => [r.id, r.id]));
  const find = x => (parent.get(x) === x ? x : find(parent.get(x)));
  const union = (a, b) => parent.set(find(a), find(b));
  const disputed = [];
  const isMap1 = r => r.years.includes(-123000);
  const disjoint = (a, b) => !a.years.some(y => b.years.includes(y));

  // candidate links between rules of different years
  const cand = [];
  const byShape = new Map();
  for (const r of rules) { if (!byShape.has(r.shape)) byShape.set(r.shape, []); byShape.get(r.shape).push(r); }
  for (const list of byShape.values())
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) cand.push([list[i], list[j], 'контур']);
  for (const r of rules)
    for (const m of r.why.matchAll(/\b(m\d*[a-z]?-[a-z0-9-]+[a-z0-9])/g))
      if (byId.has(m[1]) && m[1] !== r.id) cand.push([r, byId.get(m[1]), 'перенос']);
  const bySlug = new Map(); // m2d-yenisei, m8-yenisei, m6-yenisei — one lineage of rules
  for (const r of rules) { const k = slug(r.id); if (!bySlug.has(k)) bySlug.set(k, []); bySlug.get(k).push(r); }
  for (const list of bySlug.values())
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) cand.push([list[i], list[j], 'id правила']);
  const byName = new Map();
  for (const r of rules) {
    const k = `${r.properties.NAME}::${r.properties.AREA || ''}`;
    if (!byName.has(k)) byName.set(k, []); byName.get(k).push(r);
  }
  for (const list of byName.values())
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) cand.push([list[i], list[j], 'имя']);

  const seen = new Set();
  for (const [a, b, how] of cand) {
    if (isMap1(a) || isMap1(b)) continue;
    // same NAME and AREA: one zone, also on the same map (several outline pieces of one culture)
    if (sameName(a, b)) { union(a.id, b.id); continue; }
    if (!disjoint(a, b)) continue;
    const k = [a.id, b.id].sort().join('|');
    if (!seen.has(k)) { seen.add(k); disputed.push({ a, b, how }); }
  }

  // clusters → keys (slug of the earliest rule; unique)
  const clusters = new Map();
  for (const r of rules) { const c = find(r.id); if (!clusters.has(c)) clusters.set(c, []); clusters.get(c).push(r); }
  const keyOf = new Map(), used = new Set();
  const minYear = r => Math.min(...r.years);
  for (const list of clusters.values()) {
    list.sort((x, y) => minYear(x) - minYear(y) || x.id.localeCompare(y.id));
    let k = slug(list[0].id);
    if (used.has(k)) k = isMap1(list[0]) ? `${k}-123k` : `${k}-2`;
    while (used.has(k)) k += 'x';
    used.add(k);
    for (const r of list) keyOf.set(r.id, k);
  }

  // rows
  const mapRows = [], zoneRows = [];
  for (const r of rules) for (const y of [...r.years].filter(y => REGISTRY_YEARS.includes(y)).sort((a, b) => a - b))
    mapRows.push(mapRow(r, y, keyOf.get(r.id), ru));
  mapRows.sort((a, b) => a.key.localeCompare(b.key) || a['Карта'] - b['Карта']);
  for (const list of clusters.values()) {
    const latest = list[list.length - 1], p = latest.properties;
    const names = [...new Set(list.map(r => r.properties.AREA ? `${r.properties.NAME} — ${r.properties.AREA}` : r.properties.NAME))];
    const years = [...new Set(list.flatMap(r => r.years))].filter(y => REGISTRY_YEARS.includes(y)).sort((a, b) => a - b);
    zoneRows.push({
      key: keyOf.get(latest.id), 'Название': names.reverse().join('; '),
      'Русское': [loadRu()[p.NAME], p.AREA ? loadRu()[p.AREA] : ''].filter(Boolean).join(' — '),
      'Тип': zoneType(latest), 'Статус': 'стоит', 'Карты': years.join(', '),
      'Пункты': [...new Set(list.flatMap(r => itemsOf(r.why)))].join(', '),
    });
  }
  zoneRows.sort((a, b) => a.key.localeCompare(b.key));
  writeTsv(zf, ZONE_COLS, zoneRows);
  writeTsv(mf, MAP_COLS, mapRows);
  const dis = disputed.map(({ a, b, how }) =>
    `${keyOf.get(a.id)}\t${a.years.join(',')}\t${a.properties.NAME}${a.properties.AREA ? ' — ' + a.properties.AREA : ''}\t` +
    `${keyOf.get(b.id)}\t${b.years.join(',')}\t${b.properties.NAME}${b.properties.AREA ? ' — ' + b.properties.AREA : ''}\t${how}`);
  fs.writeFileSync(path.join(outDir, 'zones-disputed.tsv'), '﻿' + ['key A\tкарты A\tимя A\tkey B\tкарты B\tимя B\tсвязь', ...dis].join('\r\n') + '\r\n');
  console.log(`zones: ${zoneRows.length}, zone × map: ${mapRows.length}, disputed links: ${disputed.length} (zones-disputed.tsv)`);
}

// ---- add-missing: append rows for rules not yet in the registry ----
function addMissing() {
  const rules = loadRules(), ru = loadRu();
  const maps = readTsv(MAPS_FILE);
  const have = new Set(maps.map(m => `${m['id правила']}|${m['Карта']}`));
  const keyByName = new Map(maps.filter(m => m.key).map(m => [`${m.NAME}::${m.AREA}`, m.key]));
  const added = [];
  for (const r of rules) for (const y of r.years.filter(y => REGISTRY_YEARS.includes(y))) {
    if (have.has(`${r.id}|${y}`)) continue;
    added.push(mapRow(r, y, keyByName.get(`${r.properties.NAME}::${r.properties.AREA || ''}`) || '', ru));
  }
  if (!added.length) { console.log('registry is complete — nothing to add'); return; }
  const all = [...maps, ...added];
  writeTsv(MAPS_FILE, MAP_COLS, all);
  for (const a of added) console.log(`added: ${a['id правила']} ${a['Карта']} → key ${a.key || '(empty — fill in, and add the zone to zones.tsv)'}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'init') init(rest[0] === '--out' ? path.resolve(rest[1]) : CORR);
  else if (cmd === 'add-missing') addMissing();
  else { console.log('usage: node tools/zones-registry.mjs init [--out DIR] | add-missing'); process.exit(1); }
}
