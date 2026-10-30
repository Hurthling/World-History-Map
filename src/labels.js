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
//
// Long names are split into lines (owner 30.10, item С-5): see splitLabel().
// =============================================================================

import { CONFIG } from './config.js';

// ---- Line breaks for long names (owner 30.10, item С-5) --------------------
// A name longer than LINE_CHARS characters (spaces count, brackets do not) is
// split into ceil(length / LINE_CHARS) lines, only at spaces, so that the longest
// line is as short as possible. Text in brackets at the end of the name is kept
// whole if possible: on the same line if the whole name fits, otherwise as the
// last line; only when the bracketed text itself is longer than LINE_CHARS is it
// split by the same rule. Inside other brackets we avoid breaking if we can.
const LINE_CHARS = 30;
const charCount = s => s.replace(/[()]/g, '').length;

// Split into the fewest lines allowed by the length rule, longest line minimal;
// among equal splits prefer the one with fewer breaks inside brackets
function balanceLines(text) {
  if (charCount(text) <= LINE_CHARS) return [text];
  const words = text.split(' ');
  const k = Math.min(Math.ceil(charCount(text) / LINE_CHARS), words.length);
  // depth[i] > 0: a break after word i would fall inside brackets
  const inside = [];
  let depth = 0;
  for (const w of words) {
    for (const ch of w) depth += ch === '(' ? 1 : ch === ')' ? -1 : 0;
    inside.push(depth > 0);
  }
  let best = null;
  const cuts = [];
  (function search(start, left) {
    if (left === 1) {
      const bounds = [0, ...cuts, words.length];
      const lines = bounds.slice(1).map((e, i) => words.slice(bounds[i], e).join(' '));
      const score = [cuts.filter(c => inside[c - 1]).length, Math.max(...lines.map(charCount))];
      if (!best || score[0] < best.score[0] || (score[0] === best.score[0] && score[1] < best.score[1])) best = { lines, score };
      return;
    }
    for (let c = start + 1; c <= words.length - left + 1; c++) {
      cuts.push(c);
      search(c, left - 1);
      cuts.pop();
    }
  })(0, k);
  return best.lines;
}

export function splitLabel(text) {
  const m = text.match(/^(.*\S)\s+\(([^()]*)\)$/);
  if (!m) return balanceLines(text);
  const [, main, inner] = m;
  if (charCount(main) + 1 + inner.length <= LINE_CHARS) return [text];
  const tail = `(${inner})`;
  return [...balanceLines(main), ...(inner.length <= LINE_CHARS ? [tail] : balanceLines(tail))];
}

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
    const lines = splitLabel(text);
    const lineHeight = fontSize * 1.1;
    // A culture label sits just below the species label of the same piece
    // (its first line, so a multi-line culture label grows downwards)
    const dy = a.minor ? size * 0.9 + (lines.length - 1) * lineHeight / 2 : 0;
    // Rough text size estimate (uppercase labels are wider): the longest line × number of lines
    const longest = Math.max(...lines.map(l => l.length));
    const w = longest * fontSize * (major ? 0.72 : 0.56) + 6;
    const h = fontSize * 1.2 + (lines.length - 1) * lineHeight;
    const box = { x1: x - w / 2, x2: x + w / 2, y1: y + dy - h / 2, y2: y + dy + h / 2 };

    if (boxes.some(b => box.x1 < b.x2 && box.x2 > b.x1 && box.y1 < b.y2 && box.y2 > b.y1)) continue;
    boxes.push(box);
    placed.push({ name: a.name, text, lines, x, y: y + dy, fontSize: +fontSize.toFixed(1), major });
  }
  return placed;
}
