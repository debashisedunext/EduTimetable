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

const row = (over: Partial<SlotRow> & Pick<SlotRow, "classSectionId" | "dayOfWeek" | "periodNumber" | "subjectId" | "teacherId">): SlotRow => ({
  roomId: null,
  mergedGroupId: null,
  isLocked: false,
  ...over,
});

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
      { classSectionIds: [11], subjectId: 301, teacherId: 102, roomId: null, mergedGroupId: null },
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
      { classSectionIds: [12], subjectId: 300, teacherId: 101, roomId: null, mergedGroupId: null },
      1, 1,
    );
    expect(clash.ok).toBe(false);
    const free = eng.checkPlace(
      { classSectionIds: [12], subjectId: 300, teacherId: 101, roomId: null, mergedGroupId: null },
      1, 2,
    );
    expect(free.ok).toBe(true);
  });
});
