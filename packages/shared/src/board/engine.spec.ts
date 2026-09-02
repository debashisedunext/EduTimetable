import { describe, expect, it } from "vitest";
import { cleanSchool, teacher } from "../feasibility/fixtures";
import type { SolverInput } from "../solver/types";
import { BoardEngine, entryKeyOf, rowsToEntries, type SlotRow } from "./engine";

function inputFor(over: Partial<SolverInput> = {}): SolverInput {
  return {
    snapshot: cleanSchool(),
    teacherUnavailability: [],
    labRoomIds: [901, 902],
    preferredRoomByMapping: {},
    mergedGroupRooms: {},
    lockedSlots: [],
    seed: 1,
    ...over,
  };
}

const row = (over: Partial<SlotRow> & Pick<SlotRow, "classSectionId" | "dayOfWeek" | "periodNumber">): SlotRow => ({
  subjectId: null,
  teacherId: null,
  roomId: null,
  mergedGroupId: null,
  electiveBlockId: null,
  electiveOptionId: null,
  isLocked: false,
  ...over,
});

/**
 * §4.9 — one occurrence of a block, as the writer stores it: a member row per
 * attending section (no subject, teacher or room) plus an option row per
 * parallel lesson (no section).
 */
const blockRows = (
  blockId: number,
  day: number,
  period: number,
  sections: number[],
  options: Array<{ optionId: number; subjectId: number; teacherId: number; roomId: number }>,
): SlotRow[] => [
  ...sections.map((classSectionId) =>
    row({ classSectionId, dayOfWeek: day, periodNumber: period, electiveBlockId: blockId }),
  ),
  ...options.map((o) =>
    row({
      classSectionId: null,
      dayOfWeek: day,
      periodNumber: period,
      subjectId: o.subjectId,
      teacherId: o.teacherId,
      roomId: o.roomId,
      electiveBlockId: blockId,
      electiveOptionId: o.optionId,
    }),
  ),
];

// cleanSchool: sections 11 (5-A) / 12 (5-B); subjects 300..304 (English..Art,
// max 2/day); teachers 101..105 (one subject each, both sections).
const K = (cs: number, d: number, p: number) => entryKeyOf({ classSectionId: cs, mergedGroupId: null, dayOfWeek: d, periodNumber: p });

describe("rowsToEntries", () => {
  it("collapses merged-group echo rows into one linked entry", () => {
    const entries = rowsToEntries([
      row({ classSectionId: 11, dayOfWeek: 1, periodNumber: 3, subjectId: 300, teacherId: 101, mergedGroupId: 7, roomId: 55 }),
      row({ classSectionId: 12, dayOfWeek: 1, periodNumber: 3, subjectId: 300, teacherId: 101, mergedGroupId: 7 }),
      row({ classSectionId: 11, dayOfWeek: 2, periodNumber: 1, subjectId: 301, teacherId: 102 }),
    ]);
    expect(entries).toHaveLength(2);
    const merged = entries.find((e) => e.mergedGroupId === 7)!;
    expect(merged.classSectionIds.sort()).toEqual([11, 12]);
    expect(merged.roomId).toBe(55);
  });
});

