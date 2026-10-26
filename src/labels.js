// =============================================================================
// labels.js — decides where country names go and which ones fit.
//
// Step 1 (once per year / resize): computeLabelAnchors()
//   For every piece of territory of every named country remember its centre
//   point and area (in map pixels at zoom 1).
//
// Step 2 (on every zoom/pan): layoutLabels()
//   Map 1: zones of a species also get a second, smaller italic label with
//   their culture or area (AREA) — shown only when zoomed in (CONFIG.labels.cultureZoom).
//
//   Scale those numbers by the current zoom; each name is labelled once, on its
//   largest piece that is on screen; drop labels that are too small or
//   off-screen, size the font by territory size, and skip labels that would
//   overlap a bigger one already placed.
// =============================================================================

import { CONFIG } from './config.js';

export function computeLabelAnchors(features, path) {
  // One anchor per piece of territory; layoutLabels() labels each name once,
  // on its largest piece that is on screen (so a group of zones or a country
  // with islands still gets its label when its biggest piece is off screen)
  const anchors = []; // {name, x, y, area, label?, minor?}
  for (const f of features) {
    const name = f.properties?.NAME;
    if (!name || !f.geometry || f.properties?.KIND === 'uninhabited' || f.properties?.KIND === 'overlap') continue;
    const polys = f.geometry.type === 'MultiPolygon'
      ? f.geometry.coordinates
      : [f.geometry.coordinates];
    for (const coords of polys) {
      const poly = { type: 'Polygon', coordinates: coords };
      const area = path.area(poly);
      const [x, y] = path.centroid(poly);
      if (!(area > 0 && Number.isFinite(x) && Number.isFinite(y))) continue;
      anchors.push({ name, x, y, area });
      // Map 1: culture / area label of a species zone (key NAME::AREA, as for selection)
      const p = f.properties;
      if (p.SPECIES && p.AREA) anchors.push({ name: `${name}::${p.AREA}`, label: p.AREA, x, y, area, minor: true });
    }
  }
  // Larger first; for the same piece the species label goes before the culture label
  return anchors.sort((a, b) => b.area - a.area || (a.minor ? 1 : 0) - (b.minor ? 1 : 0));
}

export function layoutLabels(anchors, transform, width, height, translate) {
  const { minArea, minFont, maxFont } = CONFIG.labels;
  const k = transform.k;
  const placed = [];
  const boxes = [];

  const done = new Set(); // names already labelled (or blocked) on their largest visible piece
  for (const a of anchors) {
    const screenArea = a.area * k * k;
    if (screenArea < minArea) break; // anchors are sorted by area, the rest are smaller
    if (done.has(a.name)) continue;
    if (a.minor && k < CONFIG.labels.cultureZoom) continue; // culture labels: only when zoomed in

    const x = transform.applyX(a.x);
    const y = transform.applyY(a.y);
    if (x < 0 || x > width || y < 0 || y > height) continue; // this piece's centre is off screen
    done.add(a.name);

    const size = Math.max(minFont, Math.min(maxFont, Math.sqrt(screenArea) * 0.11));
    const fontSize = a.minor ? Math.max(minFont, size * 0.75) : size;
    const major = !a.minor && fontSize >= 13;
    const text = translate(a.label || a.name);
    // A culture label sits just below the species label of the same piece
    const dy = a.minor ? size * 0.9 : 0;
    // Rough text size estimate (uppercase labels are wider)
    const w = text.length * fontSize * (major ? 0.72 : 0.56) + 6;
    const h = fontSize * 1.2;
    const box = { x1: x - w / 2, x2: x + w / 2, y1: y + dy - h / 2, y2: y + dy + h / 2 };

    if (boxes.some(b => box.x1 < b.x2 && box.x2 > b.x1 && box.y1 < b.y2 && box.y2 > b.y1)) continue;
    boxes.push(box);
    placed.push({ name: a.name, text, x, y: y + dy, fontSize: +fontSize.toFixed(1), major });
  }
  return placed;
}
