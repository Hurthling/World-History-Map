// =============================================================================
// i18n.js — translations.
//
// Two kinds of texts:
//   1. Interface texts (buttons, labels): translations/ui/<lang>.json
//      Use t('key') or t('key', { n: 5 }) for texts with placeholders {n}.
//   3. Notes shown in the country card (our culture zones):
//      translations/notes/<lang>.json, key = NOTE field of the zone. Use note('key').
//   2. Country / region names: translations/names/<lang>.json
//      A simple map "English name" -> "translated name".
//      Use placeName('Ottoman Empire'). If no translation exists, the
//      English name from the data is shown (so partial translations are fine).
//
// To add a language: see translations/README.md
// =============================================================================

import { CONFIG } from './config.js';

let ui = {};          // current interface texts
let uiFallback = {};  // English interface texts (used for missing keys)
let names = {};       // current name translations
let notes = {};       // current notes for culture zones
let notesFallback = {};
let currentLang = CONFIG.fallbackLanguage;
let languages = [];

async function loadJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

// List of languages offered in the switcher
export async function loadLanguages() {
  languages = await loadJson(CONFIG.paths.languages);
  uiFallback = await loadJson(CONFIG.paths.ui(CONFIG.fallbackLanguage));
  try { notesFallback = await loadJson(CONFIG.paths.notes(CONFIG.fallbackLanguage)); } catch { notesFallback = {}; }
  return languages;
}

// Pick the starting language: saved choice -> browser language -> fallback
export function pickInitialLanguage(saved) {
  const codes = languages.map(l => l.code);
  if (saved && codes.includes(saved)) return saved;
  for (const pref of navigator.languages || [navigator.language]) {
    const code = String(pref).slice(0, 2).toLowerCase();
    if (codes.includes(code)) return code;
  }
  return CONFIG.fallbackLanguage;
}

export async function setLanguage(lang) {
  ui = lang === CONFIG.fallbackLanguage ? uiFallback : await loadJson(CONFIG.paths.ui(lang));
  try {
    names = await loadJson(CONFIG.paths.names(lang));
  } catch {
    names = {}; // no name translations for this language yet — that's fine
  }
  try {
    notes = lang === CONFIG.fallbackLanguage ? notesFallback : await loadJson(CONFIG.paths.notes(lang));
  } catch {
    notes = {};
  }
  currentLang = lang;
  document.documentElement.lang = lang;
}

export function getLanguage() {
  return currentLang;
}

// Interface text by key, with {placeholders}
export function t(key, params = {}) {
  const text = ui[key] ?? uiFallback[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (_, k) => (params[k] ?? `{${k}}`));
}

// Country / region name in the current language (falls back to English)
export function placeName(englishName) {
  if (!englishName) return '';
  return names[englishName] || englishName;
}

// Note text for a culture zone (falls back to English; empty if none)
export function note(key) {
  if (!key) return '';
  return notes[key] || notesFallback[key] || '';
}

export function hasTranslatedName(englishName) {
  return Boolean(names[englishName]);
}

// Year as text: -500 -> "500 BC", 1492 -> "1492 AD" (format comes from ui file)
export function formatYear(year) {
  const abs = Math.abs(year);
  const n = abs >= 10000
    ? new Intl.NumberFormat(currentLang).format(abs)
    : String(abs);
  return t(year < 0 ? 'yearBC' : 'yearAD', { n });
}

// Short form for timeline tick marks
export function formatYearShort(year) {
  const abs = Math.abs(year);
  const n = abs >= 10000
    ? new Intl.NumberFormat(currentLang, { notation: 'compact' }).format(abs)
    : String(abs);
  return year < 0 ? t('yearBCShort', { n }) : n;
}

// Fills every element that has data-i18n="key" with the translated text
export function applyToDocument(root = document) {
  root.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  root.querySelectorAll('[data-i18n-label]').forEach(el => {
    el.setAttribute('aria-label', t(el.dataset.i18nLabel));
    el.setAttribute('title', t(el.dataset.i18nLabel));
  });
  document.title = t('appTitle');
}
