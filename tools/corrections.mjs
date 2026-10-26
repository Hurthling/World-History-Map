// =============================================================================
// corrections.mjs — applies our own fixes (corrections/corrections.json) to
// the source maps before they are simplified.
//
// Why a separate file: the source data comes from another project and can be
// re-downloaded at any time. Keeping our fixes as a list of rules means they
// survive updates, and it is always clear what we changed and why.
//
// Rule format (see corrections/README.md for details):
//   {
//     "id": "short-name",                 unique name of the rule
//     "why": "explanation",               for humans
//     "years": [1994, 2000] | "all",      which maps the rule applies to
//     "action": "set" | "remove" | "add",
//     "where": { ...conditions... },      which shapes it applies to (set/remove)
//     "set": { "NAME": "...", ... }       new values (action "set")
//     "shape": "swiderian",               outline file corrections/shapes/<shape>.geojson (action "add")
//     "properties": { "NAME": "...", ...} properties of the new zone (action "add")
//     "clipToLand": true                  cut the zone to the land of that year (default true)
//     "simplify": "15%"                   simplify the zone after cutting it to the land (share of
//                                         points to keep; for big zones along a detailed coast)
//   }
//
// Conditions in "where" (all must be true):
//   "NAME": "Switzerland"       name equals ("" matches shapes without a name)
//   "containsPoint": [lon, lat] the shape covers this point (longitude first!)
//   "maxAreaKm2": 100           the shape is smaller than this
//   "minAreaKm2": 100           the shape is larger than this
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import mapshaper from 'mapshaper';

const ACTIONS = ['set', 'remove', 'add'];

export function loadCorrections(file) {
  if (!fs.existsSync(file)) return [];
  const rules = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ids = new Set();
  for (const r of rules) {
    if (!r.id || !ACTIONS.includes(r.action)) throw new Error(`Correction without id or with unknown action: ${JSON.stringify(r)}`);
    if (r.action !== 'add' && !r.where) throw new Error(`Correction ${r.id}: "where" is required`);
    if (r.action === 'add' && (!r.shape || !r.properties?.NAME)) throw new Error(`Correction ${r.id}: "shape" and "properties.NAME" are required`);
    if (ids.has(r.id)) throw new Error(`Duplicate correction id: ${r.id}`);
    ids.add(r.id);
  }
  return rules;
}

// Phase 1 — edits of the source map: "set" and "remove" rules (changes it in place).
// Run BEFORE simplification. Returns report lines, e.g. "switzerland-name: 1 changed".
export function applyEdits(geojson, year, rules) {
  const report = [];
  for (const rule of rulesFor(rules, year)) {
    if (rule.action === 'add') continue;
    const matches = geojson.features.filter(f => matchesWhere(f, rule.where));
    if (rule.action === 'set') {
      for (const f of matches) Object.assign(f.properties, rule.set);
    } else {
      geojson.features = geojson.features.filter(f => !matches.includes(f));
    }
    report.push(`${rule.id}: ${matches.length} ${rule.action === 'set' ? 'changed' : 'removed'}`
      + (matches.length ? '' : '   <-- NOTHING MATCHED, check the rule'));
  }
  return report;
}

