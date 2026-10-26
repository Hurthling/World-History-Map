// =============================================================================
// map.js — draws the world map (SVG) and handles zoom, pan, hover and click.
//
// Uses the d3 library (global `d3`, loaded in index.html).
//
//   const map = createMap(svgElement, tooltipElement, { onSelect })
//   map.setLand(landGeoJson)      — draw the land background once
//   map.setFeatures(features)     — draw countries for the current year
//   map.setSelected(key)          — highlight a country (or null); key = selectionKey(props)
//   map.refreshLabels()           — redraw labels (e.g. after language change)
//   map.setHydro({rivers, lakes}) — today's rivers and lakes (once)
//   map.setRiversExt(features)    — rivers extended over the exposed sea floor (per year)
//
// Layers, bottom to top: ocean → graticule → land → countries → lakes →
// rivers → ice cover → selection outline → labels. Lakes and rivers ignore the mouse, so
// clicks go to the land or zone underneath. Small rivers appear only when
// zoomed in (CONFIG.rivers).
//
// map.setMode('finds') — maps drawn from dated finds (map 2): empty land is
// hatched as "No data" and clicking it opens a "No data" card.
// map.setReviewedArea(geo) — a map reviewed only in part (map 8000): hatching and
// the "No data" card only inside these parts of the land (null = all land).
//
// Hatching and stripes are drawn as real lines clipped to the shapes (<clipPath>),
// not as SVG <pattern> fills: Chrome on Android drew random rectangles of garbage
// pixels with pattern fills (and earlier with a <mask>). The lines are rebuilt on
// every zoom so they keep the same spacing on screen.
// map.setMode('probability') — map 1: no hatching; clicking empty land opens a
// "probability below 50 %" card. Overlaps of two zones (KIND "overlap", see
// tools/overlaps.mjs) are filled with vertical stripes of both colours.
// Zones with KIND = "uninhabited" get their own colour. Labels are drawn outside the zoom layer so their text
// keeps the same size while zooming (see labels.js).
// =============================================================================

import { CONFIG } from './config.js';
import { fillFor, stripeColors } from './colors.js';
import { placeName, t } from './i18n.js';
import { NO_DATA, LOW_PROB } from './state.js';
import { computeLabelAnchors, layoutLabels } from './labels.js';

// Key used for selection: NAME, or "NAME::AREA" for one area of a group of zones
// (several zones with a common NAME — e.g. "Foragers of Australia" — and their own AREA).
// A click on such an area selects only that area; the map label stays the group's NAME.
export function selectionKey(props) {
  if (!props?.NAME) return null;
  return props.AREA ? `${props.NAME}::${props.AREA}` : props.NAME;
}

