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
import { useEffect, useMemo, useRef, useState } from "react";
import {
  assignInitials, assignSwatches, computeLoads, coverageGaps, defaultsFor, planClasses, relieveLoad,
  subjectAppliesTo, suggestCurriculum, suggestMappings, weeklyCapacity, withCurriculumPeriods,
  type CurriculumCell, type LoadRemedy, type MappingSuggestion, type SubjectAnswer,
  type Swatch, type TeacherLoad, type TeacherAnswer, type WingAnswer,
} from "@edutimetable/shared";
import type { WeekAnswer } from "./Structure";
import {
  Advisor, CellDialog, HoverBody, MiniBar, RemoveSubject, ResetAllocation, type Hover,
} from "./AllocationParts";
import { api } from "../../api";
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
}

const label = (className: string, section: string) => `${className}-${section}`;
/** "Class 3-A" → "3-A": the class is already the group heading. */
const shortLabel = (l: string) => l.replace(/^Class\s+/i, "");

const BAND_COLOUR: Record<string, string> = {
  ok: "var(--steel)", warn: "var(--amber)", full: "var(--brand)", over: "var(--signal)",
};
const BAND_BG: Record<string, string> = {
  ok: "var(--paper)", warn: "var(--amber-bg)", full: "var(--steel-pale)", over: "var(--signal-bg)",
};

// ─────────────────────────────────────────────────────────────── the model

