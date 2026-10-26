// =============================================================================
// hydro.mjs — rivers and lakes for every map.
//
// What it does:
//   1. Takes today's rivers and lakes from Natural Earth (public domain,
//      1:50 million scale; downloaded into tools/.cache/natural-earth/).
//      Each river and lake keeps one field: r = "scalerank" (1 = largest).
//      The page shows small rivers only when zoomed in.
//      Result: data/hydro.json (TopoJSON, objects "rivers" and "lakes").
//      Ranks are adjusted so that a visible tributary never flows into a hidden
//      river or lake (promoteRanks).
//   2. For maps with a lower sea level (corrections/sea-levels.json) rivers
//      that end at today's coast would stop in the middle of dry land. They are
//      extended over the exposed sea floor down to the ancient sea: from the
//      mouth (first through today's estuary, if it is too narrow for the grid)
//      we follow the elevation grid (ETOPO1, see coast.mjs) step by step to the
//      lowest neighbouring cell, as water would flow; delta branches join the
//      channel already drawn; the line is cut exactly at the drawn ancient coast.
//      The line is a reasonable guess, not a known river bed.
//      Result: data/coast/rivers_ext_<year>.json (TopoJSON, object "riversExt").
//
// Rivers and lakes are modern on all maps; the page says so under the year.
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import mapshaper from 'mapshaper';
import * as topojson from 'topojson-client';
import { loadGrid, oceanMask, flatLand } from './coast.mjs';

const NE_BASE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/';
const RIVERS = 'ne_50m_rivers_lake_centerlines';
const LAKES = 'ne_50m_lakes';

