// =============================================================================
// timeline.js — the time slider at the bottom of the page.
//
// The slider moves between the AVAILABLE maps (not every year exists in the
// data). Each step = the next map. Buttons: previous, play/pause, next.
// Keyboard: ← / → anywhere on the page (except inside form fields).
//
//   const timeline = createTimeline(rootElement, years, { onChange, onTogglePlay })
//   timeline.update(year, playing)   — reflect the current state
//   timeline.refreshTexts()          — after a language change
// =============================================================================

import { formatYear, formatYearShort, t } from './i18n.js';

// Years that get a printed label under the slider (nearest map is used)
const LANDMARKS = [-10000, -3000, -1, 500, 1000, 1500, 1800, 2010];

export function createTimeline(root, years, { onChange, onTogglePlay }) {
  const slider = root.querySelector('#year-slider');
  const yearText = root.querySelector('#year-readout');
  const stepText = root.querySelector('#year-step');
  const ticks = root.querySelector('#timeline-ticks');
  const prevBtn = root.querySelector('#btn-prev');
  const nextBtn = root.querySelector('#btn-next');
  const playBtn = root.querySelector('#btn-play');

  const list = years.map(y => y.year);
  slider.min = 0;
  slider.max = list.length - 1;
  slider.step = 1;

  let currentIndex = 0;

  function go(index) {
    const i = Math.max(0, Math.min(list.length - 1, index));
    if (i !== currentIndex) onChange(list[i]);
  }

  slider.addEventListener('input', () => go(Number(slider.value)));
  prevBtn.addEventListener('click', () => go(currentIndex - 1));
  nextBtn.addEventListener('click', () => go(currentIndex + 1));
  playBtn.addEventListener('click', () => onTogglePlay());

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea, button')) return;
    if (e.key === 'ArrowLeft') { go(currentIndex - 1); e.preventDefault(); }
    if (e.key === 'ArrowRight') { go(currentIndex + 1); e.preventDefault(); }
  });

  // One small mark per available map + labels for landmark years
  function drawTicks() {
    const last = list.length - 1;
    const labelIdx = new Set(LANDMARKS.map(y => nearestIndex(y)));
    ticks.innerHTML = '';
    list.forEach((year, i) => {
      const mark = document.createElement('span');
      mark.className = 'tick' + (labelIdx.has(i) ? ' has-label' : '');
      mark.style.left = `${(i / last) * 100}%`;
      if (labelIdx.has(i)) {
        const lbl = document.createElement('span');
        lbl.className = 'tick-label' + (year < 0 && year > -5000 && year !== -1 ? ' optional' : '');
        lbl.textContent = formatYearShort(year);
        mark.appendChild(lbl);
      }
      ticks.appendChild(mark);
    });
  }

  function nearestIndex(target) {
    let best = 0;
    list.forEach((y, i) => { if (Math.abs(y - target) < Math.abs(list[best] - target)) best = i; });
    return best;
  }

  function update(year, playing) {
    currentIndex = list.indexOf(year);
    slider.value = currentIndex;
    slider.setAttribute('aria-valuetext', formatYear(year));
    yearText.textContent = formatYear(year);
    stepText.textContent = t('mapStep', { i: currentIndex + 1, n: list.length });
    prevBtn.disabled = currentIndex === 0;
    nextBtn.disabled = currentIndex === list.length - 1;
    playBtn.classList.toggle('is-playing', playing);
    playBtn.setAttribute('aria-label', t(playing ? 'pause' : 'play'));
    playBtn.setAttribute('title', t(playing ? 'pause' : 'play'));
    [...ticks.children].forEach((el, i) => el.classList.toggle('is-current', i === currentIndex));
  }

  drawTicks();

  return {
    update,
    refreshTexts: drawTicks,
    nextYear(year) { const i = list.indexOf(year); return i < list.length - 1 ? list[i + 1] : null; },
    firstYear: list[0],
    lastYear: list[list.length - 1],
  };
}
