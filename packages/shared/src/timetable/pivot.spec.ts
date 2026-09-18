import { describe, expect, it } from "vitest";
import { blockSections, cellEvents, PIVOT_FIELD, pivotCellKey, pivotSlots, SLOT, type SlotTuple } from "./pivot";
import { initialsOf } from "./initials";

/**
 * Tuples as the controller builds them:
 * [classSectionId, day, period, subjectId, teacherId, roomId, mergedGroupId,
 *  locked, substituted, electiveBlockId]
 */
const slot = (
  cs: number | null, day: number, period: number,
  subject: number | null, teacher: number | null, room: number | null,
  extra: Partial<{ merged: number; locked: 0 | 1; sub: 0 | 1; block: number }> = {},
): SlotTuple => [
  cs, day, period, subject, teacher, room,
  extra.merged ?? null, extra.locked ?? 0, extra.sub ?? 0, extra.block ?? null,
];

/**
 * Class 5-A (section 1) and 5-B (section 2), Monday.
 *
 * P1 is an ordinary lesson in each. P2 is a §4.9 split elective across both:
 * two member rows carrying the block and no subject or teacher, and three
 * option rows carrying no section and their own teacher and room. P3 is a
 * §4.10 merged group — one teacher, both sections at once.
 */
const week: SlotTuple[] = [
  slot(1, 1, 1, 10, 100, 900),                          // 5-A Maths, T100
  slot(2, 1, 1, 10, 101, 901),                          // 5-B Maths, T101
  slot(1, 1, 2, null, null, null, { block: 7 }),        // 5-A member of block 7
  slot(2, 1, 2, null, null, null, { block: 7 }),        // 5-B member of block 7
  slot(null, 1, 2, 20, 200, 910, { block: 7 }),         // French,   T200
  slot(null, 1, 2, 21, 201, 911, { block: 7 }),         // Sanskrit, T201
  slot(null, 1, 2, 22, 202, 912, { block: 7 }),         // German,   T202
  slot(1, 1, 3, 30, 300, 920, { merged: 5 }),           // merged PE, both sections
  slot(2, 1, 3, 30, 300, 921, { merged: 5 }),
];

