// =============================================================================
// check-colors.mjs — warns about culture zones that are hard to tell apart.
//
// Called by build-data.mjs for maps reviewed against dated finds
// (corrections/reviewed.json → "years"). For every pair of named zones
// (one entry per colour key: GROUP, else SUBJECTO, else NAME) it reports:
//   - "same"    — the same palette colour closer than SAME_KM (2000 km);
//   - "similar" — different colours that look alike (OKLab difference < MIN_DIFF,
//                 light theme) closer than NEAR_KM.
// If the map is reviewed only in part, only zones inside the reviewed part count.
// Colours: src/styles.css (--polity-N), index: src/colors.js (paletteIndex).
// To fix a warning, give one of the zones another colour in corrections/colors.json.
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as topojson from 'topojson-client';
import { paletteIndex } from '../src/colors.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NEAR_KM = 1500;
const SAME_KM = 2000; // owner 27.10, item 3-188: same colour within 1500–2000 km is still easy to link by eye
const MIN_DIFF = 10;

// Light-theme palette, read from styles.css (the first definition of each --polity-N)
function readPalette() {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  const pal = [];
  for (const m of css.matchAll(/--polity-(\d+):\s*(#[0-9a-fA-F]{6})/g)) if (pal[m[1]] == null) pal[m[1]] = m[2];
  return pal;
}

function oklab(hex) {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const [r, g, b] = c;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
export function colorDiff(a, b) {
  const p = oklab(a), q = oklab(b);
  return 100 * Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

function km(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dlat = (b[1] - a[1]) * rad, dlon = (b[0] - a[0]) * rad;
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dlon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function rings(g) {
  if (!g) return [];
  if (g.type === 'Polygon') return [g.coordinates[0]];
  if (g.type === 'MultiPolygon') return g.coordinates.map(p => p[0]);
  return [];
}

function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// topo: TopoJSON of a map (object "borders"); area: TopoJSON of the reviewed part or null
export function checkColors(topo, area) {
  const pal = readPalette();
  const areaRings = area ? Object.values(area.objects).flatMap(o => topojson.feature(area, o).features ?? [topojson.feature(area, o)]).flatMap(f => rings(f.geometry)) : null;
  const zones = new Map();
  for (const f of topojson.feature(topo, topo.objects.borders).features) {
    const p = f.properties || {};
    if (!p.NAME || p.KIND || p.SPECIES) continue;
    const idx = paletteIndex(p);
    if (idx == null) continue;
    const key = p.COLOR != null ? `${p.GROUP || p.NAME}` : (p.GROUP || p.SUBJECTO || p.NAME);
    const pts = rings(f.geometry).flat();
    if (!pts.length) continue;
    if (areaRings) {
      const c = pts[Math.floor(pts.length / 2)];
      const mid = pts.reduce((s, q) => [s[0] + q[0] / pts.length, s[1] + q[1] / pts.length], [0, 0]);
      if (!areaRings.some(r => inRing(mid[0], mid[1], r) || inRing(c[0], c[1], r))) continue;
    }
    const z = zones.get(key) || { key, idx, pts: [] };
    z.pts.push(...pts);
    zones.set(key, z);
  }
  // Thin out the outline points (enough to estimate distances between zones)
  const list = [...zones.values()].map(z => ({ ...z, pts: z.pts.filter((_, i) => i % Math.max(1, Math.floor(z.pts.length / 80)) === 0) }));
  const out = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      const diff = a.idx === b.idx ? 0 : colorDiff(pal[a.idx], pal[b.idx]);
      if (diff >= MIN_DIFF) continue;
      const limit = a.idx === b.idx ? SAME_KM : NEAR_KM;
      let d = Infinity;
      for (const p of a.pts) { for (const q of b.pts) { const x = km(p, q); if (x < d) d = x; } if (d < 1) break; }
      if (d > limit) continue;
      out.push(a.idx === b.idx
        ? `same colour ${a.idx}: "${a.key}" — "${b.key}", ${Math.round(d)} km`
        : `similar colours ${a.idx}/${b.idx} (difference ${diff.toFixed(1)}): "${a.key}" — "${b.key}", ${Math.round(d)} km`);
    }
  }
  return out;
}