function ensureFile(cacheDir, name) {
  const file = path.join(cacheDir, `${name}.geojson`);
  if (!fs.existsSync(file)) {
    console.log(`Downloading ${name} ...`);
    fs.mkdirSync(cacheDir, { recursive: true });
    execFileSync('curl', ['-sSL', '-o', file, `${NE_BASE}${name}.geojson`], { stdio: 'inherit' });
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Keep only geometry and the size rank
function slim(fc) {
  return {
    type: 'FeatureCollection',
    features: fc.features
      .filter(f => f.geometry)
      .map(f => ({ type: 'Feature', properties: { r: Number(f.properties.scalerank) || 6 }, geometry: f.geometry })),
  };
}

export async function buildHydro({ root, levels, outDataDir, coastDir }) {
  const cacheDir = path.join(root, 'tools', '.cache', 'natural-earth');
  const rivers = slim(ensureFile(cacheDir, RIVERS));
  const lakes = slim(ensureFile(cacheDir, LAKES));
  const grid = await loadGrid(path.join(root, 'tools', '.cache', 'etopo'));
  const promoted = promoteRanks(rivers, lakes, grid);
  console.log(`  rivers & lakes: ${promoted.rivers} rivers and ${promoted.lakes} lakes shown earlier, so that no visible river ends in nothing`);

  // --- 1. Modern rivers and lakes -------------------------------------------
  const outFile = path.join(outDataDir, 'hydro.json');
  const out = await mapshaper.applyCommands(
    '-i rivers.json name=rivers -simplify 40% keep-shapes ' +
    '-i lakes.json name=lakes -simplify 40% keep-shapes ' +
    '-o target=rivers,lakes format=topojson quantization=100000 hydro.json',
    { 'rivers.json': rivers, 'lakes.json': lakes },
  );
  fs.writeFileSync(outFile, out['hydro.json']);
  console.log(`  rivers & lakes: ${rivers.features.length} rivers, ${lakes.features.length} lakes → ${Math.round(fs.statSync(outFile).size / 1024)} KB`);

  // --- 2. Extensions over the exposed shelf ----------------------------------
  const result = {};
  const years = Object.keys(levels).map(Number);
  if (!years.length) return result;
  const ocean = oceanMask(grid);
  const atCoast = coastTest(root, 6);
  for (const year of years) {
    const level = levels[String(year)];
    const drawnTopo = JSON.parse(fs.readFileSync(path.join(coastDir, `land_${year}.json`), 'utf8'));
    const water = waterRouter(await flatLand(modernLand(root)), topojson.feature(drawnTopo, drawnTopo.objects.land));
    const features = extendRivers(rivers, grid, ocean, level, atCoast, water);
    const file = path.join(coastDir, `rivers_ext_${year}.json`);
    // Cut the lines exactly at the drawn ancient coast (land_<year>.json)
    const res = await mapshaper.applyCommands(
      `-i ext.json name=riversExt -clip "${path.join(coastDir, `land_${year}.json`)}" -filter-fields r ` +
      '-o format=topojson quantization=100000 out.json',
      { 'ext.json': { type: 'FeatureCollection', features } },
    );
    fs.writeFileSync(file, res['out.json']);
    result[year] = `coast/rivers_ext_${year}.json`;
    console.log(`  rivers ${year}: ${features.length} extended over the shelf (sea level ${level} m)`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// The page shows small rivers only when zoomed in (field r, CONFIG.rivers).
// If a tributary is shown but the river or lake it flows into is not, the
// tributary seems to end in nothing. So the river (lake) downstream gets at
// least the rank of the tributary: r(main) <= r(tributary), r(lake) <= r(river) + 1.
// A river end that touches the middle of another river is a mouth; when two
// rivers touch end to end, the one whose far end is lower lies downstream.
function promoteRanks(rivers, lakes, grid) {
  const TOL_KM = 4;
  const elevAt = ([lon, lat]) => {
    const x = ((Math.round((lon + 180) / grid.step) % grid.nx) + grid.nx) % grid.nx;
    const y = Math.min(grid.ny - 1, Math.max(0, Math.round((lat + 90) / grid.step)));
    return grid.elev[y * grid.nx + x];
  };
  const partsOf = (g) => (g.type === 'MultiLineString' ? g.coordinates : g.type === 'LineString' ? [g.coordinates] : []);
  const ringsOf = (g) => (g.type === 'Polygon' ? g.coordinates : g.type === 'MultiPolygon' ? g.coordinates.flat() : []);
  const segIndex = (items) => {                  // 1° cell → segments
    const map = new Map();
    for (const it of items) for (const line of it.lines) for (let i = 1; i < line.length; i++) {
      const [a, b] = [line[i - 1], line[i]];
      const k = `${Math.floor((a[0] + b[0]) / 2)},${Math.floor((a[1] + b[1]) / 2)}`;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push({ a, b, it, line, i });
    }
    return map;
  };
  const touching = (index, [lon, lat]) => {
    const kx = Math.cos((lat * Math.PI) / 180) * 111.32, ky = 110.57, hits = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const s of index.get(`${Math.floor(lon) + dx},${Math.floor(lat) + dy}`) || []) {
        const ax = (s.a[0] - lon) * kx, ay = (s.a[1] - lat) * ky, bx = (s.b[0] - lon) * kx, by = (s.b[1] - lat) * ky;
        const vx = bx - ax, vy = by - ay;
        const u = Math.max(0, Math.min(1, -(ax * vx + ay * vy) / ((vx * vx + vy * vy) || 1)));
        if (Math.hypot(ax + u * vx, ay + u * vy) < TOL_KM) hits.push({ ...s, u });
      }
    }
    return hits;
  };
  const rItems = rivers.features.map(f => ({ f, lines: partsOf(f.geometry) }));
  const lItems = lakes.features.map(f => ({ f, lines: ringsOf(f.geometry) }));
  const rIndex = segIndex(rItems), lIndex = segIndex(lItems);

  // Downstream links: [from item, to item]
  const links = [];
  for (const it of rItems) for (const line of it.lines) {
    const ends = [line[0], line[line.length - 1]];
    ends.forEach((e, k) => {
      const far = ends[1 - k];
      for (const h of touching(rIndex, e)) {
        if (h.it === it) continue;
        const atEnd = (h.i === 1 && h.u < 0.05) || (h.i === h.line.length - 1 && h.u > 0.95);
        if (!atEnd) { links.push([it, h.it]); continue; }          // flows into the middle of h
        const hFar = h.i === 1 ? h.line[h.line.length - 1] : h.line[0];
        if (elevAt(hFar) < elevAt(far)) links.push([it, h.it]);     // end to end: h is downstream
      }
    });
  }
  const before = new Map(rItems.map(it => [it, it.f.properties.r]));
  for (let pass = 0, changed = true; changed && pass < 50; pass++) {
    changed = false;
    for (const [from, to] of links) {
      if (to.f.properties.r > from.f.properties.r) { to.f.properties.r = from.f.properties.r; changed = true; }
    }
  }
  let lakesPromoted = 0;
  for (const it of rItems) for (const line of it.lines) for (const e of [line[0], line[line.length - 1]]) {
    for (const h of touching(lIndex, e)) {
      if (h.it.f.properties.r > it.f.properties.r + 1) { h.it.f.properties.r = it.f.properties.r + 1; lakesPromoted++; }
    }
  }
  return { rivers: rItems.filter(it => before.get(it) !== it.f.properties.r).length, lakes: lakesPromoted };
}

// ---------------------------------------------------------------------------
// Extensions over the exposed shelf.
// Every river end that lies at today's coast gets a line down to the ancient sea:
//   - from the mouth we follow the elevation grid to the lowest neighbouring
//     cell (as water would flow); if that gets stuck, we take the shortest way
//     to the nearest cell of the ancient sea;
//   - the line ends exactly on the ancient coastline (where the grid crosses the
//     sea level, the same rule d3.contours uses to draw the coast) plus a short
//     overshoot into the sea, so it never stops short of the water;
//   - branches of one delta that reach a channel already drawn join it there
//     instead of being dropped.
function extendRivers(rivers, grid, ocean, level, atCoast, water) {
  const { elev, nx, ny, step } = grid;
  const cellOf = ([lon, lat]) => {
    const x = ((Math.round((lon + 180) / step) % nx) + nx) % nx;
    const y = Math.min(ny - 1, Math.max(0, Math.round((lat + 90) / step)));
    return y * nx + x;
  };
  const lonLatOf = (i) => {
    const x = i % nx, y = (i - x) / nx;
    return [-180 + x * step, -90 + y * step];
  };
  const neighbours = (i, radius) => {
    const x0 = i % nx, y0 = (i - x0) / nx, out = [];
    for (let dy = -radius; dy <= radius; dy++) {
      const y = y0 + dy;
      if (y < 0 || y >= ny) continue;
      for (let dx = -radius; dx <= radius; dx++) {
        if (!dx && !dy) continue;
        out.push(y * nx + ((x0 + dx + nx) % nx));
      }
    }
    return out;
  };
  // Ancient sea: connected areas of the sea floor below the ancient sea level.
  // Tiny pits (fewer than MIN_SEA cells) do not count: they vanish from the drawn
  // coast, and a river must not end in them.
  const MIN_SEA = 40;
  const below = (j) => ocean[j] && elev[j] < level;
  const seaMask = new Uint8Array(elev.length);
  const seen = new Uint8Array(elev.length);
  for (let i = 0; i < elev.length; i++) {
    if (seen[i] || !below(i)) continue;
    const comp = [i];
    seen[i] = 1;
    for (let h = 0; h < comp.length; h++) {
      for (const j of neighbours(comp[h], 1)) if (!seen[j] && below(j)) { seen[j] = 1; comp.push(j); }
    }
    if (comp.length >= MIN_SEA) for (const j of comp) seaMask[j] = 1;
  }
  const isSea = (j) => seaMask[j] === 1;
  // A few more steps into the sea: the part over water is cut off later exactly
  // at the drawn coast (see clipToCoast), so the river never stops short of it
  const intoSea = (cells) => {
    const visited = new Set(cells);
    let cur = cells[cells.length - 1];
    for (let n = 0; n < 4; n++) {
      const next = neighbours(cur, 1).filter(j => isSea(j) && !visited.has(j));
      if (!next.length) break;
      cur = next.reduce((a, b) => (elev[a] <= elev[b] ? a : b));
      visited.add(cur);
      cells.push(cur);
    }
    return cells;
  };
  // Shortest way (8 neighbours) through ocean cells to the ancient sea
  const shortestToSea = (from) => {
    const prev = new Map([[from, -1]]);
    const queue = [from];
    for (let h = 0; h < queue.length && queue.length < 200000; h++) {
      const i = queue[h];
      for (const j of neighbours(i, 1)) {
        if (prev.has(j) || !ocean[j]) continue;
        prev.set(j, i);
        if (isSea(j)) {
          const path = [j];
          for (let k = i; k !== -1; k = prev.get(k)) path.push(k);
          return path.reverse();
        }
        queue.push(j);
      }
    }
    return null;
  };

  const owner = new Map();           // grid cell → the already drawn channel (its points) that passes it
  const ends = [];
  for (const f of rivers.features) {
    const parts = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates];
    for (const line of parts) for (const end of [line[0], line[line.length - 1]]) ends.push({ end, r: f.properties.r });
  }
  // Big rivers first: they draw the main channels, smaller branches join them
  ends.sort((a, b) => a.r - b.r);

  const out = [];
  for (const { end, r } of ends) {
    if (!atCoast(end)) continue;                               // not at today's sea: source, tributary or lake end
    if (isSea(cellOf(end))) continue;                          // already in the ancient sea
    // Mouths inside narrow estuaries (Amazon, Congo, St. Lawrence, Dnieper …) are
    // land on the coarse elevation grid: first follow today's water of the estuary
    let head = [];
    let c0 = cellOf(end);
    let near = neighbours(c0, 3).concat(c0).filter(j => ocean[j]);
    if (!near.length) {
      const route = water.route(end, (p) => ocean[cellOf(p)]);
      if (!route) continue;
      head = route.pts;
      if (route.reachedWater) {                                // e.g. the Black Sea or the Caspian
        out.push(lineFeature([end, ...head], r, false));
        continue;
      }
      c0 = cellOf(head[head.length - 1]);
      near = neighbours(c0, 3).concat(c0).filter(j => ocean[j]);
      if (!near.length) continue;
    }
    let cur = near.reduce((a, b) => (elev[a] <= elev[b] ? a : b));
    let cells = [cur];
    let joined = owner.has(cur) ? cur : null;
    if (joined === null && !isSea(cur)) {
      const visited = new Set([cur]);
      for (let n = 0; n < 3000; n++) {
        const next = neighbours(cur, 1).filter(j => ocean[j] && !visited.has(j));
        if (!next.length) break;
        cur = next.reduce((a, b) => (elev[a] <= elev[b] ? a : b));
        visited.add(cur);
        cells.push(cur);
        if (isSea(cur)) break;
        if (owner.has(cur)) { joined = cur; break; }
      }
      if (joined === null && !isSea(cur)) {                    // stuck: take the shortest way
        const path = shortestToSea(cells[0]);
        if (!path) continue;
        cells = path;
      }
    }
    // Line: river end → (estuary) → cell centres → into the sea (cut at the coast later),
    // or → the channel it joins
    let pts;
    if (joined !== null) {
      // End exactly on the drawn (smoothed) line of the channel it joins
      const [cx, cy] = lonLatOf(joined);
      const target = owner.get(joined).reduce((a, b) => (Math.hypot(a[0] - cx, a[1] - cy) <= Math.hypot(b[0] - cx, b[1] - cy) ? a : b));
      pts = [end, ...head, ...cells.slice(0, -1).map(lonLatOf), target];
    } else {
      pts = [end, ...head, ...intoSea(cells).map(lonLatOf)];
    }
    const feature = lineFeature(pts, r, joined !== null);
    if (!feature) continue;
    for (const c of cells) if (!isSea(c) && !owner.has(c)) owner.set(c, feature.geometry.coordinates);
    out.push(feature);
  }
  return out.filter(Boolean);
}

function lineFeature(pts, r, joined) {
  if (pts.some((p, k) => k && Math.abs(p[0] - pts[k - 1][0]) > 180)) return null; // crosses the date line
  return { type: 'Feature', properties: { r, j: joined ? 1 : 0 }, geometry: { type: 'LineString', coordinates: smooth(pts) } };
}

// ---------------------------------------------------------------------------
// Ways through today's water near a river mouth (fine raster, 1.5′ ≈ 2.8 km).
// `modern` — today's land, `drawn` — the land drawn on this map (ancient coast).
// route(end, handOver): shortest way from the river end through today's water
// until it reaches water drawn on the map (reachedWater = true) or a point where
// handOver(point) is true (there the elevation grid takes over). Null if none
// is found within ±5°.
function waterRouter(modern, drawn) {
  const RES = 1 / 40;
  const index = (fc) => {                        // 1° latitude band → edges crossing it
    const bands = new Map();
    for (const f of fc.features) {
      const g = f.geometry;
      if (!g) continue;
      const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
      for (const poly of polys) for (const ring of poly) for (let i = 1; i < ring.length; i++) {
        const [a, b] = [ring[i - 1], ring[i]];
        if (a[1] === b[1]) continue;
        for (let y = Math.floor(Math.min(a[1], b[1])); y <= Math.floor(Math.max(a[1], b[1])); y++) {
          if (!bands.has(y)) bands.set(y, []);
          bands.get(y).push([a, b]);
        }
      }
    }
    return bands;
  };
  const mIndex = index(modern), dIndex = index(drawn);
  // Inside/outside for a window of pixels, row by row (even–odd rule)
  const raster = (bands, lon0, lat0, w, h) => {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const lat = lat0 + (y + 0.5) * RES;
      const xs = [];
      for (const [a, b] of bands.get(Math.floor(lat)) || []) {
        if ((a[1] > lat) === (b[1] > lat)) continue;
        xs.push(a[0] + ((lat - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const x1 = Math.max(0, Math.ceil((xs[k] - lon0) / RES - 0.5));
        const x2 = Math.min(w - 1, Math.floor((xs[k + 1] - lon0) / RES - 0.5));
        for (let x = x1; x <= x2; x++) out[y * w + x] = 1;
      }
    }
    return out;
  };
  return {
    route(end, handOver) {
      const dLat = 5, dLon = Math.min(12, 5 / Math.max(0.2, Math.cos((end[1] * Math.PI) / 180)));
      const lon0 = end[0] - dLon, lat0 = end[1] - dLat;
      const w = Math.round((2 * dLon) / RES), h = Math.round((2 * dLat) / RES);
      const land = raster(mIndex, lon0, lat0, w, h);
      const drawnLand = raster(dIndex, lon0, lat0, w, h);
      const at = (i) => [lon0 + ((i % w) + 0.5) * RES, lat0 + (Math.floor(i / w) + 0.5) * RES];
      const ex = Math.floor((end[0] - lon0) / RES), ey = Math.floor((end[1] - lat0) / RES);
      const prev = new Int32Array(w * h).fill(-2);
      const queue = [];
      for (let dy = -5; dy <= 5; dy++) for (let dx = -5; dx <= 5; dx++) {
        const x = ex + dx, y = ey + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const i = y * w + x;
        if (!land[i]) { prev[i] = -1; queue.push(i); }
      }
      for (let q = 0; q < queue.length; q++) {
        const i = queue[q];
        const p = at(i);
        const reachedWater = !drawnLand[i];
        if (reachedWater || handOver(p)) {
          const path = [];
          for (let k = i; k !== -1; k = prev[k]) path.push(at(k));
          path.reverse();
          // every 3rd pixel is enough (the line is smoothed afterwards)
          const pts = path.filter((_, k) => k % 3 === 0 || k === path.length - 1);
          return { pts, reachedWater };
        }
        const x = i % w, y = (i - x) / w;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (prev[j] !== -2 || land[j]) continue;
          prev[j] = i;
          queue.push(j);
        }
      }
      return null;
    },
  };
}

// Test "this point is within `km` of today's coastline" (Natural Earth land 1:50m)
function modernLand(root) {
  const t = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'world-atlas', 'land-50m.json'), 'utf8'));
  return topojson.feature(t, t.objects.land);
}

