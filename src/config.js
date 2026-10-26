// =============================================================================
// config.js — all tunable settings in one place.
// Change values here instead of hunting through the code.
// =============================================================================

export const CONFIG = {
  // Where data files live (relative to index.html)
  paths: {
    index: 'data/index.json',          // list of available years
    land: 'data/land.json',            // world land outline (background)
    hydro: 'data/hydro.json',          // rivers and lakes (today's, Natural Earth)
    dataRoot: 'data/',                 // border files are listed in index.json
    languages: 'translations/languages.json',
    ui: (lang) => `translations/ui/${lang}.json`,       // interface texts
    names: (lang) => `translations/names/${lang}.json`, // country names
    notes: (lang) => `translations/notes/${lang}.json`, // notes for culture zones
  },

  // Year shown when the page opens (the nearest available map is used)
  defaultYear: 1500,

  // Language used when the browser language is not available
  fallbackLanguage: 'en',

  // Map zoom limits (1 = whole world)
  zoom: { min: 1, max: 40 },

  // Autoplay: milliseconds between maps
  playIntervalMs: 1600,

  // Labels: a country gets a label only if its largest piece covers at least
  // this many screen pixels (area). Smaller = more labels.
  labels: {
    minArea: 900,
    minFont: 9,
    maxFont: 20,
    cultureZoom: 2.5,   // map 1: culture labels appear from this zoom on
  },

  // Rivers: which size ranks are shown at which zoom (1 = largest rivers).
  // [zoom from, largest rank shown]; the last matching row wins.
  rivers: [[1, 3], [1.8, 5], [4, 6]],
};
