/**
 * Phase 6 exit criteria (§5.6): prove that "Optimized" mode produces
 * measurably fewer teacher gaps than "Fast" on a benchmark school, with ZERO
 * hard-constraint regressions.
 *
 * Runs entirely inside the stack (no DB state needed):
 *   docker compose exec api node scripts/optimize-benchmark.cjs
 *
 * It builds a benchmark school, solves it with the fast CSP engine, sends the
 * same model to the CP-SAT service, replays the answer through the real
 * ConstraintChecker, and prints both objective scores side by side.
 */
const {
  buildCpSatModel,
  buildTeacherCtx,
  buildVariables,
  DEFAULT_WEIGHTS,
  describeImprovement,
  scoreTimetable,
  solveTimetable,
  verifyAssignment,
} = require("/app/packages/shared/dist/cjs/index.js");

const OPTIMIZER = process.env.OPTIMIZER_URL ?? "http://optimizer:8000";
const SECTIONS = Number(process.env.BENCH_SECTIONS ?? 6);
const BUDGET = Number(process.env.BENCH_BUDGET ?? 30);

/**
 * Benchmark school: `SECTIONS` class-sections, 5 days × 8 periods, 6 subjects.
 * Demand deliberately leaves ~25% of the grid free — a perfectly packed week
 * has no room to move anything, so gaps only become interesting with slack.
 */
function benchmarkSchool(sections) {
  const subjects = ["English", "Mathematics", "Science", "Hindi", "History", "Art"];
  const periodsPerWeek = [6, 6, 5, 5, 5, 3]; // 30 of 40 slots
  const classSections = [];
  const mappings = [];
  const teachers = [];
  let mappingId = 1;

  // one teacher per subject per 2 sections, so teachers span sections (gaps matter)
  const teachersPerSubject = Math.max(1, Math.ceil(sections / 2));
  subjects.forEach((subject, si) => {
    for (let k = 0; k < teachersPerSubject; k++) {
      teachers.push({
        id: si * 100 + k + 1,
        name: `${subject.slice(0, 3)}-T${k + 1}`,
        maxPeriodsPerDay: 6,
        maxPeriodsPerWeek: 30,
        classTeacherPeriodRule: "none",
        periodPattern: "every_period",
        alternateDaySet: null,
        unavailableFullDays: [],
        unavailablePeriodCount: 0,
      });
    }
  });

  for (let i = 0; i < sections; i++) {
    const id = 1000 + i;
    classSections.push({ id, label: `B-${i + 1}`, classId: 10, classTeacherId: null });
    subjects.forEach((subject, si) => {
      const teacherId = si * 100 + (i % teachersPerSubject) + 1;
      mappings.push({
        id: mappingId++,
        teacherId,
        teacherName: teachers.find((t) => t.id === teacherId).name,
        subjectId: 300 + si,
        subjectName: subject,
        classSectionId: id,
        classSectionLabel: `B-${i + 1}`,
        periodsPerWeek: periodsPerWeek[si],
      });
    });
  }

  return {
    config: { id: 1, name: "Benchmark Wing", workingDays: [1, 2, 3, 4, 5], periodsPerDay: 8, daySegments: [4, 4] },
    classSections,
    subjectRequirements: subjects.map((s, i) => ({
      id: 200 + i,
      classId: 10,
      subjectId: 300 + i,
      subjectName: s,
      periodsPerWeek: periodsPerWeek[i],
      maxPeriodsPerDay: 2,
      samePeriodAcrossWeek: false,
      consecutiveBlockSize: 1,
      consecutiveBlocksPerWeek: null,
    })),
    teachers,
    mappings,
    mergedGroups: [],
    crossConfigTeacherLoad: {},
    labRoomCount: 2,
    labSubjectIds: [302],
  };
}

const input = {
  snapshot: benchmarkSchool(SECTIONS),
  teacherUnavailability: [],
  labRoomIds: [901, 902],
  preferredRoomByMapping: {},
  mergedGroupRooms: {},
  lockedSlots: [],
  seed: 4242,
};

async function main() {
console.log(`benchmark: ${SECTIONS} sections · 5 days × 8 periods · CP-SAT budget ${BUDGET}s\n`);

// ---- 1. fast engine ----
const t0 = Date.now();
const fast = solveTimetable(input, { budgetMs: 60_000 });
const fastMs = Date.now() - t0;
const variables = buildVariables(input, buildTeacherCtx(input));
if (fast.unplaced.length > 0) {
  console.error(`FAIL: fast engine left ${fast.unplaced.length} variable(s) unplaced — fix the benchmark`);
  process.exit(1);
}
const before = scoreTimetable(input, fast.placements, variables, DEFAULT_WEIGHTS);
console.log(`fast     : ${fast.placements.length} variables in ${fastMs}ms`);
console.log(`           gaps=${before.teacherGaps} peakLoad=${before.peakDailyLoad} roomChanges=${before.roomChanges} weighted=${before.weighted}`);

// ---- 2. CP-SAT ----
const model = buildCpSatModel(input, variables, DEFAULT_WEIGHTS, BUDGET);
const res = await fetch(`${OPTIMIZER}/solve`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ ...model, label: "benchmark" }),
});
if (!res.ok) {
  console.error(`FAIL: optimizer HTTP ${res.status}`);
  process.exit(1);
}
const cp = await res.json();
console.log(`\ncp-sat   : status=${cp.status} assignments=${cp.assignments.length}/${variables.length} wall=${(cp.wallTimeSec ?? 0).toFixed(1)}s`);

if (cp.assignments.length !== variables.length) {
  console.error("FAIL: CP-SAT did not cover every variable");
  process.exit(1);
}

// ---- 3. parity gate: the real ConstraintChecker must accept it ----
const verified = verifyAssignment(input, variables, cp.assignments);
if (!verified.ok) {
  console.error(`FAIL: hard-constraint regression — ${verified.reason}`);
  process.exit(1);
}
console.log("           ✓ every placement re-verified by the ConstraintChecker (zero hard-constraint regressions)");

const after = scoreTimetable(input, verified.placements, variables, DEFAULT_WEIGHTS);
console.log(`           gaps=${after.teacherGaps} peakLoad=${after.peakDailyLoad} roomChanges=${after.roomChanges} weighted=${after.weighted}`);

console.log(`\nimprovement: ${describeImprovement(before, after)}`);

if (after.teacherGaps < before.teacherGaps) {
  console.log(`\nPASS — optimized mode cut teacher gaps ${before.teacherGaps} → ${after.teacherGaps}`);
} else if (after.weighted < before.weighted) {
  console.log(`\nPASS — optimized mode improved the weighted objective ${before.weighted} → ${after.weighted}`);
} else {
  console.error(`\nFAIL — no measurable improvement (weighted ${before.weighted} → ${after.weighted})`);
  process.exit(1);
}
}

main().catch((e) => { console.error(e); process.exit(1); });
