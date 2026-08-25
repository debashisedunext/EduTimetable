import { Global, Module } from "@nestjs/common";
import { PrismaBaseService } from "./prisma-base.service";
import { PrismaService } from "./prisma.service";
import { TenantConnectionsService } from "./tenant-connections.service";
import { createRoutingProxy } from "./routing-proxy";
import { TenantContextService } from "../tenant/tenant-context.service";

@Global()
@Module({
  providers: [
    PrismaBaseService,
    TenantConnectionsService,
    {
      // Three views of the data layer (§17.5):
      //   PrismaBaseService        — the raw application pool, unscoped
      //   TenantConnectionsService — one pool per dedicated tenant, bounded
      //   PrismaService            — a pointer to whichever of those the
      //                              current request belongs to, school-scoped
      // Everything injects PrismaService.
      provide: PrismaService,
      inject: [TenantContextService, TenantConnectionsService],
      useFactory: (tenant: TenantContextService, connections: TenantConnectionsService) =>
        createRoutingProxy(tenant, connections) as PrismaService,
    },
  ],
  exports: [PrismaService, PrismaBaseService, TenantConnectionsService],
})
export class PrismaModule {}