function coastTest(root, km) {
  const land = modernLand(root);   // distances only: the date-line edges do not matter here
  const buckets = new Map();                     // 1° cell → coast segments
  const key = (x, y) => `${Math.floor(x)},${Math.floor(y)}`;
  for (const f of land.features) {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const poly of polys) for (const ring of poly) for (let i = 1; i < ring.length; i++) {
      const [a, b] = [ring[i - 1], ring[i]];
      const k = key((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push([a, b]);
    }
  }
  return ([lon, lat]) => {
    const kx = Math.cos((lat * Math.PI) / 180) * 111.32, ky = 110.57;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const [a, b] of buckets.get(key(lon + dx, lat + dy)) || []) {
        const ax = (a[0] - lon) * kx, ay = (a[1] - lat) * ky, bx = (b[0] - lon) * kx, by = (b[1] - lat) * ky;
        const vx = bx - ax, vy = by - ay;
        const u = Math.max(0, Math.min(1, -(ax * vx + ay * vy) / ((vx * vx + vy * vy) || 1)));
        if (Math.hypot(ax + u * vx, ay + u * vy) < km) return true;
      }
    }
    return false;
  };
}

// Chaikin smoothing (2 rounds), keeps the first and last points
function smooth(pts) {
  let p = pts;
  for (let round = 0; round < 2; round++) {
    const q = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const [a, b] = [p[i], p[i + 1]];
      q.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]]);
      q.push([0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
    }
    q.push(p[p.length - 1]);
    p = q;
  }
  return p.map(([x, y]) => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4]);
}
