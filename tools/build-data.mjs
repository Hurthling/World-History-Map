// =============================================================================
// build-data.mjs — prepares map data for the site.
//
// What it does:
//   1. Takes the raw GeoJSON maps from the "historical-basemaps" project
//      (https://github.com/aourednik/historical-basemaps, GPL-3.0).
//      If they are not present locally, it downloads them with `git clone`.
//   2. Builds ancient coastlines for years listed in corrections/sea-levels.json
//      (see tools/coast.mjs) → data/coast/land_<year>.json
//   3. Applies our own fixes from corrections/corrections.json, including new
//      culture zones from corrections/shapes/ (see tools/corrections.mjs and
//      corrections/README.md). New zones are cut to the land of that year.
//   4. Simplifies every map (drops excess detail) so the site loads fast.
//   5. Saves each map as compact TopoJSON into  data/borders/
//   6. Writes data/index.json — the list of available years (the timeline
//      is built from this file).
//   7. Copies a world land outline (Natural Earth via the "world-atlas"
//      npm package) to data/land.json — used as the background under borders.
//   8. Builds rivers and lakes (data/hydro.json) and, for ancient coastlines,
//      river extensions over the exposed sea floor (see tools/hydro.mjs).
//   9. On "probability" maps (map 1) cuts out places where zones of different
//      species or cultures overlap (see tools/overlaps.mjs), and trims source
//      shapes to today's land (their coast is glacial; item 1-30).
//
// Run:   npm install        (once)
//        npm run build-data
//
// Options (environment variables):
//   SOURCE_DIR   folder with world_*.geojson files (default: tools/.cache/...)
//   SIMPLIFY     share of points to keep, e.g. "8%" (default below)
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import mapshaper from 'mapshaper';
import * as topojson from 'topojson-client';
import { loadCorrections, applyEdits, buildZones } from './corrections.mjs';
import { buildCoasts, flatLand } from './coast.mjs';
import { buildHydro } from './hydro.mjs';
import { buildOverlaps } from './overlaps.mjs';
import { checkColors } from './check-colors.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'tools', '.cache', 'historical-basemaps');
const SOURCE_DIR = process.env.SOURCE_DIR || path.join(CACHE, 'geojson');
const SIMPLIFY = process.env.SIMPLIFY || '8%';
const OUT_DIR = path.join(ROOT, 'data', 'borders');
const PATCHED_DIR = path.join(ROOT, 'tools', '.cache', 'patched');
const CORRECTIONS = path.join(ROOT, 'corrections', 'corrections.json');
const SHAPES_DIR = path.join(ROOT, 'corrections', 'shapes');
const SEA_LEVELS = path.join(ROOT, 'corrections', 'sea-levels.json');
const COAST_DIR = path.join(ROOT, 'data', 'coast');
const REVIEWED = path.join(ROOT, 'corrections', 'reviewed.json');
const REGIONS_DIR = path.join(ROOT, 'corrections', 'regions');
const COLORS = path.join(ROOT, 'corrections', 'colors.json');
const SOURCE_REPO = 'https://github.com/aourednik/historical-basemaps.git';

