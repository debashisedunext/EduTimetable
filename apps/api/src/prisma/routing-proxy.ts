/**
 * The routing proxy (§17.5, Phase 9.4).
 *
 * `PrismaService` is not a connection — it is a *pointer* to whichever
 * connection the current request belongs to. Every property access resolves
 * against the tenant context: a shared-mode school gets the application
 * database, a dedicated one gets its own.
 *
 * This is the piece that let 9.4 change where queries go without touching any
 * of the ~40 classes that inject PrismaService. `this.prisma.room.findMany()`
 * compiles and runs exactly as it did in Phase 1.
 *
 * The lookup here is deliberately synchronous — a Map read, no awaiting. The
 * async work (resolving the tenant, decrypting its URL, opening a pool) happens
 * once per request in the guard, which binds the resolved client to the
 * context. If nothing was bound, the default connection is correct: that is
 * every shared tenant, every deployment with no registry, and every background
 * job that opened its own context.
 */
import { PrismaClient } from "@prisma/client";
import type { TenantContextService } from "../tenant/tenant-context.service";
import type { TenantConnectionsService } from "./tenant-connections.service";

export function createRoutingProxy(
  tenant: TenantContextService,
  connections: TenantConnectionsService,
): PrismaClient {
  const resolve = (): PrismaClient =>
    (tenant.connection() as PrismaClient | undefined) ?? connections.defaultClient();

  return new Proxy({} as PrismaClient, {
    get(_target, prop, receiver) {
      const client = resolve();
      const value = Reflect.get(client as object, prop, receiver);
      // Bind methods ($transaction, $queryRaw, …) to the client they came from,
      // or `this` inside Prisma's own code would be the proxy.
      return typeof value === "function" ? value.bind(client) : value;
    },
    has: (_t, prop) => prop in (resolve() as object),
    ownKeys: () => Reflect.ownKeys(resolve() as object),
    getOwnPropertyDescriptor: (_t, prop) => {
      const d = Reflect.getOwnPropertyDescriptor(resolve() as object, prop);
      // A proxy may only report a non-configurable property if the target has
      // one, and the target here is an empty object.
      return d && { ...d, configurable: true };
    },
  });
}
