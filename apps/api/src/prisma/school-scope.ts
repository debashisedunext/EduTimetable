/**
 * Phase 9.1 (§17) — the school-scoping Prisma extension.
 *
 * This is the single scoping module for *row ownership*, the same way
 * ScopeService (§15.3) is the single scoping module for *user visibility*.
 * It replaces what would otherwise be a schoolId filter hand-added to 75
 * `where: { id }` call sites — the kind of change that is wrong the first time
 * someone adds a 76th.
 *
 * Every one of the 30 models carries `school_id` (9.1's migration denormalized
 * it onto the 16 that previously reached their school only through a parent),
 * so the extension applies uniformly to `$allModels` with no per-model map to
 * fall out of date.
 *
 * What it does, per operation:
 *   reads with a flexible where  → AND the school in
 *   findUnique / findUniqueOrThrow → re-issued as findFirst with the school
 *       ANDed in, because Prisma's findUnique only accepts unique fields. A
 *       cross-school id therefore returns null / throws, never the row.
 *   create / createMany / upsert.create → school stamped into the payload,
 *       recursively through nested relation writes
 *   update / delete / upsert → ownership pre-checked, then the original runs
 *   updateMany / deleteMany / count / aggregate / groupBy → AND the school in
 *
 * Outside a tenant context (schoolId null) it is a pass-through: SSO
 * provisioning resolves the user's school as its *input* and cannot already be
 * scoped to it, and the same is true of seeds, migrations and the health probe.
 * Those paths are expected to announce themselves via runUnscoped(); anything
 * else touching the database with no context is a wiring bug, and logs one.
 */
import { BadRequestException, Logger, NotFoundException } from "@nestjs/common";
import { Prisma, PrismaClient } from "@prisma/client";
import type { TenantContextService } from "../tenant/tenant-context.service";

const logger = new Logger("SchoolScope");

/**
 * The tenant root (9.2). `schools` is the one table that does not *have* a
 * school_id — it IS the school — so it is scoped by its own primary key, its
 * rows are never stamped, and it is skipped by the cross-school reference
 * check (a row's school_id is guarded by a real foreign key as of 9.2, and by
 * the stamping above that).
 */
const TENANT_ROOT = "School";

/**
 * Relation metadata, read from Prisma's own DMMF so it cannot drift from the
 * schema: for each model, which scalar columns are foreign keys and what they
 * point at, plus which relation fields carry nested writes and to which model.
 *
 * This exists because scoping the *rows* is not sufficient on its own. A write
 * stamped with school B can still name school A's class id:
 *
 *     POST /class-subjects { classId: <A's class>, subjectId: <B's subject> }
 *
 * lands a row owned by B that points into A's data. Scoped reads hide it from
 * A, so nothing looks wrong — but B's readiness and solver would then pull A's
 * class-section into B's timetable. Verifying every reference against the same
 * school closes it.
 */
interface ModelRefs {
  /** scalar FK column → the model it references (by `id`) */
  scalar: Array<{ field: string; target: string }>;
  /** relation field carrying nested writes → the model those rows belong to */
  nested: Map<string, string>;
}

function buildRefMap(): Map<string, ModelRefs> {
  const map = new Map<string, ModelRefs>();
  for (const model of Prisma.dmmf.datamodel.models) {
    const refs: ModelRefs = { scalar: [], nested: new Map() };
    for (const field of model.fields) {
      if (field.kind !== "object" || !field.relationName) continue;
      refs.nested.set(field.name, field.type);
      const from = field.relationFromFields ?? [];
      const to = field.relationToFields ?? [];
      // Only single-column FKs pointing at the parent's `id` — the only shape
      // this schema uses, and the only one that can be checked by id lookup.
      // The school_id → schools relation is not a cross-school reference to
       // check; it is the ownership column itself, and it has a real FK.
      if (field.type === TENANT_ROOT) continue;
      if (from.length === 1 && to.length === 1 && to[0] === "id") {
        refs.scalar.push({ field: from[0], target: field.type });
      }
    }
    map.set(model.name, refs);
  }
  return map;
}

