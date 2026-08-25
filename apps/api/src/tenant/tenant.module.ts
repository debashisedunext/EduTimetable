import { Global, Module } from "@nestjs/common";
import { TenantContextService } from "./tenant-context.service";

/**
 * Global so PrismaModule, the guards, the gateways and every feature module
 * share one AsyncLocalStorage instance — two instances would mean a context
 * opened by the middleware is invisible to the Prisma extension.
 */
@Global()
@Module({
  providers: [TenantContextService],
  exports: [TenantContextService],
})
export class TenantModule {}