// Properties kept from the source data (everything else is dropped).
// NAME             — name of the country / region / culture
// SUBJECTO         — the power that controls it (used for colouring)
// PARTOF           — larger cultural area it belongs to
// BORDERPRECISION  — 1 approximate, 2 moderately precise, 3 legally defined
// NOTE             — (our zones) key of an explanatory note, text in translations/notes/<lang>.json
// SOURCES          — (our zones) links to sources, separated by " | "
// KIND             — (our zones) "uninhabited" for land nobody had reached yet
// GROUP            — (our zones) colour group: zones with the same GROUP share one colour; not shown in the card
// AREA             — (our zones) name of one area inside a group of areas: NAME is then the
//                    group's common name (map label), AREA is the card title (e.g. NAME
//                    "Foragers of Australia", AREA "Foragers of the Kimberley")
// SPECIES          — (map 1) human species of the zone: sapiens, neanderthal, denisovan, erectus,
//                    floresiensis, luzonensis, unknown — the main colour (src/colors.js)
// CULTURE          — (map 1) archaeological culture: a shade of the species colour
// PARTS            — (overlaps, tools/overlaps.mjs) selection keys of the two overlapping zones
// COLOR            — (our zones) colour number in the common palette, set by hand in
//                    corrections/colors.json (by GROUP, else NAME); else the colour comes from a hash
const KEEP_FIELDS = ['NAME', 'SUBJECTO', 'PARTOF', 'BORDERPRECISION', 'NOTE', 'SOURCES', 'KIND', 'GROUP', 'AREA', 'SPECIES', 'CULTURE', 'PARTS', 'COLOR'];
// Fields used only by some of our zones: dropped where empty
const OPTIONAL_FIELDS = ['GROUP', 'AREA', 'SPECIES', 'CULTURE', 'PARTS', 'COLOR'];

// Broken characters in the source data ("\uFFFD" = unreadable letter).
// Add new pairs here if the build reports more of them.
const TEXT_FIXES = {
  'Arag\uFFFDn': 'Aragón',
  'Monte Alb\uFFFDn': 'Monte Albán',
  'Teotihuac\uFFFDn': 'Teotihuacán',
};

function fixTexts(topo, year) {
  for (const g of topo.objects.borders.geometries) {
    for (const key of KEEP_FIELDS) {
      const v = g.properties?.[key];
      if (typeof v !== 'string') continue;
      if (TEXT_FIXES[v]) g.properties[key] = TEXT_FIXES[v];
      else if (v.includes('\uFFFD')) console.warn(`  ! ${year}: broken text "${v}" — add it to TEXT_FIXES`);
    }
  }
}

function ensureSource() {
  if (fs.existsSync(SOURCE_DIR)) return;
  console.log(`Source not found, downloading ${SOURCE_REPO} ...`);
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  execFileSync('git', ['clone', '--depth', '1', SOURCE_REPO, CACHE], { stdio: 'inherit' });
}

// "world_bc3000.geojson" -> -3000, "world_1492.geojson" -> 1492
function yearFromFilename(file) {
  const m = /^world_(bc)?(\d+)\.geojson$/.exec(file);
  if (!m) return null;
  return m[1] ? -Number(m[2]) : Number(m[2]);
}

// Today's land as flat outlines (cut at the date line, see flatLand in coast.mjs)
async function modernLand() {
  const t = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'world-atlas', 'land-50m.json'), 'utf8'));
  return flatLand(topojson.feature(t, t.objects.land));
}

// Today's land written once to a file, for mapshaper -clip (item 1-30)
let modernLandPath = null;
function modernLandFile(land) {
  if (!modernLandPath) {
    fs.mkdirSync(PATCHED_DIR, { recursive: true });
    modernLandPath = path.join(PATCHED_DIR, '_modern_land.geojson');
    fs.writeFileSync(modernLandPath, JSON.stringify(land));
  }
  return modernLandPath;
}

