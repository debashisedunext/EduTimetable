/**
 * §15.3 Phase 28 — step 9: the whole allocation on one page.
 *
 * This replaces two steps. Curriculum asked "how many periods does each subject
 * get?" and Mapping asked "who teaches it?", and the split was arbitrary: they
 * are the same decision seen twice. The proof was already in the codebase —
 * `withCurriculumPeriods` exists for no reason except to stop the second step
 * quoting a number the first had since changed.
 *
 * One grid: **class-sections down, subjects across**, and each cell carries the
 * three facts at once — periods a week, the teacher, the room.
 *
 * Three things about this screen are decisions rather than styling:
 *
 *  1. **Periods are a CLASS fact; teacher and room are a SECTION fact.**
 *     `class_subjects` is keyed `(class_id, subject_id, academic_year_id)`, so
 *     changing 6 to 5 in Class 5-A's Maths changes all four sections. The grid
 *     does not hide that: rows group by class and the Load column SPANS the
 *     group, so the shape of the table is the explanation.
 *  2. **The load arithmetic is not a second opinion.** It comes from
 *     `computeLoads` in `packages/shared`, which the server calls too — see the
 *     note at the top of that module, which supersedes the older comment in
 *     `Syllabus.tsx` about not second-guessing the importer.
 *  3. **Everything except the grid is collapsed.** The grid is the page; the
 *     rest is apparatus, and apparatus earns its space by being asked for.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  assignInitials, assignSwatches, computeLoads, coverageGaps, defaultsFor, planClasses, relieveLoad,
  baseFromLessons, lessonsFromBase,
  subjectAppliesTo, subjectsForWing, suggestCurriculum, suggestMappings, weeklyCapacity,
  withCurriculumPeriods,
  type CurriculumCell, type LoadRemedy, type MappingSuggestion, type SubjectAnswer,
  type Swatch, type TeacherLoad, type TeacherAnswer, type WingAnswer,
} from "@edutimetable/shared";
import type { WeekAnswer } from "./Structure";
import {
  Advisor, CellBar, CellDialog, HoverBody, MiniBar, RemoveSubject, ResetAllocation,
  type CellSave, type Hover,
} from "./AllocationParts";
import { api } from "../../api";
import { asMessage } from "../../components";
import { Heading } from "./ui";

interface ClassTeacher { classSection: string; employeeCode: string }

/** Everything the screen derives once, from the draft answers. */
interface Model {
  wings: WingAnswer[];
  wing: WingAnswer | undefined;
  wingName: string;
  subjects: SubjectAnswer[];
  staff: Array<{ code: string; name: string; subjects: string[]; guest: boolean; classes: string[] }>;
  /**
   * Employee code → the initials to SHOW.
   *
   * A cell has room for about six characters, and `EDX-1041` spends all of them
   * on a prefix every teacher in the school shares. Initials are what a staff
   * room actually says.
   *
   * Minted by `assignInitials`, the same function `teacherSheets` uses at
   * commit — so the initials somebody is shown here are the ones the database
   * gets, rather than a display-only guess that turns out to be `AY2`.
   */
  initialsOf: Map<string, string>;
  /** Class rows of the ACTIVE wing, in ladder order. */
  classes: Array<{ className: string; sections: string[] }>;
  capacity: number;
  days: number;
  /**
   * Every wing's working days, not just the active one's.
   *
   * Load is a property of a TEACHER, and a teacher's other classes may be in
   * another wing with a different week. Handing `computeLoads` the active
   * wing's day count for all of them made `reachCap` wrong for everybody
   * outside the tab that happened to be open.
   */
  daysByWing: Record<string, number>;
  /** How long one period is, in this wing (§28). Step 5's number, shown here. */
  minutes: number;
  cells: CurriculumCell[];
  mappings: MappingSuggestion[];
  classTeachers: ClassTeacher[];
  rooms: string[];
  swatches: Record<string, Swatch>;
  loads: TeacherLoad[];
  byCode: Map<string, TeacherLoad>;
  gaps: number;
  /** Whether the plan on screen is a stored edit rather than the proposal. */
  edited: { curriculum: boolean; mappings: boolean };
  /**
   * §27.10 — the assignments that no longer agree with the Teachers step.
   *
   * The suggester staffs the curriculum from what each teacher teaches and
   * which classes they take. Once anything here is edited the stored plan wins
   * for good, which is right — but it also means changing somebody's subjects
   * on step 7 and coming back leaves the grid exactly as it was, and the honest
   * reading of that is "the Allocation page ignored me".
   *
   * So the mismatch is named rather than left to be noticed.
   */
  stale: Array<{ label: string; why: string }>;
  /** How many cells nobody teaches if the plan were re-proposed from scratch. */
  proposedGaps: number;
  /**
   * §31.17 — what the intersection rule removed from the grid.
   *
   * Counted rather than merely applied, because a column or a row that quietly
   * is not there reads as data somebody has lost.
   */
  hidden: { subjects: number; classes: number };
  /** §31.18 — the elective blocks that touch this wing, one column each. */
  blocks: Array<{
    id: number;
    name: string;
    periodsPerWeek: number;
    maxPeriodsPerDay: number;
    placement: "solver" | "same_period" | "fixed";
    members: Set<string>;
    options: Array<{ subject: string; teacher: string; room: string }>;
  }>;
  /**
   * §31.19 — the subjects a §4.9 block already owns, keyed `class::subject`.
   *
   * A block IS the teaching of its options: `solver/writer.ts` places the block
   * and `solver/variables.ts` builds a variable per mapping, so a curriculum
   * row for an option subject is that class taught the language twice. The
   * reference school has twenty-four of them.
   *
   * One map rather than a predicate re-derived at each call site: the cell's
   * style, the typing guard, the toolbar and the strip all ask this question,
   * and §10.6's rule is that four derivations of one fact are four chances to
   * disagree.
   */
  electiveLock: Map<string, { blockId: number; blockName: string }>;
}

/** The key `Model.electiveLock` is built and read with — never spelled twice. */
export const lockKey = (className: string, subject: string) =>
  `${className.trim().toLowerCase()}::${subject.trim().toLowerCase()}`;

/**
 * §31.18 — one §4.9 split-elective block, as the Lesson Grid needs it.
 *
 * Labels rather than ids for the members, because that is the vocabulary this
 * grid works in throughout (`Class 6-A`), and resolving ids to labels a second
 * time is a second chance to disagree with the row headers.
 */
export interface ElectiveBlockView {
  id: number;
  name: string;
  periodsPerWeek: number;
  maxPeriodsPerDay: number;
  placement: "solver" | "same_period" | "fixed";
  /** Class-section labels whose week this block occupies. */
  members: string[];
  /**
   * The parallel lessons inside the slot — one colour band each, and (§31.19)
   * one strip chip each.
   *
   * Teacher and room ride along because the strip explains the block rather
   * than merely naming it, and asking the server a second time for facts this
   * payload already carried is how two screens start disagreeing about who
   * takes French.
   */
  options: Array<{ subjectName: string; teacherName: string; roomName: string }>;
}

const label = (className: string, section: string) => `${className}-${section}`;
/** "Class 3-A" → "3-A": the class is already the group heading. */
const shortLabel = (l: string) => l.replace(/^Class\s+/i, "");

/**
 * §31.10 — "Pre-Nursery-A" → "PNA", for a column that has to be narrow.
 *
 * The row header is seven characters wide (§31.17), and a full label spends them on
 * a name the reader already knows from the row above. The class's words become
 * their initials and the section is appended: multi-word names shrink hardest,
 * which is exactly where the width was going.
 *
 * A number stays a number — "Class 5-A" is "5A", not "5A" via some initial of
 * "5" — and an existing acronym is left alone, so "LKG-A" is "LKGA" rather than
 * "LA", which would collide with every other L class.
 *
 * The full label never leaves the screen: it is the cell's `title`, and the
 * §31.6 strip prints it in full.
 */
const initialLabel = (l: string) => {
  const cut = l.lastIndexOf("-");
  const cls = (cut > 0 ? l.slice(0, cut) : l).replace(/^class\s+/i, "").trim();
  const sec = cut > 0 ? l.slice(cut + 1).trim() : "";
  const words = cls.split(/[\s-]+/).filter(Boolean);
  // A single word is trimmed rather than initialled: "Nursery" as "N" would
  // collide with every other N class, and left whole it is longer than the
  // column — so three letters, which is what a wall chart uses.
  const head = words.length > 1
    ? words.map((w) => w[0]).join("").toUpperCase()
    : cls.length <= 4 ? cls : cls.slice(0, 3);
  return `${head}${sec}`;
};

const BAND_COLOUR: Record<string, string> = {
  ok: "var(--steel)", warn: "var(--amber)", full: "var(--brand)", over: "var(--signal)",
};
const BAND_BG: Record<string, string> = {
  ok: "var(--paper)", warn: "var(--amber-bg)", full: "var(--steel-pale)", over: "var(--signal-bg)",
};

// ─────────────────────────────────────────────────────────────── the model

