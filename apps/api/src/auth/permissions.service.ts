import { Injectable } from "@nestjs/common";
import type { Permission } from "@edutimetable/shared";
import { PrismaService } from "../prisma/prisma.service";

const CACHE_TTL_MS = 30_000;

/**
 * Role → permission lookup with a short in-process cache. The Roles &
 * Responsibility page (Phase 1) calls invalidate() on save so changes take
 * effect on the next request (§15.4).
 */
@Injectable()
export class PermissionsService {
  constructor(private readonly prisma: PrismaService) {}

  private cache = new Map<number, { permissions: Permission[]; expires: number }>();

  async getForRole(roleId: number): Promise<Permission[]> {
    const hit = this.cache.get(roleId);
    if (hit && hit.expires > Date.now()) return hit.permissions;

    const rows = await this.prisma.rolePermission.findMany({ where: { roleId } });
    const permissions = rows.map((r) => r.permission as Permission);
    this.cache.set(roleId, { permissions, expires: Date.now() + CACHE_TTL_MS });
    return permissions;
  }

  invalidate(roleId?: number) {
    if (roleId === undefined) this.cache.clear();
    else this.cache.delete(roleId);
  }
}
