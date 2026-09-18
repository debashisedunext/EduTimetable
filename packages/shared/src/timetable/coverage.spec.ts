import { describe, expect, it } from "vitest";
import { buildCoverage } from "./coverage";
import type { SlotTuple } from "./pivot";

const slot = (
  cs: number | null, day: number, period: number,
  subject: number | null, teacher: number | null, room: number | null,
  extra: Partial<{ merged: number; block: number }> = {},
): SlotTuple => [
  cs, day, period, subject, teacher, room,
  extra.merged ?? null, 0, 0, extra.block ?? null,
];

/** P1–P6 teach; P7 is the §18 extra window and is deliberately outside it. */
const TEACHING = new Set<number | null>([1, 2, 3, 4, 5, 6]);

describe("§31.7 placed against required", () => {
  it("counts each SECTION's own lessons, never the class's total", () => {
    // The bug this exists to prevent: Class 5 is owed 6 periods of Maths, and
    // that is true of 5-A and of 5-B *separately*. Adding them up and comparing
    // 12 with 6 would report every class in the school as over-taught.
    const week: SlotTuple[] = [
      slot(1, 1, 1, 10, 100, 900), slot(1, 2, 1, 10, 100, 900), slot(1, 3, 1, 10, 100, 900),
      slot(2, 1, 2, 10, 101, 901), slot(2, 2, 2, 10, 101, 901),
    ];
    const cov = buildCoverage({ slots: week, teachingPeriods: TEACHING });
    expect(cov.placedAt(1, 10)).toBe(3);
    expect(cov.placedAt(2, 10)).toBe(2);
  });

  it("leaves §18 extra classes out — a revision class is not the syllabus", () => {
    // Counting it would hide a genuine shortfall behind next week's revision.
    const week: SlotTuple[] = [
      slot(1, 1, 1, 10, 100, 900),
      slot(1, 1, 7, 10, 100, 900), // the extra window
    ];
    const cov = buildCoverage({ slots: week, teachingPeriods: TEACHING });
    expect(cov.placedAt(1, 10)).toBe(1);
    expect(cov.placedIn(1)).toBe(1);
  });

  it("credits BOTH sections of a §4.10 merged group", () => {
    // The one place in §31 where merged rows are not collapsed: `cellEvents`
    // collapses them because a teacher is in one place, and here the question
    // is what each class received — and both classes received the lesson.
    const week: SlotTuple[] = [
      slot(1, 1, 3, 30, 300, 920, { merged: 5 }),
      slot(2, 1, 3, 30, 300, 921, { merged: 5 }),
    ];
    const cov = buildCoverage({ slots: week, teachingPeriods: TEACHING });
    expect(cov.placedAt(1, 30)).toBe(1);
    expect(cov.placedAt(2, 30)).toBe(1);
  });

  it("refuses to compare a subject that also runs as a §4.9 option", () => {
    // A school with French BOTH as a curriculum row and as an elective option
    // would otherwise read `0/4` for every section while the children are
    // sitting in French. A confident wrong answer is worse than none.
    const week: SlotTuple[] = [
      slot(1, 1, 1, 10, 100, 900),                     // ordinary Maths
      slot(1, 1, 2, null, null, null, { block: 7 }),   // 5-A in the block
      slot(null, 1, 2, 20, 200, 910, { block: 7 }),    // the French option
    ];
    const cov = buildCoverage({ slots: week, teachingPeriods: TEACHING });
    expect(cov.comparable(1, 10)).toBe(true);
    expect(cov.comparable(1, 20)).toBe(false);
    expect(cov.electiveSubjects.has(20)).toBe(true);
    // The option row is not attributed to anybody: it belongs to no section.
    expect(cov.placedAt(1, 20)).toBe(0);
  });

  it("counts a block's MEMBER row towards the week but towards no subject", () => {
    // The member row occupies 5-A's cell and carries no subject, so it makes
    // the section generated without inflating any subject's total.
    const week: SlotTuple[] = [slot(1, 1, 2, null, null, null, { block: 7 })];
    const cov = buildCoverage({ slots: week, teachingPeriods: TEACHING });
    expect(cov.placedIn(1)).toBe(1);
    expect(cov.placedAt(1, 20)).toBe(0);
  });

  it("does not compare a section with nothing generated", () => {
    // Before a generation every cell would read `0/6`, which is not five
    // hundred missing periods — it is an empty week, and saying so loudly
    // would train the reader to ignore the notation entirely.
    const cov = buildCoverage({ slots: [], teachingPeriods: TEACHING });
    expect(cov.comparable(1, 10)).toBe(false);
    expect(cov.placedAt(1, 10)).toBe(0);

    // ...but a PARTLY generated section is compared, because there the missing
    // periods are real.
    const partial = buildCoverage({
      slots: [slot(1, 1, 1, 10, 100, 900)],
      teachingPeriods: TEACHING,
    });
    expect(partial.comparable(1, 10)).toBe(true);
    expect(partial.comparable(1, 11)).toBe(true); // a subject with none placed at all
    expect(partial.placedAt(1, 11)).toBe(0);
    // ...and a DIFFERENT section, still empty, is still not compared.
    expect(partial.comparable(2, 10)).toBe(false);
  });

  it("counts over-placement as readily as under", () => {
    const week: SlotTuple[] = [1, 2, 3, 4, 5, 6].map((d) => slot(1, d > 5 ? 5 : d, d, 10, 100, 900));
    const cov = buildCoverage({ slots: week, teachingPeriods: TEACHING });
    expect(cov.placedAt(1, 10)).toBe(6);
  });
});
