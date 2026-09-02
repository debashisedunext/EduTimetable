/**
 * §10.5 — the school's subject and class colours, resolved once.
 *
 * The assignment is set-aware (see `packages/shared/src/colors/palette.ts`): a
 * name hashes to a preferred slot and probes forward if it is taken, which is
 * what gets all 20 of the reference school's subjects a *distinct* colour
 * instead of the ~5 collisions a bare hash leaves. Being set-aware means it
 * needs the whole set, so it is computed once here rather than per cell.
 *
 * One provider, at the app root, for the reason the palette module exists at
 * all: every screen must agree. A grid that worked out its own colours would
 * make Maths green on the Board and blue on the Matrix.
 *
 * Until the lists arrive — and for anyone whose role cannot read them — every
 * lookup returns null and the grids draw exactly as they did before. Colour is
 * an enhancement to a screen that already works.
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { assignSwatches, lookupSwatch, type Swatch } from "@edutimetable/shared";
import { useApi } from "./hooks";

interface Colors {
  subject: (name: string | null | undefined) => Swatch | null;
  /** Keyed on the CLASS, so 5-A, 5-B and 5-C read as one family. */
  classOf: (classSectionLabel: string | null | undefined) => Swatch | null;
  ready: boolean;
}

const NONE: Colors = { subject: () => null, classOf: () => null, ready: false };
const ColorContext = createContext<Colors>(NONE);

export const useColors = () => useContext(ColorContext);

/**
 * "Class 5-A" → "Class 5". Sections of a class share their class's colour: on a
 * teacher's grid the useful grouping is "which class am I with", and three
 * shades for 5-A/5-B/5-C would spend three palette slots saying one thing.
 *
 * Splits on the LAST hyphen because class names themselves contain them —
 * "Pre-Nursery-A" must become "Pre-Nursery", not "Pre".
 */
export function classOfLabel(label: string): string {
  const cut = label.lastIndexOf("-");
  return cut > 0 ? label.slice(0, cut).trim() : label.trim();
}

interface ColorNames {
  subjects: { id: number; name: string }[];
  classes: { id: number; name: string }[];
}

export function ColorProvider({ children }: { children: ReactNode }) {
  // One small request, from `/me/colors` rather than `/subjects` + `/classes`:
  // those are `masters.manage`, and a teacher who fell back to a different
  // scheme would see Maths in a different colour from the admin looking at the
  // same timetable. The scheme has to be the school's, not the role's.
  const { data } = useApi<ColorNames>("/me/colors");

  const value = useMemo<Colors>(() => {
    if (!data) return NONE;
    const subjectMap = assignSwatches(data.subjects.map((s) => s.name));
    const classMap = assignSwatches(data.classes.map((c) => c.name));
    return {
      subject: (name) => lookupSwatch(subjectMap, name),
      classOf: (label) => (label ? lookupSwatch(classMap, classOfLabel(label)) : null),
      ready: true,
    };
  }, [data]);

  return <ColorContext.Provider value={value}>{children}</ColorContext.Provider>;
}