async function buildBorders(coasts, land, riversExt) {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const files = fs.readdirSync(SOURCE_DIR)
    .map(f => ({ file: f, year: yearFromFilename(f) }))
    .filter(x => x.year !== null)
    .sort((a, b) => a.year - b.year);

  const rules = loadCorrections(CORRECTIONS);
  const colors = fs.existsSync(COLORS) ? JSON.parse(fs.readFileSync(COLORS, 'utf8')).colors || {} : {};
  const usedColors = new Set();
  fs.mkdirSync(PATCHED_DIR, { recursive: true });

  const years = [];
  for (const { file, year } of files) {
    const outName = `world_${year}.json`; // negative years keep the minus sign
    const outPath = path.join(OUT_DIR, outName);

    // Apply our corrections to the raw map, save a patched copy, build from it
    const raw = JSON.parse(fs.readFileSync(path.join(SOURCE_DIR, file), 'utf8'));
    const report = applyEdits(raw, year, rules);
    const zones = await buildZones(year, rules, { shapesDir: SHAPES_DIR, land: coasts[year]?.geojson || land });
    report.push(...zones.report);
    // "Probability" maps (map 1): overlapping species / cultures become separate striped shapes
    if (probabilityYears.includes(year)) {
      const overlaps = await buildOverlaps(zones.features);
      zones.features.push(...overlaps.features);
      report.push(...overlaps.report);
    }
    // Colours set by hand (corrections/colors.json): by GROUP, else by NAME
    for (const f of zones.features) {
      const key = f.properties.GROUP || f.properties.NAME;
      if (key in colors) { f.properties.COLOR = colors[key]; usedColors.add(key); }
    }
    for (const f of zones.features) for (const k of KEEP_FIELDS) if (!(k in f.properties)) f.properties[k] = null;
    const zonesPath = path.join(PATCHED_DIR, `zones_${year}.geojson`);
    fs.writeFileSync(zonesPath, JSON.stringify({ type: 'FeatureCollection', features: zones.features }));
    for (const f of raw.features) {
      f.properties = f.properties || {};
      for (const k of KEEP_FIELDS) if (!(k in f.properties)) f.properties[k] = null;
    }
    const patchedPath = path.join(PATCHED_DIR, file);
    fs.writeFileSync(patchedPath, JSON.stringify(raw));

    // Source map is simplified; our zones are added afterwards unchanged
    // (drawn on top, in the order of corrections.json)
    const cmd = [
      `-i "${patchedPath}" name=borders`,
      `-filter-fields ${KEEP_FIELDS.join(',')}`,
      // "Probability" maps (map 1) have today's coast: trim source shapes to today's land,
      // otherwise their glacial-age coast sticks out into the sea (item 1-30). Done before
      // simplifying, so that the detailed coast of today's land is simplified too
      ...(!coasts[year] && probabilityYears.includes(year) ? [`-clip "${modernLandFile(land)}"`] : []),
      `-simplify ${SIMPLIFY} keep-shapes`,
      // Maps with an ancient coastline: trim source shapes to that coast, so that
      // bits of today's coast do not stick out into the ancient sea
      ...(coasts[year] ? [`-clip "${path.join(ROOT, 'data', coasts[year].file)}"`] : []),
      ...(zones.features.length ? [
        `-i "${zonesPath}" name=zones`,
        `-filter-fields ${KEEP_FIELDS.join(',')}`,
        `-merge-layers target=borders,zones name=borders force`,
      ] : []),
      `-o "${outPath}" format=topojson quantization=100000`,
    ].join(' ');
    await mapshaper.runCommands(cmd);

    const topo = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    fixTexts(topo, year);
    // Some fields are used only by a few of our zones: drop the empty ones elsewhere
    for (const g of topo.objects.borders.geometries) {
      for (const k of OPTIONAL_FIELDS) if (g.properties && g.properties[k] == null) delete g.properties[k];
    }
    fs.writeFileSync(outPath, JSON.stringify(topo));
    const geoms = topo.objects.borders.geometries;
    const names = [...new Set(geoms.map(g => g.properties?.NAME).filter(Boolean))].sort();
    const kb = Math.round(fs.statSync(outPath).size / 1024);
    console.log(`${String(year).padStart(8)}  ${String(geoms.length).padStart(4)} shapes  ${String(kb).padStart(5)} KB`);
    for (const line of report) console.log(`          fix ${line}`);
    const entry = { year, file: `borders/${outName}`, count: names.length };
    if (coasts[year]) { entry.land = coasts[year].file; entry.seaLevel = coasts[year].level; }
    if (riversExt[year]) entry.riversExt = riversExt[year];
    if (reviewedYears.includes(year)) entry.reviewed = true;
    if (reviewedAreas[year]) { entry.reviewedArea = reviewedAreas[year].file; entry.reviewedNote = reviewedAreas[year].note; }
    if (probabilityYears.includes(year)) entry.mode = 'probability';
    if (coastNotes[year]) entry.coastNote = coastNotes[year];
    years.push(entry);
    // Neighbouring zones of similar colour, repeated colours (reviewed maps only)
    if (reviewedYears.includes(year)) {
      const area = reviewedAreas[year] ? JSON.parse(fs.readFileSync(path.join(ROOT, 'data', reviewedAreas[year].file), 'utf8')) : null;
      for (const line of checkColors(topo, area)) console.log(`          colour ${line}`);
    }
  }
  for (const key of Object.keys(colors)) if (!usedColors.has(key)) console.warn(`  ! corrections/colors.json: "${key}" matches no zone`);
  return years;
}

