// =============================================================================
// colors.js — picks a fill colour for each country.
//
// Map 1 zones are coloured by species and culture (see SHADES below).
// Other zones: a colour set by hand (COLOR — written by the build from
// corrections/colors.json, our culture zones only), else the colour is derived
// from the zone's colour group (GROUP, our zones only), else the country's ruling
// power (SUBJECTO), or its own NAME. The same name always gets the same colour, so an empire keeps its
// colour as you move through time, and colonies share the colour of the
// metropole.
//
// One palette for states and culture zones (map 8000, items 3-70 and 3-87):
// styles.css, --polity-0 … --polity-17, separately for light and dark themes.
// Here we only choose the index.
// =============================================================================

export const PALETTE_SIZE = 18;

// Simple, stable string hash (same input -> same number, every time)
export function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Map 1: human species (SPECIES) are the main colour, archaeological cultures
// (CULTURE) are shades of it. Colours: styles.css, --sp-<species>-<0..4>
// (0 = the species without a named culture). Here: which shade a culture gets.
const SHADES = {
  sapiens: { msa: 1, aterian: 2, nubian: 3, 'levantine-mousterian': 4 },
  neanderthal: { mousterian: 1, taubachian: 2, 'altai-mp': 3 },
  denisovan: { 'altai-mp': 1 },
  unknown: { 'levantine-mousterian': 1 },
};

export function speciesColor(species, culture) {
  const shade = (culture && SHADES[species]?.[culture]) || 0;
  return `var(--sp-${species}-${shade})`;
}

// Overlap of two zones (KIND "overlap"): the two colours of its stripes
export function stripeColors(props) {
  const sp = String(props.SPECIES).split('|');
  const cu = String(props.CULTURE || '|').split('|');
  return [speciesColor(sp[0], cu[0]), speciesColor(sp[1], cu[1])];
}

// Returns a CSS colour value for a feature's properties
// (overlaps are filled with a stripe pattern in map.js instead)
export function fillFor(props) {
  if (props?.KIND === 'uninhabited') return 'var(--uninhabited)';
  if (props?.SPECIES) return speciesColor(props.SPECIES, props.CULTURE);
  const i = paletteIndex(props);
  return i == null ? 'var(--land-unclaimed)' : `var(--polity-${i})`;
}

// Index in the common palette (also used by tools/check-colors.mjs), or null for unnamed land
export function paletteIndex(props) {
  // COLOR (our zones): set by hand in corrections/colors.json
  if (props?.COLOR != null) return Number(props.COLOR) % PALETTE_SIZE;
  // GROUP (our zones): several zones of one population share a colour
  const key = props?.GROUP || props?.SUBJECTO || props?.NAME;
  if (!key) return null;
  return hash(key) % PALETTE_SIZE;
}
