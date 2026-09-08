/**
 * §15.3 Phase 25.4 — what the guided setup PROPOSES: rooms and a curriculum.
 *
 * The point of these two steps is that nobody types 38 rooms or 130 curriculum
 * cells one at a time. A suggestion that has to be corrected is far cheaper
 * than a form that has to be filled — but only if the suggestion is right often
 * enough to be worth reading, and never quietly wrong in a way that breaks the
 * school later.
 *
 * Both functions are pure, so both are checked by unit tests rather than by
 * looking at a screen and nodding.
 */
import { LUNCH_LABEL } from "../import/contract";
import type { RawSheet } from "../import/types";
import { CLASS_LADDER, planClasses, type WingAnswer } from "./wizard";

// ────────────────────────────────────────────────────────────── subjects

export interface SubjectAnswer {
  name: string;
  code?: string;
  isLab?: boolean;
  requiresDoublePeriod?: boolean;
  /**
   * §26.2 placement. All optional, and absent means "not stated" rather than
   * "neutral": the committer fills a blank from `defaultsFor(name)`, so a
   * subject somebody never opened still arrives classified, while one they DID
   * set to priority 3 stays at 3 even if the classifier would have said 5.
   */
  category?: SubjectDefaults["category"];
  priority?: number;
  lunchRule?: SubjectDefaults["lunchRule"];
  gapAfterLunch?: boolean;
}

/**
 * Which activity room a subject wants, if any.
 *
 * Matched on the subject NAME, which is what the admin typed — there is no
 * other signal at this point in the setup, and a school that calls it "Games"
 * rather than "Physical Education" simply gets no suggestion, which is the
 * right failure: a missing proposal is corrected in one click, a wrong one is
 * corrected only if somebody notices.
 */
const ACTIVITY_ROOMS: Array<{ match: RegExp; room: string; type: RoomType }> = [
  { match: /\b(art|craft|drawing|painting)\b/i, room: "Art Room", type: "art" },
  { match: /\b(music|singing|instrumental)\b/i, room: "Music Room", type: "music" },
  { match: /\b(dance|choreography)\b/i, room: "Dance Room", type: "other" },
  { match: /\b(physical education|pe|sports|games|athletics)\b/i, room: "Sports Ground", type: "sports" },
  { match: /\b(library|reading)\b/i, room: "Library", type: "other" },
];

export type RoomType = "classroom" | "lab" | "sports" | "music" | "art" | "auditorium" | "other";

export interface SuggestedRoom {
  name: string;
  type: RoomType;
  capacity: number | null;
  isShared: boolean;
  /** Subject names this room serves. EMPTY MEANS GENERAL — see below. */
  subjects: string[];
  /** For the screen: why this room was proposed. */
  because: string;
  /** Which class-section it is the home room of, if any. */
  homeRoomFor?: string;
}

/**
 * Propose the rooms this school appears to need.
 *
 * **The trap this function exists to avoid:** a lab with no subjects listed is
 * *general* and serves everything (§19) — that is what keeps schools created
 * before room-subject mapping working. So a suggester that proposes
 * `Science Lab` without attaching Science to it does not create a science lab,
 * it creates a second general-purpose room with a misleading name, and the
 * solver will happily put Hindi in it. Every proposed lab therefore carries its
 * subjects, and `suggest.spec.ts` asserts it directly.
 */
export function suggestRooms(
  wings: WingAnswer[],
  subjects: SubjectAnswer[],
  opts: {
    strength?: number;
    /**
     * The proposed curriculum, and each wing's weekly capacity.
     *
     * Needed to size the LABS. One lab per lab subject is the obvious guess and
     * it is wrong the moment a school has ten sections: Feasibility Check 5
     * refuses it — *"84 lab periods/week are required but 2 lab rooms supply
     * only 80 lab slots"* — and no amount of staffing helps, because it is a
     * property of the rooms. Demand is periods x sections; supply is one room's
     * week.
     */
    curriculum?: CurriculumPlan;
    capacityByWing?: Record<string, number>;
  } = {},
): SuggestedRoom[] {
  const rooms: SuggestedRoom[] = [];
  const { classes } = planClasses(wings);
  const capacity = opts.strength ?? 40;

  // One home room per class-section. The solver claims a section's home room
  // for every non-lab lesson (§19), so this is not decoration — without it
  // every ordinary lesson has no room.
  for (const c of classes) {
    for (const s of c.sections) {
      const label = `${c.className}-${s}`;
      rooms.push({
        name: label,
        type: "classroom",
        capacity,
        isShared: false,
        subjects: [],
        because: "Home room",
        homeRoomFor: label,
      });
    }
  }

  // Enough labs per lab subject to hold the demand — not one and hope.
  const sectionsOf = new Map(classes.map((c) => [c.className, c.sections.length]));
  const roomWeek = Math.max(20, ...Object.values(opts.capacityByWing ?? { d: 40 }));
  for (const s of subjects.filter((x) => x.isLab)) {
    const demand = (opts.curriculum?.cells ?? [])
      .filter((c) => c.subjectName === s.name)
      .reduce((n, c) => n + c.periodsPerWeek * (sectionsOf.get(c.className) ?? 1), 0);
    const needed = Math.max(1, Math.ceil(demand / roomWeek));
    for (let i = 0; i < needed; i++) {
      rooms.push({
        name: needed === 1 ? `${s.name} Lab` : `${s.name} Lab ${i + 1}`,
        type: "lab",
        capacity,
        isShared: false,
        subjects: [s.name],
        because: needed === 1
          ? `${s.name} is marked a lab subject`
          : `${s.name} needs ${demand} periods a week, which is more than ${needed - 1} lab(s) can hold`,
      });
    }
  }

  // Activity rooms, from the subject list.
  const seen = new Set<string>();
  for (const s of subjects) {
    const hit = ACTIVITY_ROOMS.find((a) => a.match.test(s.name));
    if (!hit || seen.has(hit.room)) continue;
    seen.add(hit.room);
    rooms.push({
      name: hit.room,
      type: hit.type,
      // A shared room is one several wings compete for; the contention check
      // (Check 5) needs to know, and a sports ground plainly is one.
      isShared: hit.room === "Library" || hit.room === "Sports Ground",
      capacity: hit.room === "Sports Ground" ? null : capacity,
      subjects: [s.name],
      because: `${s.name} is on your subject list`,
    });
  }

  return rooms;
}