describe("BoardEngine.checkMove", () => {
  it("allows a move into a genuinely free legal cell", () => {
    const eng = new BoardEngine(inputFor(), [
      row({ classSectionId: 11, dayOfWeek: 1, periodNumber: 1, subjectId: 300, teacherId: 101 }),
    ]);
    expect(eng.checkMove(K(11, 1, 1), 2, 3).ok).toBe(true);
  });

  it("rejects when the teacher is busy elsewhere, naming the blocking class", () => {
    const eng = new BoardEngine(inputFor(), [
      row({ classSectionId: 11, dayOfWeek: 1, periodNumber: 1, subjectId: 300, teacherId: 101 }),
      row({ classSectionId: 12, dayOfWeek: 2, periodNumber: 3, subjectId: 300, teacherId: 101 }),
    ]);
    const res = eng.checkMove(K(11, 1, 1), 2, 3);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("T.English");
    expect(res.reason).toContain("5-B");
  });

  it("rejects when the section already has a card there", () => {
    const eng = new BoardEngine(inputFor(), [
      row({ classSectionId: 11, dayOfWeek: 1, periodNumber: 1, subjectId: 300, teacherId: 101 }),
      row({ classSectionId: 11, dayOfWeek: 2, periodNumber: 3, subjectId: 301, teacherId: 102 }),
    ]);
    const res = eng.checkMove(K(11, 1, 1), 2, 3);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("already teaches");
  });

  it("enforces the subject daily maximum", () => {
    const eng = new BoardEngine(inputFor(), [
      row({ classSectionId: 11, dayOfWeek: 1, periodNumber: 1, subjectId: 300, teacherId: 101 }),
      row({ classSectionId: 11, dayOfWeek: 1, periodNumber: 3, subjectId: 300, teacherId: 101 }),
      row({ classSectionId: 11, dayOfWeek: 2, periodNumber: 1, subjectId: 300, teacherId: 101 }),
    ]);
    // English already twice on day 1 (max 2/day) — moving the day-2 card there must fail
    const res = eng.checkMove(K(11, 2, 1), 1, 5);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("daily maximum");
  });

  it("does not let the moving card block itself", () => {
    const eng = new BoardEngine(inputFor(), [
      row({ classSectionId: 11, dayOfWeek: 1, periodNumber: 1, subjectId: 300, teacherId: 101 }),
      row({ classSectionId: 11, dayOfWeek: 1, periodNumber: 2, subjectId: 300, teacherId: 101 }),
    ]);
    // moving P1→P4 keeps the daily count at 2 — legal even though max is 2/day
    expect(eng.checkMove(K(11, 1, 1), 1, 4).ok).toBe(true);
  });

  it("enforces alternate_period adjacency for such teachers", () => {
    const snap = cleanSchool();
    snap.teachers[0] = teacher(101, "T.English", { periodPattern: "alternate_period" });
    const eng = new BoardEngine(inputFor({ snapshot: snap }), [
      row({ classSectionId: 11, dayOfWeek: 1, periodNumber: 1, subjectId: 300, teacherId: 101 }),
      row({ classSectionId: 12, dayOfWeek: 2, periodNumber: 3, subjectId: 300, teacherId: 101 }),
    ]);
    const res = eng.checkMove(K(11, 1, 1), 2, 4); // adjacent to their 5-B P3
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("alternate periods");
  });

  it("enforces alternate_day allowed-day pruning on manual moves", () => {
    const snap = cleanSchool();
    snap.teachers[0] = teacher(101, "T.English", { periodPattern: "alternate_day", alternateDaySet: [1, 3, 5] });
    const eng = new BoardEngine(inputFor({ snapshot: snap }), [
      row({ classSectionId: 11, dayOfWeek: 1, periodNumber: 1, subjectId: 300, teacherId: 101 }),
    ]);
    const res = eng.checkMove(K(11, 1, 1), 2, 2);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("alternate days");
    expect(eng.checkMove(K(11, 1, 1), 3, 2).ok).toBe(true);
  });

  it("enforces teacher unavailability on manual moves", () => {
    const eng = new BoardEngine(
      inputFor({ teacherUnavailability: [{ teacherId: 101, dayOfWeek: 4, periodNumber: 2 }] }),
      [row({ classSectionId: 11, dayOfWeek: 1, periodNumber: 1, subjectId: 300, teacherId: 101 })],
    );
    const res = eng.checkMove(K(11, 1, 1), 4, 2);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("unavailable");
  });

  it("enforces the class-teacher P1 rule: no P1 in another section", () => {
    const snap = cleanSchool();
    // teacher 101 is class teacher of 5-A (classTeacherId 101 in fixture)
    snap.teachers[0] = teacher(101, "T.English", { classTeacherPeriodRule: "always_first_period" });
    const eng = new BoardEngine(inputFor({ snapshot: snap }), [
      row({ classSectionId: 12, dayOfWeek: 1, periodNumber: 3, subjectId: 300, teacherId: 101 }),
    ]);
    const res = eng.checkMove(K(12, 1, 3), 2, 1); // P1 in 5-B — not their own class
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("Period 1");
    // P1 in their OWN section is fine
    const eng2 = new BoardEngine(inputFor({ snapshot: snap }), [
      row({ classSectionId: 11, dayOfWeek: 1, periodNumber: 3, subjectId: 300, teacherId: 101 }),
    ]);
    expect(eng2.checkMove(K(11, 1, 3), 2, 1).ok).toBe(true);
  });

  it("enforces the same-period-across-week rule", () => {
    const snap = cleanSchool();
    snap.subjectRequirements[0] = { ...snap.subjectRequirements[0], samePeriodAcrossWeek: true };
    const eng = new BoardEngine(inputFor({ snapshot: snap }), [
      row({ classSectionId: 11, dayOfWeek: 1, periodNumber: 2, subjectId: 300, teacherId: 101 }),
      row({ classSectionId: 11, dayOfWeek: 2, periodNumber: 2, subjectId: 300, teacherId: 101 }),
    ]);
    const bad = eng.checkMove(K(11, 1, 2), 3, 4); // different period than the anchored P2
    expect(bad.ok).toBe(false);
    expect(bad.reason).toContain("same-period");
    expect(eng.checkMove(K(11, 1, 2), 3, 2).ok).toBe(true); // same period, new day
  });

  it("keeps a hard preferred room hard, but re-homes lab cards to any free lab", () => {
    const snap = cleanSchool();
    snap.labSubjectIds = [302]; // Science is a lab subject
    const eng = new BoardEngine(inputFor({ snapshot: snap }), [
      row({ classSectionId: 11, dayOfWeek: 1, periodNumber: 1, subjectId: 302, teacherId: 103, roomId: 901 }),
      row({ classSectionId: 12, dayOfWeek: 2, periodNumber: 3, subjectId: 302, teacherId: 103, roomId: 901 }),
    ]);
    // teacher 103 busy day2 P3 — but move to day 2 P4: lab 901 free there; also lab 902 exists
    const res = eng.checkMove(K(11, 1, 1), 2, 4);
    expect(res.ok).toBe(true);
    expect([901, 902]).toContain(res.roomId);
    // non-lab room stays hard: a card with preferred room 700 can't land where 700 is taken
    const eng2 = new BoardEngine(inputFor(), [
      row({ classSectionId: 11, dayOfWeek: 1, periodNumber: 1, subjectId: 300, teacherId: 101, roomId: 700 }),
      row({ classSectionId: 12, dayOfWeek: 2, periodNumber: 3, subjectId: 301, teacherId: 102, roomId: 700 }),
    ]);
    const clash = eng2.checkMove(K(11, 1, 1), 2, 3);
    expect(clash.ok).toBe(false);
  });

  it("refuses to move a locked card", () => {
    const eng = new BoardEngine(inputFor(), [
      row({ classSectionId: 11, dayOfWeek: 1, periodNumber: 1, subjectId: 300, teacherId: 101, isLocked: true }),
    ]);
    const res = eng.checkMove(K(11, 1, 1), 2, 3);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("locked");
  });
});

