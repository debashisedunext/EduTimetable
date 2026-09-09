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
 * **This module exports a component and nothing else, deliberately.** The
 * context, the hook and `classOfLabel` live in `colors-context.ts` — see the
 * note there: a module that mixes them cannot be fast-refreshed, and each
 * invalidation minted a new context object while the grids held the old one,
 * which turned every cell white with nothing anywhere reporting an error.
 */
import { useMemo, type ReactNode } from "react";
import { assignSwatches, lookupSwatch } from "@edutimetable/shared";
import { ColorContext, NO_COLORS, classOfLabel, type Colors } from "./colors-context";
import { useApi } from "./hooks";

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
    if (!data) return NO_COLORS;
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