/** The proposed rooms, as importer sheets. */
export function roomSheets(rooms: SuggestedRoom[]): RawSheet[] {
  if (rooms.length === 0) return [];
  const rows = rooms.map((r) => ({
    "Room Name": r.name,
    Type: r.type,
    Capacity: r.capacity ?? "",
    Shared: r.isShared ? "Yes" : "No",
    // §19, invariant 5: rooms are ASSIGNED, not left blank. Creating "Class 1-A
    // Room" and not writing `class_sections.home_room_id` produces a school
    // whose every ordinary lesson shows no room — Readiness says so ("10
    // class-sections have no home room"), and the room the wizard proposed sits
    // there doing nothing. The importer already owns this column; the suggester
    // simply was not filling it in.
    "Home Room For": r.homeRoomFor ?? "",
  }));
  return [{
    name: "Rooms",
    headers: Object.keys(rows[0]),
    rows: rows.map((cells, i) => ({ row: i + 2, cells })),
  }];
}

// ──────────────────────────────────────────────────────────── curriculum

/**
 * §26.2 — where a subject belongs in the day.
 *
 * Four facts about the SUBJECT, not about one class's version of it: "Games is
 * not taught straight after lunch" is true of Games. The curriculum row still
 * owns the per-class facts — how many periods, how many a day, block size.
 */
export interface SubjectDefaults {
  category: "scholastic" | "co_scholastic";
  /** 1..5, higher is earlier in the day. A preference, never a rule (§26.2). */
  priority: number;
  lunchRule: "any" | "before" | "after";
  gapAfterLunch: boolean;
}

/**
 * The neutral answer: what an unrecognised subject gets, and what every row in
 * the database had before this phase. Priority 3 is the middle of 1..5, so a
 * name the classifier does not know is neither favoured nor penalised.
 */
export const NEUTRAL_SUBJECT: SubjectDefaults = {
  category: "scholastic",
  priority: 3,
  lunchRule: "any",
  gapAfterLunch: false,
};

const SCHOLASTIC = (priority: number): SubjectDefaults =>
  ({ category: "scholastic", priority, lunchRule: "any", gapAfterLunch: false });
const CO_SCHOLASTIC = (priority: number): SubjectDefaults =>
  ({ category: "co_scholastic", priority, lunchRule: "any", gapAfterLunch: false });

/**
 * Roughly how much of a week each subject wants, by band.
 *
 * Weights, not periods. The actual numbers are derived by scaling these to the
 * wing's REAL weekly capacity — see `suggestCurriculum`. A fixed table would
 * hand an 8-period week a 40-period curriculum, which is the one failure this
 * step must not have.
 *
 * ORDER IS SIGNIFICANT: the lookup is a `find`, so the first pattern that
 * matches wins. Every compound name ending in "Science" must therefore sit
 * ABOVE the bare science row — otherwise "Computer Science" and "Social
 * Science" are both silently weighted as laboratory science, which is how a
 * 3-period computing course became a 6-period one. Keep specific before
 * general when adding a row.
 *
 * §26.2 — the same table now also carries each family's **placement defaults**.
 * One classifier rather than a second one beside it: a school's subject names
 * are matched once, and the guided setup, the Subjects master, the §16 importer
 * and the ERP sync all read the answer from here. Two tables would eventually
 * disagree about whether "Games" is co-scholastic, and only a school would find
 * out.
 */
/**
 * §27.15 — where a subject sits on the LADDER, as well as how much it wants.
 *
 * Weight alone proposed Biology to Pre-Nursery. The classifier knew Biology is a
 * 4-6 period laboratory science and had no opinion at all about who is old
 * enough to take it, so every subject in the list was offered to every class in
 * the school. A pre-primary class arriving with Chemistry in it is not a small
 * cosmetic wrong: it is the setup telling a nursery teacher, in its first
 * proposal, that it does not know what a nursery is.
 *
 * `from`/`to` are inclusive positions on `CLASS_LADDER` (Pre-Nursery is 1), and
 * a subject outside its range is simply not proposed for that class.
 *
 * Two things this deliberately is NOT:
 *
 *  - **Not a rule.** It shapes the PROPOSAL only. A school that teaches French
 *    from Nursery clicks the empty cell and types a number, and nothing argues
 *    with them — the same one click that removes a subject puts it back.
 *  - **Not a claim about a school's own list.** An unrecognised name has no
 *    range, so it is offered everywhere, which is the right failure: a missing
 *    proposal is corrected in one click, a wrong one only if somebody notices.
 */
const AT = (className: string): number => CLASS_LADDER.indexOf(className as never) + 1;
/** Class 1 — where formal subject teaching starts, above the pre-primary four. */
const PRIMARY = AT("Class 1");
/** Class 5 — the usual entry point for a third language. */
const MIDDLE = AT("Class 5");
/** Class 9 — where one Science becomes Physics, Chemistry and Biology. */
const SECONDARY = AT("Class 9");
/** Class 11 — where a stream's own subjects begin. */
const SENIOR = AT("Class 11");

