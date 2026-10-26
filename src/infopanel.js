// =============================================================================
// infopanel.js — the card that appears when a country is clicked.
//
// Shows: name, the power that rules it, its cultural area, how precise the
// borders are, a note and sources (for our culture zones), and a link to Wikipedia. If the selected country does not
// exist on the current year's map, the card says so (the selection is kept,
// so it reappears when you move to a year where it exists).
//
//   const panel = createInfoPanel(element, { onClose })
//   panel.show(key, features, year, lookup)
//                                      — key: NAME or "NAME::AREA" (one area of a group
//                                        of zones: title = AREA, subtitle = group NAME);
//                                        features: all pieces with this key;
//                                        lookup(key) -> features (for overlaps: the card
//                                        shows both overlapping zones, keys in PARTS)
//   panel.showNoData(year)             — empty land on a map drawn from finds (map 2)
//   panel.showLowProbability(year)     — empty land on map 1 ("probability below 50 %")
//   panel.hide()
// =============================================================================

import { t, placeName, hasTranslatedName, formatYear, getLanguage, note } from './i18n.js';

const PRECISION_KEYS = { 1: 'precision1', 2: 'precision2', 3: 'precision3' };

export function createInfoPanel(el, { onClose }) {
  const title = el.querySelector('#info-name');
  const body = el.querySelector('#info-body');
  const link = el.querySelector('#info-wiki');
  el.querySelector('#info-close').addEventListener('click', onClose);

  function row(label, value) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    return [dt, dd];
  }

  function wikiUrl(name) {
    // Use the current language's Wikipedia only when we have a translated name
    const translated = hasTranslatedName(name);
    const host = translated ? t('wikipediaHost') : 'en.wikipedia.org';
    const query = translated ? placeName(name) : name;
    return `https://${host}/wiki/Special:Search?search=${encodeURIComponent(query)}&go=Go`;
  }

  // Card for empty land: "No data" (map drawn from finds) or "below 50 %" (map 1)
  function showEmpty(titleKey, textKey, year) {
    title.textContent = t(titleKey);
    body.innerHTML = '';
    const para = document.createElement('p');
    para.className = 'info-text';
    para.textContent = t(textKey, { year: formatYear(year) });
    body.appendChild(para);
    link.hidden = true;
    el.hidden = false;
  }
  const showNoData = (year) => showEmpty('noData', 'noDataText', year);
  const showLowProbability = (year) => showEmpty('lowProb', 'lowProbText', year);

  // Note and sources of one of our zones
  function appendNoteAndSources(p) {
    const text = note(p.NOTE);
    if (text) {
      const para = document.createElement('p');
      para.className = 'info-text';
      para.textContent = text;
      body.appendChild(para);
    }
    const sources = String(p.SOURCES || '').split('|').map(x => x.trim()).filter(Boolean);
    if (!sources.length) return;
    const h = document.createElement('p');
    h.className = 'info-sources-title';
    h.textContent = t('sources');
    const ul = document.createElement('ul');
    ul.className = 'info-sources';
    for (const url of sources) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = sourceLabel(url);
      li.appendChild(a);
      ul.appendChild(li);
    }
    body.append(h, ul);
  }

  // Overlap of two zones (map 1): both zones, one after the other
  function showOverlap(p, lookup) {
    title.textContent = placeName(p.AREA || p.NAME);
    body.innerHTML = '';
    const sub = document.createElement('p');
    sub.className = 'info-group';
    sub.textContent = p.AREA ? `${placeName(p.NAME)} · ${t('overlapCultures')}` : t('overlapSpecies');
    body.appendChild(sub);
    for (const partKey of String(p.PARTS || '').split('|').map(x => x.trim()).filter(Boolean)) {
      const part = lookup(partKey)[0]?.properties;
      if (!part) continue;
      const h = document.createElement('h3');
      h.className = 'info-part';
      h.textContent = placeName(part.AREA || part.NAME);
      const ps = document.createElement('p');
      ps.className = 'info-group';
      ps.textContent = placeName(part.NAME);
      body.append(h, ps);
      appendNoteAndSources(part);
    }
    link.hidden = true;
    el.hidden = false;
  }

  function show(key, features, year, lookup = () => []) {
    if (features[0]?.properties?.KIND === 'overlap') { showOverlap(features[0].properties, lookup); return; }
    const [name, area] = String(key).split('::');
    const uninhabited = features[0]?.properties?.KIND === 'uninhabited';
    title.textContent = uninhabited ? t('uninhabited') : placeName(area || name);
    body.innerHTML = '';
    if (area) {
      // One area of a group of zones: the group's common name as a subtitle
      const sub = document.createElement('p');
      sub.className = 'info-group';
      sub.textContent = placeName(name);
      body.appendChild(sub);
    }
    const dl = document.createElement('dl');

    if (!features.length) {
      const note = document.createElement('p');
      note.className = 'info-note';
      note.textContent = t('notOnThisMap', { year: formatYear(year) });
      body.appendChild(note);
    } else {
      const p = features[0].properties || {};
      if (uninhabited) {
        // no "ruled by" / borders rows for uninhabited land
      } else if (p.SUBJECTO && p.SUBJECTO !== name) dl.append(...row(t('ruledBy'), placeName(p.SUBJECTO)));
      if (!uninhabited && p.PARTOF && p.PARTOF !== name && p.PARTOF !== p.SUBJECTO) dl.append(...row(t('partOf'), placeName(p.PARTOF)));
      if (!uninhabited) {
        const prec = p.BORDERPRECISION || 1;
        const [dt, dd] = row(t('borders'), '');
        const chip = document.createElement('span');
        chip.className = `chip prec-${prec}`;
        chip.textContent = t(PRECISION_KEYS[prec] || 'precision1');
        dd.appendChild(chip);
        dl.append(dt, dd);
        body.appendChild(dl);
      }

      // Our culture zones carry a note (NOTE = key in translations/notes/<lang>.json)
      // and sources ("url | url | ...")
      appendNoteAndSources(p);
    }

    // Our zones list their own sources, so the generic Wikipedia search is hidden
    link.hidden = Boolean(features[0]?.properties?.SOURCES);
    link.href = wikiUrl(name);
    link.lang = hasTranslatedName(name) ? getLanguage() : 'en';
    el.hidden = false;
  }

  // "https://en.wikipedia.org/wiki/Swiderian_culture" -> "en.wikipedia.org — Swiderian culture"
  function sourceLabel(url) {
    try {
      const u = new URL(url);
      const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '').replace(/_/g, ' ');
      return last && u.hostname.includes('wikipedia') ? `${u.hostname.replace('www.', '')} — ${last}` : u.hostname.replace('www.', '');
    } catch {
      return url;
    }
  }

  return {
    show,
    showNoData,
    showLowProbability,
    hide() { el.hidden = true; },
  };
}