describe("BoardEngine.checkSwap (§7.3 — both directions must stay legal)", () => {
  it("accepts a clean two-way swap", () => {
    const eng = new BoardEngine(inputFor(), [
      row({ classSectionId: 11, dayOfWeek: 1, periodNumber: 1, subjectId: 300, teacherId: 101 }),
      row({ classSectionId: 11, dayOfWeek: 1, periodNumber: 2, subjectId: 301, teacherId: 102 }),
    ]);
    expect(eng.checkSwap(K(11, 1, 1), K(11, 1, 2)).ok).toBe(true);
  });

  it("rejects a swap where only ONE direction is legal", () => {
    const eng = new BoardEngine(inputFor(), [
      row({ classSectionId: 11, dayOfWeek: 1, periodNumber: 1, subjectId: 300, teacherId: 101 }),
      row({ classSectionId: 11, dayOfWeek: 2, periodNumber: 2, subjectId: 301, teacherId: 102 }),
      // teacher 101 is busy in 5-B on day 2 P2 → English can't take Maths' old cell
      row({ classSectionId: 12, dayOfWeek: 2, periodNumber: 2, subjectId: 300, teacherId: 101 }),
    ]);
    const res = eng.checkSwap(K(11, 1, 1), K(11, 2, 2));
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("T.English");
  });

  it("board state is unchanged after a pure swap check", () => {
    const eng = new BoardEngine(inputFor(), [
      row({ classSectionId: 11, dayOfWeek: 1, periodNumber: 1, subjectId: 300, teacherId: 101 }),
      row({ classSectionId: 11, dayOfWeek: 1, periodNumber: 2, subjectId: 301, teacherId: 102 }),
    ]);
    eng.checkSwap(K(11, 1, 1), K(11, 1, 2));
    eng.checkSwap(K(11, 1, 1), K(11, 1, 2));
    // still identical verdicts and both entries in place
    expect(eng.get(K(11, 1, 1))?.subjectId).toBe(300);
    expect(eng.get(K(11, 1, 2))?.subjectId).toBe(301);
    expect(eng.checkMove(K(11, 1, 1), 1, 3).ok).toBe(true);
  });
});