const WEIGHTS: Array<
  { match: RegExp; lower: number; upper: number; senior: number; from?: number; to?: number } & SubjectDefaults
> = [
  { match: /\b(english|language arts)\b/i, lower: 6, upper: 6, senior: 6, ...SCHOLASTIC(5) },
  // The second language runs the whole ladder; a THIRD language does not — and
  // it is a §4.9 split block when it arrives, not a subject every child takes.
  { match: /\b(sanskrit|french|german|spanish|urdu)\b/i, lower: 5, upper: 5, senior: 4, from: MIDDLE, ...SCHOLASTIC(4) },
  { match: /\b(hindi|regional|second language)\b/i, lower: 5, upper: 5, senior: 4, ...SCHOLASTIC(4) },
  { match: /\b(math|maths|mathematics)\b/i, lower: 6, upper: 7, senior: 7, ...SCHOLASTIC(5) },
  { match: /\b(evs|environmental)\b/i, lower: 4, upper: 0, senior: 0, ...SCHOLASTIC(4) },
  // ↓ specific "…Science" families, above the generic science row
  { match: /\b(computer|computing|information technology|it)\b/i, lower: 2, upper: 3, senior: 3, from: PRIMARY, ...SCHOLASTIC(3) },
  // A stream's own subjects: Class 11 upward. Below that the same ground is
  // covered inside Social Science, which is the row underneath.
  {
    match: /\b(economics|political science|accountancy|accounts|business studies|entrepreneurship|psychology|sociology|informatics)\b/i,
    lower: 4, upper: 5, senior: 5, from: SENIOR, ...SCHOLASTIC(4),
  },
  { match: /\b(social|history|geography|civics|political)\b/i, lower: 4, upper: 5, senior: 5, from: PRIMARY, ...SCHOLASTIC(4) },
  // The named sciences separate at Class 9; before that a school teaches
  // "Science", which is the row underneath and starts at Class 1.
  {
    match: /\b(physics|chemistry|biology|botany|zoology)\b/i,
    lower: 4, upper: 5, senior: 6, from: SECONDARY, ...SCHOLASTIC(4),
  },
  { match: /\b(science)\b/i, lower: 4, upper: 5, senior: 6, from: PRIMARY, ...SCHOLASTIC(4) },
  // Co-scholastic from here down. Note what is NOT claimed: art and music get a
  // low priority (they yield the morning) but no lunch rule, because there is
  // nothing about a painting lesson that a full stomach prevents.
  { match: /\b(art|craft|music|dance)\b/i, lower: 2, upper: 2, senior: 1, ...CO_SCHOLASTIC(2) },
  // The one family with a real physical constraint behind it, and the reason
  // `gapAfterLunch` exists: children cannot run straight after eating. `after`
  // as well, because a games period before lunch means arriving at lunch filthy.
  {
    match: /\b(physical education|pe|sports|games|yoga|swimming|athletics)\b/i,
    lower: 3, upper: 3, senior: 2,
    ...CO_SCHOLASTIC(2), lunchRule: "after", gapAfterLunch: true,
  },
  { match: /\b(moral|value|general knowledge|gk|library|assembly)\b/i, lower: 1, upper: 1, senior: 1, ...CO_SCHOLASTIC(1) },
];

/**
 * §26.2 — the placement defaults for a subject name.
 *
 * The **only** way anything in the product guesses these. Every caller — the
 * guided setup, the Subjects master's "suggest" action, the §16 importer
 * filling a blank column, the ERP sync — asks here, so a school cannot end up
 * with Games co-scholastic on one screen and scholastic on another.
 *
 * An unrecognised name gets `NEUTRAL_SUBJECT` rather than a guess. A wrong
 * guess about where a subject sits in the day is worse than no opinion: it
 * quietly constrains the solver on behalf of a school that never said so.
 */
export function defaultsFor(name: string): SubjectDefaults {
  const w = WEIGHTS.find((x) => x.match.test(name ?? ""));
  if (!w) return { ...NEUTRAL_SUBJECT };
  return {
    category: w.category,
    priority: w.priority,
    lunchRule: w.lunchRule,
    gapAfterLunch: w.gapAfterLunch,
  };
}

/**
 * §27.15 — is this subject normally taught to a class at this rung?
 *
 * Exported because the answer is worth SAYING, not only acting on: an empty
 * cell that reads "Biology usually starts at Class 9" is a proposal explaining
 * itself, where a silently blank one is indistinguishable from a bug. A name
 * the classifier does not recognise fits everywhere — no opinion is the honest
 * answer, and the range is a proposal rather than a rule in any case.
 */
export function subjectSuitsClass(subjectName: string, sequence: number): boolean {
  const w = WEIGHTS.find((x) => x.match.test(subjectName ?? ""));
  if (!w) return true;
  return sequence >= (w.from ?? 1) && sequence <= (w.to ?? CLASS_LADDER.length);
}

/** The rung a subject's range starts at, for the sentence that explains it. */
export function subjectStartsAt(subjectName: string): string | null {
  const w = WEIGHTS.find((x) => x.match.test(subjectName ?? ""));
  return w?.from && w.from > 1 ? CLASS_LADDER[w.from - 1] : null;
}

/** Where a class sits on the ladder decides which weight column applies. */
function bandOf(sequence: number): "lower" | "upper" | "senior" {
  // 1-8 is Pre-Nursery..Class 4, 9-12 is Class 5..8, 13+ is Class 9 upward.
  if (sequence <= 8) return "lower";
  if (sequence <= 12) return "upper";
  return "senior";
}

export interface CurriculumCell {
  className: string;
  subjectName: string;
  periodsPerWeek: number;
  maxPerDay: number;
}