export function createMap(svgEl, tooltipEl, { onSelect }) {
  const svg = d3.select(svgEl);
  const projection = d3.geoNaturalEarth1();
  const path = d3.geoPath(projection);

  // Clip shapes for the "No data" hatching and for overlap stripes (see top of file)
  const defs = svg.append('defs');
  const hatchClip = defs.append('clipPath').attr('id', 'clip-nodata').append('path');

  const ocean = svg.append('rect').attr('class', 'ocean');
  const zoomLayer = svg.append('g').attr('class', 'zoom-layer');
  const sphere = zoomLayer.append('path').attr('class', 'sphere');
  const graticule = zoomLayer.append('path').attr('class', 'graticule');
  const landPath = zoomLayer.append('path').attr('class', 'land');
  // "No data" hatching: diagonal lines clipped to the empty land (reviewed maps)
  const hatchG = zoomLayer.append('g').attr('class', 'hatch').attr('clip-path', 'url(#clip-nodata)');
  const hatchLines = hatchG.append('path').attr('class', 'hatch-line');
  const countriesG = zoomLayer.append('g').attr('class', 'countries');
  // Overlaps (map 1): the second colour as vertical bars, clipped to each overlap shape
  const stripesG = zoomLayer.append('g').attr('class', 'stripes');
  const hydroG = zoomLayer.append('g').attr('class', 'hydro');
  const lakesG = hydroG.append('g').attr('class', 'lakes');
  const riversG = hydroG.append('g').attr('class', 'rivers');
  // Rivers and lakes are hidden under ice sheets (zones with NOTE "uninhabited-ice"):
  // the ice zones are drawn once more on top of them. (An SVG <mask> did the same,
  // but Chrome on Android drew rectangular garbage around the rivers with it.)
  const iceCoverG = zoomLayer.append('g').attr('class', 'ice-cover');
  const selectionPath = zoomLayer.append('path').attr('class', 'selection-outline');
  const labelsG = svg.append('g').attr('class', 'labels').attr('aria-hidden', 'true');

  let width = 0;
  let height = 0;
  let land = null;
  let features = [];
  let selected = null;
  let anchors = [];               // label positions, computed per year
  let transform = d3.zoomIdentity;
  let reviewed = false;           // map drawn from dated finds → show "No data"
  let reviewedArea = null;        // reviewed parts of the land (map reviewed only in part) or null
  let probability = false;        // map 1: coloured where presence is more likely than 50 %
  let hydro = { rivers: [], lakes: [] };
  let riversExt = [];


  // ---- Zoom & pan ---------------------------------------------------------
  const zoom = d3.zoom()
    .scaleExtent([CONFIG.zoom.min, CONFIG.zoom.max])
    .on('zoom', (event) => {
      transform = event.transform;
      zoomLayer.attr('transform', transform);
      drawScreenLines();
      updateRiverDetail();
      scheduleLabels();
    });
  svg.call(zoom).on('dblclick.zoom', null);

  // ---- Size: fit the projection to the element ---------------------------
  function resize() {
    const rect = svgEl.getBoundingClientRect();
    width = Math.max(1, rect.width);
    height = Math.max(1, rect.height);
    svg.attr('viewBox', `0 0 ${width} ${height}`);
    // Thinner rivers on small screens (used in styles.css as --rs)
    svgEl.style.setProperty('--rs', String(Math.max(0.45, Math.min(1, width / 1200))));
    ocean.attr('width', width).attr('height', height);
    projection.fitExtent([[8, 8], [width - 8, height - 8]], { type: 'Sphere' });
    zoom.extent([[0, 0], [width, height]]).translateExtent([[0, 0], [width, height]]);
    redrawGeometry();
  }

  function redrawGeometry() {
    sphere.attr('d', path({ type: 'Sphere' }));
    graticule.attr('d', path(d3.geoGraticule10()));
    if (land) landPath.attr('d', path(land));
    drawHatchClip();
    countriesG.selectAll('path').attr('d', path);
    defs.selectAll('clipPath.stripes path').attr('d', path);
    lakesG.selectAll('path').attr('d', path);
    riversG.selectAll('path').attr('d', d => path(d.f));
    iceCoverG.selectAll('path').attr('d', path);
    drawSelection();
    drawScreenLines();
    anchors = computeLabelAnchors(features, path);
    scheduleLabels();
  }

  // ---- "No data" hatching and overlap stripes (lines, not patterns) --------
  const HATCH = 7;  // px on screen between hatch lines
  const STRIPE = 4; // px on screen, width of one stripe
  // The part of the map (in projected, un-zoomed coordinates) visible on screen
  function visibleBox() {
    const [x0, y0] = transform.invert([0, 0]);
    const [x1, y1] = transform.invert([width, height]);
    return [x0, y0, x1, y1];
  }
  function drawHatchClip() {
    const area = reviewedArea || land;
    hatchClip.attr('d', reviewed && area ? path(area) : null);
  }
  // Diagonal lines over the visible part of the map, HATCH px apart on screen
  function hatchPath() {
    const [x0, y0, x1, y1] = visibleBox();
    const s = HATCH * Math.SQRT2 / transform.k;   // horizontal step of 45° lines
    const h = y1 - y0;
    let d = '';
    for (let x = Math.floor((x0 - h) / s) * s; x <= x1; x += s) {
      d += `M${x.toFixed(2)},${y1.toFixed(2)}L${(x + h).toFixed(2)},${y0.toFixed(2)}`;
    }
    return d;
  }
  // Vertical bars, STRIPE px wide and 2·STRIPE px apart on screen, over a box
  function barsPath([[bx0, by0], [bx1, by1]]) {
    const [x0, y0, x1, y1] = visibleBox();
    const left = Math.max(bx0, x0), right = Math.min(bx1, x1);
    const top = Math.max(by0, y0), bottom = Math.min(by1, y1);
    if (left >= right || top >= bottom) return null;
    const w = STRIPE / transform.k;
    let d = '';
    for (let x = Math.floor(left / (2 * w)) * 2 * w + w; x < right; x += 2 * w) {
      d += `M${x.toFixed(2)},${top.toFixed(2)}h${w.toFixed(3)}V${bottom.toFixed(2)}h${(-w).toFixed(3)}Z`;
    }
    return d;
  }
  function drawScreenLines() {
    hatchLines.attr('d', reviewed ? hatchPath() : null);
    stripesG.selectAll('g.stripe-bars path').attr('d', d => barsPath(path.bounds(d)));
  }

  // Overlaps (map 1): the shape is filled with the first colour (countries layer);
  // the second colour is drawn on top as bars clipped to the shape
  function drawStripes() {
    const overlaps = features.filter(f => f.properties?.KIND === 'overlap');
    overlaps.forEach((f, i) => { f.stripeId = `stripes-${i}`; });
    const clips = defs.selectAll('clipPath.stripes').data(overlaps, d => d.stripeId)
      .join(enter => { const c = enter.append('clipPath').attr('class', 'stripes'); c.append('path'); return c; })
      .attr('id', d => d.stripeId);
    clips.select('path').attr('d', path);
    stripesG.selectAll('g.stripe-bars').data(overlaps, d => d.stripeId)
      .join(enter => { const g = enter.append('g').attr('class', 'stripe-bars'); g.append('path'); return g; })
      .attr('clip-path', d => `url(#${d.stripeId})`)
      .select('path').style('fill', d => stripeColors(d.properties)[1]);
  }

  function fillOf(d) {
    return d.properties?.KIND === 'overlap' ? stripeColors(d.properties)[0] : fillFor(d.properties);
  }

  // ---- Countries ----------------------------------------------------------
  function drawCountries() {
    drawStripes();
    countriesG.selectAll('path')
      .data(features)
      .join('path')
      .attr('d', path)
      .attr('class', d => `country prec-${d.properties?.BORDERPRECISION || 1}`
        + (d.properties?.NAME ? '' : ' unnamed')
        + (d.properties?.KIND === 'uninhabited' ? ' uninhabited' : '')
        + (d.properties?.KIND === 'overlap' ? ` overlap${d.properties.AREA ? ' overlap-same' : ''}` : ''))
      .style('fill', fillOf);
    iceCoverG.selectAll('path')
      .data(features.filter(f => f.properties?.NOTE === 'uninhabited-ice'))
      .join('path').attr('d', path).style('fill', d => fillFor(d.properties));
    anchors = computeLabelAnchors(features, path);
    drawSelection();
    drawScreenLines();
    scheduleLabels();
  }

  function drawSelection() {
    const parts = selected ? features.filter(f => selectionKey(f.properties) === selected) : [];
    selectionPath.attr('d', parts.length ? path({ type: 'FeatureCollection', features: parts }) : null);
    countriesG.selectAll('path').classed('is-selected', d => selected && selectionKey(d.properties) === selected);
  }

  // ---- Rivers and lakes ---------------------------------------------------
  function drawHydro() {
    lakesG.selectAll('path').data(hydro.lakes).join('path')
      .attr('class', d => `lake r-${d.properties.r}`).attr('d', path);
    const rivers = hydro.rivers.map(f => ({ f, ext: false })).concat(riversExt.map(f => ({ f, ext: true })));
    riversG.selectAll('path').data(rivers).join('path')
      .attr('class', d => `river r-${Math.min(6, d.f.properties.r)}${d.ext ? ' ext' : ''}`)
      .attr('d', d => path(d.f));
    updateRiverDetail();
  }

  let shownRank = 0;
  function updateRiverDetail() {
    let rank = 0;
    for (const [k, r] of CONFIG.rivers) if (transform.k >= k) rank = r;
    if (rank === shownRank) return;
    shownRank = rank;
    riversG.selectAll('path').attr('display', d => (d.f.properties.r <= rank ? null : 'none'));
    lakesG.selectAll('path').attr('display', d => (d.properties.r <= rank + 1 ? null : 'none'));
  }

  // ---- Labels (throttled to one update per animation frame) --------------
  let labelFrame = 0;
  function scheduleLabels() {
    if (labelFrame) return;
    labelFrame = requestAnimationFrame(() => {
      labelFrame = 0;
      const placed = layoutLabels(anchors, transform, width, height, placeName);
      labelsG.selectAll('text')
        .data(placed, d => d.name)
        .join('text')
        .attr('x', d => d.x)
        .attr('y', d => d.y)
        .attr('font-size', d => d.fontSize)
        .classed('is-major', d => d.major)
        .classed('is-selected', d => selected && (d.name === selected || d.name === String(selected).split('::')[0]))
        .text(d => d.text);
    });
  }

  // ---- Hover tooltip (mouse only) and click --------------------------------
  countriesG
    .on('pointermove', (event) => {
      if (event.pointerType !== 'mouse') return;
      const d = d3.select(event.target).datum();
      const name = d?.properties?.NAME;
      const p = d?.properties;
      const text = p?.KIND === 'uninhabited' ? t('uninhabited')
        : p?.SPECIES && p?.KIND !== 'overlap' && p?.AREA ? `${placeName(p.AREA)} · ${placeName(name)}`
        : p?.AREA ? placeName(p.AREA)
        : name ? placeName(name)
        : inReviewed(event) ? t('noData')
        : probability ? t('lowProb') : '';
      if (!text) { tooltipEl.hidden = true; return; }
      tooltipEl.textContent = text;
      tooltipEl.hidden = false;
      const box = svgEl.getBoundingClientRect();
      tooltipEl.style.left = `${event.clientX - box.left + 14}px`;
      tooltipEl.style.top = `${event.clientY - box.top + 14}px`;
    })
    .on('pointerleave', () => { tooltipEl.hidden = true; });

  svg.on('click', (event) => {
    const el = event.target;
    const d = el.__data__;
    const key = el.classList.contains('country') ? selectionKey(d?.properties) : null;
    const emptyLand = el.classList.contains('land') || (el.classList.contains('country') && !key);
    onSelect(key || (emptyLand && inReviewed(event) ? NO_DATA : emptyLand && probability ? LOW_PROB : null));
  });

  // Is the pointer over the reviewed part of the map? (whole map unless reviewed only in part)
  function inReviewed(event) {
    if (!reviewed) return false;
    if (!reviewedArea) return true;
    const box = svgEl.getBoundingClientRect();
    const p = transform.invert([event.clientX - box.left, event.clientY - box.top]);
    const lonLat = projection.invert(p);
    return Boolean(lonLat) && d3.geoContains(reviewedArea, lonLat);
  }

  window.addEventListener('resize', () => resize());
  resize();

  return {
    setLand(geo) { land = geo; landPath.attr('d', path(land)); drawHatchClip(); },
    setReviewedArea(geo) { reviewedArea = geo; drawHatchClip(); },
    setHydro(next) { hydro = next; shownRank = 0; drawHydro(); },
    setRiversExt(next) { riversExt = next; shownRank = 0; drawHydro(); },
    setFeatures(next) { features = next; drawCountries(); },
    setSelected(name) { selected = name; drawSelection(); scheduleLabels(); },
    refreshLabels() { scheduleLabels(); },
    // mode: 'finds' (dated finds, "No data" hatching), 'probability' (map 1) or null
    setMode(mode) {
      reviewed = mode === 'finds';
      probability = mode === 'probability';
      svg.classed('is-reviewed', reviewed).classed('is-probability', probability);
      drawHatchClip();
      drawScreenLines();
    },
    hasCountry(key) { return features.some(f => selectionKey(f.properties) === key); },
    featuresByName(key) { return features.filter(f => selectionKey(f.properties) === key); },
    zoomIn() { svg.transition().duration(250).call(zoom.scaleBy, 1.6); },
    zoomOut() { svg.transition().duration(250).call(zoom.scaleBy, 1 / 1.6); },
    resetZoom() { svg.transition().duration(400).call(zoom.transform, d3.zoomIdentity); },
  };
}
