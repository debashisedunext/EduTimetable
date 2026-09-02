import { describe, expect, it } from "vitest";
import { PALETTE, assignSwatches, hashName, lookupSwatch, swatchFor } from "./palette";

/** sRGB relative luminance, per WCAG 2.1. */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** Hue in degrees, for the "neighbours look different" check. */
function hue(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => c / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}
const hueGap = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

// The real subject list of the reference school — the set this has to work on.
const SUBJECTS = [
  "Art & Craft", "Biology", "Chemistry", "Civics", "Computer", "Economics", "English",
  "French", "Geography", "German", "Hindi", "History", "Mathematics", "Music & Rhymes",
  "Physical Education", "Physics", "Sanskrit", "Science", "Social Science", "Story Time",
];

describe("§10.5 palette — legibility", () => {
  it("every swatch's text clears WCAG AA on its own background", () => {
    for (const s of PALETTE) {
      expect(contrast(s.bg, s.fg), `${s.fg} on ${s.bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("and on white, because a cell can be drawn either way", () => {
    for (const s of PALETTE) {
      expect(contrast("#ffffff", s.fg), `${s.fg} on white`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps real headroom, so a later tweak cannot silently drop below the line", () => {
    const worst = Math.min(...PALETTE.map((s) => contrast(s.bg, s.fg)));
    expect(worst).toBeGreaterThanOrEqual(5.4);
  });

  it("uses text that is a DARK SHADE OF ITS OWN HUE, not a neutral grey", () => {
    // This is the specific thing that was asked for: same colour, in dark.
    for (const s of PALETTE) {
      expect(hueGap(hue(s.bg), hue(s.fg)), `${s.bg} vs ${s.fg}`).toBeLessThan(28);
      expect(luminance(s.fg)).toBeLessThan(luminance(s.bg));
    }
  });
});

describe("§10.5 palette — distinctness", () => {
  it("puts a different HUE next door, so a displaced name never looks the same", () => {
    for (let i = 0; i < PALETTE.length; i++) {
      const a = PALETTE[i], b = PALETTE[(i + 1) % PALETTE.length];
      expect(hueGap(hue(a.bg), hue(b.bg)), `slot ${i} vs ${i + 1}`).toBeGreaterThan(25);
    }
  });

  it("has no duplicate backgrounds", () => {
    expect(new Set(PALETTE.map((s) => s.bg)).size).toBe(PALETTE.length);
  });
});

describe("§10.5 assignSwatches", () => {
  it("gives all 20 of the reference school's subjects DISTINCT colours", () => {
    // The whole reason the assignment is set-aware. A bare hash leaves about
    // five of these sharing with another, however wide the palette.
    const map = assignSwatches(SUBJECTS);
    const used = new Set(SUBJECTS.map((s) => map[s].bg));
    expect(used.size).toBe(SUBJECTS.length);
  });

  it("does not depend on the order the names arrived in", () => {
    const a = assignSwatches(SUBJECTS);
    const b = assignSwatches([...SUBJECTS].reverse());
    for (const s of SUBJECTS) expect(b[s]).toEqual(a[s]);
  });

  it("is stable when a non-colliding name is added", () => {
    const before = assignSwatches(SUBJECTS);
    const after = assignSwatches([...SUBJECTS, "Robotics"]);
    const moved = SUBJECTS.filter((s) => after[s].bg !== before[s].bg);
    // Adding one name may push at most its own probe chain along; it must not
    // reshuffle the school.
    expect(moved.length).toBeLessThanOrEqual(1);
  });

  it("ignores blanks, duplicates and case", () => {
    const map = assignSwatches(["Maths", "  maths  ", "", "   ", "Maths"]);
    expect(Object.keys(map)).toEqual(["Maths"]);
  });

  it("reuses colours rather than failing when a school has more names than swatches", () => {
    const many = Array.from({ length: PALETTE.length + 9 }, (_, i) => `Subject ${i}`);
    const map = assignSwatches(many);
    expect(Object.keys(map)).toHaveLength(many.length);
    for (const n of many) expect(map[n]).toBeTruthy();
  });
});

describe("§10.5 lookup and fallback", () => {
  it("matches a name whatever its case or padding", () => {
    const map = assignSwatches(["Mathematics"]);
    expect(lookupSwatch(map, "  mathematics ")).toEqual(map["Mathematics"]);
    expect(lookupSwatch(map, "Physics")).toBeNull();
    expect(lookupSwatch(map, null)).toBeNull();
  });

  it("hashes identically for the same name every time", () => {
    expect(hashName("Mathematics")).toBe(hashName("  MATHEMATICS  "));
    expect(swatchFor("Mathematics")).toEqual(swatchFor("mathematics"));
  });
});