describe("BoardEngine merged groups (§4.9 — one linked unit)", () => {
  const mergedRows = [
    row({ classSectionId: 11, dayOfWeek: 1, periodNumber: 1, subjectId: 300, teacherId: 101, mergedGroupId: 7, roomId: 55 }),
    row({ classSectionId: 12, dayOfWeek: 1, periodNumber: 1, subjectId: 300, teacherId: 101, mergedGroupId: 7 }),
  ];
  const GK = entryKeyOf({ classSectionId: 11, mergedGroupId: 7, dayOfWeek: 1, periodNumber: 1 });

  it("moves only when EVERY member section is free at the target", () => {
    const eng = new BoardEngine(inputFor(), [
      ...mergedRows,
      row({ classSectionId: 12, dayOfWeek: 2, periodNumber: 3, subjectId: 301, teacherId: 102 }),
    ]);
    const blockedByMember = eng.checkMove(GK, 2, 3); // 5-B busy there
    expect(blockedByMember.ok).toBe(false);
    expect(eng.checkMove(GK, 2, 4).ok).toBe(true);
  });

  it("applyMove relocates the whole linked unit", () => {
    const eng = new BoardEngine(inputFor(), mergedRows);
    eng.applyMove(GK, 3, 5, 55);
    const moved = eng.all.find((e) => e.mergedGroupId === 7)!;
    expect([moved.day, moved.period]).toEqual([3, 5]);
    expect(moved.classSectionIds.sort()).toEqual([11, 12]);
    // both member cells at the old position are free again
    const eng2check = eng.checkPlace(
      { classSectionIds: [11], subjectId: 301, teacherId: 102, roomId: null, mergedGroupId: null, electiveBlockId: null, options: [] },
      1, 1,
    );
    expect(eng2check.ok).toBe(true);
  });
});

describe("BoardEngine.legalDestinations (§7.2 highlight mode)", () => {
  it("marks every cell as move / swap / illegal consistently with direct checks", () => {
    const eng = new BoardEngine(inputFor(), [
      row({ classSectionId: 11, dayOfWeek: 1, periodNumber: 1, subjectId: 300, teacherId: 101 }),
      row({ classSectionId: 11, dayOfWeek: 1, periodNumber: 2, subjectId: 301, teacherId: 102 }),
      row({ classSectionId: 12, dayOfWeek: 2, periodNumber: 3, subjectId: 300, teacherId: 101 }),
    ]);
    const map = eng.legalDestinations(K(11, 1, 1));
    expect(map.get("1:2")?.kind).toBe("swap"); // occupied by Maths → swap proposal
    expect(map.get("2:3")?.kind).toBe("illegal"); // teacher busy in 5-B
    expect(map.get("3:4")?.kind).toBe("move"); // free legal cell
    expect(map.has("1:1")).toBe(false); // own cell excluded
    // 5 days × 6 periods minus own cell
    expect(map.size).toBe(29);
  });
});

describe("BoardEngine.checkPlace (unplaced tray)", () => {
  it("validates a fresh placement like the solver would", () => {
    const eng = new BoardEngine(inputFor(), [
      row({ classSectionId: 11, dayOfWeek: 1, periodNumber: 1, subjectId: 300, teacherId: 101 }),
    ]);
    const clash = eng.checkPlace(
      { classSectionIds: [12], subjectId: 300, teacherId: 101, roomId: null, mergedGroupId: null, electiveBlockId: null, options: [] },
      1, 1,
    );
    expect(clash.ok).toBe(false);
    const free = eng.checkPlace(
      { classSectionIds: [12], subjectId: 300, teacherId: 101, roomId: null, mergedGroupId: null, electiveBlockId: null, options: [] },
      1, 2,
    );
    expect(free.ok).toBe(true);
  });
});