function useModel(answers: Record<string, any>, activeWing: number,
                  electives: ElectiveBlockView[]): Model {
  return useMemo(() => {
    const wings: WingAnswer[] = answers.wings ?? [];
    const weeks: Record<string, WeekAnswer> = answers.weeks ?? {};
    /*
      §32 — only the subjects THIS timetable teaches.

      `subjectsForWing` in `packages/shared` is the one definition, shared with
      the Subjects step's tick boxes and with the commit that writes
      `timetable_subjects` — three readers of one rule, each of which would get
      "absent means all" (invariant 7) wrong in its own way.

      Narrowed by the ACTIVE wing rather than by the pool: two grouped wings
      share a §30 pool and are exactly the case this exists for, since Junior
      and Senior teach different subjects out of one resource group.

      This also feeds `computeLoads`, `suggestMappings` and `coverageGaps`, so a
      subject a wing does not teach stops being demand it is short of rather
      than merely disappearing from the grid — which is what would have made
      the column vanish while Readiness still reported it missing.
    */
    const named: SubjectAnswer[] = (answers.subjects ?? []).filter((s: SubjectAnswer) => s.name?.trim());
    const subjects = subjectsForWing(
      named,
      answers.subjectsByWing,
      (answers.wings ?? [])[activeWing]?.name ?? null,
    );
    const teachers: TeacherAnswer[] = answers.teachers ?? [];

    const capacityByWing: Record<string, number> = {};
    const daysByWing: Record<string, number> = {};
    const minutesByWing: Record<string, number> = {};
    for (const w of wings) {
      const week = weeks[w.name];
      const workingDays = week?.workingDays ?? [1, 2, 3, 4, 5];
      capacityByWing[w.name] = weeklyCapacity(week?.periodsPerDay ?? 8, workingDays);
      daysByWing[w.name] = workingDays.length;
      // §28 — how long a period IS. A property of the wing's week (step 5),
      // not of a class or a subject: the solver places into period NUMBERS on
      // one shared grid, so two classes in a wing cannot have different period
      // lengths. Shown here because minutes-a-week is what a head teacher
      // actually asks about, and changed here because that is where they are
      // looking when they ask.
      minutesByWing[w.name] = week?.periodDurationMins ?? 40;
    }

    // The suggestion is the fallback, exactly as the two old steps had it: an
    // edited answer wins, an absent one is re-proposed. That is what lets
    // adding a teacher on step 7 change the proposal while an edit made here
    // survives.
    const proposedCurriculum = suggestCurriculum(wings, subjects, capacityByWing, daysByWing);
    const stored: CurriculumCell[] | null = Array.isArray(answers.curriculum) ? answers.curriculum : null;

    /**
     * §27.15 — the fallback is per WING, not all-or-nothing.
     *
     * `answers.curriculum ?? proposal` reads fine until a school with a planned
     * wing adds a second one. The stored array is not empty, so it wins for the
     * whole school, and every class in the new wing arrives with no subjects at
     * all — a grid of dashes on a page whose whole job is to arrive full. §27.12
     * makes this the ORDINARY path, not an edge case: an existing school's
     * answers are prefilled from its master data, so the array is populated
     * before anybody has touched the page.
     *
     * A wing, rather than a class, is the unit that decides. Absence has to keep
     * meaning something inside a wing that has been planned: a class somebody
     * emptied on purpose — every subject removed, which §27.15's delete makes a
     * normal thing to do — must stay empty, and it would come straight back if
     * the fallback filled any class with no rows.
     */
    const wingOfClass = new Map(planClasses(wings).classes.map((c) => [c.className, c.wing]));
    const plannedWings = new Set((stored ?? []).map((c) => wingOfClass.get(c.className)).filter(Boolean));
    const fresh = (className: string) => !plannedWings.has(wingOfClass.get(className));

    const cells: CurriculumCell[] = stored
      ? [...stored, ...proposedCurriculum.cells.filter((c) => fresh(c.className))]
      : proposedCurriculum.cells;
    const curriculum = { cells, totals: [], dropped: [] };
    const proposedMappings = suggestMappings(wings, curriculum, teachers, daysByWing);
    // The same rule for the staffing, or the new wing's cells would all read
    // "no teacher" and the §27.10 banner would offer to re-staff the entire
    // school to fix a wing that was never staffed in the first place.
    const classOfSection = (cs: string) => cs.replace(/-[^-]+$/, "").trim();
    const storedMappings: MappingSuggestion[] | null =
      Array.isArray(answers.mappings) ? answers.mappings : null;
    const mappings = withCurriculumPeriods(curriculum, storedMappings
      ? [...storedMappings,
         ...proposedMappings.mappings.filter((x) => x.classSections.every((cs) => fresh(classOfSection(cs))))]
      : proposedMappings.mappings);
    const storedCTs: ClassTeacher[] | null =
      Array.isArray(answers.classTeachers) ? answers.classTeachers : null;
    const classTeachers: ClassTeacher[] = storedCTs
      ? [...storedCTs,
         ...proposedMappings.classTeachers.filter((c) => fresh(classOfSection(c.classSection)))]
      : proposedMappings.classTeachers;

    const shownInitials = assignInitials(teachers);
    const staff = teachers
      .map((t, i) => ({
        code: t.employeeCode?.trim() || `T-${String(i + 1).padStart(3, "0")}`,
        name: t.name,
        subjects: t.subjects ?? [],
        guest: t.employmentType === "guest",
        // §27.9 — empty means "not stated", never "no classes" (invariant 7).
        classes: t.classes ?? [],
      }))
      .filter((t) => t.name?.trim());

    const wing = wings[activeWing];
    const all = planClasses(wings).classes;

    // §28.1 — the school's own "getting full" line, from step 10's settings.
    // One number, so the rail here and Readiness afterwards cannot disagree
    // about who is nearly full.
    const warnAt = (answers.settings?.loadAlertPct ?? 75) / 100;
    const loads = computeLoads({ wings, curriculum: cells, mappings, teachers, subjects, daysByWing, warnAt });

    /**
     * Where the stored plan and the Teachers step disagree.
     *
     * Three ways, and they are named separately because they have different
     * fixes: the teacher is gone, they no longer teach the subject, or they are
     * no longer scoped to the class.
     */
    const byCodeStaff = new Map(staff.map((t) => [t.code, t]));
    const stale: Array<{ label: string; why: string }> = [];
    for (const m of mappings) {
      const who = byCodeStaff.get(m.employeeCode);
      const where = m.classSections.join(", ");
      if (!who) {
        stale.push({ label: `${where} ${m.subjectName}`, why: "that teacher is no longer on the staff list" });
      } else if (!who.subjects.includes(m.subjectName)) {
        stale.push({ label: `${where} ${m.subjectName}`, why: `${who.name} no longer teaches ${m.subjectName}` });
      } else if (who.classes.length > 0
        && !m.classSections.every((cs) => who.classes.includes(cs.replace(/-[^-]+$/, "")))) {
        stale.push({ label: `${where} ${m.subjectName}`, why: `${who.name} is not scoped to ${where}` });
      }
    }

    /**
     * §31.17 — the grid is the INTERSECTION, not the cross product.
     *
     * A subject is a column if some class in this timetable takes it; a class
     * is a row if it takes some subject in this timetable. One rule read twice,
     * because the two halves are the same statement — §27.16's declaration of
     * which classes a subject is taught to — and answering it differently for
     * rows and columns would draw a row whose every cell the server refuses.
     *
     * That is not a tidying. A cell where the two do not meet is not an empty
     * cell somebody might fill: `assertSubjectApplies` REFUSES it, so it is a
     * cell that can only ever say no. A primary wing given the CBSE catalogue
     * gets Biology, Accountancy and eighteen more senior columns it can never
     * use, each one squeezing the subjects it does teach below the width where
     * a period count is legible.
     *
     * **Display only, and deliberately after every engine has run.** The
     * proposal, the loads and the coverage gaps above are computed from the
     * unfiltered list on purpose — a subject dropped from the columns must
     * stop being drawn, never stop being demand the school is short of, which
     * is the mistake §32's own note warns about. Nothing is deleted either: a
     * curriculum cell for a hidden pair stays in `answers.curriculum` and is
     * still committed. This decides what is drawn and nothing else.
     *
     * **Empty means "not stated", so this cannot bite a school that has not
     * declared anything** (invariant 7): `subjectAppliesTo` returns true for a
     * subject with no classes listed, so a school that never used §27.16 sees
     * exactly the grid it saw before. Only a stated exclusion removes anything.
     *
     * The guard is the last line. If the rule would empty the grid — every
     * subject declared, none of them for any class here — it does not apply:
     * a blank grid reads as broken, and it would hide the only screen from
     * which the declarations can be put right.
     */
    /**
     * §31.18 — the elective blocks that touch this wing.
     *
     * Matched by member LABEL against the sections this wing actually runs, so
     * a block belonging to another wing of the same pool does not appear here
     * and a block only half in this wing does — with the sections that are not
     * in it left blank, which is the truth about who attends.
     */
    const wingSectionLabels = new Set(
      all.filter((c) => c.wing === wing?.name)
        .flatMap((c) => c.sections.map((sec) => label(c.className, sec).trim().toLowerCase())),
    );
    const blocks = (electives ?? [])
      .map((b) => ({
        id: b.id,
        name: b.name,
        periodsPerWeek: b.periodsPerWeek,
        maxPeriodsPerDay: b.maxPeriodsPerDay,
        placement: b.placement,
        members: new Set(b.members.map((x) => x.trim().toLowerCase())),
        options: b.options.map((o) => ({
          subject: o.subjectName, teacher: o.teacherName, room: o.roomName,
        })),
      }))
      .filter((b) => [...b.members].some((x) => wingSectionLabels.has(x)));

    /**
     * §31.19 — which `(class, subject)` pairs a block owns.
     *
     * **EVERY section of the class, not any.** Periods are a class fact (§27):
     * one number covers all of 5-A, 5-B and 5-C. If only half a class's
     * sections attend the block the other half genuinely take the subject as
     * curriculum, and refusing that one number would leave them with no way to
     * be taught at all. So partial membership does not lock — it is reported in
     * the strip instead, which is the honest answer to a question the data
     * model can ask and a single number cannot answer.
     */
    const electiveLock = new Map<string, { blockId: number; blockName: string }>();
    for (const b of blocks) {
      for (const c of all.filter((x) => x.wing === wing?.name)) {
        const covered = c.sections.every((sec) =>
          b.members.has(label(c.className, sec).trim().toLowerCase()));
        if (!covered) continue;
        for (const o of b.options) {
          electiveLock.set(lockKey(c.className, o.subject), { blockId: b.id, blockName: b.name });
        }
      }
    }

    const wingClasses = all.filter((c) => c.wing === wing?.name);
    const paired = subjects.filter((s) => wingClasses.some((c) => subjectAppliesTo(s, c.className)));
    /*
      §31.18 — a class in an elective block is taught something.

      §31.17 drops a class no subject is declared for, on the grounds that every
      one of its cells would be refused. A block is the exception and has to be
      named: its options are not `class_subjects` rows, so a class whose only
      teaching is a language block looks undeclared to the rule above — and
      hiding it would take away the row that shows the block, the row whose Load
      figure is the only place that demand is counted.
    */
    const inABlock = (className: string) =>
      blocks.some((b) => [...b.members].some((x) => x.startsWith(`${className.trim().toLowerCase()}-`)));
    const pairedClasses = wingClasses.filter(
      (c) => inABlock(c.className) || paired.some((s) => subjectAppliesTo(s, c.className)),
    );
    const usable = paired.length > 0 && pairedClasses.length > 0;

    return {
      wings,
      wing,
      wingName: wing?.name ?? "",
      subjects: usable ? paired : subjects,
      staff,
      classes: (usable ? pairedClasses : wingClasses).map((c) => ({ className: c.className, sections: c.sections })),
      /**
       * What the rule above took away, so that it is never a silent narrowing.
       *
       * A column that quietly is not there reads as a subject the school
       * forgot to create, and a class row that quietly is not there reads as
       * children who have been lost. Both are stated on the rail instead, with
       * the reason, because the fix is on the Subjects master and somebody has
       * to know to go there.
       */
      hidden: usable
        ? { subjects: subjects.length - paired.length, classes: wingClasses.length - pairedClasses.length }
        : { subjects: 0, classes: 0 },
      capacity: capacityByWing[wing?.name ?? ""] ?? 40,
      days: daysByWing[wing?.name ?? ""] ?? 5,
      daysByWing,
      minutes: minutesByWing[wing?.name ?? ""] ?? 40,
      cells,
      mappings,
      classTeachers,
      initialsOf: new Map(
        teachers.map((t, i) => [
          t.employeeCode?.trim() || `T-${String(i + 1).padStart(3, "0")}`,
          shownInitials[i],
        ]),
      ),
      // §19: the room list the school actually has. A blank choice means the
      // section's home room, which is what the solver claims by default.
      rooms: (answers.rooms ?? []).map((r: { name: string }) => r.name).filter(Boolean),
      // Set-aware, so twenty subjects do not collide the way a bare hash would
      // (§10.5) — and the same module the Board and Matrix use, so Maths is one
      // colour everywhere.
      /*
        §31.18 — the option subjects are in the SET, not coloured separately.

        `assignSwatches` is set-aware on purpose (§10.5): it hashes to a
        preferred slot and probes forward, so the answer for one name depends
        on every other name in the call. Colouring the elective options in a
        second call would let French and Maths land on the same swatch — the
        collision the set-awareness exists to prevent — and the two bands of a
        language block would then be indistinguishable, which is precisely what
        this column is for.

        An option's subject may not be a column here at all (not ticked for this
        wing, or taken out by §31.17), and it still belongs in the set: the
        timetable does teach it, through the block.
      */
      swatches: assignSwatches([...new Set([
        ...subjects.map((s) => s.name),
        ...blocks.flatMap((b) => b.options.map((o) => o.subject)),
      ])]),
      loads,
      byCode: new Map(loads.map((l) => [l.employeeCode, l])),
      gaps: coverageGaps(wings, curriculum, mappings).length,
      edited: {
        curriculum: Array.isArray(answers.curriculum) && answers.curriculum.length > 0,
        mappings: Array.isArray(answers.mappings) && answers.mappings.length > 0,
      },
      stale,
      proposedGaps: coverageGaps(wings, curriculum, proposedMappings.mappings).length,
      blocks,
      electiveLock,
    };
  }, [electives, JSON.stringify([answers.wings, answers.weeks, answers.subjects, answers.teachers,
                      answers.curriculum, answers.mappings, answers.classTeachers, answers.rooms,
                      // §32 — the grid's columns depend on it, so it has to be
                      // in the key or a tick would not redraw the grid.
                      answers.subjectsByWing,
                      answers.settings?.loadAlertPct]), activeWing]);
}

// ─────────────────────────────────────────────────────────── the hover card

function Tip({ at, children }: { at: { x: number; y: number }; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: at.x + 14, top: at.y + 14 });
  useEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    // Flipped rather than clamped: a card that slides back under the cursor
    // covers the cell somebody is reading.
    const left = at.x + 14 + box.width > window.innerWidth - 8 ? at.x - box.width - 14 : at.x + 14;
    const top = at.y + 14 + box.height > window.innerHeight - 8 ? at.y - box.height - 14 : at.y + 14;
    setPos({ left: Math.max(8, left), top: Math.max(8, top) });
  }, [at.x, at.y]);

  return (
    <div ref={ref} role="tooltip" style={{
      position: "fixed", left: pos.left, top: pos.top, zIndex: 600, pointerEvents: "none",
      maxWidth: 340, background: "var(--paper)", border: "1px solid var(--line)", borderRadius: 11,
      boxShadow: "0 12px 34px rgba(11,31,68,.24)", padding: "11px 13px", fontSize: 11.6,
      color: "var(--ink-soft)", lineHeight: 1.5,
    }}>{children}</div>
  );
}

/**
 * §27.14 — the hover card is a preference, and it is remembered.
 *
 * The card is the fastest way to read a cell — four facts about a 58px button
 * without opening anything — and it is also a panel that follows the pointer
 * across a grid somebody may be scanning rather than reading. Both are true, so
 * this is a switch rather than a decision made once for everybody.
 *
 * It is remembered across visits, unlike the §8.1d nav collapse, and the
 * difference is not inconsistency: the nav's default was the shape the school
 * asked every user to start in, whereas somebody who turns cards off has told
 * us something about how they work. Making them say it again on every visit
 * would be the annoyance they were switching off.
 *
 * Failing to read or write the preference is not an error worth surfacing — a
 * browser with storage blocked gets the default and a working page.
 */
const HOVER_PREF = "edutimetable.allocation.hoverDetail";

function useHoverDetail(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => {
    try { return window.localStorage.getItem(HOVER_PREF) !== "off"; } catch { return true; }
  });
  return [on, (next: boolean) => {
    setOn(next);
    try { window.localStorage.setItem(HOVER_PREF, next ? "on" : "off"); } catch { /* storage blocked */ }
  }];
}

// ─────────────────────────────────────────────────────────────── the step

/**
 * §31.10 — everything the Master Grid's strip needs about one cell.
 *
 * Read from this component's own model, so the strip cannot disagree with the
 * grid above it — and, crucially, so it speaks from the **draft**. The other
 * four tabs' strip reads `/slots` and `/context`, which is the week as *saved*;
 * this grid edits answers that are only in the browser until Save. A strip that
 * asked the server here would say 6 while the cell said 8, one click apart.
 */
export interface AllocationCellFacts {
  /** "Class 5-A" */
  section: string;
  /** "Class 5" — periods are a CLASS fact (§27), and the strip says so. */
  className: string;
  subject: string;
  periodsPerWeek: number;
  teacherCode: string;
  teacherName: string | null;
  teacherInitials: string | null;
  room: string | null;
  /** §4.10 — every section taught together in this one lesson, this one included. */
  sharedWith: string[];
  isClassTeacher: boolean;
  /** What else this class studies, for the context group. */
  studies: Array<{ subject: string; periods: number }>;
  /** The week this wing offers, so a total has a denominator. */
  capacity: number;
  /**
   * §31.19 — the §4.9 block that already teaches this subject to this class,
   * if one does. Its periods are set on the block, not here.
   */
  lockedBy?: string | null;
  /** §31.19 — present only for a block column's cell. */
  block?: {
    id: number;
    name: string;
    periodsPerWeek: number;
    maxPeriodsPerDay: number;
    placement: "solver" | "same_period" | "fixed";
    options: Array<{ subject: string; teacher: string; room: string }>;
    members: string[];
    /** Whether the selected section is one of them. */
    attends: boolean;
  };
}

/**
 * §31.16 — one cell's box, as a button or as a field.
 *
 * The selected cell holds a real `<input>`, and an input inside a `<button>` is
 * invalid HTML: the button swallows the click that would place a caret, and
 * screen readers announce a control containing a control. So the element
 * changes with the state while everything else — the colours, the three lines,
 * the focus ring — stays identical, which is why the caller passes one style
 * object rather than maintaining two.
 *
 * The div claims no ARIA role of its own: the `<input>` inside is the control
 * and carries the label, and a `gridcell` on a wrapper inside a real `<td>`
 * would describe the same table to a screen reader twice, differently.
 */
