import { Global, Module } from "@nestjs/common";
import { PrismaBaseService } from "./prisma-base.service";
import { PrismaService } from "./prisma.service";
import { withSchoolScope } from "./school-scope";
import { TenantContextService } from "../tenant/tenant-context.service";

@Global()
@Module({
  providers: [
    PrismaBaseService,
    {
      // One connection, two views of it: PrismaBaseService is the raw pool,
      // PrismaService is that same pool behind the school-scoping extension.
      // Everything injects the scoped one by default (9.1 / §17).
      provide: PrismaService,
      inject: [PrismaBaseService, TenantContextService],
      useFactory: (base: PrismaBaseService, tenant: TenantContextService) =>
        withSchoolScope(base, tenant) as PrismaService,
    },
  ],
  exports: [PrismaService, PrismaBaseService],
})
export class PrismaModule {}