/** Exported for the unit tests — the extension itself uses the module-level copy. */
export const REF_MAP = buildRefMap();

/** Operations whose `where` accepts arbitrary filters, so the school can be ANDed in. */
const FILTERABLE = new Set([
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "updateMany",
  "deleteMany",
  "count",
  "aggregate",
  "groupBy",
]);

/** Operations addressing exactly one row by a unique key. */
const BY_UNIQUE = new Set(["findUnique", "findUniqueOrThrow", "update", "delete", "upsert"]);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);

/** Model name (`TimetableSlot`) → client delegate key (`timetableSlot`). */
const delegateKey = (model: string) => model.charAt(0).toLowerCase() + model.slice(1);

/**
 * Rewrite a findUnique-style `where` into one findFirst accepts.
 *
 * Prisma addresses a compound unique through a synthetic key —
 * `{ schoolId_name: { schoolId, name } }` — which only the by-unique operations
 * understand; findFirst rejects it outright. Since every top-level object value
 * in a unique where IS a compound-unique group, flattening them into plain
 * field equality is exact, not a guess.
 */
export function flattenUniqueWhere(where: unknown): Record<string, unknown> {
  if (!isPlainObject(where)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(where)) {
    if (isPlainObject(value)) Object.assign(out, value);
    else out[key] = value;
  }
  return out;
}

/**
 * The predicate that ties a row to a school: its own `id` on the schools table,
 * `school_id` on every other (9.2).
 */
const ownershipOf = (model: string, schoolId: number) =>
  model === TENANT_ROOT ? { id: schoolId } : { schoolId };

/** AND the school into a where clause without clobbering a caller's own filters. */
export function scopeWhere(where: unknown, schoolId: number, model = ""): Record<string, unknown> {
  const own = ownershipOf(model, schoolId);
  if (!isPlainObject(where) || Object.keys(where).length === 0) return own;
  // AND rather than spread: a caller that already passed its own schoolId (the
  // masters controllers all do) keeps it, and a mismatch yields no rows —
  // which is the correct answer, not a silently widened query.
  return { AND: [where, own] };
}

/**
 * Stamp the school onto a write payload, following nested relation writes.
 *
 * Never called for the schools table itself — that row has no school_id; it is
 * the school (see TENANT_ROOT).
 * Needed because a nested `members: { create: [...] }` (merged teaching groups)
 * never reaches the extension as its own operation, and its rows are NOT NULL
 * on school_id like every other table.
 */
export function stampCreate<T>(node: T, schoolId: number): T {
  if (Array.isArray(node)) return node.map((n) => stampCreate(n, schoolId)) as unknown as T;
  if (!isPlainObject(node)) return node;

  const out: Record<string, unknown> = { ...node };
  if (out.schoolId === undefined) out.schoolId = schoolId;

  for (const [key, value] of Object.entries(out)) {
    if (!isPlainObject(value)) continue;
    const isRelationWrite =
      value.create !== undefined ||
      value.createMany !== undefined ||
      value.connectOrCreate !== undefined;
    if (!isRelationWrite) continue;

    const nested: Record<string, unknown> = { ...value };
    if (nested.create !== undefined) nested.create = stampCreate(nested.create, schoolId);
    if (isPlainObject(nested.createMany) && nested.createMany.data !== undefined) {
      nested.createMany = {
        ...nested.createMany,
        data: stampCreate(nested.createMany.data, schoolId),
      };
    }
    if (nested.connectOrCreate !== undefined) {
      const stampOne = (coc: unknown) =>
        isPlainObject(coc) && coc.create !== undefined
          ? { ...coc, create: stampCreate(coc.create, schoolId) }
          : coc;
      nested.connectOrCreate = Array.isArray(nested.connectOrCreate)
        ? nested.connectOrCreate.map(stampOne)
        : stampOne(nested.connectOrCreate);
    }
    out[key] = nested;
  }
  return out as unknown as T;
}

/**
 * Walk a write payload and gather every id it points at, grouped by the model
 * that id belongs to. Follows nested relation writes, so a merged group's
 * `members: { create: [{ classSectionId }] }` is checked as thoroughly as a
 * top-level column.
 */
