/**
 * §21 — the choosers behind an auto-resolve remedy.
 *
 * Every remedy that names somebody or something — "give 5-A to Iyer", "put
 * 3-B in Room 12" — comes through here, so the *reason* one candidate beat
 * another lives in one place and can be tested without a database.
 *
 * The bias throughout is toward the least surprising answer: a class teacher
 * who already teaches the section, the emptiest free room, the eligible
 * teacher with the most room left. An auto-fix that picks arbitrarily is worse
 * than none, because the admin then has to check every row anyway.
 */
import type {
  FeasibilitySnapshot,
  Remedy,
  RemedyChange,
  RemedyValue,
  SnapshotRoom,
  SnapshotTeacher,
} from "./types";
import { teacherWeeklyLoad } from "./min-day";

const DAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const remedy = (kind: Remedy["kind"], summary: string, changes: RemedyChange[]): Remedy => ({
  kind,
  summary,
  changes,
});

/** Weekly periods already on each teacher, counting a merged lesson once. */
export function loadByTeacher(snap: FeasibilitySnapshot): Map<number, number> {
  const local = teacherWeeklyLoad(snap);
  for (const [id, cross] of Object.entries(snap.crossConfigTeacherLoad)) {
    // §3.10: a teacher's other wing counts against the same person.
    local.set(Number(id), (local.get(Number(id)) ?? 0) + cross.periods);
  }
  return local;
}

export interface TeacherPick {
  teacher: SnapshotTeacher;
  /** periods they would carry afterwards, for the summary line */
  loadAfter: number;
}

/**
 * The teacher best placed to take `periods` of work in `classId`.
 *
 * Hard filters first — active engagement, §18 scope, weekly capacity — then
 * the one with the most headroom, so repeated fixes spread rather than pile
 * onto whoever happens to sort first. A teacher with no scope stated is
 * eligible for anything (§18: empty means "not stated", never "no classes"),
 * but is ranked below one who has been explicitly given the class.
 */
export function pickTeacher(
  snap: FeasibilitySnapshot,
  opts: {
    classId: number;
    periods: number;
    /** who must not be chosen — the teacher we are moving work away from */
    exclude?: number[];
    /** e.g. an alternate-period teacher cannot take a consecutive block */
    allowPattern?: (t: SnapshotTeacher) => boolean;
    /**
     * Periods this remedy has already handed out, by teacher.
     *
     * A remedy that moves four classes off one person picks four times, and
     * the snapshot's loads do not move in between — without this, all four
     * land on whoever was emptiest at the start and the fix creates the
     * overload it was clearing.
     */
    pending?: Map<number, number>;
  },
): TeacherPick | null {
  const load = loadByTeacher(snap);
  for (const [id, n] of opts.pending ?? []) load.set(id, (load.get(id) ?? 0) + n);
  const exclude = new Set(opts.exclude ?? []);
  const candidates = snap.teachers
    .filter((t) => !exclude.has(t.id))
    // §18: a guest belongs to extra classes, never the regular curriculum.
    .filter((t) => t.employmentType !== "guest")
    .filter((t) => t.eligibleClassIds.length === 0 || t.eligibleClassIds.includes(opts.classId))
    .filter((t) => (opts.allowPattern ? opts.allowPattern(t) : true))
    .map((t) => ({ t, after: (load.get(t.id) ?? 0) + opts.periods }))
    .filter((c) => c.after <= c.t.maxPeriodsPerWeek)
    .sort((a, b) => {
      // An explicitly scoped teacher is a better answer than an unscoped one,
      // even if the unscoped one is emptier: the school has said something
      // about the first and nothing about the second.
      const scoped = (x: typeof a) => (x.t.eligibleClassIds.includes(opts.classId) ? 0 : 1);
      return scoped(a) - scoped(b) || a.after - b.after || a.t.id - b.t.id;
    });
  const best = candidates[0];
  return best ? { teacher: best.t, loadAfter: best.after } : null;
}

/**
 * A room no class-section calls home, for a section that has none.
 *
 * Labs are skipped: a lab is a shared resource the solver draws on by subject
 * (§19), and making one a section's home room would take it out of that pool
 * all week. Biggest first, so the largest sections are not left with a
 * cupboard once the good rooms are gone.
 */
export function pickFreeRoom(snap: FeasibilitySnapshot, taken: Set<number>): SnapshotRoom | null {
  // `?? []` is not defensiveness for its own sake: a snapshot also travels as
  // JSON in a BullMQ payload, and during a rolling deploy a job queued by the
  // previous build arrives without this field. No remedy is the right answer
  // there; a crash inside the Feasibility Engine is not.
  const rooms = snap.rooms ?? [];
  const claimed = new Set<number>(taken);
  for (const roomId of Object.values(snap.homeRoomBySection)) {
    if (roomId !== null) claimed.add(roomId);
  }
  return (
    rooms
      .filter((r) => !claimed.has(r.id) && r.roomType !== "lab")
      .sort((a, b) => (b.capacity ?? 0) - (a.capacity ?? 0) || a.id - b.id)[0] ?? null
  );
}

/**
 * A lab that could serve `subjectId` but has not been told to.
 *
 * Prefers a lab already set up for something — marking it as *also* serving
 * this subject is a smaller claim than committing a general lab, which today
 * serves everything and would stop doing so the moment it is given a subject
 * list (§19).
 */
export function pickLabForSubject(snap: FeasibilitySnapshot, subjectId: number): SnapshotRoom | null {
  const labs = (snap.rooms ?? []).filter((r) => r.roomType === "lab" && !r.subjectIds.includes(subjectId));
  return (
    labs
      .filter((r) => r.subjectIds.length > 0)
      .sort((a, b) => a.subjectIds.length - b.subjectIds.length || a.id - b.id)[0] ?? null
  );
}

