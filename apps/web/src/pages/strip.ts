/**
 * §31.6 — the shape of one block of the Master Grid's strip.
 *
 * It lived inside `MasterGrid.tsx` while the strip had one author. §31.11 gives
 * it a second: the Draft Board tab describes a *card* — a placement with a
 * clock, a class, a teacher and a room — and it must describe it from its OWN
 * payload, because that is the one the cards were drawn from. A board looking
 * at Draft #3 while the strip read Draft #2's tuples would explain a lesson
 * that is not on the screen.
 *
 * So the board hands the strip finished groups rather than ids. That is the
 * same call §31.10 made for the Lesson Grid tab and for the same reason: a
 * second derivation from a different payload is free to disagree with the grid
 * it sits under, and eventually will.
 *
 * MasterGrid imports Board, so this cannot live in MasterGrid — a module of its
 * own is what keeps the dependency one-way.
 */
export interface StripGroup {
  label: string;
  primary?: string;
  swatch?: { bg: string; fg: string } | null;
  lines?: string[];
  chips?: Array<{ text: string; swatch?: { bg: string; fg: string } | null; title?: string }>;
}