export function collectReferences(
  model: string,
  node: unknown,
  acc: Map<string, Set<number>>,
): void {
  if (Array.isArray(node)) {
    for (const n of node) collectReferences(model, n, acc);
    return;
  }
  if (!isPlainObject(node)) return;
  const refs = REF_MAP.get(model);
  if (!refs) return;

  for (const { field, target } of refs.scalar) {
    const value = node[field];
    if (typeof value === "number") {
      if (!acc.has(target)) acc.set(target, new Set());
      acc.get(target)!.add(value);
    }
  }

  for (const [key, value] of Object.entries(node)) {
    const childModel = refs.nested.get(key);
    if (childModel === undefined || !isPlainObject(value)) continue;
    if (value.create !== undefined) collectReferences(childModel, value.create, acc);
    if (isPlainObject(value.createMany) && value.createMany.data !== undefined) {
      collectReferences(childModel, value.createMany.data, acc);
    }
    if (value.connectOrCreate !== undefined) {
      const each = Array.isArray(value.connectOrCreate) ? value.connectOrCreate : [value.connectOrCreate];
      for (const coc of each) {
        if (isPlainObject(coc) && coc.create !== undefined) collectReferences(childModel, coc.create, acc);
      }
    }
  }
}

/**
 * Wrap a PrismaClient so every query is filtered to the ambient school.
 *
 * `base` is the same connection, un-extended: the ownership and reference
 * checks below run through it so they cannot recurse back into this extension.
 */