/**
 * §4.9 Phase 16 — a split-elective block is a draggable card.
 *
 * It used to arrive as an opaque "reserved" cell: the board knew it was taken
 * and could not move it. Now it is an ordinary entry whose variable is the
 * same elective macro-variable the solver placed — so every option's teacher
 * and every option's room is checked by the state machine, not re-implemented.
 */
describe("BoardEngine — elective blocks as cards (§4.9)", () => {
  /** 5-A and 5-B take a 3-option block at Tue P3. Three teachers, three rooms. */
  const OPTIONS = [
    { optionId: 21, subjectId: 501, teacherId: 201, roomId: 801 },
    { optionId: 22, subjectId: 502, teacherId: 202, roomId: 802 },
    { optionId: 23, subjectId: 503, teacherId: 203, roomId: 803 },
  ];
  const electiveInput = () => {
    const snap = cleanSchool();
    snap.teachers.push(
      teacher(201, "Mme Dubois", { eligibleClassIds: [5] }),
      teacher(202, "Shri Joshi", { eligibleClassIds: [5] }),
      teacher(203, "Hr. Bauer", { eligibleClassIds: [5] }),
    );
    snap.electiveBlocks = [
      {
        id: 7,
        name: "Class 5 Third Language",
        periodsPerWeek: 2,
        maxPeriodsPerDay: 1,
        placement: "solver",
        fixedSlots: [],
        memberClassSectionIds: [11, 12],
        memberLabels: ["5-A", "5-B"],
        options: [
          { id: 21, subjectId: 501, subjectName: "French", teacherId: 201, teacherName: "Mme Dubois", roomId: 801, roomName: "Lang 1" },
          { id: 22, subjectId: 502, subjectName: "Sanskrit", teacherId: 202, teacherName: "Shri Joshi", roomId: 802, roomName: "Lang 2" },
          { id: 23, subjectId: 503, subjectName: "German", teacherId: 203, teacherName: "Hr. Bauer", roomId: 803, roomName: "Lang 3" },
        ],
      },
    ];
    return inputFor({ snapshot: snap });
  };
  const BK = (d: number, p: number) => `B7@${d}:${p}`;

  it("folds member and option rows into ONE card", () => {
    const entries = rowsToEntries(blockRows(7, 2, 3, [11, 12], OPTIONS));
    expect(entries).toHaveLength(1);
    const b = entries[0];
    expect(b.key).toBe("B7@2:3");
    expect(b.classSectionIds).toEqual([11, 12]);
    // The card has no subject or teacher of its own — the lessons do.
    expect(b.subjectId).toBeNull();
    expect(b.teacherId).toBeNull();
    expect(b.options.map((o) => o.optionId)).toEqual([21, 22, 23]);
  });

  it("moves to a cell that is free in every member section", () => {
    const eng = new BoardEngine(electiveInput(), blockRows(7, 2, 3, [11, 12], OPTIONS));
    expect(eng.checkMove(BK(2, 3), 4, 5).ok).toBe(true);
  });

  it("refuses a cell where one member section is busy, and names that section", () => {
    const eng = new BoardEngine(electiveInput(), [
      ...blockRows(7, 2, 3, [11, 12], OPTIONS),
      // only 5-B is busy at Thu P5 — the block still cannot go there
      row({ classSectionId: 12, dayOfWeek: 4, periodNumber: 5, subjectId: 300, teacherId: 101 }),
    ]);
    const v = eng.checkMove(BK(2, 3), 4, 5);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/5-B/);
  });

  it("refuses a cell where one OPTION teacher is already teaching", () => {
    const eng = new BoardEngine(electiveInput(), [
      ...blockRows(7, 2, 3, [11, 12], OPTIONS),
      // Hr. Bauer takes an ordinary lesson elsewhere at Thu P5. Every option
      // runs at once, so his clash takes the whole block off that cell.
      row({ classSectionId: 13, dayOfWeek: 4, periodNumber: 5, subjectId: 503, teacherId: 203 }),
    ]);
    const v = eng.checkMove(BK(2, 3), 4, 5);
    expect(v.ok).toBe(false);
    expect(v.reason).toBeTruthy();
  });

  it("respects the block's own daily cap, not a subject's", () => {
    const eng = new BoardEngine(electiveInput(), [
      ...blockRows(7, 2, 3, [11, 12], OPTIONS),
      ...blockRows(7, 4, 1, [11, 12], OPTIONS),
    ]);
    // maxPeriodsPerDay 1: the Tue occurrence cannot join the Thu one.
    expect(eng.checkMove(BK(2, 3), 4, 6).ok).toBe(false);
  });

  it("group-swaps onto an occupied cell, sending each displaced lesson back", () => {
    const eng = new BoardEngine(electiveInput(), [
      ...blockRows(7, 2, 3, [11, 12], OPTIONS),
      // Thu P5 holds a DIFFERENT lesson in each member section — the case a
      // two-card swap cannot express and a plain move always refuses.
      row({ classSectionId: 11, dayOfWeek: 4, periodNumber: 5, subjectId: 300, teacherId: 101 }),
      row({ classSectionId: 12, dayOfWeek: 4, periodNumber: 5, subjectId: 301, teacherId: 102 }),
    ]);
    const v = eng.checkSwapGroup(BK(2, 3), 4, 5);
    expect(v.ok).toBe(true);
    expect(v.displaced.map((d) => d.key).sort()).toEqual(["S11@4:5", "S12@4:5"]);

    // and the check is pure: the board is exactly as it was
    expect(eng.get(BK(2, 3))?.day).toBe(2);
    expect(eng.entryAt(11, 4, 5)?.key).toBe("S11@4:5");
  });

  it("refuses the group swap when a displaced lesson cannot live at the source", () => {
    const eng = new BoardEngine(electiveInput(), [
      ...blockRows(7, 2, 3, [11, 12], OPTIONS),
      row({ classSectionId: 11, dayOfWeek: 4, periodNumber: 5, subjectId: 300, teacherId: 101 }),
      row({ classSectionId: 12, dayOfWeek: 4, periodNumber: 5, subjectId: 301, teacherId: 102 }),
      // T.English is already teaching 5-C at Tue P3, where the swap would
      // send him. The block's own side is fine; this side is not.
      row({ classSectionId: 13, dayOfWeek: 2, periodNumber: 3, subjectId: 300, teacherId: 101 }),
    ]);
    const v = eng.checkSwapGroup(BK(2, 3), 4, 5);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/cannot take the slot this card is leaving/);
  });

  it("applies the group swap as one transaction — nothing lands twice", () => {
    const eng = new BoardEngine(electiveInput(), [
      ...blockRows(7, 2, 3, [11, 12], OPTIONS),
      row({ classSectionId: 11, dayOfWeek: 4, periodNumber: 5, subjectId: 300, teacherId: 101 }),
      row({ classSectionId: 12, dayOfWeek: 4, periodNumber: 5, subjectId: 301, teacherId: 102 }),
    ]);
    const v = eng.checkSwapGroup(BK(2, 3), 4, 5);
    eng.applySwapGroup(BK(2, 3), 4, 5, v.roomAtTarget, v.displaced);

    expect(eng.get("B7@4:5")?.classSectionIds).toEqual([11, 12]);
    expect(eng.entryAt(11, 2, 3)?.subjectId).toBe(300);
    expect(eng.entryAt(12, 2, 3)?.subjectId).toBe(301);
    // the board must still be internally consistent: moving the block back is
    // legal again, which it would not be if a ghost were left behind
    expect(eng.checkSwapGroup("B7@4:5", 2, 3).ok).toBe(true);
  });

  it("refuses a swap with its own other occurrence — that would change nothing", () => {
    const eng = new BoardEngine(electiveInput(), [
      ...blockRows(7, 2, 3, [11, 12], OPTIONS),
      ...blockRows(7, 4, 1, [11, 12], OPTIONS),
    ]);
    // Both cells hold the identical card, so the "swap" is a no-op. Offering
    // it as a legal destination is a green cell that does nothing when clicked
    // — on a full school it was the ONLY kind of destination a block had.
    const v = eng.checkSwapGroup(BK(2, 3), 4, 1);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/already runs in this slot/);
    expect(eng.legalDestinations(BK(2, 3)).get("4:1")?.kind).toBe("illegal");
  });

  it("an ordinary card cannot be dropped where a block sits — it names the block", () => {
    const eng = new BoardEngine(electiveInput(), [
      ...blockRows(7, 2, 3, [11, 12], OPTIONS),
      row({ classSectionId: 11, dayOfWeek: 1, periodNumber: 1, subjectId: 300, teacherId: 101 }),
    ]);
    const v = eng.checkMove(K(11, 1, 1), 2, 3);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/Class 5 Third Language/);
  });

  it("leaves sections that do not attend the block alone", () => {
    const eng = new BoardEngine(electiveInput(), [
      ...blockRows(7, 2, 3, [11, 12], OPTIONS),
      row({ classSectionId: 13, dayOfWeek: 1, periodNumber: 1, subjectId: 300, teacherId: 105 }),
    ]);
    // 5-C does not attend, so its own grid is untouched at that cell
    expect(eng.checkMove(K(13, 1, 1), 2, 3).ok).toBe(true);
  });
});

