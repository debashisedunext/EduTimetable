/**
 * The worker process (compose service `worker`). Runs the Phase 2 solver as a
 * background job — CPU-heavy generation never touches the API's request path
 * (CLAUDE.md invariant). Progress streams to the api via BullMQ QueueEvents,
 * which the EventsGateway forwards to Socket.IO clients.
 */
import { Worker, type Job } from "bullmq";
import Redis from "ioredis";
import { PrismaClient } from "@prisma/client";
import {
  buildTeacherCtx,
  buildVariables,
  DEFAULT_WEIGHTS,
  describeImprovement,
  runFeasibility,
  scoreTimetable,
  solveTimetable,
  type ObjectiveWeights,
} from "@edutimetable/shared";
import { buildSolverInput } from "./solver/input";
import { TenantContextService } from "./tenant/tenant-context.service";
import { withSchoolScope } from "./prisma/school-scope";
import { StandaloneTenantClients } from "./prisma/standalone-tenant-client";
import { configSlotsKeyPattern, scanDel } from "./redis/cache-keys";
import { withFairScheduling } from "./solver/fair-scheduling";
import { optimizeWithCpSat, type OptimizeOutcome } from "./solver/optimize";
import { writeDraftSlots } from "./solver/writer";

const connection = {
  host: process.env.REDIS_HOST ?? "redis",
  port: Number(process.env.REDIS_PORT ?? 6379),
};
// The worker runs the same school-scoping extension as the API (9.1 / §17).
// TenantContextService has no Nest dependencies, so it is simply instantiated
// here; each job opens a context from its own job data before touching the DB.
const tenant = new TenantContextService();
const sharedBase = new PrismaClient();
const sharedScoped = withSchoolScope(sharedBase, tenant);
// A school with its own database gets its own connection here too (9.4 / §17.5).
// Without this, a dedicated tenant's generation would write its slots into the
// shared database, scoped to a school id that means something else there.
const tenants = new StandaloneTenantClients(sharedBase, sharedScoped, tenant);
const redis = new Redis(connection);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How many jobs may run at once, across all schools (§17.7). */
const SOLVER_CONCURRENCY = Number(process.env.SOLVER_CONCURRENCY ?? 3);

/**
 * How long BullMQ treats a running job's lock as valid.
 *
 * The default is 30 seconds, renewed halfway through by a timer — and that
 * assumption does not hold here. Generation is **synchronous CPU work**: a
 * solve running its full `budgetMs` blocks the event loop, so the renewal timer
 * never fires and the lock expires underneath a job that is working perfectly
 * well. BullMQ then treats it as stalled and may hand it to another worker
 * while the first is still solving — duplicate generation, or a job that
 * reports neither completed nor failed to the Generate screen ("Missing lock
 * for job N"). Raising `SOLVER_CONCURRENCY` above one in 9.9 made this more
 * likely, not less: three CPU-bound solves timesharing one loop each take
 * roughly three times as long in wall-clock.
 *
 * Five minutes covers a 30s solve plus a 120s CP-SAT pass plus writes, with
 * contention. The asymmetry justifies erring long: too long only delays the
 * retry of a job whose worker really did die, while too short duplicates work
 * that is still running.
 *
 * It stays below the per-school slot TTL in `fair-scheduling.ts` (15 minutes),
 * so a job always loses its BullMQ lock before it loses its school's slot.
 */
const LOCK_DURATION_MS = Number(process.env.WORKER_LOCK_DURATION_MS ?? 300_000);
const workerOptions = {
  connection,
  concurrency: SOLVER_CONCURRENCY,
  lockDuration: LOCK_DURATION_MS,
  // Checking for stalled jobs more often than the lock can expire just burns
  // Redis round-trips.
  stalledInterval: LOCK_DURATION_MS,
};

