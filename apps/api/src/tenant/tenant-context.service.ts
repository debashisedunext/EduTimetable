/**
 * Phase 9.1 (§17) — the ambient tenant context.
 *
 * Every request, socket message and background job runs inside an
 * AsyncLocalStorage store carrying the school it belongs to. The Prisma
 * scoping extension (prisma/school-scope.ts) reads it on every query, which is
 * why no call site had to change: `this.prisma.room.findMany()` is scoped
 * because of where it runs, not because of how it is written.
 *
 * Deliberately NOT a Nest request-scoped provider: request scope would cascade
 * through the ~40 classes that inject PrismaService, destroy singleton caching
 * and put the §14 300ms p95 API budget at risk.
 *
 * The store is mutable on purpose. The middleware opens an empty store around
 * the whole request (so guards, handlers and interceptors all share it) and
 * JwtAuthGuard fills in the school once the session token is verified.
 */
import { Injectable, Logger } from "@nestjs/common";
import { AsyncLocalStorage } from "node:async_hooks";

export interface TenantStore {
  /** The school every scoped query is filtered to. null = unscoped. */
  schoolId: number | null;
  /**
   * The control-plane tenant this school belongs to (§17.3). Unlike schoolId
   * it is unique across every database, which is what makes it the right key
   * for the connection registry — a dedicated tenant's local school id is
   * usually 1, and so is everyone else's.
   */
  tenantId?: number | null;
  /**
   * The database connection this context works against, resolved once per
   * request by the connection registry (9.4).
   *
   * It lives here because property access on the PrismaService proxy is
   * synchronous while opening a connection is not — so the async work happens
   * once, up front, and the proxy only ever does a synchronous read. Absent
   * means "the default connection", which is every shared-mode tenant and
   * every deployment with no registry.
   */
  client?: unknown;
  /** users.id of the acting session, when there is one. */
  userId?: number;
  /**
   * Set by runUnscoped(). Distinguishes "deliberately global" (migrations,
   * SSO provisioning, health checks) from "forgot to open a context", which is
   * what the dev-mode warning in school-scope.ts is looking for.
   */
  unscoped?: boolean;
  /** Free-text label for logs — which entry point opened this context. */
  origin?: string;
}

@Injectable()
export class TenantContextService {
  private readonly logger = new Logger(TenantContextService.name);
  private readonly als = new AsyncLocalStorage<TenantStore>();

  /** The active store, or undefined outside any context. */
  current(): TenantStore | undefined {
    return this.als.getStore();
  }

  /** The active school, or null when unscoped / outside a context. */
  schoolId(): number | null {
    return this.als.getStore()?.schoolId ?? null;
  }

  /**
   * The active school, or a thrown error. Use this where a row is about to be
   * written and must be attributed — `school_id` is NOT NULL on every table,
   * so a missing context is a bug to surface, not a value to guess.
   */
  requireSchoolId(): number {
    const id = this.schoolId();
    if (id === null) {
      throw new Error(
        `A school is required here but no tenant context is open (origin: ${this.current()?.origin ?? "none"})`,
      );
    }
    return id;
  }

  /**
   * Open an empty store for the lifetime of `fn`. The HTTP middleware calls
   * this before the guards run so the guard can fill the school in later.
   */
  open<T>(origin: string, fn: () => T): T {
    return this.als.run({ schoolId: null, origin }, fn);
  }

  /** Run `fn` scoped to one school — sockets, queue jobs, scripts, tests. */
  runAs<T>(
    scope: {
      schoolId: number;
      tenantId?: number | null;
      client?: unknown;
      userId?: number;
      origin?: string;
    },
    fn: () => T,
  ): T {
    return this.als.run({ ...scope, schoolId: scope.schoolId }, fn);
  }

  /**
   * Run `fn` with scoping explicitly switched off. Only for genuinely
   * cross-school work: SSO provisioning (the user's school is the *input*),
   * migrations, seeds, and the health probe. Every use should be obvious.
   */
  runUnscoped<T>(origin: string, fn: () => T): T {
    return this.als.run({ schoolId: null, unscoped: true, origin }, fn);
  }

  /**
   * Fill in the school on the store the middleware already opened. Called by
   * JwtAuthGuard once the session token is verified.
   */
  attach(schoolId: number, userId?: number, tenantId?: number | null): void {
    const store = this.als.getStore();
    if (!store) {
      // A route reached the guard without the middleware — a wiring bug, and
      // silently unscoped queries are exactly what 9.1 exists to prevent.
      this.logger.error(
        `No tenant context open while authenticating user ${userId ?? "?"} — queries would run unscoped`,
      );
      return;
    }
    store.schoolId = schoolId;
    store.userId = userId;
    store.tenantId = tenantId ?? null;
  }

  /**
   * Point the current context at a specific database connection. Called by the
   * connection registry once the tenant's client is open (9.4); leaving it
   * unset means the default connection.
   */
  bindConnection(client: unknown): void {
    const store = this.als.getStore();
    if (store) store.client = client;
  }

  /** The connection this context works against, or undefined for the default. */
  connection(): unknown | undefined {
    return this.als.getStore()?.client;
  }
}