describe("BoardEngine — merged groups can swap now (§7.3)", () => {
  it("group-swaps a merged card onto a cell holding a different lesson per section", () => {
    const eng = new BoardEngine(inputFor(), [
      row({ classSectionId: 11, dayOfWeek: 1, periodNumber: 3, subjectId: 300, teacherId: 101, mergedGroupId: 7, roomId: 55 }),
      row({ classSectionId: 12, dayOfWeek: 1, periodNumber: 3, subjectId: 300, teacherId: 101, mergedGroupId: 7 }),
      row({ classSectionId: 11, dayOfWeek: 3, periodNumber: 4, subjectId: 301, teacherId: 102 }),
      row({ classSectionId: 12, dayOfWeek: 3, periodNumber: 4, subjectId: 302, teacherId: 103 }),
    ]);
    const key = entryKeyOf({ classSectionId: 11, mergedGroupId: 7, dayOfWeek: 1, periodNumber: 3 });
    const v = eng.checkSwapGroup(key, 3, 4);
    expect(v.ok, v.reason).toBe(true);
    expect(v.displaced).toHaveLength(2);

    // and it shows up as a swap in the highlight map, which is what changed:
    // before this, every occupied cell was flatly illegal for a merged card.
    expect(eng.legalDestinations(key).get("3:4")?.kind).toBe("swap");
  });
});

