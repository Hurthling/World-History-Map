// =============================================================================
// overlaps.mjs — finds places where two of our zones overlap (map 1: species
// and cultures) and cuts them out as separate shapes.
//
// Used only for "probability" maps (corrections/reviewed.json → "probability").
// A zone takes part if it has SPECIES (and optionally CULTURE). Two zones make
// an overlap if their species differ, or the species is the same but the
// cultures differ. The overlap is drawn on top of both zones with vertical
// stripes of the two colours (src/map.js); a click on it shows both zones.
//
// Overlap shape properties:
//   KIND    "overlap"
//   NAME    "Neanderthals + Denisovans" (two species) or the common species name
//   AREA    (same species only) "Culture A + Culture B"
//   PARTS   selection keys of the two zones, "NAME::AREA | NAME::AREA"
//   SPECIES "a|b",  CULTURE "a|b"  (used for the stripe colours)
// Tiny slivers (shared borders, rounding) are ignored: MIN_AREA_KM2.
// =============================================================================

import mapshaper from 'mapshaper';

const MIN_AREA_KM2 = 500;

export async function buildOverlaps(zoneFeatures) {
  const zones = zoneFeatures.filter(f => f.properties?.SPECIES && f.geometry);
  const features = [];
  const report = [];
  for (let i = 0; i < zones.length; i++) {
    for (let j = i + 1; j < zones.length; j++) {
      const a = zones[i].properties;
      const b = zones[j].properties;
      const sameSpecies = a.SPECIES === b.SPECIES;
      if (sameSpecies && (a.CULTURE || '') === (b.CULTURE || '')) continue;
      if (!bboxesTouch(bbox(zones[i].geometry), bbox(zones[j].geometry))) continue;
      const geometry = await intersect(zones[i], zones[j]);
      if (!geometry) continue;
      const area = polygonsOf(geometry).reduce((s, rings) => s + areaKm2(rings), 0);
      if (area < MIN_AREA_KM2) continue;
      const name = sameSpecies ? a.NAME : `${a.NAME} + ${b.NAME}`;
      features.push({
        type: 'Feature',
        geometry,
        properties: {
          NAME: name,
          AREA: sameSpecies ? `${a.AREA} + ${b.AREA}` : null,
          SUBJECTO: name,
          PARTOF: name,
          BORDERPRECISION: 1,
          KIND: 'overlap',
          PARTS: `${key(a)} | ${key(b)}`,
          SPECIES: `${a.SPECIES}|${b.SPECIES}`,
          CULTURE: `${a.CULTURE || ''}|${b.CULTURE || ''}`,
        },
      });
      report.push(`overlap: ${key(a)}  ×  ${key(b)}  ≈ ${Math.round(area / 1000)} thousand km²`);
    }
  }
  return { features, report };
}

function key(p) {
  return p.AREA ? `${p.NAME}::${p.AREA}` : p.NAME;
}

async function intersect(fa, fb) {
  const fc = (f) => ({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: f.geometry }] });
  const out = await mapshaper.applyCommands(
    '-i a.json -clip b.json -dissolve2 -o format=geojson geojson-type=FeatureCollection out.json',
    { 'a.json': fc(fa), 'b.json': fc(fb) },
  );
  const text = out['out.json'];
  const res = JSON.parse(typeof text === 'string' ? text : Buffer.from(text).toString('utf8'));
  return res.features.find(f => f.geometry)?.geometry || null;
}

function polygonsOf(g) {
  if (!g) return [];
  if (g.type === 'Polygon') return [g.coordinates];
  if (g.type === 'MultiPolygon') return g.coordinates;
  return [];
}

function bbox(g) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const rings of polygonsOf(g)) for (const [x, y] of rings[0]) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

function bboxesTouch(a, b) {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

// Approximate area in km² (planar, good enough to drop slivers)
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
