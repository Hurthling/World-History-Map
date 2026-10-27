// =============================================================================
// main.js — starts the app and connects all parts together.
//
// Flow:
//   1. Load languages and interface texts.
//   2. Load the list of available years (data/index.json).
//   3. Create the map, the timeline and the info panel.
//   4. Whenever the state changes (year / language / selection / playing),
//      update the parts that depend on it.
//
// Modules (all in src/):
//   config.js    settings            state.js     current state + URL hash
//   i18n.js      translations        data.js      loading map files
//   map.js       drawing the map     labels.js    placing country names
//   colors.js    country colours     timeline.js  year slider
//   infopanel.js country card
// =============================================================================

import { CONFIG } from './config.js';
import { state, readYearFromHash, writeYearToHash, storage, NO_DATA, LOW_PROB } from './state.js';
import * as i18n from './i18n.js';
import * as data from './data.js';
import { createMap } from './map.js';
import { createTimeline } from './timeline.js';
import { createInfoPanel } from './infopanel.js';

const $ = (sel) => document.querySelector(sel);

async function start() {
  // --- 1. Languages ---------------------------------------------------------
  const languages = await i18n.loadLanguages();
  const lang = i18n.pickInitialLanguage(storage.get('lang'));
  await i18n.setLanguage(lang);
  i18n.applyToDocument();
  buildLanguageSwitch(languages);

  // --- 2. Data index ----------------------------------------------------------
  const years = await data.loadIndex();

  // --- 3. UI parts --------------------------------------------------------------
  const map = createMap($('#map'), $('#tooltip'), {
    onSelect: (name) => state.set({ selected: name }),
  });
  const timeline = createTimeline($('#timeline'), years, {
    onChange: (year) => state.set({ year, playing: false }),
    onTogglePlay: togglePlay,
  });
  const panel = createInfoPanel($('#info'), {
    onClose: () => state.set({ selected: null }),
  });

  // Rivers and lakes are the same on all maps: load once, in the background
  data.loadHydro().then(h => map.setHydro(h)).catch(err => console.warn('rivers:', err));

  $('#btn-zoom-in').addEventListener('click', () => map.zoomIn());
  $('#btn-zoom-out').addEventListener('click', () => map.zoomOut());
  $('#btn-zoom-reset').addEventListener('click', () => map.resetZoom());

  // --- 4. React to state changes -----------------------------------------------
  let loadToken = 0;
  async function showYear(year) {
    const token = ++loadToken;
    document.body.classList.add('is-loading');
    try {
      const [features, land, riversExt, reviewedArea] = await Promise.all([
        data.loadYear(year), data.loadLand(year), data.loadRiversExt(year).catch(() => []),
        data.loadReviewedArea(year),
      ]);
      if (token !== loadToken) return; // a newer year was requested meanwhile
      map.setLand(land);
      map.setReviewedArea(reviewedArea);
      map.setRiversExt(riversExt);
      const mode = data.mapMode(year);
      map.setMode(mode);
      map.setFeatures(features);
      showSeaLevel(year);
      showRiversNote(year);
      showLegend(mode, year);
      refreshPanel();
      data.prefetchYear(timeline.nextYear(year));
    } catch (err) {
      showError(err);
    } finally {
      if (token === loadToken) document.body.classList.remove('is-loading');
    }
  }

  function refreshPanel() {
    const { selected, year } = state.get();
    if (!selected) { panel.hide(); return; }
    if (selected === NO_DATA || selected === LOW_PROB) {
      const mode = data.mapMode(year);
      if (selected === NO_DATA && mode === 'finds') panel.showNoData(year);
      else if (selected === LOW_PROB && mode === 'probability') panel.showLowProbability(year);
      else panel.hide();
      return;
    }
    // map.featuresByName also finds the two zones of an overlap (their keys are in PARTS)
    panel.show(selected, map.featuresByName(selected), year, (key) => map.featuresByName(key));
  }

  state.subscribe(async (now, prev) => {
    if (now.year !== prev.year) {
      writeYearToHash(now.year);
      timeline.update(now.year, now.playing);
      showYear(now.year);
    }
    if (now.playing !== prev.playing) timeline.update(now.year, now.playing);
    if (now.selected !== prev.selected) {
      map.setSelected(now.selected);
      refreshPanel();
    }
    if (now.lang !== prev.lang) {
      await i18n.setLanguage(now.lang);
      storage.set('lang', now.lang);
      i18n.applyToDocument();
      markActiveLanguage(now.lang);
      timeline.refreshTexts();
      timeline.update(now.year, now.playing);
      map.refreshLabels();
      refreshPanel();
      showSeaLevel(now.year);
      showRiversNote(now.year);
      showLegend(data.mapMode(now.year), now.year);
    }
  });

  // --- Autoplay -------------------------------------------------------------------
  let playTimer = null;
  function togglePlay() {
    const { playing, year } = state.get();
    if (playing) { state.set({ playing: false }); return; }
    if (year === timeline.lastYear) state.set({ year: timeline.firstYear });
    state.set({ playing: true });
  }
  state.subscribe((now, prev) => {
    if (now.playing === prev.playing) return;
    clearInterval(playTimer);
    if (!now.playing) return;
    playTimer = setInterval(() => {
      const next = timeline.nextYear(state.get().year);
      if (next == null) { state.set({ playing: false }); return; }
      state.set({ year: next, playing: true });
    }, CONFIG.playIntervalMs);
  });

  // --- Initial year: from the link (#y1492) or the default ----------------------
  window.addEventListener('hashchange', () => {
    const y = readYearFromHash();
    if (y != null) state.set({ year: data.nearestYear(y), playing: false });
  });
  const startYear = data.nearestYear(readYearFromHash() ?? CONFIG.defaultYear);
  state.set({ lang, year: startYear });
}