// Phase 0 pipeline demo — kept as the smoke path for the queue infrastructure,
// which now includes fair scheduling, so it runs under the same rules.
new Worker(
  "demo",
  withFairScheduling(
    redis,
    "demo",
    async (job) => {
      const steps: number = job.data.steps ?? 20;
      for (let i = 1; i <= steps; i++) {
        await sleep(150);
        await job.updateProgress(Math.round((i / steps) * 100));
      }
      return { placed: steps };
    },
    (job, schoolId) => console.log(`[worker] demo job ${job.id} deferred — school ${schoolId} already has one running`),
  ),
  workerOptions,
);

new Worker(
  "solver",
  withFairScheduling(
    redis,
    "solver",
    async (job) => {
    const configId: number = job.data.configId;
    const schoolId: unknown = job.data.schoolId;
    if (typeof schoolId !== "number") {
      // Refusing beats guessing: without a school the draft slots this job
      // writes could not be attributed, and its progress events could not be
      // addressed to anyone (9.1 / §17).
      throw new Error(
        `Solver job ${job.id} carries no schoolId — re-queue it from the Generate screen`,
      );
    }
    const tenantId: number | null =
      typeof job.data.tenantId === "number" ? job.data.tenantId : null;
    console.log(
      `[worker] solver job ${job.id}: config ${configId} (school ${schoolId}` +
        `${tenantId !== null ? `, tenant ${tenantId}` : ""})`,
    );
    const prisma = await tenants.scopedFor(tenantId);
    return tenant.runAs(
      { schoolId, tenantId, client: prisma, origin: `solver job ${job.id}` },
      () => solve(job, configId, schoolId, tenantId, prisma),
    );
    },
    (job, schoolId) =>
      console.log(
        `[worker] solver job ${job.id} deferred — school ${schoolId} already has a generation running`,
      ),
  ),
  // Concurrency above one so a long generation in one school does not block
  // every other school behind it; the per-school cap inside withFairScheduling
  // stops one school taking every slot (§17.7).
  workerOptions,
);

