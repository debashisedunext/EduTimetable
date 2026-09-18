/**
 * §31 — a teacher's name in two or three characters.
 *
 * ## Why this is a module and not a one-liner at the call site
 *
 * It was a one-liner at the call site, twice: `Board.tsx` took three letters
 * and `Substitutes.tsx` took two, so the same person was `RKS` on one screen
 * and `RK` on the next. That is survivable while initials are decoration on a
 * card that also carries the full name. §31's Master Grid gives a cell **27
 * pixels** and nothing else, so the initials stop being decoration and become
 * the only thing identifying the teacher — and two screens disagreeing about
 * who `RK` is would be a screen that teaches the reader something untrue, the
 * same argument §10.5 made for colour.
 *
 * ## The school's own answer wins
 *
 * `teachers.initials` exists on the model and the §16 importer carries it
 * through, because a school that writes `S.-PE` on its own wall chart is not
 * describing a name — it is describing a person, and deriving `SP` from
 * "Sunita Prasad" would quietly overrule them. So a stored value is returned
 * untouched, and the derivation is only ever a **fallback** for a school that
 * has never entered one.
 */

/**
 * @param name  the teacher's full name, as the school entered it.
 * @param stored `teachers.initials` when the school has set it — returned as
 *               given, because it is an answer rather than a guess.
 */
export function initialsOf(name: string | null | undefined, stored?: string | null): string {
  const kept = (stored ?? "").trim();
  if (kept) return kept;
  const words = (name ?? "")
    .split(/[\s.]+/)
    .map((w) => w.trim())
    .filter(Boolean);
  if (words.length === 0) return "??";
  // Three characters, not two. At 27px both fit, and three tells "R. K. Sharma"
  // apart from "R. K. Singh" — which on a staff of 122 is a distinction the
  // school has to be able to make.
  const letters = words.map((w) => w[0]).join("").slice(0, 3).toUpperCase();
  // A single-word name has one letter and one letter is not an identity, so it
  // borrows from the word itself rather than standing alone.
  return letters.length > 1 ? letters : (words[0].slice(0, 2).toUpperCase() || "??");
}