// Maps reviewed only in part (reviewed.json → "regions"): the reviewed parts of the
// land (land of that year ∩ outline from corrections/regions/) → data/coast/reviewed_<year>.json.
// Only there empty land is hatched as "No data" (src/map.js).
async function buildReviewedAreas(regions, coasts, land) {
  const result = {};
  for (const [y, { shape, note }] of Object.entries(regions)) {
    const year = Number(y);
    const landFile = path.join(PATCHED_DIR, `_land_${year}.geojson`);
    fs.mkdirSync(PATCHED_DIR, { recursive: true });
    fs.writeFileSync(landFile, JSON.stringify(coasts[year]?.geojson || land));
    const file = `coast/reviewed_${year}.json`;
    await mapshaper.runCommands([
      `-i "${landFile}" name=area`,
      `-clip "${path.join(REGIONS_DIR, shape + '.geojson')}"`,
      `-dissolve2`,
      `-o "${path.join(ROOT, 'data', file)}" format=topojson quantization=100000`,
    ].join(' '));
    fs.rmSync(landFile);
    result[year] = { file, note };
    console.log(`  reviewed part of ${year}: ${shape} → ${file}`);
  }
  return result;
}

function copyLand() {
  const src = path.join(ROOT, 'node_modules', 'world-atlas', 'land-50m.json');
  fs.copyFileSync(src, path.join(ROOT, 'data', 'land.json'));
}

ensureSource();
const land = await modernLand();
// reviewed.json: "years" — maps drawn from dated finds ("No data" hatching);
// "probability" — maps coloured where a species' presence is more likely than 50 % (map 1);
// "coastNotes" — key of a note under the year (translations/ui), e.g. "the coastline is today's"
const reviewed = fs.existsSync(REVIEWED) ? JSON.parse(fs.readFileSync(REVIEWED, 'utf8')) : {};
const reviewedYears = reviewed.years || [];
const probabilityYears = reviewed.probability || [];
const coastNotes = reviewed.coastNotes || {};
const seaLevels = fs.existsSync(SEA_LEVELS) ? JSON.parse(fs.readFileSync(SEA_LEVELS, 'utf8')) : {};
const levels = seaLevels.levels || {};
fs.rmSync(COAST_DIR, { recursive: true, force: true });
const coasts = await buildCoasts({ root: ROOT, levels, lakes: seaLevels.lakes, local: seaLevels.local, basins: seaLevels.basins, landGeoJson: land, outDir: COAST_DIR });
const reviewedAreas = await buildReviewedAreas(reviewed.regions || {}, coasts, land);
const riversExt = await buildHydro({ root: ROOT, levels, basins: seaLevels.basins, outDataDir: path.join(ROOT, 'data'), coastDir: COAST_DIR });
const years = await buildBorders(coasts, land, riversExt);
copyLand();
const index = {
  generated: new Date().toISOString().slice(0, 10),
  source: 'historical-basemaps by A. Ourednik (GPL-3.0)',
  simplify: SIMPLIFY,
  years,
};
fs.writeFileSync(path.join(ROOT, 'data', 'index.json'), JSON.stringify(index, null, 2) + '\n');
console.log(`\nDone: ${years.length} maps -> data/borders/, index -> data/index.json`);
