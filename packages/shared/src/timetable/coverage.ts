/**
 * §31.7 — what a class-section is owed, against what is actually on the board.
 *
 * The Lesson grid's cells are the **curriculum**: a 6 means Class 5-A is meant
 * to have six periods of Maths. This module answers the other half — how many
 * it has — so the screen can say `5/6` at the moment somebody is looking at
 * the row, rather than leaving it for Readiness to mention later.
 *
 * ## Only when they differ
 *
 * A number that is always two numbers is a number nobody reads. So the callers
 * draw one figure when the week matches the curriculum and two when it does
 * not, and this module's job is to be *sure* about the difference — a screen
 * that cries wolf about a missing period is worse than one that says nothing,
 * because the first thing it costs is the reader's trust in the other 500
 * cells.
 *
 * ## Five things that make the count wrong if they are not handled
 *
 * 1. **Required is a CLASS fact; placed is a SECTION fact.** `class_subjects`
 *    is keyed by class (§27), so "6 periods of Maths" is true of Class 5 and
 *    therefore of 5-A *and* 5-B separately. Summing the two sections' lessons
 *    and comparing 12 against 6 is the obvious bug, and it would report every
 *    class in the school as massively over-taught.
 *
 * 2. **§18 extra classes are not the syllabus.** A revision class placed in the
 *    extra window is a real lesson and is in the payload, but counting it
 *    towards the curriculum would hide a genuine shortfall behind next week's
 *    revision. `teachingPeriods` is the filter, and it is the same set the
 *    Matrix's fill rate uses so the two figures cannot disagree.
 *
 * 3. **A §4.10 merged group places one row per section**, which is exactly what
 *    this wants — 5-A and 5-B are each taught, and each gets its period. This
 *    is the one place in §31 where the merged rows are *not* collapsed:
 *    `cellEvents` collapses them because a teacher is in one place, and here
 *    the question is what each class received.
 *
 * 4. **A §4.9 block is not a curriculum row**, and its rows cannot be
 *    attributed: member rows carry no subject and option rows carry no
 *    class-section (invariant 9). Normally both sides simply exclude it. But a
 *    school that ALSO has French as a curriculum row would see `0/4` for every
 *    section while the children are sitting in French — a confident wrong
 *    answer. So a subject that runs as an elective option is marked **not
 *    comparable** and the screen shows the curriculum figure alone.
 *
 * 5. **"Nothing placed" and "nothing generated" are different facts.** Before a
 *    generation every cell would read `0/6`, which is not five hundred missing
 *    periods, it is an empty week. A section with no placed teaching lesson at
 *    all is therefore not compared — the same distinction the strip already
 *    draws between "not yet" and "no teacher".
 */
import { SLOT, type SlotTuple } from "./pivot";

export interface CoverageInput {
  /** The week on screen, as `/slots` serves it. */
  slots: SlotTuple[];
  /**
   * Period numbers that count towards the curriculum: teaching periods only,
   * with breaks, §28.3 activities and the §18 extra window already excluded.
   */
  teachingPeriods: Set<number | null>;
}

export interface Coverage {
  /** Lessons of this subject placed for this class-section in the shown week. */
  placedAt(sectionId: number, subjectId: number): number;
  /**
   * Whether `placedAt` may honestly be compared with the curriculum.
   *
   * False for a section with nothing generated, and for a subject that also
   * runs as a §4.9 option — see (4) and (5) above.
   */
  comparable(sectionId: number, subjectId: number): boolean;
  /** Every teaching lesson placed for this class-section, whatever the subject. */
  placedIn(sectionId: number): number;
  /** Subjects excluded by rule (4), for a caller that wants to say why. */
  electiveSubjects: Set<number>;
}

export function buildCoverage({ slots, teachingPeriods }: CoverageInput): Coverage {
  const placed = new Map<string, number>();
  const perSection = new Map<number, number>();
  const electiveSubjects = new Set<number>();

  for (const s of slots) {
    const subjectId = s[SLOT.subjectId];
    // An OPTION row: a subject, a teacher, a room, and no class-section
    // (invariant 9). It is what marks the subject unattributable — recorded
    // whatever period it sits in, because the rule is about the subject rather
    // than about this particular lesson.
    if (s[SLOT.classSectionId] === null && s[SLOT.electiveBlockId] !== null && subjectId !== null) {
      electiveSubjects.add(subjectId);
      continue;
    }
    if (!teachingPeriods.has(s[SLOT.period])) continue;
    const sectionId = s[SLOT.classSectionId];
    if (sectionId === null || sectionId === undefined) continue;
    perSection.set(sectionId, (perSection.get(sectionId) ?? 0) + 1);
    // A §4.9 MEMBER row occupies the cell and carries no subject, so it counts
    // towards the section's week — which is what makes the section "generated"
    // — but towards no subject's total.
    if (subjectId === null || subjectId === undefined) continue;
    const key = `${sectionId}:${subjectId}`;
    placed.set(key, (placed.get(key) ?? 0) + 1);
  }

  return {
    placedAt: (sectionId, subjectId) => placed.get(`${sectionId}:${subjectId}`) ?? 0,
    placedIn: (sectionId) => perSection.get(sectionId) ?? 0,
    comparable: (sectionId, subjectId) =>
      (perSection.get(sectionId) ?? 0) > 0 && !electiveSubjects.has(subjectId),
    electiveSubjects,
  };
}