function CellShell({
  editing, className, onClick, style, title, children, ...rest
}: {
  editing: boolean;
  className?: string;
  onClick: () => void;
  style: React.CSSProperties;
  title?: string;
  children: React.ReactNode;
} & Record<string, unknown>) {
  if (editing) {
    return (
      /* No `role` invented for the div: the labelled `<input>` inside IS the
         control, and claiming `gridcell` on a wrapper inside a real `<td>`
         would describe the table to a screen reader twice, differently. */
      <div className={className} onClick={onClick} title={title}
        style={{ ...style, cursor: "text" }} {...rest}>
        {children}
      </div>
    );
  }
  return (
    <button className={className} onClick={onClick} title={title} style={style} {...rest}>
      {children}
    </button>
  );
}

export function StepAllocation({
  answers, onChange, onFocusMode, density = "comfortable", wing, onSelectCell, toolbarHost,
  spanByClass, electives = [], onElectivesChanged,
}: {
  answers: Record<string, any>;
  onChange: (patch: Record<string, any>) => void;
  /** Lets the step ask the wizard shell to fold its chrome away. */
  onFocusMode?: (on: boolean) => void;
  /**
   * §31.10 — how much width a column may take.
   *
   * `comfortable` is this grid as it has always been: columns sized by their
   * content, three lines in a cell, and a horizontal scrollbar once a school
   * has more subjects than the pane has room for. That is right for
   * `/allocation`, which is a page of its own.
   *
   * `compact` is the Master Grid's Lesson Grid tab, where the whole point is
   * that **every subject is on screen at once**. Two things pay for it: the
   * columns become percentages of a `table-layout: fixed` table rather than
   * content-sized, and the cell's third line — the room — moves to the strip
   * below the grid, which is why that strip exists.
   *
   * The default is what it was, so the guided setup and `/allocation` render
   * exactly as they did before this prop.
   */
  density?: "comfortable" | "compact";
  /**
   * §33.6 — how many BASE periods one of each class's lessons occupies, by
   * class name.
   *
   * A class on 60-minute lessons in a 30-minute grid has a span of 2, so "3
   * English a week" is six base periods. `class_subjects.periods_per_week` is
   * stored in base periods and stays that way — it is what `writer.ts` counts —
   * so this cell converts at its own edge and nothing downstream changes.
   *
   * Absent, or 1, and the cell is exactly what it was: the number typed is the
   * number stored, which is every school with no §33 spans.
   */
  spanByClass?: Record<string, number>;
  /**
   * §31.18 — the §4.9 elective blocks this timetable runs, one column each.
   *
   * Supplied by the Master Grid, which knows the academic year; the guided
   * setup does not pass it, and that is deliberate rather than an omission —
   * a block is created on the Electives screen after the setup has produced
   * the class-sections it attaches to, so during setup there is nothing to
   * show. Absent is exactly the grid as it was.
   */
  electives?: ElectiveBlockView[];
  /**
   * §31.19 — re-read the blocks, after this grid has changed one.
   *
   * A block's periods are the one thing here that writes straight to the
   * server: blocks are not in the wizard's draft, so there is no Save for them
   * to ride on (§27.15's delete is the same exception for the same reason).
   * The host refetches rather than this component patching its own copy —
   * local state would survive a PUT the server refused and read as saved.
   */
  onElectivesChanged?: () => void;
  /**
   * §31.10 — which wing to show, when the HOST already picks one.
   *
   * The Master Grid's top bar selects the timetable and its other four tabs
   * obey it. This grid has wing tabs of its own, and two controls for one
   * choice contradict each other the first time they disagree — so when a name
   * is given the tabs are not rendered and the selection follows it. On
   * `/allocation`, which has no top bar to defer to, it stays undefined and the
   * tabs behave exactly as before.
   */
  wing?: string | null;
  /**
   * §31.10 — the cell somebody is looking at, for a host that draws a strip.
   *
   * The FACTS, not the coordinates. The host could look "Class 5-A × Maths" up
   * for itself, but only by rebuilding this component's model from the same
   * draft — a second derivation of merged groups, class teachers and swatches,
   * free to disagree with the grid it sits under. The grid already knows, so
   * it hands over what it knows.
   */
  onSelectCell?: (facts: AllocationCellFacts | null) => void;
  /**
   * §31.10 — where this step's controls should be drawn.
   *
   * The Master Grid already has a toolbar; this step drawing a second one
   * underneath it gave the Lesson Grid tab two rows of chrome, one above the
   * box and one inside it. Given a node, the control row is PORTALLED there
   * instead.
   *
   * A portal rather than lifting the state out: `query`, `hoverDetail`,
   * `showHelp` and the two destructive actions all belong to this component and
   * read its model. Moving six pieces of state into the host to move six
   * buttons would be the tail wagging the dog, and `/allocation` — which has no
   * toolbar to lend — would still need them back here.
   */
  toolbarHost?: HTMLElement | null;
}) {
  const [activeWing, setActiveWing] = useState(0);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [showChips, setShowChips] = useState(false);
  const [showAdvice, setShowAdvice] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [editing, setEditing] = useState<{ section: string; subject: string } | null>(null);
  const [hover, setHover] = useState<{ what: Hover; x: number; y: number } | null>(null);
  const [hoverDetail, setHoverDetail] = useHoverDetail();
  const [resetting, setResetting] = useState(false);
  /** §27.15 — the cell whose subject is being taken off a class. */
  const [removing, setRemoving] = useState<{ className: string; subject: string } | null>(null);
  /**
   * §27.16 — why an edit was refused, when it was.
   *
   * A keystroke that does nothing is indistinguishable from a broken grid, and
   * this grid takes single digits with no Enter — so the one case where it
   * declines has to say so out loud.
   */
  const [refused, setRefused] = useState<string | null>(null);
  /**
   * §27.11 — the timetable id behind the wing whose tab is open.
   *
   * The wizard works on draft answers and holds no ids; the wings were created
   * by name on step 3. Looked up here rather than threaded through every step,
   * and absent until it resolves — which is why the destructive control only
   * appears once there is something real to point it at.
   */
  const [configIds, setConfigIds] = useState<Record<string, number>>({});
  useEffect(() => {
    let live = true;
    api<Array<{ id: number; name: string }>>("/timetable-configs")
      .then((cfgs) => {
        if (!live) return;
        setConfigIds(Object.fromEntries(cfgs.map((c) => [c.name.toLowerCase(), c.id])));
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, []);
  const [cursor, setCursor] = useState<{ row: number; col: number }>({ row: 0, col: 0 });
  const gridRef = useRef<HTMLDivElement>(null);

  /*
    A forced wing wins over the local tab state, and falls back to it when the
    name matches nothing — `AllocationTab` refuses to render in that case, so
    reaching the fallback means the host did not supply a wing at all.
  */
  const wingNames: string[] = ((answers.wings ?? []) as Array<{ name: string }>).map((w) => w.name);
  const forcedWing = wing
    ? wingNames.findIndex((n) => n.trim().toLowerCase() === wing.trim().toLowerCase())
    : -1;
  const shownWing = forcedWing >= 0 ? forcedWing : activeWing;

  const m = useModel(answers, shownWing, electives);

  /** §31.10 — one cell, as the strip needs it. */
  const factsFor = (section: string, subject: string): AllocationCellFacts | null => {
    const className = section.replace(/-[^-]+$/, "");
    if (!m.subjects.some((x) => x.name === subject)) return null;
    const idx = mappingIndexOf(section, subject);
    const row = idx >= 0 ? m.mappings[idx] : null;
    const code = row?.employeeCode ?? "";
    return {
      section,
      className,
      subject,
      periodsPerWeek: periodsOf(className, subject),
      teacherCode: code,
      teacherName: code ? nameOf(code) : null,
      teacherInitials: code ? initialsOf(code) : null,
      // The fallback the cell itself draws, so the strip names the same room.
      room: code ? (row?.room || `${shortLabel(section)} room`) : null,
      sharedWith: row?.merged && (row.classSections?.length ?? 0) > 1
        ? row.classSections.map((x) => x.trim())
        : [section],
      isClassTeacher: !!code && classTeacherOf(section) === code,
      studies: m.cells
        .filter((c) => c.className === className && c.periodsPerWeek > 0)
        .map((c) => ({ subject: c.subjectName, periods: c.periodsPerWeek }))
        .sort((a, b) => b.periods - a.periods),
      capacity: m.capacity,
      // §31.19 — which §4.9 block already owns this subject for this class.
      lockedBy: m.electiveLock.get(lockKey(className, subject))?.blockName ?? null,
    };
  };

  /**
   * §31.19 — the same facts for a §4.9 block cell.
   *
   * It fills `AllocationCellFacts` rather than inventing a parallel shape,
   * because the strip's contract is one callback and one payload — §31.10's
   * rule that the strip is fed finished facts from the screen's OWN model, so
   * that it cannot describe a cell the grid is not showing. What a block does
   * not have — a teacher, a room, one subject — is null, and the `block` field
   * is what tells the strip to draw the other groups instead.
   */
  const blockFactsFor = (section: string, blockId: number): AllocationCellFacts | null => {
    const b = m.blocks.find((x) => x.id === blockId);
    if (!b) return null;
    const className = section.replace(/-[^-]+$/, "");
    return {
      section,
      className,
      subject: b.name,
      periodsPerWeek: b.members.has(section.trim().toLowerCase()) ? b.periodsPerWeek : 0,
      teacherCode: "",
      teacherName: null,
      teacherInitials: null,
      room: null,
      sharedWith: [section],
      isClassTeacher: false,
      studies: m.cells
        .filter((c) => c.className === className && c.periodsPerWeek > 0)
        .map((c) => ({ subject: c.subjectName, periods: c.periodsPerWeek }))
        .sort((a, b2) => b2.periods - a.periods),
      capacity: m.capacity,
      lockedBy: null,
      block: {
        id: b.id,
        name: b.name,
        periodsPerWeek: b.periodsPerWeek,
        maxPeriodsPerDay: b.maxPeriodsPerDay,
        placement: b.placement,
        options: b.options,
        members: [...b.members],
        attends: b.members.has(section.trim().toLowerCase()),
      },
    };
  };

  /**
   * Which cell the strip is describing.
   *
   * Re-emitted whenever the MODEL changes, not only on click: editing through
   * the dialog would otherwise leave the strip quoting the numbers the cell had
   * before it was edited — the exact contradiction the strip reads the draft to
   * avoid. The callback is held in a ref so a host that passes a fresh arrow
   * every render does not re-fire this on every render.
   */
  /**
   * §31.19 — the selected cell, which is a subject cell OR a §4.9 block cell.
   *
   * `blockId` set is the whole difference; `subject` then carries the block's
   * NAME so every label site keeps working unchanged. A discriminated union
   * would be tidier in the type and would have meant narrowing at a dozen
   * places that only ever want something to print.
   */
  const [stripCell, setStripCell] =
    useState<{ section: string; subject: string; blockId?: number } | null>(null);
  /*
    §31.15 — a selection cannot outlive the wing it names.

    The toolbar now EDITS the selected cell, so a stale one is worse than a
    stale strip line: switching wing would leave a bar pointing at a section
    the grid no longer shows, and typing in it would write to a class nobody
    is looking at.
  */
  useEffect(() => setStripCell(null), [activeWing]);
  const emitCell = useRef(onSelectCell);
  emitCell.current = onSelectCell;
  useEffect(() => {
    emitCell.current?.(stripCell
      ? (stripCell.blockId !== undefined
        ? blockFactsFor(stripCell.section, stripCell.blockId)
        : factsFor(stripCell.section, stripCell.subject))
      : null);
    // Deps are `stripCell` and `m` deliberately: `factsFor` is rebuilt every
    // render and listing it would re-fire this on renders that changed nothing,
    // while `m` is what actually changes its answer.
  }, [stripCell, m]);

  /**
   * §31.17 — the two fixed columns, and the floor the subjects share.
   *
   * Both edges are **pixels now, not percentages**, and that is what makes the
   * widths sayable. "Seven characters" is an absolute statement about a
   * class-section label; as a percentage of a table whose own width grows with
   * the subject count it was not one, and at forty subjects the header was
   * taking 11% of 2,700px — a third of the pane — for a cell holding "NurA".
   *
   * It also removes a disagreement rather than restating it. The old
   * `tightMinWidth` had to be derived backwards from the column percentage,
   * because the edges were percentages of the very number being computed; with
   * the edges fixed, the honest sum below IS the only arithmetic and there is
   * no second one to drift from it.
   *
   * The subject columns are given no width at all: under `table-layout: fixed`
   * the unclaimed space divides equally between them, so they are exactly "the
   * rest", and `minWidth` is the point at which a scrollbar appears instead of
   * a cell too narrow to read — the rule §31.1 set for the timetable tabs.
   */
  const tight = density === "compact";
  /**
   * Seven characters of a class-section label, plus the class-teacher badge.
   *
   * 19px of padding + ~48px for seven characters at 11.5px Inter + a 6px gap +
   * the 18px initials circle. "Class-section" in the header fits the same box
   * once its own padding is tightened.
   */
  const HEAD_PX = 92;
  /** Wide enough for "40/40" and the bar under it; it no longer scrolls away. */
  const LOAD_PX = 88;
  /** The narrowest a cell may be and still hold a period count and two initials. */
  const MIN_COL_PX = 50;
  const subjectCols = m.subjects.length + m.blocks.length;
  const tightMinWidth = HEAD_PX + LOAD_PX + Math.max(1, subjectCols) * MIN_COL_PX;

  /**
   * §31.18 — a block's cell, painted with one band per option.
   *
   * The rule §10.5 set for a class row was a dashed steel tint, because a block
   * is several subjects at once and no single colour is true of it. A gradient
   * with hard stops says the same thing without giving up the information: the
   * cell IS several subjects, and here they are, in the same colours those
   * subjects wear in every other column of this grid and on the Board.
   *
   * `bg` rather than `border`: these are the pale fills the palette designed to
   * be written on, so `var(--ink)` reads on every one of them — which matters
   * because no single `fg` can be right across three different bands.
   */
  const bandsFor = (options: Array<{ subject: string }>): string => {
    const fills = options.map((o) => m.swatches[o.subject]?.bg ?? "var(--steel-pale)");
    if (fills.length === 0) return "var(--steel-pale)";
    if (fills.length === 1) return fills[0];
    const step = 100 / fills.length;
    return `linear-gradient(105deg, ${fills
      .map((c, i) => `${c} ${(i * step).toFixed(3)}% ${((i + 1) * step).toFixed(3)}%`)
      .join(", ")})`;
  };

  /**
   * §31.18 — the block periods that press on a class's week.
   *
   * The MAX across the class's sections, never the sum: Check 1 measures each
   * section's week separately, so a block covering only 5-A is five periods on
   * 5-A and none on 5-B, and the binding number for "does Class 5 fit?" is the
   * tightest section. Summing would double-count the ordinary case where every
   * section attends, which would report a full class as over by the width of
   * its own elective.
   */
  const electivePeriodsOf = (className: string) => {
    const cls = m.classes.find((c) => c.className === className);
    if (!cls) return 0;
    return cls.sections.reduce((worst, sec) => {
      const id = label(className, sec).trim().toLowerCase();
      const n = m.blocks.reduce((t, b) => t + (b.members.has(id) ? b.periodsPerWeek : 0), 0);
      return Math.max(worst, n);
    }, 0);
  };

  /**
   * The load rail's bar and gap, sized so every teacher fits inside its 340px.
   *
   * A gap is only worth having while the bars are wide enough to be told apart
   * without it; past that it is 74% of the space each teacher gets. Below the
   * `minWidth` floor a flex child stops shrinking and the container overflows,
   * which is exactly what it used to do.
   */
  const RAIL_MAX = 560;
  const railFits = (bar: number, gap: number) =>
    m.loads.length * bar + Math.max(0, m.loads.length - 1) * gap <= RAIL_MAX;
  // Widest pair that fits, in order. Stated as a list rather than as a formula
  // because the answer wanted is "as bold as will go", and a formula would have
  // to be read backwards to see that.
  const [railBar, railGap] =
    railFits(4, 2) ? [4, 2]
    : railFits(3, 1) ? [3, 1]
    : railFits(2, 1) ? [2, 1]
    : railFits(2, 0) ? [2, 0]
    : [1, 0];

  /** Every section of the active wing, in grid order. */
  const sections = useMemo(
    () => m.classes.flatMap((c) => c.sections.map((s) => ({ id: label(c.className, s), className: c.className }))),
    [m.classes],
  );

  /**
   * §31.19 — every column the cursor can land on, subjects then blocks.
   *
   * `moveTo`, the in-cell arrow handler and the window key handler each clamped
   * to `m.subjects.length`, which was three copies of "how wide is this grid?"
   * — and with §31.18's block columns on the end, three copies that were wrong.
   * One list, indexed by all three, and the order here IS the order the row
   * renders in, so a column index means the same thing to the keyboard and to
   * the `<td>` it lands on.
   */
  const columns = useMemo(() => [
    ...m.subjects.map((s) => ({ kind: "subject" as const, name: s.name, blockId: undefined as number | undefined })),
    ...m.blocks.map((b) => ({ kind: "block" as const, name: b.name, blockId: b.id })),
  ], [m.subjects, m.blocks]);

  // ── reading the draft ──────────────────────────────────────────────────
  const periodsOf = (className: string, subject: string) =>
    m.cells.find((c) => c.className === className && c.subjectName === subject)?.periodsPerWeek ?? 0;

  /**
   * §33.6 — how many base periods one of this class's lessons takes.
   *
   * 1 for every class of every school that has not set a §33 span, which is
   * what makes everything below identical to what it was.
   */
  const spanOf = (className: string) => Math.max(1, spanByClass?.[className] ?? 1);

  /**
   * The cell's number, in the unit the class is taught in.
   *
   * A class on 60-minute lessons in a 30-minute grid is asked for *lessons*,
   * because "three English a week" is what a school says — while the row goes
   * on storing six base periods, which is what the solver counts.
   *
   * `over` is the remainder, and it is the §33.6 warning: five base periods at
   * a span of two is two hours and a stray half-hour. That is a correct
   * timetable for the data given and not what anybody meant, so it is reported
   * where the number is rather than discovered in the generated week. It can
   * only arise from a row written before the span was set, or through the §16
   * importer, whose Curriculum sheet is still in base periods.
   */
  const lessonsOf = (className: string, subject: string) => {
    const base = periodsOf(className, subject);
    const span = spanOf(className);
    // One definition, in `packages/shared`, because this grid needs it three
    // times — to show the number, to seed the field, and to read it back.
    return { base, span, ...lessonsFromBase(base, span) };
  };

  const mappingIndexOf = (section: string, subject: string) =>
    m.mappings.findIndex(
      (x) => x.subjectName === subject && x.classSections.some((cs) => cs.trim() === section),
    );

  const classTeacherOf = (section: string) =>
    m.classTeachers.find((c) => c.classSection === section)?.employeeCode ?? "";

  const nameOf = (code: string) => m.staff.find((s) => s.code === code)?.name ?? code;
  /** What a cell shows for a teacher: their initials, never the employee code. */
  const initialsOf = (code: string) => m.initialsOf.get(code) ?? code;

  const totalOf = (className: string) =>
    m.cells.filter((c) => c.className === className).reduce((n, c) => n + c.periodsPerWeek, 0);

  /**
   * The hover handlers for one thing — and, switched off, no handlers at all.
   *
   * The switch belongs HERE rather than on the card's render, and that is the
   * whole of why this exists. `onMouseMove` sets state on every pixel the
   * pointer travels; on a 50-section × 22-subject grid that is a re-render of
   * the whole table per mouse move. Hiding the card at the end of that chain
   * would leave every one of those renders happening for nothing — somebody
   * turning the card off to make the page calmer would get the same page,
   * doing the same work, with the answer thrown away. Returning `{}` means
   * React attaches no listener and nothing runs.
   */
  const peek = (what: Hover) => (hoverDetail
    ? {
        onMouseEnter: (e: React.MouseEvent) => setHover({ what, x: e.clientX, y: e.clientY }),
        onMouseMove: (e: React.MouseEvent) => setHover({ what, x: e.clientX, y: e.clientY }),
      }
    : {});

  // ── writing it ─────────────────────────────────────────────────────────

  /**
   * Set a class's periods for one subject.
   *
   * `maxPerDay` is raised with the number when the week arithmetically demands
   * it — 6 periods at 1 a day needs 6 days, and Check 3 refuses that in a
   * five-day week however it is staffed. Carried over from the old step
   * verbatim: this is the kind of rule that gets lost in a rewrite.
   */
  const setPeriods = (className: string, subject: string, periods: number) => {
    /**
     * §27.16 — the school said this class does not take this subject.
     *
     * Refused rather than accepted-then-rejected: the server refuses the same
     * row (`assertSubjectApplies`), and a grid that writes into the draft what
     * the commit will throw out is a grid that lies for four steps. It names
     * the screen that owns the statement, because that IS the way to change it
     * — the same division §27.15 draws between a guess you may override in
     * place and an answer you change where it was given.
     */
    const declared = m.subjects.find((x) => x.name === subject);
    if (periods > 0 && declared && !subjectAppliesTo(declared, className)) {
      setRefused(
        `${subject} is not taught in ${className} — it is set for ${(declared.classes ?? []).join(", ")} ` +
        `on the Subjects screen. Add the class there to teach it here.`,
      );
      return;
    }
    setRefused(null);
    const others = m.cells.filter((c) => !(c.className === className && c.subjectName === subject));
    if (periods <= 0) { onChange({ curriculum: others }); return; }
    const existing = m.cells.find((c) => c.className === className && c.subjectName === subject);
    const maxPerDay = Math.max(Math.ceil(periods / m.days), existing?.maxPerDay ?? 1);
    onChange({ curriculum: [...others, {
      className, subjectName: subject, periodsPerWeek: periods, maxPerDay,
      /*
        §31.10 — the block survives a change of periods.

        This rebuilds the cell from scratch, so anything not named here is
        silently dropped. Before the block fields existed that was harmless;
        now, typing a digit into the cell would quietly undo a double period
        somebody set in the dialog, with nothing on screen to show it had gone.
      */
      consecutiveBlockSize: existing?.consecutiveBlockSize,
      consecutiveBlocksPerWeek: existing?.consecutiveBlocksPerWeek,
      blockMayCrossBreak: existing?.blockMayCrossBreak,
    }] });
  };

  /**
   * §31.10 — how a subject is blocked, for one class.
   *
   * A CLASS fact, like the periods beside it: `class_subjects` is keyed by
   * class, so every section of Pre-Nursery gets the same double period. The
   * dialog says so, the same way the Load column's rowSpan has always said it
   * about periods.
   *
   * A size of 1 clears the two companions rather than leaving them beside a
   * block that no longer exists — the same rule the API and the importer apply
   * on write, so all three agree about what "no block" stores.
   */
  const setBlock = (
    className: string,
    subject: string,
    block: { size: number; perWeek: number | null; mayCrossBreak: boolean },
  ) => {
    const existing = m.cells.find((c) => c.className === className && c.subjectName === subject);
    if (!existing) return;
    const size = Math.max(1, Math.min(4, Math.floor(block.size)));
    const others = m.cells.filter((c) => !(c.className === className && c.subjectName === subject));
    onChange({ curriculum: [...others, {
      ...existing,
      consecutiveBlockSize: size,
      consecutiveBlocksPerWeek: size > 1 ? block.perWeek : null,
      blockMayCrossBreak: size > 1 ? block.mayCrossBreak : false,
    }] });
  };

  const setMappings = (next: MappingSuggestion[]) => onChange({ mappings: next });

  /**
   * §27.15 — this class does not take this subject.
   *
   * Not the same as zero periods, which is why it is its own action. Zero
   * leaves the mapping behind: the teacher is still recorded as teaching a
   * subject nobody is taught, they still appear in the coverage count, and the
   * next re-proposal has a row to keep. Removing means removing both.
   *
   * Periods are a CLASS fact (§3.11), so this is a class-wide act — every
   * section of Pre-Nursery stops taking Biology together, which is the same
   * rule the Load column's rowSpan has been saying all along.
   *
   * A merged group that also teaches another class keeps its other members:
   * §4.10 groups may span classes, and taking the whole group away would stop
   * teaching in a class nobody asked about.
   */
  const dropCell = (className: string, subject: string) => {
    const classOf = (cs: string) => cs.replace(/-[^-]+$/, "").trim();
    onChange({
      curriculum: m.cells.filter((c) => !(c.className === className && c.subjectName === subject)),
      mappings: m.mappings
        .map((x) => (x.subjectName !== subject
          ? x
          : { ...x, classSections: x.classSections.filter((cs) => classOf(cs) !== className) }))
        .filter((x) => x.classSections.length > 0),
    });
  };

  const setClassTeacher = (section: string, code: string) =>
    onChange({
      classTeachers: [
        ...m.classTeachers.filter((c) => c.classSection !== section),
        ...(code ? [{ classSection: section, employeeCode: code }] : []),
      ],
    });

  const applyRemedy = (r: LoadRemedy) => {
    const c = r.change;
    if (c.type === "reassign") {
      setMappings(m.mappings.map((x, i) => (i === c.rowIndex ? { ...x, employeeCode: c.toCode } : x)));
    } else if (c.type === "assign") {
      setMappings([...m.mappings, {
        employeeCode: c.toCode, subjectName: c.subjectName,
        classSections: [c.classSection], periodsPerWeek: c.periodsPerWeek,
      }]);
    } else if (c.type === "merge") {
      // The rows collapse into one merged row (§4.10) — one lesson, every
      // listed section attending. The teacher and periods are unchanged; what
      // changes is that it now costs them once.
      const kept = m.mappings[c.rowIndexes[0]];
      const gone = new Set(c.rowIndexes.slice(1));
      setMappings(m.mappings
        .map((x, i) => (i === c.rowIndexes[0]
          ? { ...kept, merged: true, classSections: c.rowIndexes.flatMap((k) => m.mappings[k].classSections) }
          : x))
        .filter((_, i) => !gone.has(i)));
    } else if (c.type === "raiseCap") {
      onChange({
        teachers: (answers.teachers ?? []).map((t: TeacherAnswer, i: number) => {
          const code = t.employeeCode?.trim() || `T-${String(i + 1).padStart(3, "0")}`;
          return code === c.employeeCode ? { ...t, maxPeriodsPerWeek: c.to } : t;
        }),
      });
    }
  };

  // ── the cell popup's rules ─────────────────────────────────────────────
  const remedies = useMemo(() => (showAdvice ? relieveLoad({
    wings: m.wings, curriculum: m.cells, mappings: m.mappings,
    teachers: answers.teachers ?? [], subjects: m.subjects,
    // Every wing's real week, not the open tab's: a teacher's other classes
    // may be in a wing with a different number of days.
    daysByWing: m.daysByWing,
  }) : []), [showAdvice, m, answers.teachers]);

  const overCount = m.loads.filter((l) => l.band === "over").length;
  const warnCount = m.loads.filter((l) => l.band === "warn" || l.band === "full").length;

  const q = query.trim().toLowerCase();
  const matches = (section: string, subject: string, code: string) =>
    !q || section.toLowerCase().includes(q) || subject.toLowerCase().includes(q)
      || code.toLowerCase().includes(q) || nameOf(code).toLowerCase().includes(q)
      // Searchable by what the cell actually SHOWS. Typing the initials you can
      // see and getting nothing is the kind of thing that makes a filter feel
      // broken; the employee code still works for anybody who knows it.
      || initialsOf(code).toLowerCase().includes(q);

  /**
   * §31.16 — where the cursor goes, defined once.
   *
   * Two callers now: the window handler, for a grid nobody has clicked into,
   * and the in-cell input, which the window handler deliberately ignores. A
   * second copy would be a second set of clamping rules, and the two would
   * disagree at the edges first.
   */
  const moveTo = (row: number, col: number) => {
    const r = Math.max(0, Math.min(sections.length - 1, row));
    const c = Math.max(0, Math.min(columns.length - 1, col));
    setCursor({ row: r, col: c });
    const sec = sections[r], cur = columns[c];
    if (sec && cur) setStripCell({ section: sec.id, subject: cur.name, blockId: cur.blockId });
  };

  /**
   * What the in-cell input currently reads.
   *
   * Held as a STRING, and that is the whole reason it is state rather than the
   * model's number: backspacing to empty has to leave the field empty for as
   * long as somebody is typing. A number cannot express "empty", so binding the
   * input to `periodsOf` would put a 0 back under the caret the instant the last
   * digit was deleted — and then "12" typed over it would read as "012".
   */
  const [typed, setTyped] = useState("");
  const cellInput = useRef<HTMLInputElement>(null);

  /*
    Re-seeded from the model whenever the selection moves, and only then.

    Not on every render: the model changes as a direct result of typing, so
    re-seeding there would overwrite the string somebody is halfway through
    with the number it has already produced.
  */
  useLayoutEffect(() => {
    if (!stripCell) return;
    const className = stripCell.section.replace(/-[^-]+$/, "");
    // §33.6 — seeded in LESSONS, the unit `commitTyped` reads back. Seeding
    // base periods here would show 6 in a field where typing 6 means six
    // hours, and arrowing across a row would rewrite every cell it passed.
    // §31.19 — a block's number comes off the block, not the curriculum.
    const base = stripCell.blockId !== undefined
      ? (m.blocks.find((b) => b.id === stripCell.blockId)?.periodsPerWeek ?? 0)
      : null;
    const lessons = base !== null
      ? lessonsFromBase(base, spanOf(className)).lessons
      : lessonsOf(className, stripCell.subject).lessons;
    setTyped(lessons > 0 ? String(lessons) : "");
    /*
      Focused here rather than with `autoFocus`, so arrowing from cell to cell
      moves the caret with the selection rather than only on the first mount —
      and in a LAYOUT effect (§8.1d), because a passive one runs after paint and
      the caret would appear a frame late on every single move.
    */
    cellInput.current?.focus();
    cellInput.current?.select();
  }, [stripCell?.section, stripCell?.subject, stripCell?.blockId]);

  /**
   * §31.19 — the block's periods a week, written straight to the server.
   *
   * The one write on this grid that does not go through the draft, and it has
   * to be: a §4.9 block is not in the wizard's answers, so there is no Save for
   * it to ride on (§27.15's delete is the same exception for the same reason).
   *
   * On COMMIT rather than per keystroke — the field accumulates digits over
   * 900ms (§31.15), so "12" would otherwise be a PUT of 1 followed by a PUT of
   * 12, and a school watching Split Electives would see the first.
   *
   * The server owns every rule here: `assertWithinWeek` caps it at the week and
   * §29.1's freeze guard refuses a published timetable. Both come back as
   * ordinary messages, into the same toast §27.15 already uses, so this screen
   * does not need its own copy of either rule to get them wrong with.
   */
  const setBlockPeriods = async (blockId: number, className: string, lessons: number) => {
    const b = m.blocks.find((x) => x.id === blockId);
    if (!b) return;
    const want = baseFromLessons(lessons, spanOf(className));
    if (want <= 0 || want === b.periodsPerWeek) return;
    try {
      await api(`/elective-blocks/${blockId}`, {
        method: "PUT", body: JSON.stringify({ periodsPerWeek: want }),
      });
      setRefused(null);
      onElectivesChanged?.();
    } catch (e) {
      setRefused(asMessage(e));
      onElectivesChanged?.();
    }
  };

  /** Digits in, a refusal or a write out. */
  const commitTyped = (className: string, subject: string, raw: string) => {
    const clean = raw.replace(/[^0-9]/g, "").slice(0, 2);
    setTyped(clean);
    /*
      §31.19 — a block column writes to the block, not to the curriculum.

      Checked before the empty-string guard below returns, because the two
      paths share this one field and the block id is the only thing that says
      which of them the digits belong to.
    */
    if (stripCell?.blockId !== undefined) {
      if (clean !== "") void setBlockPeriods(stripCell.blockId, className, Number(clean));
      return;
    }
    /*
      §31.19 — a subject the block already teaches is refused, by name.

      The block IS the teaching of French: `writer.ts` places it and
      `variables.ts` builds a variable per mapping, so a curriculum row here
      would be this class taught French twice. Refused rather than quietly
      ignored — the reference school has twenty-four rows that were entered
      exactly this way.
    */
    const owner = m.electiveLock.get(lockKey(className, subject));
    if (owner) {
      setRefused(
        `${subject} is one of the options in ${owner.blockName}. Its periods are set on that `
        + `block — open the ${owner.blockName} column to change them.`,
      );
      return;
    }
    // An empty field is somebody mid-edit, not a request for zero. Writing 0
    // here would drop the row's periods on the way to typing a two-digit
    // number, and the load rail would flash as they passed through.
    if (clean === "") return;
    /*
      §33.6 — typed in LESSONS, stored in base periods.

      The conversion is here and only here: `setPeriods` goes on meaning base
      periods, which is what `class_subjects` stores and what the solver
      counts, so nothing downstream has to learn a second unit. For a class
      with no span — every class of every school today — `span` is 1 and this
      is the arithmetic it always was.
    */
    const want = baseFromLessons(Number(clean), spanOf(className));
    // Refused above the week, as the screen refuses everywhere else: a class
    // asking for more periods than its week holds can never be timetabled.
    const total = totalOf(className) - periodsOf(className, subject) + want;
    if (total <= m.capacity) setPeriods(className, subject, want);
  };

  /**
   * §31.16 — the arrows, inside a field the window handler will not see.
   *
   * They always move CELLS rather than the caret. The field holds at most two
   * characters and is selected on arrival, so there is no caret position worth
   * navigating to — and a grid where Right sometimes moves a column and
   * sometimes a character is a grid nobody can move around confidently.
   */
  const onCellKey = (
    e: React.KeyboardEvent<HTMLInputElement>,
    row: number, col: number,
    className: string, subject: string,
  ) => {
    if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      moveTo(
        row + (e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0),
        col + (e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0),
      );
      return;
    }
    /*
      §31.17 — Enter moves DOWN a row; it no longer opens the dialog.

      §31.15 kept the dialog behind Enter for the two things a toolbar cannot
      hold — the whole-week impact preview and §4.10 merged-group members — but
      the cell became a field in the same phase, and in a field of numbers Enter
      means "done, next one". Typing a column of periods down a class list put a
      modal over the grid on every single value.

      Down rather than right because the cell is a CLASS fact: the number is
      recorded against the class and every section of it (§27), so a column is
      what somebody actually fills in. `⋯ More` in the toolbar is now the only
      way to the dialog, which is the §31.15 shape anyway — every field the
      dialog holds except two is already in the bar.
    */
    if (e.key === "Enter") {
      e.preventDefault();
      moveTo(row + 1, col);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      /*
        Blurs, and does NOT clear the selection.

        Clearing it would take the toolbar's fields away too — the bar is drawn
        from the same selection — so Escape would silently mean "stop editing
        the teacher and the room as well". Letting go of the keyboard is the
        whole of what it is for; the next arrow key takes it back.
      */
      cellInput.current?.blur();
      return;
    }
    /*
      §27.15 — Delete, and NOT Backspace.

      Backspace used to open the same removal confirmation, which was right
      while the cell was a button and is wrong now that it is a field: inside a
      field Backspace means "delete a digit", and one that instead asked to
      delete the whole curriculum row would be the most dangerous keystroke on
      the screen. Delete keeps that job, and the toolbar's ✕ is the visible one.
    */
    if (e.key === "Delete") {
      e.preventDefault();
      if (periodsOf(className, subject) > 0 || mappingIndexOf(sections[row].id, subject) >= 0) {
        setRemoving({ className, subject });
      }
    }
  };

  // ── keyboard ───────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editing) return;
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA")) return;
      const nav = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"].includes(e.key);
      /*
        §31.16 — Delete, and no longer Backspace.

        Backspace opened the same removal confirmation, which was right while
        every cell was a button. The selected cell is a field now, and inside a
        field Backspace means "delete a digit" — a Backspace that instead asked
        to delete a whole curriculum row would be the most dangerous keystroke
        on the screen, and the two meanings would differ by whether the caret
        happened to be in the cell. Delete keeps the job; the toolbar's ✕ is
        the visible one.
      */
      const remove = e.key === "Delete";
      if (!nav && !remove) return;
      e.preventDefault();
      const row = Math.max(0, Math.min(sections.length - 1,
        // §31.17 — Enter steps down, exactly as it does inside the cell's own
        // field. Without it here, Enter on a grid nobody has typed into yet
        // would be the one key that does nothing.
        cursor.row + (e.key === "ArrowDown" || e.key === "Enter" ? 1 : e.key === "ArrowUp" ? -1 : 0)));
      const col = Math.max(0, Math.min(columns.length - 1,
        cursor.col + (e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0)));
      const sec = sections[row], sub = columns[col];
      if (!sec || !sub) return;
      // §31.10 — the keyboard cursor moves the strip too, so a row can be read
      // across without reaching for the mouse for every cell.
      moveTo(row, col);
      // §31.17 — Enter moves down, as it does inside the field. `moveTo` above
      // has already done it; opening the dialog here would put one over the
      // grid for anybody arrowing around without having typed anything.
      if (e.key === "Enter") return;
      if (remove) {
        // §31.19 — a block column holds no curriculum row to remove, and its
        // members and options are Split Electives' to change. Delete here would
        // otherwise land on whatever `sub.name` happened to match.
        if (sub.kind === "block") return;
        // Nothing there is nothing to remove — and the confirmation would have
        // no counts on it, which reads as a broken dialog rather than a no-op.
        if (periodsOf(sec.className, sub.name) > 0 || mappingIndexOf(sec.id, sub.name) >= 0) {
          setRemoving({ className: sec.className, subject: sub.name });
        }
        return;
      }
      /*
        §31.16 — no digit path here any more.

        Digits are typed into the cell's own `<input>`, which is focused the
        moment a cell is selected — and this handler deliberately ignores a
        focused input, so after the first selection it never sees one. Keeping a
        second way to write the number would mean two buffers for one field,
        and they would disagree the first time somebody typed fast.

        Arrowing into a cell from here still selects it, which focuses the
        field: the keyboard hands over rather than sharing.
      */
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, cursor, sections, m]);

  // ── render ─────────────────────────────────────────────────────────────

  /**
   * Below EVERY hook, deliberately.
   *
   * This used to sit near the top, next to the model — which reads better and
   * is a Rules-of-Hooks violation: the `useMemo` for the remedies and the
   * `useEffect` for the keyboard come after it, so the render that adds the
   * first wing runs more hooks than the one before it and React throws
   * "rendered fewer hooks than expected". The path is not exotic; it is what
   * every new school does.
   */
  /**
   * §31.10 — this step's own controls, drawn here or lent to a host.
   *
   * ONE definition, with the portal deciding only where it lands. Two copies —
   * one inline, one for the host — is how a control ends up on one and not the
   * other, six months after anybody remembers there were two.
   */
  /*
    §31.15 — the toolbar in three parts, and the order is the point.

    The SELECTED CELL first, because it is what somebody is doing; the filter
    next, because it is what they reach for while doing it; and everything else
    behind a menu, because "Start again" and "Clear saved data" are pressed once
    in the life of a school and were taking the width the cell's fields needed.

    The menu is a hamburger rather than three more buttons for the same reason
    §31.1 made the Master Grid's tab rail vertical: the horizontal room on this
    screen belongs to the grid.
  */
  /**
   * §31.15 — what a `CellSave` does, defined once.
   *
   * The dialog and the toolbar's `CellBar` produce the same shape and must land
   * the same rows in the same order: the periods before the block, so a cell
   * this very save created has a curriculum row for the block to be written on.
   * It was inline in the dialog's `onSave`; two copies of an order-dependent
   * sequence is how the two doors come to disagree about a double period.
   */
  const applyCell = (sectionId: string, subjectName: string, next: CellSave) => {
    if (next.periods !== undefined) setPeriods(next.className, subjectName, next.periods);
    if (next.block) setBlock(next.className, subjectName, next.block);
    if (next.mappings) setMappings(next.mappings);
    if (next.classTeacher !== undefined) setClassTeacher(sectionId, next.classTeacher);
    // §28 — the period LENGTH is step 5's key, so it is written back into step
    // 5's answer. `commitWeeks(…, {changedOnly})` picks it up; nothing here
    // writes to the server.
    if (next.minutes !== undefined && m.wing) {
      onChange({
        weeks: {
          ...(answers.weeks ?? {}),
          [m.wing.name]: { ...(answers.weeks?.[m.wing.name] ?? {}), periodDurationMins: next.minutes },
        },
      });
    }
  };

  const controls = (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", flexShrink: 0 }}>
      {stripCell && (
        <CellBar
          m={m} answers={answers}
          section={stripCell.section} subject={stripCell.subject}
          periodsOf={periodsOf} mappingIndexOf={mappingIndexOf}
          classTeacherOf={classTeacherOf}
          compact={tight}
          /*
            §31.19 — the bar is told WHY it may not edit, never left to work it
            out. Two different reasons, and they read differently in the bar: a
            block cell has no subject, teacher or room of its own to change,
            while a locked subject cell has all three and they belong to a block
            somewhere else.
          */
          block={stripCell.blockId !== undefined
            ? m.blocks.find((b) => b.id === stripCell.blockId) ?? null
            : null}
          lockedBy={stripCell.blockId === undefined
            ? m.electiveLock.get(lockKey(stripCell.section.replace(/-[^-]+$/, ""), stripCell.subject))?.blockName ?? null
            : null}
          onMore={() => setEditing({ section: stripCell.section, subject: stripCell.subject })}
          onRemove={() => setRemoving({
            className: stripCell.section.replace(/-[^-]+$/, ""),
            subject: stripCell.subject,
          })}
          onChange={(next) => applyCell(stripCell.section, stripCell.subject, next)}
        />
      )}
      {m.wings.length > 1 && !wing && (
        <div style={{ display: "flex", gap: 4 }}>
          {m.wings.map((w, i) => (
            <button key={w.name} onClick={() => setActiveWing(i)} className="btn"
              style={{
                padding: "4px 10px", fontSize: 11.5,
                background: i === activeWing ? "var(--brand)" : "var(--paper)",
                color: i === activeWing ? "#fff" : "var(--ink)",
                borderColor: i === activeWing ? "var(--brand)" : "var(--line)",
              }}>{w.name}</button>
          ))}
        </div>
      )}
      {/* The spacer pushes the controls right across a row of their own. Inside
          a host's toolbar there is no row to push across, and it would shove
          everything to the far edge. */}
      {!toolbarHost && <span style={{ flex: 1 }} />}
      <input value={query} onChange={(e) => setQuery(e.target.value)}
        placeholder="Filter teacher, subject, class" aria-label="Filter the grid"
        style={{
          padding: "5px 9px", border: "1px solid var(--line)", borderRadius: 8, fontSize: 12,
          background: "var(--paper)", color: "var(--ink)", width: 180,
        }} />
      {/*
        §31.15 — everything that is not the cell or the filter, behind one icon.

        Start again, Clear saved data and Help are pressed once in the life of a
        school; Hover detail perhaps twice. They were four buttons taking the
        width the selected cell's fields now need, and a toolbar's width on this
        screen is width the grid is not getting.

        A `<details>` rather than a hand-rolled popover: it opens on click,
        closes on Escape, is reachable from the keyboard and needs no
        outside-click handler to get right — the three things a bespoke menu
        usually gets wrong. `list-style: none` on the summary is what removes
        the disclosure triangle without removing the behaviour.
      */}
      <details style={{ position: "relative" }}>
        <summary
          aria-label="More actions"
          title="Start again, clear saved data, help"
          className="btn"
          style={{
            padding: "4px 10px", fontSize: 13, cursor: "pointer", listStyle: "none",
            display: "inline-flex", alignItems: "center", lineHeight: 1.2,
          }}
        >
          &#9776;
        </summary>
        <div style={{
          position: "absolute", right: 0, top: "calc(100% + 6px)", zIndex: 40,
          minWidth: 226, padding: 6, borderRadius: 10,
          background: "var(--paper)", border: "1px solid var(--line)",
          boxShadow: "0 12px 30px rgba(11,31,68,.16)",
          display: "flex", flexDirection: "column", gap: 2,
        }}>
          {/*
            `aria-pressed` rather than `role="checkbox"`: it is a toggle, and
            the tick is the visible half of the same fact.
          */}
          <button className="menu-item" aria-pressed={hoverDetail}
            onClick={() => {
              setHoverDetail(!hoverDetail);
              // The card on screen belongs to the setting being turned off —
              // leaving it up until the next mouse move reads as the switch
              // not having worked.
              setHover(null);
            }}>
            {hoverDetail ? "\u2611" : "\u2610"} Hover detail
          </button>
          <button className="menu-item" onClick={() => setShowHelp(!showHelp)} aria-expanded={showHelp}>
            ? Help
          </button>
          {/*
            Two controls, and the difference between them is the whole point.

            "Start again" rebuilds this page from your subjects, teachers and
            classes and touches nothing that has been saved. "Clear saved data"
            deletes the curriculum and the mappings out of the school. One is a
            rethink, the other is a demolition, and a single item meaning both
            would be the last thing anybody read before losing an afternoon.

            Separated by a rule here rather than merely ordered, because a menu
            makes two items look more alike than two buttons did.
          */}
          {((m.edited.mappings || m.edited.curriculum)
            || (m.wing && configIds[m.wing.name.toLowerCase()] !== undefined)) && (
            <span style={{ height: 1, background: "var(--line)", margin: "4px 2px" }} />
          )}
          {(m.edited.mappings || m.edited.curriculum) && (
            <button className="menu-item"
              title="Throw away the edits on this page and propose it again from the subjects, teachers and classes"
              onClick={() => {
                if (!window.confirm(
                  "Start this page again from the suggestion?\n\n" +
                  "The periods and teachers on this page are re-proposed from your subjects, " +
                  "teachers and classes. Nothing on any other step changes.",
                )) return;
                // `null`, not `undefined`. Only touched keys are sent, and
                // `JSON.stringify` drops an undefined one — so the server would
                // merge nothing and the stored plan would survive a reset that
                // appeared to work. A non-array reads as "not edited".
                onChange({ curriculum: null, mappings: null, classTeachers: null });
              }}>
              &#8634; Start again from the suggestion
            </button>
          )}
          {m.wing && configIds[m.wing.name.toLowerCase()] !== undefined && (
            <button className="menu-item" style={{ color: "var(--signal)" }}
              title="Delete the curriculum, the mappings and the class teachers this timetable has saved"
              onClick={() => setResetting(true)}>
              &#9003; Clear saved data
            </button>
          )}
        </div>
      </details>
      {onFocusMode && (
        <button className="btn" style={{ padding: "4px 9px", fontSize: 11.5 }}
          title="Fold the step rail away and give the room to the grid"
          onClick={() => onFocusMode(true)}>⇱ Focus</button>
      )}
    </div>
  );

  if (!m.wing) return <Heading title="Add a wing on step 3 first." />;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5, height: "100%", minHeight: 0 }}
         onMouseLeave={() => setHover(null)}>

      {/*
        §8.4 — one toolbar, not a heading block.

        The title went. Three lines of chrome sat above this grid — the wizard's
        own step line, a serif heading, and the load rail — and the heading was
        the one carrying no information: the step line two rows above already
        says "Allocation", and nobody looking at a class × subject matrix is
        wondering what it is. The row it occupied is a row of school.
      */}
      {toolbarHost ? createPortal(controls, toolbarHost) : controls}

      {/*
        §27.10 — the way back to the proposal.

        The two steps this replaced each had "Start again from the suggestion",
        and merging them dropped both. Without it the stored plan wins for ever:
        somebody adds a teacher, or changes who teaches what on step 7, comes
        back here and nothing has moved — which reads as the Allocation page
        ignoring the Teachers step, because from the outside that is exactly
        what it is doing.

        Shown as a banner rather than a quiet link when the disagreement is
        REAL — an assignment naming somebody who no longer teaches that subject,
        or cells a fresh proposal would cover and this one does not. A quiet
        link is right for "I would like to start over"; it is not enough for
        "what is on your screen contradicts what you just typed".
      */}
      {m.edited.mappings && (m.stale.length > 0 || m.proposedGaps < m.gaps) && (
        <div style={{
          borderLeft: "3px solid var(--amber)", background: "var(--amber-bg)", padding: "10px 13px",
          borderRadius: "0 8px 8px 0", fontSize: 12.2, color: "var(--ink-soft)", lineHeight: 1.55,
          flexShrink: 0, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
        }}>
          <span style={{ flex: 1, minWidth: 240 }}>
            <strong style={{ color: "var(--ink)" }}>
              This plan no longer matches the Teachers step.
            </strong>{" "}
            {m.stale.length > 0 && (
              <>
                {m.stale.length} assignment{m.stale.length === 1 ? "" : "s"} disagree — {m.stale[0].label}:{" "}
                {m.stale[0].why}
                {m.stale.length > 1 ? `, and ${m.stale.length - 1} more` : ""}.{" "}
              </>
            )}
            {m.proposedGaps < m.gaps && (
              <>Re-staffing would cover {m.gaps - m.proposedGaps} cell
                {m.gaps - m.proposedGaps === 1 ? "" : "s"} that nobody teaches.{" "}</>
            )}
          </span>
          <button className="btn" style={{ padding: "5px 11px", fontSize: 12 }}
            onClick={() => onChange({ mappings: null })}>
            Re-staff from the Teachers step
          </button>
        </div>
      )}

      {showHelp && (
        <div style={{
          borderLeft: "3px solid var(--steel-light)", background: "var(--offwhite)", padding: "9px 12px",
          borderRadius: "0 8px 8px 0", fontSize: 11.6, color: "var(--ink-soft)", lineHeight: 1.55, flexShrink: 0,
        }}>
          <strong style={{ color: "var(--ink)" }}>
            Periods are a class fact; the teacher and the room are a section fact.
          </strong>{" "}
          Change 6 to 5 in {m.classes[0]?.className ?? "a class"}-A's Maths and every section changes with it —
          which is why the Load column spans the whole class.{" "}
          {/* The instruction has to match the setting: telling somebody who has
              turned the card off to hover a cell describes a page they are not
              looking at. */}
          {hoverDetail ? (
            <><strong style={{ color: "var(--ink)" }}>Hover any cell</strong> for the detail behind it, or turn
            that off with <em>Hover detail</em>.</>
          ) : (
            <>The detail card is off — <strong style={{ color: "var(--ink)" }}>click a cell</strong> to see and
            change everything behind it, or switch the card back on with <em>Hover detail</em>.</>
          )}{" "}
          Arrow keys move, a digit sets periods, Enter opens a cell.
        </div>
      )}

      {/* ── the load line: one strip, chips on request ─────────────────
          §8.4 — a strip rather than a card. The border, the corner radius and
          the 6/11 padding were drawing a box around one row of chips and
          costing ~20px of grid to do it; a rule underneath separates it from
          the table just as well and takes a pixel. */}
      <section style={{ borderBottom: "1px solid var(--line)", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "2px 2px 5px", flexWrap: "wrap" }}>
          <button onClick={() => setShowChips(!showChips)} aria-expanded={showChips}
            style={{
              border: "none", background: "none", cursor: "pointer", padding: "2px 4px",
              display: "flex", alignItems: "center", gap: 7,
              font: "700 9.5px/1 Inter", letterSpacing: "0.09em", textTransform: "uppercase",
              color: "var(--steel)",
            }}>
            Teacher load <span style={{
              fontSize: 10, display: "inline-block",
              transform: showChips ? "rotate(180deg)" : "none", transition: "transform 200ms ease",
            }}>▾</span>
          </button>

          {/*
            The always-on miniature. 122 teachers as 122 slivers, heaviest
            first: you can see that two are red without reading a number, and
            it costs one row of the page instead of six.
          */}
          {/*
            The gap and the bar width are DERIVED from how many teachers there
            are, and that is the whole fix.

            They were fixed at 2px each. A flex item's `min-width` is a floor
            the container cannot shrink past, so 124 teachers demanded
            124x2 + 123x2 = 494px inside a box capped at 340 — and a flex
            container that cannot fit its children does not clip them, it
            overflows. The bars painted straight over "124 teachers · 29 at
            75%+ · 667 unstaffed" sitting to their right, which is how a
            reference school with a real staff list looked from day one.

            `overflow: hidden` is the backstop rather than the fix: it stops a
            future count spilling again, but a rail that quietly hides half its
            teachers would be a worse bug than the one it replaced, so the
            arithmetic keeps every bar inside the box on its own.
          */}
          <div role="img" aria-label="Every teacher's load, heaviest first"
            style={{
              display: "flex", gap: railGap, alignItems: "flex-end", height: 22,
              flex: 1, minWidth: 90, maxWidth: RAIL_MAX, overflow: "hidden",
              // A floor under the shortest bar, so a lightly-loaded teacher is
              // still a mark rather than a gap in the row.
              paddingBottom: 1, borderBottom: "1px solid var(--line)",
            }}>
            {m.loads.map((t) => (
              <span key={t.employeeCode}
                {...peek({ kind: "teacher", code: t.employeeCode })}
                style={{
                  flex: 1, minWidth: railBar, borderRadius: 1, background: BAND_COLOUR[t.band],
                  opacity: t.band === "ok" ? 0.7 : 1,
                  height: `${Math.max(18, Math.min(100, t.pct * 100))}%`,
                }} />
            ))}
          </div>

          {/* The spacer sits BEFORE the counts now: the bars get the room they
              need on the left, and the figures read as a summary at the end of
              the row rather than as labels crowding the chart. */}
          <span style={{ flex: 1 }} />

          <div style={{ fontSize: 11.2, color: "var(--ink-faint)", display: "flex", gap: 11, flexWrap: "wrap" }}>
            <span><strong style={{ fontFamily: "var(--font-mono, monospace)" }}>{m.loads.length}</strong> teachers</span>
            {overCount > 0 && <span style={{ color: "var(--signal)" }}>
              <strong style={{ fontFamily: "var(--font-mono, monospace)" }}>{overCount}</strong> over</span>}
            {warnCount > 0 && <span style={{ color: "var(--amber)" }}>
              <strong style={{ fontFamily: "var(--font-mono, monospace)" }}>{warnCount}</strong> at{" "}
              {answers.settings?.loadAlertPct ?? 75}%+</span>}
            {m.gaps > 0 && <span style={{ color: "var(--signal)" }}>
              <strong style={{ fontFamily: "var(--font-mono, monospace)" }}>{m.gaps}</strong> unstaffed</span>}
            {/* §31.17 — what the intersection rule removed, and why. Not a
                warning: a primary wing not drawing Biology is the grid being
                right. It is here so that "where has Nursery gone?" has an
                answer on the screen it went missing from. */}
            {(m.hidden.subjects > 0 || m.hidden.classes > 0) && (
              <span title={
                "Only the subjects this timetable's classes are taught, and only the classes that are "
                + "taught something, are drawn. Set which classes take a subject on the Subjects master."
              }>
                {[
                  m.hidden.subjects > 0 ? `${m.hidden.subjects} subject${m.hidden.subjects === 1 ? "" : "s"}` : null,
                  m.hidden.classes > 0 ? `${m.hidden.classes} class${m.hidden.classes === 1 ? "" : "es"}` : null,
                ].filter(Boolean).join(" · ")} not taught here
              </span>
            )}
          </div>

          <button className="btn" style={{ padding: "4px 9px", fontSize: 11.5 }}
            onClick={() => setShowAdvice(!showAdvice)}>
            {overCount > 0 || m.gaps > 0 ? `Ease the load (${overCount + m.gaps})` : "Ease the load"}
          </button>
        </div>

        {showChips && (
          <div style={{ display: "flex", gap: 6, padding: "0 11px 9px", overflowX: "auto" }}>
            {m.loads.map((t) => {
              const hit = !q || t.name.toLowerCase().includes(q)
                || t.employeeCode.toLowerCase().includes(q)
                || (m.initialsOf.get(t.employeeCode) ?? "").toLowerCase().includes(q);
              return (
                <button key={t.employeeCode}
                  // §31.10 — a teacher past their weekly limit is the one thing
                  // on this rail somebody has to act on, so it moves. Only
                  // `over`: a warn band is a number to know, not a thing to do.
                  className={t.band === "over" ? "alloc-over" : undefined}
                  onClick={() => setSelected(selected === t.employeeCode ? null : t.employeeCode)}
                  {...peek({ kind: "teacher", code: t.employeeCode })}
                  style={{
                    flex: "0 0 auto", width: 74, borderRadius: 9, padding: "6px 5px 5px", textAlign: "center",
                    background: BAND_BG[t.band], cursor: "pointer", opacity: hit ? 1 : 0.28,
                    border: `1px solid ${selected === t.employeeCode ? "var(--brand)" : t.band === "ok" ? "var(--line)" : BAND_COLOUR[t.band]}`,
                    boxShadow: selected === t.employeeCode ? "0 0 0 3px color-mix(in srgb,var(--brand) 16%,transparent)" : undefined,
                  }}>
                  <div style={{ font: "700 13px/1 var(--font-mono, monospace)", color: t.band === "ok" ? "var(--ink)" : BAND_COLOUR[t.band] }}>
                    {m.initialsOf.get(t.employeeCode) ?? t.employeeCode}
                  </div>
                  <div style={{ font: "500 10.5px/1 var(--font-mono, monospace)", color: "var(--ink-faint)", marginTop: 3 }}>
                    {t.used}/{t.cap}
                  </div>
                  <MiniBar pct={t.pct} colour={BAND_COLOUR[t.band]} />
                </button>
              );
            })}
          </div>
        )}
      </section>

      {showAdvice && (
        <Advisor items={remedies} onApply={applyRemedy} onClose={() => setShowAdvice(false)} />
      )}

      {/* ── the grid takes everything left ───────────────────────────── */}
      <div ref={gridRef} style={{
        border: "1px solid var(--line)", borderRadius: 10, background: "var(--paper)",
        overflow: "auto", flex: 1, minHeight: 220,
      }}>
        <table style={{
          borderCollapse: "separate", borderSpacing: 0, width: "100%",
          fontSize: tight ? 11 : 11.5,
          ...(tight ? { tableLayout: "fixed" as const, minWidth: tightMinWidth } : {}),
        }}>
          {tight && (
            <colgroup>
              <col style={{ width: HEAD_PX }} />
              {/* No width: under `table-layout: fixed` the columns with none
                  divide whatever the two fixed edges leave, which is exactly
                  "the rest" and needs no arithmetic to say. */}
              {m.subjects.map((s2) => <col key={s2.name} />)}
              {m.blocks.map((b) => <col key={`b${b.id}`} />)}
              <col style={{ width: LOAD_PX }} />
            </colgroup>
          )}
          <thead>
            <tr>
              <th style={{
                position: "sticky", top: 0, left: 0, zIndex: 5, background: "var(--brand)", color: "#fff",
                font: "600 10.5px/1 Inter", textAlign: "left", whiteSpace: "nowrap",
                // §31.17 — tighter padding at compact density, so the heading
                // still fits the seven-character column it now labels.
                padding: tight ? "6px 4px 6px 8px" : "6px 5px 6px 11px",
                ...(tight ? { width: HEAD_PX, overflow: "hidden" } : { minWidth: 112 }),
              }}>Class-section</th>
              {m.subjects.map((s) => (
                <th key={s.name}
                  {...peek({ kind: "subject", subject: s.name })}
                  style={{
                    position: "sticky", top: 0, zIndex: 3, background: "var(--brand)", color: "#fff",
                    font: "600 10.5px/1.2 Inter", padding: tight ? "6px 2px" : "6px 5px",
                    textAlign: "center", whiteSpace: "nowrap",
                    // Same reason as the row header: fixed layout will not
                    // widen for "Physical Educ", so it is clipped and the full
                    // name stays on the hover card.
                    ...(tight ? { overflow: "hidden" } : {}),
                  }}>
                  {s.name.length > 6 ? s.name.slice(0, 5) : s.name}
                  <span style={{ display: "block", font: "500 9px/1 var(--font-mono, monospace)", opacity: 0.7, marginTop: 2 }}>
                    {(s.category ?? defaultsFor(s.name).category) === "co_scholastic" ? "co-sch" : "sch"}
                  </span>
                </th>
              ))}
              {/*
                §31.18 — one column per §4.9 block, after the subjects.

                A column rather than a marker inside an existing one, because a
                block has its own periods-a-week and its own members: two blocks
                — a language block and an activity block — are two different
                demands on the same class, and folding them together would give
                back one number that is true of neither.
              */}
              {m.blocks.map((b) => (
                <th key={`b${b.id}`}
                  title={`${b.name} — ${b.periodsPerWeek} periods a week · ${b.options.map((o) => o.subject).join(", ") || "no options yet"}`}
                  style={{
                    position: "sticky", top: 0, zIndex: 3, background: "var(--brand)", color: "#fff",
                    font: "600 10.5px/1.2 Inter", padding: tight ? "6px 2px" : "6px 5px",
                    textAlign: "center", whiteSpace: "nowrap",
                    ...(tight ? { overflow: "hidden" } : {}),
                  }}>
                  {b.name.length > 6 ? b.name.slice(0, 5) : b.name}
                  <span style={{ display: "block", font: "500 9px/1 var(--font-mono, monospace)", opacity: 0.7, marginTop: 2 }}>
                    elect
                  </span>
                </th>
              ))}
              {/*
                §31.17 — Load sticks to the RIGHT edge, the mirror of the
                class-section column on the left.

                It is the one number the row exists to produce, and with forty
                subjects it sat 2,700px off the side of a 900px pane: to read
                "is Class 5 full?" you scrolled to the end, by which time the
                class-section column was the only thing telling you whose row
                it was. Both anchors present, the subjects scroll between them.

                zIndex 5, not 3 — the same as the left corner — so the subject
                headers pass UNDER it rather than over.
              */}
              <th style={{
                position: "sticky", top: 0, zIndex: tight ? 5 : 3, background: "var(--brand)", color: "#fff",
                font: "600 10.5px/1 Inter", padding: "6px 5px",
                ...(tight ? { right: 0, width: LOAD_PX } : { minWidth: 86 }),
              }}>Load</th>
            </tr>
          </thead>
          <tbody>
            {m.classes.map((c) => {
              /*
                §31.18 — the curriculum PLUS the elective blocks.

                Check 1 counts a block's periods as real demand on every member
                section, so without this a class spending five periods a week on
                a language block read "35/40 · 5 free" here while Readiness had
                it full. Adding the column without adding this would have been
                worse than the old silence: the five would now be on screen,
                one cell away from a Load figure that ignored it.

                `totalOf` itself is deliberately left alone — it is the
                curriculum sum, and the typing guard that refuses a cell above
                the week uses it. Blocks belong in what the row REPORTS, not in
                what it refuses: a keystroke that silently does nothing because
                of periods in a different column is the worst way to find out.
              */
              const elective = electivePeriodsOf(c.className);
              const total = totalOf(c.className) + elective;
              const state = total > m.capacity ? "over" : total < m.capacity ? "under" : "exact";
              const colour = state === "over" ? "var(--signal)" : state === "under" ? "var(--amber)" : "var(--accent)";
              return c.sections.map((sec, i) => {
                const id = label(c.className, sec);
                const ct = classTeacherOf(id);
                return (
                  <tr key={id}>
                    <th style={{
                      position: "sticky", left: 0, zIndex: 2, background: "var(--paper)", textAlign: "left",
                      padding: "3px 8px 3px 11px", borderBottom: "1px solid var(--line)",
                      borderRight: "1px solid var(--line)", fontWeight: 600, fontSize: 11.5, whiteSpace: "nowrap",
                      borderTop: i === 0 ? "2px solid var(--steel-light)" : undefined,
                      /* §31.10 — `table-layout: fixed` means content no longer
                         widens its column, so a long class-section name spills
                         over the first subject instead of pushing it right.
                         Clipped rather than allowed to overlap; the full label
                         is in the strip and on the row's own hover card. */
                      ...(tight ? { overflow: "hidden", textOverflow: "ellipsis", maxWidth: 0 } : {}),
                    }}>
                      {i === 0 && !tight && (
                        <span style={{
                          font: "700 9px/1 Inter", letterSpacing: "0.07em", textTransform: "uppercase",
                          color: "var(--ink-faint)", display: "block", marginBottom: 2,
                        }}>{c.className}</span>
                      )}
                      <span style={{ display: "flex", alignItems: "center", gap: 6 }} title={id}>
                        {/* §31.10 — "PNA" at compact density, the full label
                            everywhere else. The `title` above keeps the whole
                            name a hover away, and the strip prints it in full. */}
                        <span>{tight ? initialLabel(id) : shortLabel(id)}</span>
                        <span
                          {...peek({ kind: "ct", section: id })}
                          style={{
                            font: "700 9px/1 var(--font-mono, monospace)", borderRadius: "50%",
                            width: 18, height: 18, display: "grid", placeItems: "center", flexShrink: 0,
                            color: ct ? "var(--brand-dark)" : "var(--ink-faint)",
                            background: ct ? "var(--steel-pale)" : "transparent",
                            border: ct ? "1px solid color-mix(in srgb,var(--brand) 30%,transparent)"
                                       : "1px dashed var(--line)",
                          }}>{ct ? (m.initialsOf.get(ct) ?? ct) : "—"}</span>
                      </span>
                    </th>

                    {m.subjects.map((s, col) => {
                      const cell = lessonsOf(c.className, s.name);
                      const p = cell.base;
                      const idx = mappingIndexOf(id, s.name);
                      const row = idx >= 0 ? m.mappings[idx] : null;
                      const code = row?.employeeCode ?? "";
                      const sw = m.swatches[s.name];
                      const isCT = !!code && ct === code;
                      const merged = !!row?.merged && row.classSections.length > 1;
                      const rowIndex = sections.findIndex((x) => x.id === id);
                      const isCursor = cursor.row === rowIndex && cursor.col === col;
                      /* §31.16 — the one cell that is an input. `stripCell`
                         rather than `isCursor`: the cursor exists from the
                         first render, and an input focused before anybody has
                         clicked would steal the page's focus on arrival. */
                      const picked = stripCell?.section === id && stripCell?.subject === s.name
                        && stripCell?.blockId === undefined;
                      const dim = (selected && code !== selected) || !matches(id, s.name, code);
                      /*
                        §31.19 — a subject a §4.9 block already teaches to this
                        class. Its periods live on the block, so this cell is
                        not an entry point; it is a statement about where the
                        entry point is.

                        A stored row is drawn in `--signal` and NOT zeroed. The
                        row exists, Readiness counts it and the solver places
                        it, so printing 0 would make this the one screen telling
                        a different story — and the reference school has
                        twenty-four of them to tell it about.
                      */
                      const owner = m.electiveLock.get(lockKey(c.className, s.name));
                      const clash = !!owner && p > 0;

                      return (
                        <td key={s.name} style={{
                          padding: 1.5, borderBottom: "1px solid var(--line)", textAlign: "center",
                          borderTop: i === 0 ? "2px solid var(--steel-light)" : undefined,
                        }}>
                          {/*
                            §31.16 — the SELECTED cell is a real input, so it is
                            a `div` rather than a `button`.

                            An `<input>` inside a `<button>` is invalid HTML and
                            the button swallows the clicks that would place a
                            caret, so the element has to change with the state.
                            Everything else about it — the colours, the three
                            lines, the ring — is identical, which is why the
                            style object is shared rather than written twice.
                          */}
                          <CellShell
                            editing={picked}
                            className={p > 0 && !code ? "alloc-unstaffed" : undefined}
                            onClick={() => {
                              /*
                                §31.15 — a click SELECTS. It used to open the
                                dialog, and that is the whole change: somebody
                                works across a row — Maths 6, English 6,
                                Science 5 — and a popup that opens, takes one
                                value and closes costs two clicks and a re-read
                                of where they were, for every cell. It also
                                covers the neighbours, which is the argument
                                §31.6 already made for the strip.

                                The number is typed straight into the grid from
                                here; everything else is in the toolbar's
                                `CellBar`, above a grid that stays visible.
                              */
                              setCursor({ row: rowIndex, col });
                              setStripCell({ section: id, subject: s.name });
                              setRefused(null);
                              // The hover card is a second reading of the cell
                              // now being edited in the bar — one of them stale
                              // the moment anything is changed.
                              setHover(null);
                            }}
                            {...peek({ kind: "cell", section: id, subject: s.name })}
                            style={{
                              width: "100%", minWidth: tight ? 0 : 58, borderRadius: 6,
                              padding: tight ? "2px 1px" : "3px 2px", display: "block",
                              cursor: "pointer", opacity: dim ? 0.16 : 1,
                              boxShadow: isCursor ? "0 0 0 2px var(--brand)" : undefined,
                              ...(clash
                                // Stored, and taught by the block as well — the
                                // one state on this grid that is a contradiction
                                // rather than a gap, so it takes the signal
                                // colour a missing teacher would have had.
                                ? {
                                  background: "var(--signal-bg)", color: "var(--signal)",
                                  border: "1.5px dashed var(--signal)",
                                }
                                : owner
                                  // Owned and empty: the ordinary, correct state.
                                  // Dashed rather than plain, so a reader can see
                                  // at a glance which columns this class's
                                  // elective has taken over.
                                  ? {
                                    background: "var(--offwhite)", color: "var(--ink-faint)",
                                    border: "1px dashed var(--steel-light)",
                                  }
                                  : p <= 0
                                ? { background: "var(--offwhite)", color: "var(--ink-faint)", border: "1px solid var(--line)" }
                                : !code
                                  ? {
                                    /*
                                      §31.10 — `backgroundColor`, never the
                                      `background` shorthand: `.alloc-unstaffed`
                                      draws its moving edge with
                                      `background-image`, and the shorthand
                                      resets that to none. The border is
                                      transparent rather than absent so the cell
                                      keeps the same box as its neighbours.
                                    */
                                    backgroundColor: "var(--signal-bg)",
                                    color: "var(--signal)",
                                    border: "1.5px solid transparent",
                                  }
                                  : { background: sw?.bg, color: sw?.fg, border: `1px solid ${sw?.border ?? "transparent"}` }),
                            }}
                            title={owner
                              ? (clash
                                ? `${s.name} is an option in ${owner.blockName}, and this class also has ${p} periods of it in the curriculum — it is being taught twice. Clear them from the toolbar.`
                                : `${s.name} is taught inside ${owner.blockName}. Its periods are set on that block.`)
                              : undefined}>
                            {picked ? (
                              /*
                                §31.16 — the number, typed where it is read.

                                Same box, same font, same height as the span it
                                replaces: a field that changed the cell's size
                                would move every row below it the moment the
                                cursor arrived, which is the thing this grid is
                                least able to afford.
                              */
                              <input
                                ref={cellInput}
                                value={typed}
                                inputMode="numeric"
                                aria-label={`Periods a week of ${s.name} for ${c.className}`}
                                onChange={(e) => commitTyped(c.className, s.name, e.target.value)}
                                onFocus={(e) => e.currentTarget.select()}
                                onKeyDown={(e) => onCellKey(e, rowIndex, col, c.className, s.name)}
                                style={{
                                  font: "700 13.5px/1 var(--font-mono, monospace)",
                                  display: "block", width: "100%", textAlign: "center",
                                  border: "none", background: "transparent", color: "inherit",
                                  padding: 0, margin: 0, outline: "none",
                                  // The number line is 13.5px tall; matching it
                                  // exactly is what stops the row twitching.
                                  height: 13.5, minWidth: 0,
                                }}
                              />
                            ) : (
                              <span style={{ font: "700 13.5px/1 var(--font-mono, monospace)", display: "block", opacity: p <= 0 ? 0.5 : 1 }}>
                                {/*
                                  §33.6 — shown in the unit the class is taught
                                  in. A class on 60-minute lessons reads "3",
                                  not the six base periods stored behind it.

                                  A remainder is flagged rather than rounded
                                  away: five base periods at a span of two is
                                  two hours and a stray half-hour — a correct
                                  timetable for the data given, and not what
                                  anybody meant.
                                */}
                                {p <= 0 ? "–" : cell.span > 1 ? cell.lessons : p}
                                {cell.over > 0 && (
                                  <span title={`${p} periods do not divide into lessons of ${cell.span} — ${cell.over} would be left over`}
                                    style={{ color: "var(--signal)" }}>+{cell.over}</span>
                                )}
                              </span>
                            )}
                            <span style={{
                              font: "600 9.5px/1.1 var(--font-mono, monospace)", marginTop: 2, display: "flex",
                              alignItems: "center", justifyContent: "center", gap: 3,
                            }}>
                              {isCT && (
                                <span style={{
                                  display: "inline-grid", placeItems: "center", width: 14, height: 14,
                                  borderRadius: "50%", border: "1.5px solid currentColor", font: "700 7.5px/1 monospace",
                                }}>●</span>
                              )}
                              {p <= 0 ? " " : code ? initialsOf(code) : tight ? "none" : "no teacher"}
                              {merged && <span title="taught as one lesson">⛓</span>}
                            </span>
                            {/* §31.10 — the room is the third line, and the
                                twelve pixels a column that let twenty subjects
                                fit. At `compact` it moves to the strip, which
                                has the room to print it in full rather than
                                ellipsised to "Pre-Nurs…". */}
                            {!tight && (
                              <span style={{
                                font: "400 8.5px/1.1 Inter", opacity: 0.7, marginTop: 1, display: "block",
                                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                              }}>
                                {p <= 0 ? " " : code ? (row?.room || `${shortLabel(id)} room`) : "click to fix"}
                              </span>
                            )}
                          </CellShell>
                        </td>
                      );
                    })}

                    {/*
                      §31.18 — the block's cell for THIS section.

                      Read-only, and visibly so: a block's periods, members,
                      options and placement all live on the Electives screen
                      (§4.9), which is the one writer for them. §27.11 already
                      draws that line — a reset counts and NAMES elective blocks
                      and never removes them — and an editable-looking cell here
                      would be a second door onto rows this grid cannot express.

                      A section that does not attend gets a dash rather than a
                      zero: zero periods is a statement about a block this class
                      is in, and these children are simply somewhere else.
                    */}
                    {m.blocks.map((b, bi) => {
                      const member = b.members.has(id.trim().toLowerCase());
                      const col = m.subjects.length + bi;
                      const rowIndex = sections.findIndex((x) => x.id === id);
                      const isCursor = cursor.row === rowIndex && cursor.col === col;
                      const picked = stripCell?.section === id && stripCell?.blockId === b.id;
                      return (
                        <td key={`b${b.id}`} style={{
                          padding: 1.5, borderBottom: "1px solid var(--line)", textAlign: "center",
                          borderTop: i === 0 ? "2px solid var(--steel-light)" : undefined,
                        }}>
                          {/*
                            §31.19 — selectable, and its NUMBER is editable.

                            Everything else about a block — its options, their
                            teachers and rooms, who attends, when it runs — is
                            Split Electives' to change, and the toolbar disables
                            those fields rather than pretending otherwise. The
                            periods are here because this is the screen where
                            "does Class 5's week add up?" is being asked, and
                            sending somebody to another page to change one
                            number is what made them type it into the French
                            column instead.

                            `CellShell` again, so the selected cell is a div
                            holding a real input and an unselected one is a
                            button — the same invalid-HTML rule §31.16 wrote
                            down, not a second answer to it.
                          */}
                          <CellShell
                            editing={picked && member}
                            onClick={() => {
                              setCursor({ row: rowIndex, col });
                              setStripCell({ section: id, subject: b.name, blockId: b.id });
                              setRefused(null);
                              setHover(null);
                            }}
                            title={member
                              ? `${b.name} — ${b.periodsPerWeek} periods a week, split across ${b.options.map((o) => o.subject).join(", ") || "no options yet"}. Type to change how many; everything else is on Split Electives.`
                              : `${shortLabel(id)} does not take ${b.name}`}
                            style={{
                              width: "100%", minWidth: tight ? 0 : 58, borderRadius: 6,
                              padding: tight ? "2px 1px" : "3px 2px", display: "block",
                              cursor: "pointer",
                              boxShadow: isCursor ? "0 0 0 2px var(--brand)" : undefined,
                              background: member ? bandsFor(b.options) : "var(--offwhite)",
                              // A dashed edge, the §4.9 mark for "several
                              // lessons in one slot", kept from the Board so the
                              // two screens say the same thing about a block.
                              border: member ? "1px dashed var(--steel)" : "1px solid var(--line)",
                              color: member ? "var(--ink)" : "var(--ink-faint)",
                            }}>
                            {picked && member ? (
                              <input
                                ref={cellInput}
                                value={typed}
                                inputMode="numeric"
                                aria-label={`Periods a week of ${b.name} for ${c.className}`}
                                onChange={(e) => commitTyped(c.className, b.name, e.target.value)}
                                onFocus={(e) => e.currentTarget.select()}
                                onKeyDown={(e) => onCellKey(e, rowIndex, col, c.className, b.name)}
                                style={{
                                  font: "700 13.5px/1 var(--font-mono, monospace)",
                                  display: "block", width: "100%", textAlign: "center",
                                  border: "none", background: "transparent", color: "inherit",
                                  padding: 0, margin: 0, outline: "none",
                                  height: 13.5, minWidth: 0,
                                }}
                              />
                            ) : (
                              <span style={{ font: "700 13.5px/1 var(--font-mono, monospace)", display: "block" }}>
                                {member ? lessonsFromBase(b.periodsPerWeek, spanOf(c.className)).lessons : "—"}
                              </span>
                            )}
                            {!tight && (
                              <span style={{
                                font: "400 8.5px/1.1 Inter", opacity: 0.75, marginTop: 1, display: "block",
                              }}>
                                {member
                                  ? `${b.options.length} option${b.options.length === 1 ? "" : "s"}`
                                  : " "}
                              </span>
                            )}
                          </CellShell>
                        </td>
                      );
                    })}

                    {i === 0 && (
                      <td rowSpan={c.sections.length}
                        {...peek({ kind: "load", className: c.className })}
                        style={{
                          borderLeft: "1px solid var(--line)", borderBottom: "1px solid var(--line)",
                          borderTop: "2px solid var(--steel-light)", background: "var(--offwhite)",
                          verticalAlign: "middle", padding: "4px 8px",
                          /* §31.17 — sticky right, matching the header above.
                             The background must stay opaque or the subject
                             cells show through as they scroll beneath it. */
                          ...(tight
                            ? { position: "sticky" as const, right: 0, zIndex: 2, width: LOAD_PX }
                            : { minWidth: 86 }),
                        }}>
                        <div style={{ font: "700 12px/1 var(--font-mono, monospace)", color: colour }}>
                          {total}/{m.capacity}
                        </div>
                        <MiniBar pct={total / m.capacity} colour={colour} />
                        <div style={{ fontSize: 9, color: "var(--ink-faint)", marginTop: 3, lineHeight: 1.3 }}>
                          {state === "exact" ? "fills the week"
                            : state === "under" ? `${m.capacity - total} free`
                              : `${total - m.capacity} over`}
                          <br />
                          {/* Named rather than folded in silently: a class
                              whose total jumped by five wants to know which
                              five, and the answer is a screen away. */}
                          {elective > 0 && (
                            <>
                              <span style={{ fontFamily: "var(--font-mono, monospace)" }}>
                                incl. {elective} elective
                              </span>
                              <br />
                            </>
                          )}
                          {/* Periods are the unit the solver places; MINUTES are
                              the unit a head teacher is accountable for. Both,
                              because the conversion is not obvious at a glance. */}
                          <span style={{ opacity: 0.8, fontFamily: "var(--font-mono, monospace)" }}>
                            {total * m.minutes} min · {m.minutes}/period
                          </span>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              });
            })}
          </tbody>
        </table>
      </div>

      {/*
        Never while the dialog is open.
        Clearing `hover` on click is not enough on its own: Enter opens the same
        dialog from the keyboard without any click, and a stray mousemove over a
        cell the modal does not cover would put the card back. A modal owns the
        screen — so the guard is on the render, where it cannot be missed by a
        new way of opening it.
      */}
      {hover && !editing && (
        <Tip at={{ x: hover.x, y: hover.y }}>
          <HoverBody
            what={hover.what} m={m}
            periodsOf={periodsOf} mappingIndexOf={mappingIndexOf}
            classTeacherOf={classTeacherOf} totalOf={totalOf} nameOf={nameOf}
          />
        </Tip>
      )}

      {resetting && m.wing && configIds[m.wing.name.toLowerCase()] !== undefined && (
        <ResetAllocation
          configId={configIds[m.wing.name.toLowerCase()]}
          onClose={() => setResetting(false)}
          onDone={() => {
            setResetting(false);
            // The rows are gone; the DRAFT must go with them, or the grid keeps
            // showing a plan the school no longer has. `null`, not `undefined`
            // — the wizard sends only touched keys and JSON.stringify drops an
            // undefined one, so the cleared plan would survive the save (§28.6).
            onChange({ curriculum: null, mappings: null, classTeachers: null });
          }}
        />
      )}

      {/*
        §27.15 — outside the dialog, deliberately.

        The dialog hands over to this and closes: the two are different
        questions ("what should this cell say?" against "should this cell exist
        at all?"), and a destructive confirmation stacked on top of an edit form
        leaves the form's unsaved numbers sitting behind it, about to be thrown
        away by whichever button is pressed. The keyboard's Delete opens the
        same component with no dialog involved at all.
      */}
      {refused && (
        <div
          role="status"
          onClick={() => setRefused(null)}
          style={{
            position: "fixed", bottom: 18, left: "50%", transform: "translateX(-50%)", zIndex: 210,
            maxWidth: 520, padding: "10px 14px", borderRadius: 10, cursor: "pointer",
            border: "1px solid var(--signal)", background: "var(--paper)", color: "var(--ink)",
            font: "400 12.5px/1.45 Inter", boxShadow: "0 6px 22px rgba(11,31,68,.18)",
          }}
        >
          {refused}
        </div>
      )}

      {removing && (
        <RemoveSubject
          configId={m.wing ? configIds[m.wing.name.toLowerCase()] : undefined}
          className={removing.className}
          subjectName={removing.subject}
          sectionCount={m.classes.find((c) => c.className === removing.className)?.sections.length ?? 1}
          onClose={() => setRemoving(null)}
          onDone={() => {
            dropCell(removing.className, removing.subject);
            setRemoving(null);
          }}
        />
      )}

      {editing && (
        <CellDialog
          m={m} answers={answers} section={editing.section} subject={editing.subject}
          onClose={() => setEditing(null)}
          onRemove={() => {
            setEditing(null);
            setRemoving({ className: editing.section.replace(/-[^-]+$/, ""), subject: editing.subject });
          }}
          periodsOf={periodsOf} mappingIndexOf={mappingIndexOf} classTeacherOf={classTeacherOf}
          totalOf={totalOf}
          onSave={(next) => {
            applyCell(editing.section, editing.subject, next);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}