async function solve(
  job: Job,
  configId: number,
  schoolId: number,
  tenantId: number | null,
  prisma: PrismaClient,
) {
  // §22 Phase 17 — the generation writes into ONE named draft. The id rides on
  // the job so the worker never has to guess which; a job queued before Phase
  // 17 carries none and falls back to the config's current draft.
  //
  // Resolved BEFORE the solver input is built: the input carries the locked
  // cells the search must treat as fixed, and those belong to this draft
  // alone. Built without it, generating Draft #4 would pin Draft #2's cells.
  const draftId: number | null =
    typeof job.data.draftId === "number"
      ? job.data.draftId
      : (
          await prisma.timetableDraft.findFirst({
            where: { timetableConfigId: configId, status: "draft" },
            orderBy: { draftNo: "desc" },
            select: { id: true },
          })
        )?.id ?? null;
  const input = await buildSolverInput(prisma, configId, draftId);

  // Phase A gate (§1 design thesis): the solver only runs on proven-feasible input.
  const feasibility = runFeasibility(input.snapshot);
  if (!feasibility.ready) {
    throw new Error(
      `Feasibility gate failed: ${feasibility.blockers.length} blocker(s) — fix them on the Readiness Dashboard first`,
    );
  }

  let lastReported = 0;
  const result = solveTimetable(input, {
    budgetMs: 30_000,
    onProgress: (placed, total) => {
      if (placed - lastReported >= Math.max(1, Math.floor(total / 50)) || placed === total) {
        lastReported = placed;
        void job.updateProgress({ placed, total });
      }
    },
  });

  // ---- Phase 6 (§5.6): optional soft-optimization pass ----
  // The fast result above is already valid and is the floor: CP-SAT's answer
  // is adopted only if it verifies AND scores better (task 6.3 parity gate).
  const mode: "fast" | "optimized" = job.data.mode === "optimized" ? "optimized" : "fast";
  const weights: ObjectiveWeights = { ...DEFAULT_WEIGHTS, ...(job.data.weights ?? {}) };
  const variables = buildVariables(input, buildTeacherCtx(input));
  let placements = result.placements;
  const before = scoreTimetable(input, placements, variables, weights);
  let optimization: OptimizeOutcome = {
    attempted: false,
    adopted: false,
    status: "SKIPPED",
    detail: "fast mode — feasibility only",
  };

  if (mode === "optimized" && result.unplaced.length === 0) {
    void job.updateProgress({ placed: result.placements.length, total: result.totalVariables, phase: "optimizing" });
    optimization = await optimizeWithCpSat(
      input,
      variables,
      placements,
      weights,
      Number(job.data.optimizeBudgetSec ?? 30),
    );
    if (optimization.adopted && optimization.placements) placements = optimization.placements;
  } else if (mode === "optimized") {
    optimization = {
      attempted: false,
      adopted: false,
      status: "SKIPPED",
      detail: `${result.unplaced.length} variable(s) unplaced — optimizing a partial timetable would hide the gap`,
    };
  }
  const after = scoreTimetable(input, placements, variables, weights);

  const { rows } = await writeDraftSlots(prisma, configId, placements, schoolId, draftId);
  // §22: the payload is cached per draft (`…:draft:d7`) and the board context
  // per draft too, so deleting one fixed key would leave the week the solver
  // just rewrote on screen. The worker has no Nest context, so it sweeps the
  // config's prefix directly — the same shape `CacheKeysService` uses.
  await scanDel(redis, configSlotsKeyPattern(schoolId, configId));

  // §22.3 — stamp the numbers the school will compare drafts on, straight
  // after the write. Reading them off the registry row is what keeps the Draft
  // Board off a 2,000-row count per render (§14).
  if (draftId !== null) {
    const placed = await prisma.timetableSlot.count({
      where: { timetableConfigId: configId, status: "draft", draftId, classSectionId: { not: null }, source: { not: "extra" } },
    });
    const required = runFeasibility(input.snapshot).stats.totalRequiredSlots;
    await prisma.timetableDraft.update({
      where: { id: draftId },
      data: {
        requiredLessons: required,
        placedLessons: placed,
        generationPct: required > 0 ? Math.round((placed / required) * 10000) / 100 : 0,
        // 0 by construction right after a solve unless something went unplaced
        errorCount: result.unplaced.length,
        // §20 short teacher-days — advisory, never blocking
        warningCount: result.stats.shortTeacherDays ?? 0,
        lockedCount: await prisma.timetableSlot.count({
          where: { timetableConfigId: configId, status: "draft", draftId, isLocked: true },
        }),
        manualCount: 0,
        solverStats: result.stats as never,
        generatedAt: new Date(),
      },
    });
  }

  const summary = {
    configId,
    draftId,
    // echoed so the API's solver-completed listener knows whose school to
    // open a context for — and which database to open it against — before
    // writing the notification (9.1 / §17, 9.4 / §17.5)
    schoolId,
    tenantId,
    // echoed for the §9 solver-completed notification (NotificationsService)
    userId: job.data.userId ?? undefined,
    mode,
    placements: placements.length,
    total: result.totalVariables,
    placedVariables: placements.length,
    totalVariables: result.totalVariables,
    slotRows: rows,
    unplaced: result.unplaced,
    stats: result.stats,
    objective: {
      weights,
      before,
      after,
      improvement: describeImprovement(before, after),
      optimization,
    },
  };
  console.log(
    `[worker] solver job ${job.id} done [${mode}]: ${summary.placedVariables}/${summary.totalVariables} vars, ${rows} slot rows, ${result.unplaced.length} unplaced, ${result.stats.shortTeacherDays} short teacher-days (consolidation cleared ${result.stats.consolidatedDays}), ${result.stats.ms}ms · objective ${before.weighted}→${after.weighted} (${optimization.detail})`,
  );
  return summary;
}

console.log(
  `[worker] listening on queues 'demo', 'solver' — concurrency ${SOLVER_CONCURRENCY}, one job per school at a time`,
);
