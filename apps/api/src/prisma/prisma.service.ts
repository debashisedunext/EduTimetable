/**
 * The client every service and controller injects — and, since Phase 9.1, the
 * school-scoped one.
 *
 * This class body is intentionally empty: it exists as the DI token and the
 * type. The instance handed out is built by prisma.module.ts, which wraps the
 * raw connection in the school-scoping extension (prisma/school-scope.ts). That
 * indirection is the reason ~40 injecting classes needed no edit at all in 9.1
 * — `this.prisma.room.findMany()` is scoped by virtue of the context it runs
 * in, not by anything written at the call site.
 *
 * Need to cross school boundaries on purpose? Inject PrismaBaseService, or
 * wrap the work in TenantContextService.runUnscoped() so the intent is visible.
 */
import { PrismaClient } from "@prisma/client";

export class PrismaService extends PrismaClient {}