export function withSchoolScope(base: PrismaClient, tenant: TenantContextService): PrismaClient {
  // Prisma's $allOperations is deliberately untyped across every model — there
  // is no generated type that spans all delegates — so the boundary is `any`
  // and each branch narrows what it touches.
  const delegate = (model: string): any => (base as any)[delegateKey(model)];

  /**
   * Refuse a write that points at another school's rows.
   *
   * The rule is "reject what is provably foreign", not "require proof of
   * ownership" — and the difference matters. These checks run on the base
   * client, so inside an interactive transaction they cannot see rows the
   * transaction itself has just created. The bulk import creates a class and
   * then a class-section referencing it in one transaction; demanding proof of
   * ownership would reject that legitimate write.
   *
   * Nothing is lost by the weaker rule: another school's row is by definition
   * already committed, so it is always visible and always caught. An id that
   * resolves to nothing is either being created in this same transaction —
   * legitimate, and it will be stamped with this school anyway — or genuinely
   * absent, which the real foreign key rejects.
   *
   * One batched lookup per referenced model, so a 240-row createMany costs a
   * handful of `id IN (…)` queries on the primary key, not one query per row.
   */
  async function assertNoForeignReferences(model: string, payload: unknown, schoolId: number) {
    const wanted = new Map<string, Set<number>>();
    collectReferences(model, payload, wanted);
    if (wanted.size === 0) return;

    await Promise.all(
      [...wanted].map(async ([target, ids]) => {
        const rows: Array<{ id: number; schoolId: number }> = await delegate(target).findMany({
          where: { id: { in: [...ids] } },
          select: { id: true, schoolId: true },
        });
        const foreign = rows.filter((r) => r.schoolId !== schoolId).map((r) => r.id);
        if (foreign.length > 0) {
          throw new BadRequestException(
            `${target} ${foreign.join(", ")} does not belong to this school`,
          );
        }
      }),
    );
  }

  return base.$extends({
    name: "schoolScope",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }: any) {
          const store = tenant.current();
          const schoolId = store?.schoolId ?? null;

          if (schoolId === null) {
            if (!store?.unscoped && process.env.NODE_ENV !== "production") {
              logger.warn(
                `${model}.${operation} ran with no tenant context — unscoped. ` +
                  `Open one with TenantContextService.runAs(), or runUnscoped() if that is deliberate.`,
              );
            }
            return query(args);
          }

          if (FILTERABLE.has(operation)) {
            if (operation === "updateMany") {
              await assertNoForeignReferences(model, args?.data, schoolId);
            }
            return query({ ...args, where: scopeWhere(args?.where, schoolId, model) });
          }

          if (
            operation === "create" ||
            operation === "createMany" ||
            operation === "createManyAndReturn"
          ) {
            if (model === TENANT_ROOT) {
              // Creating a school is provisioning, not application work: it has
              // to register in the control-plane tenant registry too, or it
              // would be a school nobody can sign in to (§17.3).
              throw new BadRequestException(
                "Schools are created by tenant provisioning, not from inside a school's own session",
              );
            }
            await assertNoForeignReferences(model, args.data, schoolId);
            return query({ ...args, data: stampCreate(args.data, schoolId) });
          }

          if (BY_UNIQUE.has(operation)) {
            // findUnique cannot carry a non-unique predicate, so the school is
            // applied to the *result* instead of the query. Running the
            // original operation (rather than re-issuing a findFirst on the
            // base client) keeps it on whatever client the caller used — which
            // matters inside an interactive transaction, where a re-issued read
            // would not see rows that transaction had just written.
            if (operation === "findUnique" || operation === "findUniqueOrThrow") {
              // A caller's `select` may omit school_id; ask for it, then hide
              // it again so the shape the caller asked for is what it gets.
              const ownerField = model === TENANT_ROOT ? "id" : "schoolId";
              const select = isPlainObject(args?.select) ? args.select : null;
              const borrowed = select !== null && select[ownerField] === undefined;
              const found = await query(
                borrowed ? { ...args, select: { ...select, [ownerField]: true } } : args,
              );
              const row = found as Record<string, unknown> | null;
              if (row != null && row[ownerField] === schoolId) {
                if (borrowed) delete row[ownerField];
                return row;
              }
              if (operation === "findUniqueOrThrow") {
                throw new NotFoundException(`${model} not found`);
              }
              return null;
            }

            // update / delete / upsert address a row by unique key, which the
            // school is not part of. Look the row up first — cheap next to the
            // write — and refuse when it demonstrably belongs to someone else.
            //
            // Read unscoped, then compare, for the same reason as
            // assertNoForeignReferences: inside an interactive transaction the
            // base client cannot see rows that transaction just wrote, and the
            // bulk import legitimately updates a class-section it created a few
            // statements earlier. A row that is invisible here is not another
            // school's — another school's row is committed and therefore
            // always visible.
            const ownerField = model === TENANT_ROOT ? "id" : "schoolId";
            const existing: Record<string, unknown> | null = await delegate(model).findFirst({
              where: flattenUniqueWhere(args?.where),
              select: { [ownerField]: true },
            });
            const owned = existing === null || existing[ownerField] === schoolId ? existing : null;
            const foreign = existing !== null && existing[ownerField] !== schoolId;

            if (operation === "upsert") {
              if (foreign) throw new NotFoundException(`${model} not found`);
              if (owned === null) {
                if (model === TENANT_ROOT) {
                  throw new BadRequestException(
                    "Schools are created by tenant provisioning, not from inside a school's own session",
                  );
                }
                // Deliberately a plain create rather than letting the upsert
                // run: if a row exists under this unique key but belongs to
                // another school, upsert would silently UPDATE it. Creating
                // instead turns that case into a unique violation (a 409 via
                // crud.util's uniq()), never a cross-school write.
                await assertNoForeignReferences(model, args.create, schoolId);
                return delegate(model).create({ data: stampCreate(args.create, schoolId) });
              }
              await assertNoForeignReferences(model, args.update, schoolId);
              return query({
                ...args,
                update: model === TENANT_ROOT ? args.update : stampCreate(args.update, schoolId),
              });
            }

            if (foreign) throw new NotFoundException(`${model} not found`);
            if (operation === "update") {
              await assertNoForeignReferences(model, args.data, schoolId);
              return query({
                ...args,
                data: model === TENANT_ROOT ? args.data : stampCreate(args.data, schoolId),
              });
            }
            return query(args);
          }

          return query(args);
        },
      },
    },
  }) as unknown as PrismaClient;
}