/**
 * Alternating working days for an `alternate_day` teacher who has none set.
 *
 * Every other day from the first, which is what the solver already assumes
 * when the set is blank (§4.7) — so this makes the school's data say what the
 * solver was going to do anyway, rather than quietly changing the timetable.
 */
export function alternatingDays(workingDays: number[]): number[] {
  return workingDays.filter((_, i) => i % 2 === 0);
}

export const dayList = (days: number[]) => days.map((d) => DAY_NAMES[d] ?? d).join(", ");

/**
 * Apply a remedy's changes to a snapshot, returning a new one.
 *
 * This is not a second implementation of the database writer — it is the
 * *preview*. The server runs it to answer "what would readiness be if I
 * accepted these?" without touching a row, and the tests run it to prove the
 * round trip: a remedy that does not make its own issue disappear is not a
 * remedy, and only re-running the engine can settle that.
 *
 * Derived parts of the snapshot (`homeRoomBySection`, `labRoomsBySubject`) are
 * rebuilt rather than patched, so a preview cannot drift from what the next
 * real snapshot would say.
 */
export function applyToSnapshot(snap: FeasibilitySnapshot, changes: RemedyChange[]): FeasibilitySnapshot {
  const next: FeasibilitySnapshot = {
    ...snap,
    teachers: snap.teachers.map((t) => ({ ...t, eligibleClassIds: [...t.eligibleClassIds] })),
    mappings: snap.mappings.map((m) => ({ ...m })),
    classSections: snap.classSections.map((c) => ({ ...c })),
    subjectRequirements: snap.subjectRequirements.map((r) => ({ ...r })),
    electiveBlocks: snap.electiveBlocks.map((b) => ({ ...b, options: b.options.map((o) => ({ ...o })) })),
    rooms: (snap.rooms ?? []).map((r) => ({ ...r, subjectIds: [...r.subjectIds] })),
    homeRoomBySection: { ...snap.homeRoomBySection },
    labRoomsBySubject: { ...snap.labRoomsBySubject },
  };
  let roomsTouched = false;

  for (const c of changes) {
    if (c.op === "set") {
      switch (c.entity) {
        case "teacher": {
          const t = next.teachers.find((x) => x.id === c.id);
          if (t) (t as unknown as Record<string, RemedyValue>)[c.field] = c.to;
          break;
        }
        case "classSection": {
          // A section's home room lives in the derived map, not on the row.
          if (c.field === "homeRoomId") next.homeRoomBySection[c.id] = c.to as number | null;
          else {
            const cs = next.classSections.find((x) => x.id === c.id);
            if (cs) (cs as unknown as Record<string, RemedyValue>)[c.field] = c.to;
          }
          break;
        }
        case "mapping": {
          const m = next.mappings.find((x) => x.id === c.id);
          if (m) (m as unknown as Record<string, RemedyValue>)[c.field] = c.to;
          break;
        }
        case "electiveOption": {
          for (const b of next.electiveBlocks) {
            const o = b.options.find((x) => x.id === c.id);
            if (o) (o as unknown as Record<string, RemedyValue>)[c.field] = c.to;
          }
          break;
        }
        case "classSubject": {
          const r = next.subjectRequirements.find((x) => x.id === c.id);
          if (r) (r as unknown as Record<string, RemedyValue>)[c.field] = c.to;
          break;
        }
        case "electiveBlock": {
          const b = next.electiveBlocks.find((x) => x.id === c.id);
          if (b) (b as unknown as Record<string, RemedyValue>)[c.field] = c.to;
          break;
        }
      }
    } else if (c.op === "link") {
      if (c.entity === "teacherClass") {
        const t = next.teachers.find((x) => x.id === c.id);
        if (t && !t.eligibleClassIds.includes(c.otherId)) t.eligibleClassIds.push(c.otherId);
      } else {
        const r = next.rooms.find((x) => x.id === c.id);
        if (r && !r.subjectIds.includes(c.otherId)) r.subjectIds.push(c.otherId);
        roomsTouched = true;
      }
    } else if (c.op === "create" && c.entity === "mapping") {
      const teacherId = Number(c.data.teacherId);
      const classSectionId = Number(c.data.classSectionId);
      const subjectId = Number(c.data.subjectId);
      next.mappings.push({
        // Preview only: the real id arrives when the row is written.
        id: -1 - next.mappings.length,
        teacherId,
        teacherName: next.teachers.find((t) => t.id === teacherId)?.name ?? "",
        subjectId,
        subjectName:
          next.subjectRequirements.find((r) => r.subjectId === subjectId)?.subjectName ?? "",
        classSectionId,
        classSectionLabel: next.classSections.find((cs) => cs.id === classSectionId)?.label ?? "",
        periodsPerWeek: Number(c.data.periodsPerWeek),
      });
    }
  }

  if (roomsTouched) {
    // §19's rule, restated rather than patched: a lab with no subjects listed
    // is general and serves everything, so giving one a subject takes it out
    // of every other subject's pool.
    const generalLabs = next.rooms.filter((r) => r.roomType === "lab" && r.subjectIds.length === 0).map((r) => r.id);
    for (const subjectId of next.labSubjectIds) {
      const dedicated = next.rooms.filter((r) => r.subjectIds.includes(subjectId)).map((r) => r.id);
      next.labRoomsBySubject[subjectId] = [...dedicated, ...generalLabs];
    }
  }
  return next;
}
