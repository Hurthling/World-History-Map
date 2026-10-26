// =============================================================================
// coast.mjs — builds the land outline for maps where the sea level was
// different from today (ice age maps), e.g. Doggerland, Beringia, Sahul.
//
// How it works:
//   1. Reads a global elevation/depth grid: ETOPO1 at 10 arc-minutes (~18 km),
//      prepared by fatiando-data (GitHub, CC-BY 4.0; ETOPO1 is public domain).
//      Downloaded automatically into tools/.cache/etopo/ if missing.
//   2. Marks the world ocean: all cells below today's sea level that are
//      connected to the open Pacific (flood fill). Closed basins (Caspian, Dead
//      Sea) and seas that are cut off at this grid resolution (Black Sea,
//      Baltic) are NOT lowered — they stay as they are today.
//   3. Ocean cells shallower than the ancient sea level become land.
//      The outline is traced with d3.contours (smooth, interpolated).
//   4. The result is merged with today's detailed land outline (Natural Earth)
//      and saved as data/coast/land_<year>.json (TopoJSON, object "land").
//
// Sea levels per year: corrections/sea-levels.json
// Vanished lakes (e.g. glacial Lake Agassiz on map 8000): "lakes" in the same file,
// outlines in corrections/lakes/ — they are cut out of that year's land like the sea.
// Local sea levels ("local" in the same file, items 3-112 and 113 of map 10 000): the
// 10' grid makes some shallow seas too shallow (Bass Strait, Gulf of Carpentaria), so
// inside a given area (lon/lat polygon) a cell is water if it is deeper than the local
// level instead of the global one. Used to open Bass Strait and the Gulf on map 8000
// and to draw Lake Carpentaria on map 10 000.
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as d3 from 'd3';
import * as topojson from 'topojson-client';
import mapshaper from 'mapshaper';
import h5wasm from 'h5wasm/node';

const GRID_URL = 'https://github.com/fatiando-data/earth-topography-10arcmin/releases/download/v1/earth-topography-10arcmin.nc';

export async function loadGrid(cacheDir) {
  const file = path.join(cacheDir, 'earth-topography-10arcmin.nc');
  if (!fs.existsSync(file)) {
    console.log('Downloading elevation grid ...');
    fs.mkdirSync(cacheDir, { recursive: true });
    execFileSync('curl', ['-sSL', '-o', file, GRID_URL], { stdio: 'inherit' });
  }
  await h5wasm.ready;
  const f = new h5wasm.File(file, 'r');
  const raw = f.get('topography').value;          // rows: latitude -90 → 90
  const nyRaw = f.get('latitude').shape[0];       // 1081
  const nxRaw = f.get('longitude').shape[0];      // 2161 (−180 and +180 both present)
  f.close();
  const nx = nxRaw - 1;                           // drop duplicate +180 column
  const ny = nyRaw;
  const elev = new Float32Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) elev[y * nx + x] = raw[y * nxRaw + x];
  }
  return { elev, nx, ny, step: 1 / 6 };
}

// Cells below 0 m connected to the open ocean (4-neighbour, wraps around in longitude)
export function oceanMask({ elev, nx, ny, step }) {
  const ocean = new Uint8Array(nx * ny);
  const seedX = Math.round((-150 + 180) / step);
  const seedY = Math.round((0 + 90) / step);
  const queue = new Int32Array(nx * ny);
  let head = 0, tail = 0;
  const seed = seedY * nx + seedX;
  ocean[seed] = 1; queue[tail++] = seed;
  while (head < tail) {
    const i = queue[head++];
    const x = i % nx, y = (i - x) / nx;
    const nbrs = [y * nx + ((x + 1) % nx), y * nx + ((x - 1 + nx) % nx)];
    if (y > 0) nbrs.push(i - nx);
    if (y < ny - 1) nbrs.push(i + nx);
    for (const j of nbrs) {
      if (!ocean[j] && elev[j] < 0) { ocean[j] = 1; queue[tail++] = j; }
    }
  }
  return ocean;
}