// --- Language switch (buttons generated from translations/languages.json) ---------
function buildLanguageSwitch(languages) {
  const box = $('#lang-switch');
  box.innerHTML = '';
  for (const l of languages) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = l.short;
    b.lang = l.code;
    b.title = l.label;
    b.dataset.lang = l.code;
    b.addEventListener('click', () => state.set({ lang: l.code }));
    box.appendChild(b);
  }
  markActiveLanguage(i18n.getLanguage());
}

function markActiveLanguage(code) {
  document.querySelectorAll('#lang-switch button').forEach(b => {
    b.setAttribute('aria-pressed', String(b.dataset.lang === code));
  });
}

// Small note under the year: the ancient coastline's sea level, or a note
// about the coastline (e.g. map 1: "the coastline is today's")
function showSeaLevel(year) {
  const el = $('#sea-level');
  const level = data.seaLevelFor(year);
  const note = data.coastNoteFor(year);
  if (level == null && !note) { el.hidden = true; $('#coast-note').hidden = true; return; }
  el.textContent = level != null ? i18n.t('seaLevel', { m: Math.abs(level) }) : i18n.t(note);
  el.hidden = false;
  // Both (maps 10 000 and 8000): the note goes on its own line under the sea level
  // ("levels of the Caspian, Black Sea and Baltic are approximate")
  const extra = $('#coast-note');
  extra.hidden = !(level != null && note);
  extra.textContent = extra.hidden ? '' : i18n.t(note);
}

// Legend: one for maps drawn from finds (map 2), another for map 1 (species).
// Both are collapsible with their "Legend" button: the map-1 legend starts collapsed
// (item 1-27), the other one open (item С-3). The reader's choice is remembered in the
// browser and kept when the year changes.
const LEGENDS = { '#legend': 'legendFindsOpen', '#legend-prob': 'legendProbOpen' };
let legendsReady = false;
function initLegends() {
  for (const [sel, key] of Object.entries(LEGENDS)) {
    const el = $(sel);
    const saved = storage.get(key);
    if (saved === '1') el.open = true;
    else if (saved === '0') el.open = false;
    el.addEventListener('toggle', () => storage.set(key, el.open ? '1' : '0'));
  }
  legendsReady = true;
}

function showLegend(mode, year) {
  if (!legendsReady) initLegends();
  $('#legend').hidden = mode !== 'finds';
  // A map reviewed only in part: say which parts
  const part = $('#legend-part');
  const note = data.reviewedNoteFor(year);
  part.hidden = !note;
  part.textContent = note ? i18n.t(note) : '';
  const prob = $('#legend-prob');
  prob.hidden = mode !== 'probability';
}

// Rivers and lakes are today's: say so on maps before our era
function showRiversNote(year) {
  const el = $('#rivers-note');
  if (year >= 0) { el.hidden = true; return; }
  el.textContent = i18n.t(data.seaLevelFor(year) != null ? 'riversModernExtended' : 'riversModern');
  el.hidden = false;
}

function showError(err) {
  console.error(err);
  const box = $('#error');
  box.textContent = i18n.t('loadError');
  box.hidden = false;
}

start().catch(showError);