describe("§31 pivoting the slot payload", () => {
  it("names the tuple's fields once", () => {
    // The indices are a contract with the controller. If this table is ever
    // edited to match a payload change, `PIVOT_FIELD` moves with it — which is
    // the entire reason it is derived from `SLOT` rather than written out.
    expect(SLOT.classSectionId).toBe(0);
    expect(SLOT.teacherId).toBe(4);
    expect(PIVOT_FIELD.section).toBe(SLOT.classSectionId);
    expect(PIVOT_FIELD.teacher).toBe(SLOT.teacherId);
    expect(PIVOT_FIELD.room).toBe(SLOT.roomId);
    expect(PIVOT_FIELD.subject).toBe(SLOT.subjectId);
  });

  it("keeps a class-section's ELECTIVE cell and drops the options (invariant 9)", () => {
    const by = pivotSlots(week, "section");
    // 5-A's Monday P2 is one cell — the block — not four. The three option
    // rows belong to no section and must not become cells in anybody's grid.
    expect(by.get(pivotCellKey(1, 1, 2))).toHaveLength(1);
    expect(by.get(pivotCellKey(1, 1, 2))![0][SLOT.electiveBlockId]).toBe(7);
    expect(by.get(pivotCellKey(1, 1, 1))).toHaveLength(1);
  });

  it("keeps an elective-only teacher's week (the bug invariant 9 exists to prevent)", () => {
    const by = pivotSlots(week, "teacher");
    // T200 teaches French inside block 7 and NOTHING else. Filtering option
    // rows out of a teacher pivot is what made nine teachers on the reference
    // school look completely unscheduled.
    expect(by.get(pivotCellKey(200, 1, 2))).toHaveLength(1);
    expect(by.get(pivotCellKey(200, 1, 2))![0][SLOT.subjectId]).toBe(20);
    expect(by.get(pivotCellKey(201, 1, 2))).toHaveLength(1);
    expect(by.get(pivotCellKey(202, 1, 2))).toHaveLength(1);
    // ...and the member rows carry no teacher, so they fall out on their own
    // rather than needing a rule of their own.
    const teacherRows = [...by.values()].flat();
    expect(teacherRows.every((s) => s[SLOT.teacherId] !== null)).toBe(true);
  });

  it("puts several lessons in one cell rather than picking one", () => {
    // Maths is taught to 5-A and 5-B at the same moment by two teachers. On a
    // SUBJECT row that is one cell holding two lessons, and the count is the
    // honest thing to draw at 27 pixels.
    const by = pivotSlots(week, "subject");
    expect(by.get(pivotCellKey(10, 1, 1))).toHaveLength(2);
    // A member row carries no subject, so the block does not appear as one.
    expect(by.get(pivotCellKey(20, 1, 2))).toHaveLength(1);
    expect([...by.keys()].some((k) => k.startsWith("null@"))).toBe(false);
  });

  it("gives a merged group one cell per SECTION and one per room", () => {
    // §4.10 is one occupancy event for the teacher and two rows for the two
    // sections. Both are true; which one a tab shows is what the tab is for.
    const sections = pivotSlots(week, "section");
    expect(sections.get(pivotCellKey(1, 1, 3))).toHaveLength(1);
    expect(sections.get(pivotCellKey(2, 1, 3))).toHaveLength(1);
    const teachers = pivotSlots(week, "teacher");
    expect(teachers.get(pivotCellKey(300, 1, 3))).toHaveLength(2);
    const rooms = pivotSlots(week, "room");
    expect(rooms.get(pivotCellKey(920, 1, 3))).toHaveLength(1);
    expect(rooms.get(pivotCellKey(921, 1, 3))).toHaveLength(1);
  });

  it("keeps an option row's ROOM, which a section pivot cannot see", () => {
    // Room 910 holds a French option that belongs to no class-section. A room
    // grid built from the section pivot would report it free while a class is
    // in it — a wrong answer rather than a smaller one (§10.6).
    const rooms = pivotSlots(week, "room");
    expect(rooms.get(pivotCellKey(910, 1, 2))).toHaveLength(1);
  });

  it("separates by day and by period", () => {
    const other: SlotTuple[] = [slot(1, 1, 1, 10, 100, 900), slot(1, 2, 1, 11, 100, 900)];
    const by = pivotSlots(other, "section");
    expect(by.size).toBe(2);
    expect(by.get(pivotCellKey(1, 1, 1))![0][SLOT.subjectId]).toBe(10);
    expect(by.get(pivotCellKey(1, 2, 1))![0][SLOT.subjectId]).toBe(11);
  });

  it("returns an empty map for an empty week", () => {
    expect(pivotSlots([], "teacher").size).toBe(0);
  });
});

describe("§4.9 who is inside a block", () => {
  it("finds the member sections and ignores the options", () => {
    // Block 7 has two member rows (5-A, 5-B) and three option rows carrying no
    // section at all. The members are the answer; the options contribute
    // nothing without needing a rule of their own.
    expect(blockSections(week, 7).sort()).toEqual([1, 2]);
  });

  it("is empty for a block nobody attends, and for a week with no blocks", () => {
    expect(blockSections(week, 99)).toEqual([]);
    expect(blockSections([slot(1, 1, 1, 10, 100, 900)], 7)).toEqual([]);
  });

  it("does not report a section twice for a block that runs all week", () => {
    // Five occurrences of one block is still two sections, and a strip saying
    // "10 sections" would be counting periods.
    const allWeek: SlotTuple[] = [1, 2, 3, 4, 5].flatMap((d) => [
      slot(1, d, 2, null, null, null, { block: 7 }),
      slot(2, d, 2, null, null, null, { block: 7 }),
      slot(null, d, 2, 20, 200, 910, { block: 7 }),
    ]);
    expect(blockSections(allWeek, 7).sort()).toEqual([1, 2]);
  });
});

