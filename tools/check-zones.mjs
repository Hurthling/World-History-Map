// =============================================================================
// check-zones.mjs — compares the zone registry with corrections.json
// (owner decision 15.11; docs/zones-registry.md, CLAUDE.md item 25).
//
// corrections.json is the main data; the registry (corrections/zones.tsv,
// corrections/zone-maps.tsv) is its inventory. This check only warns, it never
// stops the build. Called by build-data.mjs; can also be run alone:
//   node tools/check-zones.mjs
// Checks:
//   - every add-rule on maps -123000 … -6000 has a "zone × map" row
//     (id, map year), and NAME, AREA, GROUP, outline file and card match the rule;
//   - the outline file exists; no row points to a missing rule or year;
//   - every key of zone-maps.tsv is in zones.tsv, keys are unique;
//   - "Карты" in zones.tsv lists the maps of the zone; a zone "стоит" has maps;
//   - "Начало" / "Конец" are numbers (calendar years, BC negative) when filled;
//   - "→ key" in "Предшественник" / "Преемник" names an existing zone.
// To fix: add the new zone to the registry (node tools/zones-registry.mjs
// add-missing, then fill the key and the zone row by hand) or correct the row.
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRules, readTsv, ZONES_FILE, MAPS_FILE, REGISTRY_YEARS } from './zones-registry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function checkZones() {
  const out = [];
  if (!fs.existsSync(ZONES_FILE) || !fs.existsSync(MAPS_FILE)) return ['registry not found (corrections/zones.tsv, corrections/zone-maps.tsv)'];
  const zones = readTsv(ZONES_FILE), maps = readTsv(MAPS_FILE), rules = loadRules();
  const zoneByKey = new Map();
  for (const z of zones) {
    if (zoneByKey.has(z.key)) out.push(`zones.tsv line ${z._line}: key "${z.key}" is repeated`);
    zoneByKey.set(z.key, z);
  }
  const rowByIdYear = new Map(maps.map(m => [`${m['id правила']}|${m['Карта']}`, m]));
  const ruleById = new Map(rules.map(r => [r.id, r]));

  // rules → rows
  for (const r of rules) for (const y of r.years.filter(y => REGISTRY_YEARS.includes(y))) {
    const m = rowByIdYear.get(`${r.id}|${y}`);
    if (!m) { out.push(`${r.id} (${y}): no row in zone-maps.tsv — run "node tools/zones-registry.mjs add-missing"`); continue; }
    const p = r.properties, where = `zone-maps.tsv line ${m._line} (${r.id}, ${y})`;
    if (m.NAME !== p.NAME) out.push(`${where}: NAME "${m.NAME}" ≠ rule "${p.NAME}"`);
    if (m.AREA !== (p.AREA || '')) out.push(`${where}: AREA "${m.AREA}" ≠ rule "${p.AREA || ''}"`);
    if (m.GROUP !== (p.GROUP || '')) out.push(`${where}: GROUP "${m.GROUP}" ≠ rule "${p.GROUP || ''}"`);
    if (m['Файл контура'] !== `shapes/${r.shape}.geojson`) out.push(`${where}: outline "${m['Файл контура']}" ≠ rule "shapes/${r.shape}.geojson"`);
    if (m['Карточка'] !== (p.NOTE || '')) out.push(`${where}: card "${m['Карточка']}" ≠ rule "${p.NOTE || ''}"`);
  }
  // rows → rules, zones
  const mapsOfKey = new Map();
  for (const m of maps) {
    const r = ruleById.get(m['id правила']);
    if (!r || !r.years.includes(Number(m['Карта']))) out.push(`zone-maps.tsv line ${m._line}: rule ${m['id правила']} on map ${m['Карта']} not found in corrections.json`);
    const f = path.join(ROOT, 'corrections', m['Файл контура']);
    if (m['Файл контура'] && !fs.existsSync(f)) out.push(`zone-maps.tsv line ${m._line}: outline file ${m['Файл контура']} not found`);
    if (!m.key) { out.push(`zone-maps.tsv line ${m._line} (${m['id правила']}): key is empty`); continue; }
    if (!zoneByKey.has(m.key)) out.push(`zone-maps.tsv line ${m._line}: key "${m.key}" is not in zones.tsv`);
    if (!mapsOfKey.has(m.key)) mapsOfKey.set(m.key, new Set());
    mapsOfKey.get(m.key).add(Number(m['Карта']));
  }
  // zones
  const num = v => v === '' || /^-?\d+$/.test(v.trim());
  for (const z of zones) {
    const where = `zones.tsv line ${z._line} (${z.key})`;
    const actual = [...(mapsOfKey.get(z.key) || [])].sort((a, b) => a - b).join(', ');
    const listed = z['Карты'].split(',').map(s => s.trim()).filter(Boolean).map(Number).sort((a, b) => a - b).join(', ');
    if (actual !== listed) out.push(`${where}: "Карты" = "${z['Карты']}", in zone-maps.tsv — "${actual}"`);
    if (z['Статус'] === 'стоит' && !actual) out.push(`${where}: status "стоит" but no map rows`);
    if (!num(z['Начало'])) out.push(`${where}: "Начало" is not a year: "${z['Начало']}"`);
    if (!num(z['Конец'])) out.push(`${where}: "Конец" is not a year: "${z['Конец']}"`);
    if (z['Начало'] && z['Конец'] && Number(z['Начало']) > Number(z['Конец'])) out.push(`${where}: "Начало" is later than "Конец"`);
    for (const f of ['Предшественник', 'Преемник'])
      for (const m of z[f].matchAll(/→\s*([a-z0-9][a-z0-9-]*[a-z0-9])\b/g))
        if (!zoneByKey.has(m[1])) out.push(`${where}: "${f}" names "${m[1]}", no such zone`);
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const lines = checkZones();
  for (const l of lines) console.log(`  registry ${l}`);
  console.log(lines.length ? `${lines.length} warning(s)` : 'registry matches corrections.json');
}
