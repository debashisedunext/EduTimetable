/**
 * §10.5 — the subject and class colour code.
 *
 * A timetable grid is a wall of small text. Colour is what lets somebody find
 * every Maths period in a week at a glance instead of reading forty cells, and
 * it is the first thing a printed timetable is judged on.
 *
 * This module is the ONLY place a colour is chosen. If the Board, the Matrix
 * and the report grids each derived their own, Maths would be green on one
 * screen and blue on the next — which is worse than no colour at all, because
 * a reader would have learned something untrue. Same discipline as the rules
 * engine: one source, several call sites.
 *
 * Two properties the palette has to hold, and both are tested rather than
 * asserted (`palette.spec.ts`):
 *
 *  1. **Legible.** Every swatch's text is a dark shade of its own background's
 *     hue, and every pair clears WCAG AA (4.5:1) on that background *and* on
 *     white, since a cell can be drawn either way. The generated minimum is
 *     5.50:1 / 5.96:1 — deliberate headroom, so a later tweak cannot quietly
 *     drop a pair below the line.
 *  2. **Distinct.** Consecutive slots are far apart in hue, so two subjects
 *     that end up adjacent never look like the same colour.
 */

export interface Swatch {
  /** cell fill */
  bg: string;
  /** text — the same hue, dark enough to read on `bg` and on white */
  fg: string;
  /** a mid tone for borders and left bars */
  border: string;
}

/**
 * 32 swatches: 16 hues × 2 tones, ordered so neighbours differ in hue rather
 * than in shade. Generated against the contrast targets above; do not hand-edit
 * an entry without re-running the spec, which recomputes every ratio.
 */
export const PALETTE: readonly Swatch[] = [
  { bg: "#e6f0f9", fg: "#296199", border: "#b4cce4" },
  { bg: "#e6d7ef", fg: "#7f20b6", border: "#c1a0d4" },
  { bg: "#f9e9e6", fg: "#a33b2b", border: "#e4bab4" },
  { bg: "#e9efd7", fg: "#4f6412", border: "#c7d4a0" },
  { bg: "#e6f9f4", fg: "#1d6f5a", border: "#b4e4d8" },
  { bg: "#d7d9ef", fg: "#2032b6", border: "#a0a6d4" },
  { bg: "#f9e6f2", fg: "#a32b75", border: "#e4b4d2" },
  { bg: "#efe3d7", fg: "#824d17", border: "#d4baa0" },
  { bg: "#e6f9e6", fg: "#1e711e", border: "#b4e4b4" },
  { bg: "#d7ecef", fg: "#146471", border: "#a0cdd4" },
  { bg: "#f2e6f9", fg: "#7c2da9", border: "#d3b4e4" },
  { bg: "#efd7dd", fg: "#a31d3e", border: "#d4a0ad" },
  { bg: "#f4f9e6", fg: "#576b1c", border: "#d8e4b4" },
  { bg: "#d7efe0", fg: "#136a34", border: "#a0d4b4" },
  { bg: "#e6e8f9", fg: "#2d3ba9", border: "#b4b9e4" },
  { bg: "#efd7ef", fg: "#931a93", border: "#d4a0d4" },
  { bg: "#f9f0e6", fg: "#875524", border: "#e4ccb4" },
  { bg: "#e0efd7", fg: "#326812", border: "#b3d4a0" },
  { bg: "#e6f7f9", fg: "#206b77", border: "#b4dee4" },
  { bg: "#ddd7ef", fg: "#4620b6", border: "#ada0d4" },
  { bg: "#f9e6eb", fg: "#a92d4c", border: "#e4b4c0" },
  { bg: "#efecd7", fg: "#685e12", border: "#d4cea0" },
  { bg: "#e6f9ed", fg: "#1d6f3d", border: "#b4e4c6" },
  { bg: "#d7e3ef", fg: "#1b5998", border: "#a0bad4" },
  { bg: "#f9e6f9", fg: "#9b299b", border: "#e4b4e4" },
  { bg: "#efdad7", fg: "#9e2d1c", border: "#d4a7a0" },
  { bg: "#edf9e6", fg: "#3b6f1d", border: "#c5e4b4" },
  { bg: "#d7efe9", fg: "#126853", border: "#a0d4c7" },
  { bg: "#ebe6f9", fg: "#4c2da9", border: "#c0b4e4" },
  { bg: "#efd7e6", fg: "#9c1c6b", border: "#d4a0c0" },
  { bg: "#f9f7e6", fg: "#6d631d", border: "#e4dfb4" },
  { bg: "#d7efd7", fg: "#136a13", border: "#a0d4a0" },
];

/** What an uncoloured cell falls back to — the app's own neutral. */
export const NEUTRAL_SWATCH: Swatch = { bg: "#ffffff", fg: "#141b26", border: "#dbe3f0" };

/**
 * FNV-1a. Chosen for being small, well spread, and byte-identical in every JS
 * runtime — the colour must not depend on which machine rendered it.
 */
export function hashName(name: string): number {
  let h = 0x811c9dc5;
  const s = name.trim().toLowerCase();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * A colour for one name, knowing nothing else.
 *
 * Used only where the full set genuinely is not available. On its own a hash
 * collides: 20 subjects into 32 slots leaves about five sharing with another,
 * however wide the palette — that is the birthday problem, not a palette that
 * is too small. Prefer `assignSwatches`.
 */
export function swatchFor(name: string): Swatch {
  return PALETTE[hashName(name) % PALETTE.length];
}

/**
 * Colours for a whole set — a school's subjects, or its classes.
 *
 * Each name hashes to a preferred slot and takes it; a taken slot probes
 * forward. Names are processed in sorted order so the result depends only on
 * the set, never on the order it arrived in — two screens fetching the same
 * subjects in different orders must not disagree.
 *
 * Stability is the property that matters most, because people learn these
 * colours. Adding a name that hashes to a free slot changes nothing at all;
 * one that collides can push a later name along its probe chain. Renaming a
 * subject re-hashes it, which is correct — it is a different name.
 *
 * More names than swatches means reuse, deterministically. That is honest
 * behaviour rather than a failure: the cell always shows its name, and colour
 * is the fast second cue, never the identifier.
 */
export function assignSwatches(names: readonly string[]): Record<string, Swatch> {
  const n = PALETTE.length;
  const taken = new Array<boolean>(n).fill(false);
  const out: Record<string, Swatch> = {};

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const name = (raw ?? "").trim();
    if (name === "") continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(name);
  }
  unique.sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0));

  let placed = 0;
  for (const name of unique) {
    const preferred = hashName(name) % n;
    let slot = preferred;
    if (placed < n) {
      // Probe forward for a free slot. Neighbours differ in hue, so a displaced
      // name still lands on something visibly different.
      let steps = 0;
      while (taken[slot] && steps < n) {
        slot = (slot + 1) % n;
        steps++;
      }
      taken[slot] = true;
      placed++;
    }
    out[name] = PALETTE[slot];
  }
  return out;
}

/**
 * Look a name up in an assignment, tolerating case and stray whitespace — the
 * grids carry display strings that came from several different queries.
 */
export function lookupSwatch(
  map: Record<string, Swatch>,
  name: string | null | undefined,
): Swatch | null {
  if (!name) return null;
  const direct = map[name] ?? map[name.trim()];
  if (direct) return direct;
  const wanted = name.trim().toLowerCase();
  for (const [k, v] of Object.entries(map)) {
    if (k.toLowerCase() === wanted) return v;
  }
  return null;
}