describe("§4.10 how many things are in a cell", () => {
  const mergedCell = pivotSlots(week, "teacher").get(pivotCellKey(300, 1, 3))!;

  it("counts a merged group as ONE lesson in the teacher's row", () => {
    // T300 takes 5-A and 5-B together. Two rows, one lesson — drawing "2" in
    // that teacher's cell would claim they are teaching two things at once.
    expect(mergedCell).toHaveLength(2);
    expect(cellEvents(mergedCell, "teacher")).toHaveLength(1);
    expect(cellEvents(mergedCell, "teacher")[0]).toHaveLength(2);
  });

  it("counts the same rows as TWO in the subject's row", () => {
    // Same rows, different question: how many sections are doing PE now. Two,
    // which is what §10.6's subject card counts.
    const bySubject = pivotSlots(week, "subject").get(pivotCellKey(30, 1, 3))!;
    expect(cellEvents(bySubject, "subject")).toHaveLength(2);
  });

  it("keeps two DIFFERENT merged groups apart", () => {
    // Not reachable through `uq_teacher_slot` in one cell, but the grouping
    // must be by id rather than by "has a merged group at all" — otherwise the
    // day it becomes reachable it collapses two lessons into one silently.
    const mixed: SlotTuple[] = [
      slot(1, 1, 4, 40, 400, 930, { merged: 8 }),
      slot(2, 1, 4, 40, 400, 931, { merged: 8 }),
      slot(3, 1, 4, 41, 400, 932, { merged: 9 }),
    ];
    const events = cellEvents(mixed, "teacher");
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.length)).toEqual([2, 1]);
  });

  it("leaves ordinary lessons alone, one event each", () => {
    const plain: SlotTuple[] = [slot(1, 1, 1, 10, 100, 900), slot(2, 1, 1, 10, 100, 901)];
    expect(cellEvents(plain, "teacher")).toHaveLength(2);
    expect(cellEvents([], "teacher")).toEqual([]);
    // Section and room cells hold one row anyway; the function must not decide
    // to merge them behind the caller's back.
    expect(cellEvents(mergedCell, "section")).toHaveLength(2);
    expect(cellEvents(mergedCell, "room")).toHaveLength(2);
  });
});

describe("§31 initials", () => {
  it("returns the school's own answer untouched", () => {
    // "S.-PE" is not a derivation of anything — it is what the school writes on
    // its wall chart, and deriving "SP" would quietly overrule them.
    expect(initialsOf("Sunita Prasad", "S.-PE")).toBe("S.-PE");
    expect(initialsOf("Anything", "  KS  ")).toBe("KS");
  });

  it("derives three characters when the school has never entered any", () => {
    expect(initialsOf("Rajesh Kumar Sharma")).toBe("RKS");
    expect(initialsOf("Anita Menon")).toBe("AM");
    expect(initialsOf("R. K. Singh")).toBe("RKS");
    // Three, not two: on a staff of 122, "R. K. Sharma" and "R. K. Singh" have
    // to be tellable apart, and both fit in 27 pixels.
    expect(initialsOf("Rajesh Kumar Sharma")).not.toBe(initialsOf("Rajesh Kumar Iyer"));
  });

  it("never returns a single character, and never an empty cell", () => {
    // One letter is not an identity, and a blank cell reads as a free period.
    expect(initialsOf("Meera")).toBe("ME");
    expect(initialsOf("")).toBe("??");
    expect(initialsOf(null)).toBe("??");
    expect(initialsOf("Meera", "")).toBe("ME");
    expect(initialsOf("Meera", null)).toBe("ME");
  });
});
