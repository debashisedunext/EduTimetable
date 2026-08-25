import { Global, Module } from "@nestjs/common";
import { ControlPrismaService } from "./control-prisma.service";
import { TenantRegistryService } from "./tenant-registry.service";
import { SchoolProvisioningService } from "./school-provisioning.service";

/**
 * The control plane (§17.3): the tenant registry and its connection.
 *
 * Global because SSO, the guards and — from 9.4 — the Prisma connection
 * registry all resolve tenants, and because there must be exactly one memo
 * cache rather than one per importing module.
 */
@Global()
@Module({
  providers: [ControlPrismaService, TenantRegistryService, SchoolProvisioningService],
  exports: [ControlPrismaService, TenantRegistryService, SchoolProvisioningService],
})
export class ControlModule {}