describe("BoardEngine — minimum periods per day (§20)", () => {
  /** T.English at exactly 3 periods on Monday, one on Tuesday to move onto. */
  const boardAtMinimum = () => {
    const snap = cleanSchool();
    for (const t of snap.teachers) t.minPeriodsPerDay = 3;
    return new BoardEngine(inputFor({ snapshot: snap }), [
      row({ classSectionId: 11, dayOfWeek: 1, periodNumber: 1, subjectId: 300, teacherId: 101 }),
      row({ classSectionId: 11, dayOfWeek: 1, periodNumber: 2, subjectId: 300, teacherId: 101 }),
      row({ classSectionId: 12, dayOfWeek: 1, periodNumber: 3, subjectId: 300, teacherId: 101 }),
    ]);
  };

  it("warns — but does not refuse — when a move leaves a teacher a short day", () => {
    const v = boardAtMinimum().checkMove(K(11, 1, 1), 2, 1);
    expect(v.ok, "a deliberate admin move is never blocked by §20").toBe(true);
    expect(v.warning).toContain("T.English");
    expect(v.warning).toContain("2 periods on Mon");
  });

  it("says nothing when the day it leaves behind is still a proper day", () => {
    const snap = cleanSchool();
    for (const t of snap.teachers) t.minPeriodsPerDay = 3;
    // Four English periods on Monday (two per section, the subject's daily
    // cap) — moving one away still leaves a full day behind.
    const engine = new BoardEngine(inputFor({ snapshot: snap }), [
      row({ classSectionId: 11, dayOfWeek: 1, periodNumber: 1, subjectId: 300, teacherId: 101 }),
      row({ classSectionId: 11, dayOfWeek: 1, periodNumber: 2, subjectId: 300, teacherId: 101 }),
      row({ classSectionId: 12, dayOfWeek: 1, periodNumber: 3, subjectId: 300, teacherId: 101 }),
      row({ classSectionId: 12, dayOfWeek: 1, periodNumber: 4, subjectId: 300, teacherId: 101 }),
    ]);
    const v = engine.checkMove(K(11, 1, 1), 2, 1);
    expect(v.ok).toBe(true);
    expect(v.warning).toBeUndefined();
  });

  it("moving within the same day is not a §20 event at all", () => {
    const v = boardAtMinimum().checkMove(K(11, 1, 1), 1, 5);
    expect(v.ok).toBe(true);
    expect(v.warning).toBeUndefined();
  });
});
