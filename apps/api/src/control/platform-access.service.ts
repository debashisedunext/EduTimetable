/**
 * Who may administer the platform (§17.6, Phase 9.8).
 *
 * Two decisions worth stating, because both are containment rules rather than
 * conveniences:
 *
 * **It is not a permission.** Every permission in this app lives in a school's
 * own `roles`/`role_permissions` (§15.2), granted by that school's Super Admin.
 * If platform access were one of those, a school admin could grant themselves
 * authority over the registry — over other schools' status, connections and
 * existence. Authority must not be grantable from inside the thing it governs,
 * so it lives in the control plane, keyed by ERP identity.
 *
 * **It is not carried in the session token.** A flag minted at sign-in would
 * stay true for the token's whole 8-hour life, so revoking someone's access
 * would not actually revoke it until they signed out. It is re-checked per
 * request instead, behind a short memo so the cost is a Map read.
 */
import { Injectable, Logger } from "@nestjs/common";
import type { SessionTokenPayload } from "@edutimetable/shared";
import { ControlPrismaService } from "./control-prisma.service";

const CACHE_TTL_MS = 30_000;

/**
 * Bootstrap escape hatch. The first platform admin cannot be granted through a
 * screen that requires already being one, and an operator locked out of their
 * own console needs a way back in that does not involve editing the database by
 * hand. Comma-separated ERP user ids.
 */
const envAllowlist = (): string[] =>
  (process.env.PLATFORM_ADMIN_ERP_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

@Injectable()
export class PlatformAccessService {
  private readonly logger = new Logger(PlatformAccessService.name);
  private readonly cache = new Map<string, { at: number; value: boolean }>();

  constructor(private readonly control: ControlPrismaService) {}

  /** Is this session a platform administrator? */
  async isPlatformAdmin(session: SessionTokenPayload | undefined): Promise<boolean> {
    const erpUserId = session?.erpUserId;
    if (!erpUserId) return false;
    if (envAllowlist().includes(erpUserId)) return true;

    const client = this.control.client;
    if (!client) return false;

    const key = erpUserId;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

    const row = await client.platformUser.findFirst({ where: { erpUserId, isActive: true } });
    this.cache.set(key, { at: Date.now(), value: row !== null });
    return row !== null;
  }

  /** Everyone who holds platform access, for the console's own listing. */
  async list() {
    const client = this.control.client;
    const rows = client ? await client.platformUser.findMany({ orderBy: { id: "asc" } }) : [];
    return {
      users: rows.map((r) => ({
        id: r.id,
        erpUserId: r.erpUserId,
        name: r.name,
        email: r.email,
        isActive: r.isActive,
        lastSeenAt: r.lastSeenAt,
      })),
      /** Surfaced so an operator can see that an env grant is in play, and why. */
      envAllowlist: envAllowlist(),
    };
  }

  /** Note that a platform admin used the console, for the "last seen" column. */
  async touch(erpUserId: string, name?: string, email?: string) {
    const client = this.control.client;
    if (!client) return;
    await client.platformUser
      .updateMany({
        where: { erpUserId },
        data: { lastSeenAt: new Date(), ...(name ? { name } : {}), ...(email ? { email } : {}) },
      })
      .catch(() => undefined);
  }

  invalidate() {
    this.cache.clear();
  }
}