export interface CurriculumPlan {
  cells: CurriculumCell[];
  /** Per class: what it totals, and the capacity it must fit inside. */
  totals: Array<{ className: string; total: number; capacity: number; over: boolean }>;
  /**
   * Subjects the week could not hold, per class — named, never silently gone.
   *
   * A school with nine subjects and an eight-period week has a real problem,
   * and the honest answers are "drop a subject" or "lengthen the week". What
   * the suggester must not do is quietly propose nine periods in an eight
   * period week, which looks like an answer and can never generate.
   */
  dropped: Array<{ className: string; subjectName: string; reason: string }>;
}

/**
 * Propose a curriculum that FITS.
 *
 * The weights above are a starting shape; what actually goes in each cell is
 * that shape scaled to the wing's real weekly capacity and then trimmed until
 * the class total fits inside it. A proposal that cannot generate is worse than
 * no proposal, because it looks like an answer.
 *
 * The last-resort trim removes from the largest subject first: taking a period
 * off Maths hurts less than taking the only period off Library, and a subject
 * reduced to zero would silently stop being taught.
 */
export function suggestCurriculum(
  wings: WingAnswer[],
  subjects: SubjectAnswer[],
  capacityByWing: Record<string, number>,
  /**
   * Working days per wing. Defaults to five.
   *
   * Needed for `maxPerDay`, and that turns out to be load-bearing: six periods
   * a week at one a day needs SIX days, so in a five-day week the pair is
   * simply impossible — Feasibility Check 3 refuses it, and no amount of extra
   * staff helps. See `suggestCurriculum`'s max/day line.
   */
  daysByWing: Record<string, number> = {},
): CurriculumPlan {
  const { classes } = planClasses(wings);
  const cells: CurriculumCell[] = [];
  const totals: CurriculumPlan["totals"] = [];
  const dropped: CurriculumPlan["dropped"] = [];

  for (const c of classes) {
    const capacity = capacityByWing[c.wing] ?? 40;
    const days = daysByWing[c.wing] ?? 5;
    const band = bandOf(c.sequence);

    // The shape, before it is made to fit.
    const wanted = subjects
      .map((s) => {
        const w = WEIGHTS.find((x) => x.match.test(s.name));
        // §27.15 — off its rung, a subject is not proposed here at all. Weight 0
        // rather than a filter of its own, so it joins the "not wanted" case
        // that EVS above Class 4 already used.
        const fits = subjectSuitsClass(s.name, c.sequence);
        return { subjectName: s.name, weight: fits ? (w ? w[band] : 2) : 0, isLab: Boolean(s.isLab) };
      })
      .filter((x) => x.weight > 0);

    /*
      A rung narrows the choice; it must never leave a class with nothing.

      A wing of Class 11-12 whose subject list is Physics, Chemistry and
      Accountancy is exactly what the ranges were written for — but a
      PRE-PRIMARY wing whose school typed only those three names would come out
      with an empty week and a Readiness score complaining about 40 free slots
      per class. The school's own list is the better evidence in that case: it
      plainly does not follow the ladder these ranges describe, so the ranges
      stand aside rather than argue.
    */
    if (wanted.length === 0) {
      for (const s of subjects) {
        const w = WEIGHTS.find((x) => x.match.test(s.name));
        wanted.push({ subjectName: s.name, weight: w ? Math.max(1, w[band]) : 2, isLab: Boolean(s.isLab) });
      }
    }

    const rawTotal = wanted.reduce((n, x) => n + x.weight, 0);
    // Scale to fill the week.
    //
    // An earlier version left 8% slack, on the theory that a full week gives
    // the solver nowhere to move. The Feasibility Engine disagreed, and it was
    // right: free periods are not slack, they are unallocated teaching time,
    // and Readiness warns about every one of them ("Class 1-A has 6 free
    // slots/week — mark them as Library/Study or add subject periods"). A
    // school proposed by this wizard should arrive complete; if it wants study
    // periods it adds them deliberately, on the Curriculum screen.
    const target = Math.max(1, capacity);
    // Both directions. Scaling only downward left a 40-period week carrying a
    // 33-period curriculum and seven unallocated slots per class — which is
    // what Readiness was warning about.
    const scale = rawTotal > 0 ? target / rawTotal : 1;

    const scaled = wanted.map((x) => ({
      ...x,
      // Capped at the Curriculum sheet's own 1-20 bound, so a very long week
      // cannot produce a row the importer would refuse.
      periods: Math.max(1, Math.min(20, Math.round(x.weight * scale))),
    }));

    // Rounding can push it back over; trim the largest until it fits. Largest
    // first because a period off Maths hurts less than the only period off
    // Library — and a subject reduced to zero would stop being taught.
    let total = scaled.reduce((n, x) => n + x.periods, 0);
    while (total > capacity) {
      const biggest = scaled.reduce((a, b) => (b.periods > a.periods ? b : a));
      if (biggest.periods <= 1) break;
      biggest.periods -= 1;
      total -= 1;
    }

    // …and rounding can equally leave it SHORT, which the trim above cannot
    // see. Eight subjects each rounded down by a fraction left Class 5 with 38
    // periods in a 40-period week — two unallocated slots per class, which is
    // exactly the "Class 5-A has 2 free slots/week" warning that held a
    // fully-configured school at 88% readiness. Scaling has to be symmetric or
    // it only ever fills the week by luck.
    //
    // Give the period to whichever subject the rounding shortchanged most,
    // measured against its own fair share — so topping up preserves the shape
    // the weights describe instead of always fattening the largest subject.
    while (total < capacity) {
      const room = scaled.filter((x) => x.periods < 20);
      if (room.length === 0) break;
      const neediest = room.reduce((a, b) =>
        b.weight * scale - b.periods > a.weight * scale - a.periods ? b : a,
      );
      neediest.periods += 1;
      total += 1;
    }

    // Still over means the week cannot hold one period of each — nine subjects
    // in an eight-period week, say. Arithmetic, not a tuning problem. Drop the
    // LEAST-weighted subjects and NAME them, because a curriculum that exceeds
    // its week looks like an answer and can never generate, while a silently
    // shortened subject list is a school that quietly stops teaching something.
    let keep = scaled;
    if (total > capacity) {
      keep = [...scaled].sort((a, b) => b.weight - a.weight || a.subjectName.localeCompare(b.subjectName));
      while (keep.length > 0 && keep.reduce((n, x) => n + x.periods, 0) > capacity) {
        const gone = keep.pop()!;
        dropped.push({
          className: c.className,
          subjectName: gone.subjectName,
          reason: `${c.className}'s week holds ${capacity} periods, which is not enough for one period of every subject.`,
        });
      }
      total = keep.reduce((n, x) => n + x.periods, 0);
    }

    for (const s of keep) {
      cells.push({
        className: c.className,
        subjectName: s.subjectName,
        periodsPerWeek: s.periods,
        /**
         * One a day is the friendly default — and it must not be smaller than
         * the week arithmetically requires.
         *
         * Six periods a week at one a day needs SIX days. In a five-day week
         * that pair is impossible: Feasibility Check 3 refuses it outright
         * ("6 periods/week need at least 6 working days, but only 5 are
         * available"), and no amount of extra staff fixes it, because it is a
         * property of the curriculum row rather than of who teaches it.
         *
         * So the floor is `ceil(periods / days)`, and the default only applies
         * above it. This was found by the feasibility engine refusing a school
         * this very suggester had just proposed.
         */
        maxPerDay: Math.max(1, Math.ceil(s.periods / days)),
      });
    }
    totals.push({ className: c.className, total, capacity, over: total > capacity });
  }

  return { cells, totals, dropped };
}

