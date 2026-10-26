// =============================================================================
// data.js — loads map data and keeps it in memory.
//
//   loadIndex()          -> list of available years [{year, file, count}, ...]
//   loadLand(year)       -> GeoJSON of world land for that year (background).
//                           Ice-age maps have their own land with the ancient
//                           coastline (index.json: "land"); others use today's.
//   loadYear(year)       -> array of GeoJSON features (countries) for that year
//   nearestYear(y)       -> the available year closest to y
//   loadHydro()          -> { rivers, lakes } — today's rivers and lakes (all maps)
//   loadRiversExt(year)  -> river extensions over the exposed sea floor for
//                           maps with a lower sea level (index.json: "riversExt"), or []
//
// Border files are TopoJSON (compact); they are converted to GeoJSON here
// using the topojson-client library (global `topojson`, see index.html).
// =============================================================================

import { CONFIG } from './config.js';

let index = null;
const landCache = new Map(); // file -> Promise<GeoJSON>
const cache = new Map(); // year -> Promise<features[]>

async function loadJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

export async function loadIndex() {
  if (!index) index = await loadJson(CONFIG.paths.index);
  return index.years;
}

export function landFileFor(year) {
  const entry = index.years.find(y => y.year === year);
  return entry?.land ? CONFIG.paths.dataRoot + entry.land : CONFIG.paths.land;
}

export function loadLand(year) {
  const file = landFileFor(year);
  if (!landCache.has(file)) {
    const promise = loadJson(file).then(topo => {
      const geo = topojson.feature(topo, topo.objects.land);
      (geo.features || [geo]).forEach(fixWinding);
      return geo;
    });
    promise.catch(() => landCache.delete(file));
    landCache.set(file, promise);
  }
  return landCache.get(file);
}

let hydroPromise = null;
export function loadHydro() {
  if (!hydroPromise) {
    hydroPromise = loadJson(CONFIG.paths.hydro).then(topo => {
      const lakes = topojson.feature(topo, topo.objects.lakes);
      lakes.features.forEach(fixWinding);
      return { rivers: topojson.feature(topo, topo.objects.rivers).features, lakes: lakes.features };
    });
    hydroPromise.catch(() => { hydroPromise = null; });
  }
  return hydroPromise;
}

const extCache = new Map();
export function loadRiversExt(year) {
  const file = index.years.find(y => y.year === year)?.riversExt;
  if (!file) return Promise.resolve([]);
  if (!extCache.has(file)) {
    const promise = loadJson(CONFIG.paths.dataRoot + file)
      .then(topo => topojson.feature(topo, topo.objects.riversExt).features);
    promise.catch(() => extCache.delete(file));
    extCache.set(file, promise);
  }
  return extCache.get(file);
}

// Map reviewed only in part (map 8000): the reviewed parts of the land (GeoJSON),
// or null if the whole map was reviewed (index.json: "reviewedArea")
const areaCache = new Map();
export function loadReviewedArea(year) {
  const file = index.years.find(y => y.year === year)?.reviewedArea;
  if (!file) return Promise.resolve(null);
  if (!areaCache.has(file)) {
    const promise = loadJson(CONFIG.paths.dataRoot + file).then(topo => {
      const geo = topojson.feature(topo, topo.objects.area);
      (geo.features || [geo]).forEach(fixWinding);
      return geo;
    });
    promise.catch(() => areaCache.delete(file));
    areaCache.set(file, promise);
  }
  return areaCache.get(file);
}

// Key of a note saying which parts of the map were reviewed (translations/ui), or null
export function reviewedNoteFor(year) {
  return index.years.find(y => y.year === year)?.reviewedNote ?? null;
}

// Map checked against dated finds: empty land is "No data" (see corrections/reviewed.json)
export function isReviewed(year) {
  return Boolean(index.years.find(y => y.year === year)?.reviewed);
}

// How the map was drawn: 'finds' (only dated finds; empty land = "No data"),
// 'probability' (coloured where presence is more likely than 50 %), or null
export function mapMode(year) {
  const entry = index.years.find(y => y.year === year);
  return entry?.mode || (entry?.reviewed ? 'finds' : null);
}

// Key of a note under the year about the coastline (translations/ui), or null
export function coastNoteFor(year) {
  return index.years.find(y => y.year === year)?.coastNote ?? null;
}

export function seaLevelFor(year) {
  return index.years.find(y => y.year === year)?.seaLevel ?? null;
}

export function loadYear(year) {
  if (!cache.has(year)) {
    const entry = index.years.find(y => y.year === year);
    if (!entry) return Promise.reject(new Error(`No map for year ${year}`));
    const promise = loadJson(CONFIG.paths.dataRoot + entry.file).then(topo => {
      const fc = topojson.feature(topo, topo.objects.borders);
      fc.features.forEach(fixWinding);
      return fc.features;
    });
    promise.catch(() => cache.delete(year)); // allow retry after a network error
    cache.set(year, promise);
  }
  return cache.get(year);
}

// d3 draws on a sphere and needs polygon outlines in clockwise order.
// Standard GeoJSON uses the opposite order, so some shapes would be drawn
// "inside out" (covering the whole globe). A polygon that covers more than
// half the sphere is certainly inside out — reverse its outlines.
function fixWinding(feature) {
  const g = feature.geometry;
  if (!g) return;
  const polys = g.type === 'MultiPolygon' ? g.coordinates : g.type === 'Polygon' ? [g.coordinates] : [];
  for (const rings of polys) {
    if (d3.geoArea({ type: 'Polygon', coordinates: rings }) > 2 * Math.PI) {
      rings.forEach(r => r.reverse());
    }
  }
}

// Start downloading a year in the background (used for "next" map)
export function prefetchYear(year) {
  if (year != null) loadYear(year).catch(() => {});
}

export function nearestYear(target) {
  let best = index.years[0].year;
  for (const { year } of index.years) {
    if (Math.abs(year - target) < Math.abs(best - target)) best = year;
  }
  return best;
}