function useModel(answers: Record<string, any>, activeWing: number): Model {
  return useMemo(() => {
    const wings: WingAnswer[] = answers.wings ?? [];
    const weeks: Record<string, WeekAnswer> = answers.weeks ?? {};
    const subjects: SubjectAnswer[] = (answers.subjects ?? []).filter((s: SubjectAnswer) => s.name?.trim());
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

    return {
      wings,
      wing,
      wingName: wing?.name ?? "",
      subjects,
      staff,
      classes: all.filter((c) => c.wing === wing?.name).map((c) => ({ className: c.className, sections: c.sections })),
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
      swatches: assignSwatches(subjects.map((s) => s.name)),
      loads,
      byCode: new Map(loads.map((l) => [l.employeeCode, l])),
      gaps: coverageGaps(wings, curriculum, mappings).length,
      edited: {
        curriculum: Array.isArray(answers.curriculum) && answers.curriculum.length > 0,
        mappings: Array.isArray(answers.mappings) && answers.mappings.length > 0,
      },
      stale,
      proposedGaps: coverageGaps(wings, curriculum, proposedMappings.mappings).length,
    };
  }, [JSON.stringify([answers.wings, answers.weeks, answers.subjects, answers.teachers,
                      answers.curriculum, answers.mappings, answers.classTeachers, answers.rooms,
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

export function StepAllocation({ answers, onChange, onFocusMode }: {
  answers: Record<string, any>;
  onChange: (patch: Record<string, any>) => void;
  /** Lets the step ask the wizard shell to fold its chrome away. */
  onFocusMode?: (on: boolean) => void;
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

  const m = useModel(answers, activeWing);

  /** Every section of the active wing, in grid order. */
  const sections = useMemo(
    () => m.classes.flatMap((c) => c.sections.map((s) => ({ id: label(c.className, s), className: c.className }))),
    [m.classes],
  );

  // ── reading the draft ──────────────────────────────────────────────────
  const periodsOf = (className: string, subject: string) =>
    m.cells.find((c) => c.className === className && c.subjectName === subject)?.periodsPerWeek ?? 0;

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
    onChange({ curriculum: [...others, { className, subjectName: subject, periodsPerWeek: periods, maxPerDay }] });
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

  // ── keyboard ───────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editing) return;
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA")) return;
      const nav = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"].includes(e.key);
      const digit = /^[0-9]$/.test(e.key);
      // §27.15 — Delete asks the same question the dialog's button asks, and
      // goes through the same confirmation. A keystroke must not be the one
      // path that deletes saved rows without showing what they are.
      const remove = e.key === "Delete" || e.key === "Backspace";
      if (!nav && !digit && !remove) return;
      e.preventDefault();
      const row = Math.max(0, Math.min(sections.length - 1,
        cursor.row + (e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0)));
      const col = Math.max(0, Math.min(m.subjects.length - 1,
        cursor.col + (e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0)));
      setCursor({ row, col });
      const sec = sections[row], sub = m.subjects[col];
      if (!sec || !sub) return;
      if (e.key === "Enter") { setEditing({ section: sec.id, subject: sub.name }); return; }
      if (remove) {
        // Nothing there is nothing to remove — and the confirmation would have
        // no counts on it, which reads as a broken dialog rather than a no-op.
        if (periodsOf(sec.className, sub.name) > 0 || mappingIndexOf(sec.id, sub.name) >= 0) {
          setRemoving({ className: sec.className, subject: sub.name });
        }
        return;
      }
      if (digit) {
        // Refused above 100%, as the screen refuses everywhere else: a class
        // asking for more periods than its week holds can never be timetabled.
        const next = totalOf(sec.className) - periodsOf(sec.className, sub.name) + Number(e.key);
        if (next <= m.capacity) setPeriods(sec.className, sub.name, Number(e.key));
      }
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
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", flexShrink: 0 }}>
        {m.wings.length > 1 && (
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
        <span style={{ flex: 1 }} />
        <input value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter teacher, subject, class" aria-label="Filter the grid"
          style={{
            padding: "5px 9px", border: "1px solid var(--line)", borderRadius: 8, fontSize: 12,
            background: "var(--paper)", color: "var(--ink)", width: 180,
          }} />
        {(m.edited.mappings || m.edited.curriculum) && (
          <button className="btn" style={{ padding: "4px 9px", fontSize: 11.5 }}
            title="Throw away the edits on this page and propose it again from the subjects, teachers and classes"
            onClick={() => {
              if (!window.confirm(
                "Start this page again from the suggestion?\n\n" +
                "The periods and teachers on this page are re-proposed from your subjects, " +
                "teachers and classes. Nothing on any other step changes.",
              )) return;
              // `null`, not `undefined`. The wizard sends only the keys it
              // touched, and `JSON.stringify` drops an undefined one — so the
              // server would merge nothing and the stored plan would survive a
              // reset that appeared to work. The server reads a non-array as
              // "not edited" and re-proposes.
              onChange({ curriculum: null, mappings: null, classTeachers: null });
            }}>↺ Start again</button>
        )}
        {/*
          Two controls, and the difference between them is the whole point.

          "Start again" rebuilds this page from your subjects, teachers and
          classes and touches nothing that has been saved. "Clear saved data"
          deletes the curriculum and the mappings out of the school. One is a
          rethink, the other is a demolition, and a single button meaning both
          would be the last thing anybody read before losing an afternoon.
        */}
        {m.wing && configIds[m.wing.name.toLowerCase()] !== undefined && (
          <button className="btn" style={{
            padding: "4px 9px", fontSize: 11.5,
            borderColor: "color-mix(in srgb,var(--signal) 40%,var(--line))", color: "var(--signal)",
          }}
            title="Delete the curriculum, the mappings and the class teachers this timetable has saved"
            onClick={() => setResetting(true)}>⌫ Clear saved data</button>
        )}
        {/*
          §27.14 — the hover card, switched off.

          A checkbox rather than a button labelled by its next action: "Hover
          detail" with a tick says what the state IS, where "Turn hover detail
          off" would only say what pressing it does — and half the readers of
          that label take it as a description of the current setting.

          `aria-pressed` rather than `role="checkbox"`: it is a toolbar toggle,
          and the tick is the visible half of the same fact.
        */}
        <button className="btn" aria-pressed={hoverDetail}
          style={{
            padding: "4px 9px", fontSize: 11.5,
            color: hoverDetail ? "var(--ink)" : "var(--ink-faint)",
          }}
          title={hoverDetail
            ? "Stop showing the detail card when the pointer rests on a cell. Clicking a cell still opens it."
            : "Show the detail card again when the pointer rests on a cell"}
          onClick={() => {
            setHoverDetail(!hoverDetail);
            // The card on screen belongs to the setting that is being turned
            // off — leaving it up until the next mouse move reads as the switch
            // not having worked.
            setHover(null);
          }}>
          {hoverDetail ? "☑" : "☐"} Hover detail
        </button>
        <button className="btn" style={{ padding: "4px 9px", fontSize: 11.5 }}
          aria-expanded={showHelp} onClick={() => setShowHelp(!showHelp)}>? Help</button>
        {onFocusMode && (
          <button className="btn" style={{ padding: "4px 9px", fontSize: 11.5 }}
            title="Fold the step rail away and give the room to the grid"
            onClick={() => onFocusMode(true)}>⇱ Focus</button>
        )}
      </div>

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
          <div role="img" aria-label="Every teacher's load, heaviest first"
            style={{ display: "flex", gap: 2, alignItems: "flex-end", height: 16, flex: 1, minWidth: 90, maxWidth: 340 }}>
            {m.loads.map((t) => (
              <span key={t.employeeCode}
                {...peek({ kind: "teacher", code: t.employeeCode })}
                style={{
                  flex: 1, minWidth: 2, borderRadius: 1, background: BAND_COLOUR[t.band],
                  opacity: t.band === "ok" ? 0.55 : 1,
                  height: `${Math.max(18, Math.min(100, t.pct * 100))}%`,
                }} />
            ))}
          </div>

          <div style={{ fontSize: 11.2, color: "var(--ink-faint)", display: "flex", gap: 11, flexWrap: "wrap" }}>
            <span><strong style={{ fontFamily: "var(--font-mono, monospace)" }}>{m.loads.length}</strong> teachers</span>
            {overCount > 0 && <span style={{ color: "var(--signal)" }}>
              <strong style={{ fontFamily: "var(--font-mono, monospace)" }}>{overCount}</strong> over</span>}
            {warnCount > 0 && <span style={{ color: "var(--amber)" }}>
              <strong style={{ fontFamily: "var(--font-mono, monospace)" }}>{warnCount}</strong> at{" "}
              {answers.settings?.loadAlertPct ?? 75}%+</span>}
            {m.gaps > 0 && <span style={{ color: "var(--signal)" }}>
              <strong style={{ fontFamily: "var(--font-mono, monospace)" }}>{m.gaps}</strong> unstaffed</span>}
          </div>

          <span style={{ flex: 1 }} />
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
        <table style={{ borderCollapse: "separate", borderSpacing: 0, width: "100%", fontSize: 11.5 }}>
          <thead>
            <tr>
              <th style={{
                position: "sticky", top: 0, left: 0, zIndex: 5, background: "var(--brand)", color: "#fff",
                font: "600 10.5px/1 Inter", padding: "6px 5px 6px 11px", textAlign: "left", minWidth: 112,
                whiteSpace: "nowrap",
              }}>Class-section</th>
              {m.subjects.map((s) => (
                <th key={s.name}
                  {...peek({ kind: "subject", subject: s.name })}
                  style={{
                    position: "sticky", top: 0, zIndex: 3, background: "var(--brand)", color: "#fff",
                    font: "600 10.5px/1.2 Inter", padding: "6px 5px", textAlign: "center", whiteSpace: "nowrap",
                  }}>
                  {s.name.length > 6 ? s.name.slice(0, 5) : s.name}
                  <span style={{ display: "block", font: "500 9px/1 var(--font-mono, monospace)", opacity: 0.7, marginTop: 2 }}>
                    {(s.category ?? defaultsFor(s.name).category) === "co_scholastic" ? "co-sch" : "sch"}
                  </span>
                </th>
              ))}
              <th style={{
                position: "sticky", top: 0, zIndex: 3, background: "var(--brand)", color: "#fff",
                font: "600 10.5px/1 Inter", padding: "6px 5px", minWidth: 86,
              }}>Load</th>
            </tr>
          </thead>
          <tbody>
            {m.classes.map((c) => {
              const total = totalOf(c.className);
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
                    }}>
                      {i === 0 && (
                        <span style={{
                          font: "700 9px/1 Inter", letterSpacing: "0.07em", textTransform: "uppercase",
                          color: "var(--ink-faint)", display: "block", marginBottom: 2,
                        }}>{c.className}</span>
                      )}
                      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span>{shortLabel(id)}</span>
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
                      const p = periodsOf(c.className, s.name);
                      const idx = mappingIndexOf(id, s.name);
                      const row = idx >= 0 ? m.mappings[idx] : null;
                      const code = row?.employeeCode ?? "";
                      const sw = m.swatches[s.name];
                      const isCT = !!code && ct === code;
                      const merged = !!row?.merged && row.classSections.length > 1;
                      const rowIndex = sections.findIndex((x) => x.id === id);
                      const isCursor = cursor.row === rowIndex && cursor.col === col;
                      const dim = (selected && code !== selected) || !matches(id, s.name, code);

                      return (
                        <td key={s.name} style={{
                          padding: 1.5, borderBottom: "1px solid var(--line)", textAlign: "center",
                          borderTop: i === 0 ? "2px solid var(--steel-light)" : undefined,
                        }}>
                          <button
                            onClick={() => {
                              setCursor({ row: rowIndex, col });
                              // The hover card is the READING of this cell; the
                              // dialog is the changing of it. Leaving the card
                              // up puts two versions of the same facts on
                              // screen at once, one of them already stale the
                              // moment the dialog is touched.
                              setHover(null);
                              setEditing({ section: id, subject: s.name });
                            }}
                            {...peek({ kind: "cell", section: id, subject: s.name })}
                            style={{
                              width: "100%", minWidth: 58, borderRadius: 6, padding: "3px 2px", display: "block",
                              cursor: "pointer", opacity: dim ? 0.16 : 1,
                              boxShadow: isCursor ? "0 0 0 2px var(--brand)" : undefined,
                              ...(p <= 0
                                ? { background: "var(--offwhite)", color: "var(--ink-faint)", border: "1px solid var(--line)" }
                                : !code
                                  ? { background: "var(--signal-bg)", color: "var(--signal)", border: "1.5px dashed var(--signal)" }
                                  : { background: sw?.bg, color: sw?.fg, border: `1px solid ${sw?.border ?? "transparent"}` }),
                            }}>
                            <span style={{ font: "700 13.5px/1 var(--font-mono, monospace)", display: "block", opacity: p <= 0 ? 0.5 : 1 }}>
                              {p <= 0 ? "–" : p}
                            </span>
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
                              {p <= 0 ? " " : code ? initialsOf(code) : "no teacher"}
                              {merged && <span title="taught as one lesson">⛓</span>}
                            </span>
                            <span style={{
                              font: "400 8.5px/1.1 Inter", opacity: 0.7, marginTop: 1, display: "block",
                              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                            }}>
                              {p <= 0 ? " " : code ? (row?.room || `${shortLabel(id)} room`) : "click to fix"}
                            </span>
                          </button>
                        </td>
                      );
                    })}

                    {i === 0 && (
                      <td rowSpan={c.sections.length}
                        {...peek({ kind: "load", className: c.className })}
                        style={{
                          borderLeft: "1px solid var(--line)", borderBottom: "1px solid var(--line)",
                          borderTop: "2px solid var(--steel-light)", background: "var(--offwhite)",
                          verticalAlign: "middle", padding: "4px 8px", minWidth: 86,
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
            if (next.periods !== undefined) setPeriods(next.className, editing.subject, next.periods);
            if (next.mappings) setMappings(next.mappings);
            if (next.classTeacher !== undefined) setClassTeacher(editing.section, next.classTeacher);
            // §28 — the period LENGTH is step 5's key, so it is written back
            // into step 5's answer. `commitWeeks(…, {changedOnly})` picks it up
            // on Next; nothing here writes to the server, as everywhere else in
            // this wizard.
            if (next.minutes !== undefined && m.wing) {
              onChange({
                weeks: {
                  ...(answers.weeks ?? {}),
                  [m.wing.name]: { ...(answers.weeks?.[m.wing.name] ?? {}), periodDurationMins: next.minutes },
                },
              });
            }
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}
