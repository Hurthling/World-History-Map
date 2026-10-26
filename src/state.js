// =============================================================================
// state.js — the single source of truth for what the page is showing.
//
// Any module can read `state.get()` and call `state.set({...})`.
// Modules that need to react to changes call `state.subscribe(fn)`.
//
// State fields:
//   year      — the year of the map currently shown (one of the available years)
//   lang      — interface language code, e.g. "en", "ru"
//   selected  — key of the clicked country: its NAME, or "NAME::AREA" for one area
//               of a group of zones (see selectionKey in map.js); NO_DATA / LOW_PROB (empty land); or null
//   playing   — true while autoplay runs
// =============================================================================

// Special value of `selected`: the user clicked empty land on a reviewed map
export const NO_DATA = '__no_data__';
// ...and on a "probability" map (map 1): presence of people here is below 50 %
export const LOW_PROB = '__low_probability__';

const listeners = new Set();
let current = { year: null, lang: 'en', selected: null, playing: false };

export const state = {
  get() {
    return current;
  },
  set(patch) {
    const prev = current;
    current = { ...current, ...patch };
    for (const fn of listeners) fn(current, prev);
  },
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

// --- URL hash: lets a link open a specific year, e.g. index.html#y1492 ------
// Format: "#y<year>", negative for BC: "#y-500". (Only letters, digits and "-"
// are used so the link also survives hosting that strips other characters.)

export function readYearFromHash() {
  const m = /^#y(-?\d+)$/.exec(window.location.hash);
  return m ? Number(m[1]) : null;
}

export function writeYearToHash(year) {
  const hash = `#y${year}`;
  if (window.location.hash !== hash) {
    history.replaceState(null, '', hash);
  }
}

// --- Small wrapper around localStorage (it can be blocked in some browsers) --

export const storage = {
  get(key) {
    try { return window.localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { window.localStorage.setItem(key, value); } catch { /* ignore */ }
  },
};
