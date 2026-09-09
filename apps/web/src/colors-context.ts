/**
 * §10.5 — the colour context itself, kept apart from the component that fills it.
 *
 * ## Why this is its own module
 *
 * It used to live in `colors.tsx` beside `ColorProvider`, and that is what made
 * the colours vanish from the grids during a dev session while every part of the
 * feature was working.
 *
 * React Fast Refresh only preserves a module's state when that module exports
 * **components and nothing else**. `colors.tsx` exported a component *and* a
 * context *and* a hook, so Vite could not fast-refresh it and invalidated it
 * instead — which it does whenever anything it imports changes, `hooks.ts` most
 * of all. Each invalidation re-evaluates the module and mints a **new**
 * `createContext` object, while grids that were not re-evaluated go on reading
 * the old one. `useContext` then finds no matching provider and returns the
 * default — which for colours is "no colour at all", so every cell quietly went
 * white and nothing anywhere reported an error.
 *
 * A `.ts` file with no component in it is not a Fast Refresh boundary, so the
 * context object survives the provider being replaced. That is the whole fix,
 * and it is the same medicine Vite's own warnings keep prescribing elsewhere in
 * this app ("Could not Fast Refresh — `inputStyle` export is incompatible").
 *
 * The silence is the part worth remembering: a context falling back to its
 * default is indistinguishable from a feature that is switched off, so a default
 * that means "off" will always fail this way. The alternative — a default that
 * throws — is worse here, because colour genuinely is optional (§10.5: a role
 * that cannot read the lists gets no colours and the grid still works).
 */
import { createContext, useContext } from "react";
import type { Swatch } from "@edutimetable/shared";

export interface Colors {
  subject: (name: string | null | undefined) => Swatch | null;
  /** Keyed on the CLASS, so 5-A, 5-B and 5-C read as one family. */
  classOf: (classSectionLabel: string | null | undefined) => Swatch | null;
  ready: boolean;
}

/**
 * Until the lists arrive — and for anyone whose role cannot read them — every
 * lookup returns null and the grids draw exactly as they did before. Colour is
 * an enhancement to a screen that already works.
 */
export const NO_COLORS: Colors = { subject: () => null, classOf: () => null, ready: false };

export const ColorContext = createContext<Colors>(NO_COLORS);

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