// Phase 2 — new zones: "add" rules. Run AFTER simplification of the source map,
// so that small hand-drawn zones keep their shape.
// `ctx.shapesDir` — folder with outline files; `ctx.land` — land GeoJSON of this year.
// Returns { features, report }.
export async function buildZones(year, rules, ctx) {
  const features = [];
  const report = [];
  for (const rule of rulesFor(rules, year)) {
    if (rule.action !== 'add') continue;
    const shape = JSON.parse(fs.readFileSync(path.join(ctx.shapesDir, `${rule.shape}.geojson`), 'utf8'));
    const shapeFc = shape.type === 'FeatureCollection' ? shape : { type: 'FeatureCollection', features: [shape.type === 'Feature' ? shape : { type: 'Feature', properties: {}, geometry: shape }] };
    // All pieces of one zone become one outline: pieces that touch or overlap
    // merge (no inner borders); separate pieces stay as parts of one shape
    const merged = await mergePieces(shapeFc);
    let zone = rule.clipToLand === false ? merged : await clipToLand(merged, ctx.land);
    if (rule.simplify) zone = await simplifyZone(zone, rule.simplify);
    const props = { BORDERPRECISION: 1, SUBJECTO: rule.properties.NAME, PARTOF: rule.properties.NAME, ...rule.properties };
    const added = zone.features.filter(f => f.geometry);
    for (const f of added) features.push({ type: 'Feature', properties: { ...props }, geometry: f.geometry });
    report.push(`${rule.id}: ${added.length ? 'added' : 'NOTHING ADDED (zone is outside the land?)'}`);
  }
  return { features, report };
}

function rulesFor(rules, year) {
  return rules.filter(r => r.years === 'all' || r.years.includes(year));
}

async function mergePieces(shapeFc) {
  if (shapeFc.features.length < 2) return shapeFc;
  const out = await mapshaper.applyCommands('-i shape.json -dissolve2 -o format=geojson geojson-type=FeatureCollection out.json', { 'shape.json': shapeFc });
  const text = out['out.json'];
  return JSON.parse(typeof text === 'string' ? text : Buffer.from(text).toString('utf8'));
}

async function simplifyZone(shapeFc, pct) {
  if (!shapeFc.features.length) return shapeFc;
  const out = await mapshaper.applyCommands(`-i shape.json -simplify ${pct} keep-shapes -o format=geojson geojson-type=FeatureCollection out.json`, { 'shape.json': shapeFc });
  const text = out['out.json'];
  return JSON.parse(typeof text === 'string' ? text : Buffer.from(text).toString('utf8'));
}

async function clipToLand(shapeFc, land) {
  const out = await mapshaper.applyCommands(
    '-i shape.json -clip land.json -o format=geojson geojson-type=FeatureCollection out.json',
    { 'shape.json': shapeFc, 'land.json': land },
  );
  const text = out['out.json'];
  return JSON.parse(typeof text === 'string' ? text : Buffer.from(text).toString('utf8'));
}

function matchesWhere(feature, where) {
  const p = feature.properties || {};
  if ('NAME' in where && (p.NAME || '') !== where.NAME) return false;
  const polys = polygonsOf(feature.geometry);
  if (!polys.length) return false;
  if (where.containsPoint) {
    const [x, y] = where.containsPoint;
    if (!polys.some(rings => pointInPolygon(x, y, rings))) return false;
  }
  if (where.maxAreaKm2 != null || where.minAreaKm2 != null) {
    const area = polys.reduce((sum, rings) => sum + areaKm2(rings), 0);
    if (where.maxAreaKm2 != null && area > where.maxAreaKm2) return false;
    if (where.minAreaKm2 != null && area < where.minAreaKm2) return false;
  }
  return true;
}

function polygonsOf(g) {
  if (!g) return [];
  if (g.type === 'Polygon') return [g.coordinates];
  if (g.type === 'MultiPolygon') return g.coordinates;
  return [];
}

// Inside the outer ring and not inside any hole
function pointInPolygon(x, y, rings) {
  return inRing(x, y, rings[0]) && !rings.slice(1).some(h => inRing(x, y, h));
}

function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Approximate area in km² (good enough to tell a sliver from a country)
function areaKm2(rings) {
  const ringArea = (r) => {
    let a = 0;
    let lat = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
      lat += r[i][1];
    }
    lat /= r.length;
    return Math.abs(a / 2) * 111.32 * 111.32 * Math.cos((lat * Math.PI) / 180);
  };
  return ringArea(rings[0]) - rings.slice(1).reduce((s, h) => s + ringArea(h), 0);
}
