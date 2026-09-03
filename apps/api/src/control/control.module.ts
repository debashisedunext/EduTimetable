import { Global, Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { ControlPrismaService } from "./control-prisma.service";
import { TenantRegistryService } from "./tenant-registry.service";
import { SchoolProvisioningService } from "./school-provisioning.service";
import { PlatformAccessService } from "./platform-access.service";
import { PlatformController } from "./platform.controller";
import { SchoolsController } from "./schools.controller";
import { SelfServeProvisioningService } from "./self-serve-provisioning.service";

/**
 * The control plane (§17.3): the tenant registry and its connection.
 *
 * Global because SSO, the guards and — from 9.4 — the Prisma connection
 * registry all resolve tenants, and because there must be exactly one memo
 * cache rather than one per importing module.
 */
@Global()
@Module({
  imports: [BullModule.registerQueue({ name: "solver" })],
  controllers: [PlatformController, SchoolsController],
  providers: [
    ControlPrismaService,
    TenantRegistryService,
    SchoolProvisioningService,
    PlatformAccessService,
    SelfServeProvisioningService,
  ],
  exports: [
    ControlPrismaService,
    TenantRegistryService,
    SchoolProvisioningService,
    PlatformAccessService,
    SelfServeProvisioningService,
  ],
})
export class ControlModule {}