// Today's land (world-atlas) is "spherical": a few outlines cross the date line
// (Chukotka, Wrangel Island, Fiji, Antarctica) with an edge from +180° to −180°.
// d3 draws that correctly, but mapshaper works on a flat map and reads such an
// edge as a line across the whole world — merging then produced long straight
// bands of land (e.g. along 71°N and 16.5°S). Here such outlines are cut at the
// date line into flat pieces, so every tool sees the same land.
export async function flatLand(landGeoJson) {
  const keep = [], cut = [], holes = [];
  for (const f of landGeoJson.features) {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const poly of polys) {
      const crosses = poly.some(ring => ring.some((p, i) => i && Math.abs(p[0] - ring[i - 1][0]) > 180));
      if (!crosses) { keep.push(poly); continue; }
      // Holes of such an outline (the Caspian Sea inside Eurasia) were lost when the
      // outline was cut at the date line (items 3-89 / 112): keep them aside and cut
      // them out of the land again afterwards
      for (const ring of poly.slice(1)) {
        if (!ring.some((p, i) => i && Math.abs(p[0] - ring[i - 1][0]) > 180)) holes.push([ring]);
      }
      // Unwrap longitudes so that the outline is continuous (may go beyond ±180°)
      const unwrapped = poly.map((ring) => {
        let shift = 0;
        const out = ring.map((p, i) => {
          if (i) {
            const d = p[0] - ring[i - 1][0];
            if (d > 180) shift -= 360; else if (d < -180) shift += 360;
          }
          return [p[0] + shift, p[1]];
        });
        // An outline around a pole (Antarctica) does not close after unwrapping:
        // close it along the pole
        const [first, last] = [out[0], out[out.length - 1]];
        if (Math.abs(last[0] - first[0]) > 1) {
          const pole = out.reduce((s, p) => s + p[1], 0) < 0 ? -90 : 90;
          out.push([last[0], pole], [first[0], pole], first);
        }
        return out;
      });
      const minLon = Math.min(...unwrapped[0].map(p => p[0]));
      const k = minLon < -180 ? 360 : 0;
      cut.push(unwrapped.map(ring => ring.map(([x, y]) => [x + k, y])));
    }
  }
  const features = [{ type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: keep } }];
  if (cut.length) {
    const input = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: cut } }] };
    for (const [bbox, shift] of [['-180,-90,180,90', 0], ['180,-90,540,90', -360]]) {
      const out = await mapshaper.applyCommands(
        `-i in.json -clip bbox=${bbox} ${shift ? `-affine shift=${shift},0` : ''} -o format=geojson geojson-type=FeatureCollection out.json`,
        { 'in.json': input },
      );
      const fc = JSON.parse(Buffer.from(out['out.json']).toString('utf8'));
      features.push(...fc.features.filter(f => f.geometry));
    }
  }
  if (holes.length) {
    const out = await mapshaper.applyCommands(
      '-i in.json -erase holes.json -o format=geojson geojson-type=FeatureCollection out.json',
      {
        'in.json': { type: 'FeatureCollection', features },
        'holes.json': { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: holes } }] },
      },
    );
    const fc = JSON.parse(Buffer.from(out['out.json']).toString('utf8'));
    return { type: 'FeatureCollection', features: fc.features.filter(f => f.geometry) };
  }
  return { type: 'FeatureCollection', features };
}

export async function buildCoasts({ root, levels, lakes = {}, local = {}, landGeoJson, outDir }) {
  const years = Object.keys(levels).map(Number);
  if (!years.length) return {};
  const grid = await loadGrid(path.join(root, 'tools', '.cache', 'etopo'));
  const ocean = oceanMask(grid);
  fs.mkdirSync(outDir, { recursive: true });
  const result = {};

  for (const year of years) {
    const level = levels[String(year)];
    // Field: ocean cells keep their depth; land = +1; closed basins = very deep
    const field = new Float32Array(grid.elev.length);
    for (let i = 0; i < field.length; i++) {
      field[i] = ocean[i] ? grid.elev[i] : (grid.elev[i] >= 0 ? 1 : -10000);
    }
    // Local sea levels: shift the depth so that "deeper than the local level"
    // becomes "deeper than the global level" for the contour below
    for (const area of local[String(year)] || []) {
      const ring = area.area;
      const xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
      const [x0, x1] = [Math.floor((Math.min(...xs) + 180) / grid.step), Math.ceil((Math.max(...xs) + 180) / grid.step)];
      const [y0, y1] = [Math.floor((Math.min(...ys) + 90) / grid.step), Math.ceil((Math.max(...ys) + 90) / grid.step)];
      let cells = 0;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const i = y * grid.nx + x;
        if (!ocean[i] || !d3.polygonContains(ring, [-180 + x * grid.step, -90 + y * grid.step])) continue;
        field[i] = grid.elev[i] + (level - area.level);
        cells++;
      }
      console.log(`  coast ${year}: local sea level ${area.level} m — ${area.name} (${cells} cells)`);
    }
    const [mp] = d3.contours().size([grid.nx, grid.ny]).thresholds([level])(field);
    // Grid pixel coordinates → longitude/latitude (pixel i is centred on node i)
    const toLonLat = ([x, y]) => [
      Math.max(-180, Math.min(180, -180 + (x - 0.5) * grid.step)),
      Math.max(-90, Math.min(90, -90 + (y - 0.5) * grid.step)),
    ];
    const ancient = {
      type: 'Feature',
      properties: {},
      geometry: { type: 'MultiPolygon', coordinates: mp.coordinates.map(poly => poly.map(ring => ring.map(toLonLat))) },
    };

    const tmpAncient = path.join(outDir, `_ancient_${year}.geojson`);
    const tmpModern = path.join(outDir, `_modern.geojson`);
    fs.writeFileSync(tmpAncient, JSON.stringify({ type: 'FeatureCollection', features: [ancient] }));
    fs.writeFileSync(tmpModern, JSON.stringify(landGeoJson));
    const outFile = path.join(outDir, `land_${year}.json`);
    await mapshaper.runCommands([
      `-i "${tmpModern}" "${tmpAncient}" combine-files`,
      `-merge-layers force name=land`,
      `-dissolve2`,
      ...(lakes[year] || []).map(name => `-erase "${path.join(root, 'corrections', 'lakes', name + '.geojson')}"`),
      // One feature per island: "keep-shapes" protects whole features only, so
      // without -explode small islands vanished during simplification
      `-explode`,
      `-simplify 30% keep-shapes`,
      `-o "${outFile}" format=topojson quantization=100000`,
    ].join(' '));
    // Also keep a GeoJSON copy for clipping culture zones during the build
    const topo = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    result[year] = { file: `coast/land_${year}.json`, geojson: topojson.feature(topo, topo.objects.land), level };
    fs.rmSync(tmpAncient); fs.rmSync(tmpModern);
    const kb = Math.round(fs.statSync(outFile).size / 1024);
    console.log(`  coast ${year}: sea level ${level} m → ${kb} KB`);
  }
  return result;
}