/** The proposed curriculum, as an importer sheet. */
export function curriculumSheets(plan: CurriculumPlan, academicYear: string): RawSheet[] {
  if (plan.cells.length === 0) return [];
  const rows = plan.cells.map((c) => ({
    "Class Name": c.className,
    "Academic Year": academicYear,
    "Subject Name": c.subjectName,
    "Periods/Week": c.periodsPerWeek,
    "Max Periods/Day": c.maxPerDay,
  }));
  return [{
    name: "Curriculum",
    headers: Object.keys(rows[0]),
    rows: rows.map((cells, i) => ({ row: i + 2, cells })),
  }];
}

// ────────────────────────────────────────────────────────────── teachers

/**
 * Initials from a name, with the collision made visible.
 *
 * "Anil Yadav" → AY. A school with an Ajay Yadav gets AY2 — proposed in the
 * cell, where somebody can pick something better, rather than enforced by a
 * unique index that fails at three in the morning. Initials are a convenience
 * for narrow columns, not an identifier; `employee_code` is the identifier.
 */
export function proposeInitials(name: string, taken: Set<string>): string {
  const parts = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  const base =
    parts.length === 0 ? "?" :
    parts.length === 1 ? parts[0].slice(0, 2).toUpperCase() :
    (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();

  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return base;
}

/** Claim a proposal so the next row cannot be handed the same one. */
function addTo(taken: Set<string>, value: string): string {
  taken.add(value);
  return value;
}

/**
 * The initials each teacher will be known by — one per row, in list order.
 *
 * Uniqueness is a property of the LIST, not of a row: two Yadavs both propose
 * `AY`, and `teachers.initials` is unique per school. So the set has to be
 * built across the whole staff list, which is why this cannot be a per-row
 * helper and why the answer depends on the order it is given.
 *
 * Extracted because two places need it and they must agree. `teacherSheets`
 * mints them at commit; the §27 Allocation grid shows them in every cell. If
 * the grid derived its own, it would display `AY` for somebody the importer
 * then stored as `AY2` — a small lie that only shows up when a school looks
 * for a teacher by the initials it was shown.
 *
 * A teacher who already HAS initials keeps them, and theirs are claimed first
 * so nobody else is handed the same.
 */
export function assignInitials(teachers: TeacherAnswer[]): string[] {
  const taken = new Set(
    (teachers ?? []).map((t) => t.initials?.trim()).filter((x): x is string => !!x),
  );
  return (teachers ?? []).map(
    (t) => t.initials?.trim() || addTo(taken, proposeInitials(t.name, taken)),
  );
}

// ─────────────────────────────────────────────────────────── teachers → sheets

export interface TeacherAnswer {
  name: string;
  employeeCode?: string;
  initials?: string;
  gender?: "male" | "female" | "other" | "";
  email?: string;
  /** Subject names this person teaches. The input to the mapping step. */
  subjects: string[];
  /** Which wing they belong to. Blank means every wing. */
  wing?: string;
  /**
   * §27.9 — the classes this teacher actually takes, by ladder name.
   *
   * A narrower statement than `wing`, and where both are present this wins:
   * "Primary" is a shorthand for "every class in Primary", and somebody who
   * has gone to the trouble of naming Class 1 and Class 2 has said something
   * more specific than the shorthand.
   *
   * **Absent or empty means NOT STATED, never "no classes"** (invariant 7) —
   * it falls back to the wing, which is what every school had before this
   * existed. That direction matters: read the other way, every teacher in every
   * existing school would become eligible for nothing and no school would
   * generate.
   */
  classes?: string[];
  /**
   * §26.5 — anything the school wants to say about this teacher, in words.
   *
   * The guided setup COLLECTS it and never evaluates it: doing so at commit
   * would be one model call per teacher, 122 of them for the reference school,
   * to answer a question nobody has asked yet. It arrives as `pending` and is
   * checked deliberately from the Teachers screen.
   */
  specialInstruction?: string;
  maxPeriodsPerDay?: number;
  /**
   * §20's floor: a day is either free, or carries at least this many periods.
   *
   * Defaulted to ZERO by the guided setup, deliberately — the application's own
   * default is 3, which is right for a school that chose it and hostile as a
   * silent imposition. A one-subject teacher with 13 periods a week and a
   * floor AND ceiling of 3 has no whole number of days that works, and
   * Readiness refuses the school for a rule nobody asked for. Step 11 offers
   * it as a setting, where it is a decision rather than a surprise.
   */
  minPeriodsPerDay?: number;
  maxPeriodsPerWeek?: number;
  maxConsecutivePeriodsPerDay?: number | null;
  canSubstitute?: boolean;
  employmentType?: "permanent" | "adhoc" | "guest";
}

const sheet = (name: string, rows: Array<Record<string, unknown>>): RawSheet => ({
  name,
  headers: rows.length === 0 ? [] : Object.keys(rows[0]),
  rows: rows.map((cells, i) => ({ row: i + 2, cells })),
});

export function subjectSheets(subjects: SubjectAnswer[]): RawSheet[] {
  if (subjects.length === 0) return [];
  return [sheet("Subjects", subjects.map((s) => {
    // §26.2 — a field the admin never touched is filled from the classifier
    // here, at the point of commit, rather than being written into the draft
    // when the row was created. The difference matters on a resumed setup:
    // renaming "Sports" to "Games" then picks up the Games rules, where a value
    // baked in at creation would keep Sports' and nobody would know why.
    const d = defaultsFor(s.name);
    return {
      "Subject Name": s.name,
      Code: s.code ?? "",
      Category: (s.category ?? d.category) === "co_scholastic" ? "Co-scholastic" : "Scholastic",
      Priority: s.priority ?? d.priority,
      "Lunch Rule": LUNCH_LABEL[s.lunchRule ?? d.lunchRule],
      "Gap After Lunch": (s.gapAfterLunch ?? d.gapAfterLunch) ? "Yes" : "No",
      "Is Lab": s.isLab ? "Yes" : "No",
      "Requires Double Period": s.requiresDoublePeriod ? "Yes" : "No",
    };
  }))];
}

/**
 * Teachers, with an employee code minted where the school has none.
 *
 * The code is the identifier — initials are a convenience for narrow columns —
 * so it has to exist and be stable. `T-001` upward is the obvious default, and
 * a school that already uses its own codes types them instead.
 */
export function teacherSheets(teachers: TeacherAnswer[], wings: WingAnswer[]): RawSheet[] {
  if (teachers.length === 0) return [];
  const { classes } = planClasses(wings);
  const classesOfWing = (wing?: string) =>
    wing ? classes.filter((c) => c.wing === wing).map((c) => c.className) : [];

  // Initials come from `assignInitials`, which is also what the §27 Allocation
  // grid renders in every cell — one implementation, so the initials a school
  // is SHOWN are the initials it GETS. Anything typed on the Teachers step
  // wins; this fills in the rest rather than leaving the column blank.
  const initials = assignInitials(teachers);
  return [sheet("Teachers", teachers.map((t, i) => ({
    "Employee Code": t.employeeCode?.trim() || `T-${String(i + 1).padStart(3, "0")}`,
    Name: t.name,
    Initials: initials[i],
    Gender: t.gender ?? "",
    Email: t.email ?? "",
    "Max Periods/Day": t.maxPeriodsPerDay ?? 6,
    "Min Periods/Day": t.minPeriodsPerDay ?? 0,
    "Max Periods/Week": t.maxPeriodsPerWeek ?? 30,
    "Max Consecutive/Day": t.maxConsecutivePeriodsPerDay ?? "",
    "Takes Substitutions": t.canSubstitute === false ? "No" : "Yes",
    Engagement: t.employmentType ?? "permanent",
    // §18 teaching scope. A teacher pinned to one wing may only take that
    // wing's classes; one left unpinned is left unstated, which means "not
    // decided" rather than "nothing" — the same rule the importer holds to.
    // §27.9 — named classes win over the wing. Both say which classes, and
    // the more specific statement is the one somebody deliberately made;
    // neither is "not decided" rather than "nothing" (invariant 7).
    "Teaching Scope": (t.classes?.length ? t.classes : classesOfWing(t.wing)).join(", "),
    // §27.13 — recorded about the TEACHER, so the next wing's Teachers step
    // opens with it already filled in. It used to reach the database only as
    // whatever mappings the suggester happened to propose, which meant a
    // school setting up its second timetable was asked for it again.
    Subjects: (t.subjects ?? []).join(", "),
    "Special Instruction": t.specialInstruction ?? "",
    Active: "Yes",
  })))];
}

// ──────────────────────────────────────────────────────────── mappings

export interface MappingSuggestion {
  employeeCode: string;
  subjectName: string;
  classSections: string[];
  periodsPerWeek: number;
  /**
   * A fixed room for these periods. The `Room` column on the Subject Mapping
   * sheet has always existed; nothing WROTE it until the Allocation screen let
   * somebody choose one, so it stayed blank and §19 fell back to the home room.
   */
  room?: string;
  /**
   * §4.10 — one lesson taught to every listed section at once.
   *
   * Load-bearing for `costOf` in `./load`: a merged group is a SINGLE occupancy
   * event, so it costs its teacher `periodsPerWeek`, not `periodsPerWeek ×
   * sections`. That is the whole reason merging relieves a load without taking
   * a subject away from anybody, and multiplying regardless would make the
   * advisor's own merge suggestion appear to change nothing.
   */
  merged?: boolean;
}

export interface MappingPlan {
  mappings: MappingSuggestion[];
  classTeachers: Array<{ classSection: string; employeeCode: string }>;
  /** Curriculum the staff list cannot cover — named, never silently unmapped. */
  uncovered: Array<{ className: string; subjectName: string; reason: string }>;
  /** Per teacher: the weekly load this plan gives them, against their cap. */
  load: Array<{ employeeCode: string; name: string; periods: number; cap: number; over: boolean }>;
}

/**
 * Propose who teaches what.
 *
 * A greedy assignment, least-loaded first, and the greediness is deliberate:
 * this is a *proposal* a human corrects, not the solver. What it must get right
 * is the arithmetic that decides whether the school can generate at all —
 * every curriculum row covered, and nobody given more than their weekly cap.
 *
 * **Anything it cannot cover is NAMED.** Silently leaving a subject unmapped
 * produces a school that fails Check 1 later with no explanation of why, which
 * is exactly the "tell me what to fix" contract this product is built on.
 */
export function suggestMappings(
  wings: WingAnswer[],
  curriculum: CurriculumPlan,
  teachers: TeacherAnswer[],
  /**
   * Working days per wing. Load-bearing — see `reach` below.
   *
   * Defaulted to five so a caller predating this argument behaves as it did,
   * but a wing running six days genuinely can carry more.
   */
  daysByWing: Record<string, number> = {},
): MappingPlan {
  const { classes } = planClasses(wings);
  const byName = new Map(classes.map((c) => [c.className, c]));

  const staff = teachers.map((t, i) => ({
    code: t.employeeCode?.trim() || `T-${String(i + 1).padStart(3, "0")}`,
    name: t.name,
    subjects: new Set(t.subjects.map((s) => s.toLowerCase())),
    wing: t.wing,
    /** §27.9 — the classes they were declared for. Empty means "not stated". */
    classes: new Set((t.classes ?? []).map((c) => c.toLowerCase())),
    cap: t.maxPeriodsPerWeek ?? 30,
    used: 0,
    /**
     * DAILY REACH: the sum of the per-day caps of everything assigned to them.
     *
     * The constraint a weekly cap alone misses, and the one Feasibility Check 3
     * catches later with *"24 periods/week need at least 6 working days, but
     * only 5 are available"*. A teacher of one subject whose classes allow one
     * period a day can teach at most one period per section per day — so their
     * real weekly ceiling is `reach × days`, not `maxPeriodsPerWeek`.
     *
     * Assigning to the weekly cap alone produces a school that looks fully
     * staffed and cannot be timetabled: the worst kind of proposal, because it
     * fails much later and somewhere else.
     */
    reach: 0,
    sections: [] as string[],
    guest: t.employmentType === "guest",
  }));

  const mappings: MappingSuggestion[] = [];
  const uncovered: MappingPlan["uncovered"] = [];

  // Heaviest first: a 7-period subject is harder to place inside a cap than a
  // 1-period one, so it should get its pick of the teachers with room.
  const cells = [...curriculum.cells].sort((a, b) => b.periodsPerWeek - a.periodsPerWeek);

  for (const cell of cells) {
    const cls = byName.get(cell.className);
    if (!cls) continue;
    for (const section of cls.sections) {
      const label = `${cls.className}-${section}`;
      const days = daysByWing[cls.wing] ?? 5;
      const eligible = staff.filter(
        (s) =>
          !s.guest &&                                    // §18: guests are not curriculum
          s.subjects.has(cell.subjectName.toLowerCase()) &&
          // §27.9: the classes they were declared for, if any. Checked BEFORE
          // the wing, and instead of it — naming classes is the more specific
          // statement, and a teacher scoped to Class 1-2 of a wing must not be
          // handed Class 5 just because the wing matches.
          (s.classes.size > 0
            ? s.classes.has(cell.className.toLowerCase())
            : (!s.wing || s.wing === cls.wing)) &&      // §18: scope
          s.used + cell.periodsPerWeek <= s.cap &&       // Check 2: weekly capacity
          // Check 3: daily distribution. The most they could teach in a week
          // even with every day full — see `reach` above.
          s.used + cell.periodsPerWeek <= (s.reach + cell.maxPerDay) * days,
      );
      if (eligible.length === 0) {
        const anyTeaches = staff.some((s) => s.subjects.has(cell.subjectName.toLowerCase()));
        const anyInWing = staff.some(
          (s) => !s.guest && s.subjects.has(cell.subjectName.toLowerCase()) &&
            (s.classes.size > 0
              ? s.classes.has(cell.className.toLowerCase())
              : (!s.wing || s.wing === cls.wing)),
        );
        uncovered.push({
          className: label,
          subjectName: cell.subjectName,
          // Three different reasons with three different fixes. Telling
          // somebody to hire when the real problem is a short week is unhelpful.
          reason: !anyTeaches
            ? `Nobody on the staff list teaches ${cell.subjectName}.`
            : !anyInWing
              // Named separately from the wing case: "nobody teaches it here"
              // and "nobody is scoped to THIS CLASS" have different fixes, and
              // being told to hire when the real answer is a tick box is the
              // kind of advice that wastes a morning.
              ? `Nobody who teaches ${cell.subjectName} is scoped to ${cell.className}.`
              : `Everybody who teaches ${cell.subjectName} in ${cls.wing} is at their limit — either their weekly cap, or as much as ${days} days can hold at ${cell.maxPerDay} period(s) a day per class.`,
        });
        continue;
      }
      const pick = eligible.reduce((a, b) => (b.used < a.used ? b : a));
      pick.used += cell.periodsPerWeek;
      pick.reach += cell.maxPerDay;
      pick.sections.push(label);
      mappings.push({
        employeeCode: pick.code,
        subjectName: cell.subjectName,
        classSections: [label],
        periodsPerWeek: cell.periodsPerWeek,
      });
    }
  }

  // One class teacher per section: somebody who already teaches it, so the
  // §4.7 first-period rule has a real lesson to attach to.
  const classTeachers: MappingPlan["classTeachers"] = [];
  const taken = new Set<string>();
  for (const c of classes) {
    for (const section of c.sections) {
      const label = `${c.className}-${section}`;
      const candidate =
        staff.find((s) => s.sections.includes(label) && !taken.has(s.code)) ??
        staff.find((s) => s.sections.includes(label));
      if (!candidate) continue;
      taken.add(candidate.code);
      classTeachers.push({ classSection: label, employeeCode: candidate.code });
    }
  }

  return {
    mappings,
    classTeachers,
    uncovered,
    load: staff.map((s) => ({
      employeeCode: s.code, name: s.name, periods: s.used, cap: s.cap, over: s.used > s.cap,
    })),
  };
}

/**
 * Which curriculum rows nobody is teaching — for a mapping list a HUMAN edited.
 *
 * `suggestMappings` names its own gaps as it builds, but the moment the mapping
 * screen lets somebody reassign or delete a row that answer is stale. The rule
 * is the same either way — every subject, in every section that studies it,
 * needs a teacher — so it is stated once here and used by both the screen (live,
 * as you edit) and the commit (as the issue list). Two copies of this rule would
 * eventually disagree, and the disagreement would read as "the screen said it
 * was fine".
 *
 * Load is deliberately NOT re-checked here: the §16 importer runs
 * `assertWithinWeek` on every row it writes, and a second opinion in the browser
 * that the server then contradicts is worse than no opinion.
 */
export function coverageGaps(
  wings: WingAnswer[],
  curriculum: CurriculumPlan,
  mappings: MappingSuggestion[],
): Array<{ className: string; subjectName: string; reason: string }> {
  const { classes } = planClasses(wings);
  const byName = new Map(classes.map((c) => [c.className, c]));
  const covered = new Set<string>();
  for (const m of mappings) {
    for (const cs of m.classSections) covered.add(`${cs.trim().toLowerCase()}|${m.subjectName.toLowerCase()}`);
  }

  const gaps: Array<{ className: string; subjectName: string; reason: string }> = [];
  for (const cell of curriculum.cells) {
    const cls = byName.get(cell.className);
    if (!cls) continue;
    for (const section of cls.sections) {
      const label = `${cls.className}-${section}`;
      if (covered.has(`${label.toLowerCase()}|${cell.subjectName.toLowerCase()}`)) continue;
      gaps.push({
        className: label,
        subjectName: cell.subjectName,
        reason: `${label} studies ${cell.subjectName} for ${cell.periodsPerWeek} periods a week and nobody is assigned to teach it.`,
      });
    }
  }
  return gaps;
}

/**
 * Take each mapping's periods/week from the CURRICULUM, which is where that
 * number is decided.
 *
 * A mapping row carries two different kinds of fact. Who teaches it is a
 * decision somebody makes on step 10. How many periods it runs for is not — it
 * is `class_subjects.periods_per_week`, decided on step 9, and a mapping is
 * merely quoting it. Storing the quote and never refreshing it means going back
 * to step 9 to give English an extra period leaves step 10 still saying seven,
 * and Readiness then reports *"ZZGS English in Class 3-A has only 7 of 8
 * periods/week mapped to a teacher"* — a blocker whose cause is two screens
 * away from where it is reported.
 *
 * So the quote is refreshed at every use, and the decision is left alone.
 */
export function withCurriculumPeriods(
  curriculum: CurriculumPlan,
  mappings: MappingSuggestion[],
): MappingSuggestion[] {
  const byKey = new Map(
    curriculum.cells.map((c) => [`${c.className.toLowerCase()}|${c.subjectName.toLowerCase()}`, c.periodsPerWeek]),
  );
  return mappings.map((m) => {
    // "Class 3-A" → "Class 3". Only the last segment is a section, so a class
    // whose own name contains a hyphen ("Pre-Nursery") survives intact.
    const className = (m.classSections[0] ?? "").trim().replace(/-[^-]+$/, "");
    const periods = byKey.get(`${className.toLowerCase()}|${m.subjectName.toLowerCase()}`);
    return periods === undefined || periods === m.periodsPerWeek ? m : { ...m, periodsPerWeek: periods };
  });
}

export function mappingSheets(plan: MappingPlan): RawSheet[] {
  const out: RawSheet[] = [];
  if (plan.mappings.length > 0) {
    out.push(sheet("Subject Mapping", plan.mappings.map((m) => ({
      "Teacher Employee Code": m.employeeCode,
      Subject: m.subjectName,
      "Class-Sections": m.classSections.join(", "),
      "Periods/Week": m.periodsPerWeek,
      Room: m.room ?? "",
      // "Yes" needs two or more sections to mean anything, and the importer
      // refuses a merged group of one — so the flag is written only where it is
      // true of the row rather than trusted from whatever set it.
      Merged: m.merged && m.classSections.length > 1 ? "Yes" : "No",
    }))));
  }
  if (plan.classTeachers.length > 0) {
    out.push(sheet("Class Teachers", plan.classTeachers.map((c) => ({
      "Class-Section": c.classSection,
      "Teacher Employee Code": c.employeeCode,
    }))));
  }
  return out;
}
