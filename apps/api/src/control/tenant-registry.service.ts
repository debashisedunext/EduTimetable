/**
 * The tenant registry (§17.3, Phase 9.2) — the lookup that turns "an SSO token
 * arrived claiming ERP installation X, school code Y" into "school_id N, in
 * this database".
 *
 * Phase 9.2 stands the registry up and makes it authoritative for identity and
 * status. Actually *routing a connection* from it is Phase 9.4; until then
 * `connectionUrlFor()` is the one piece with no caller, and dedicated tenants
 * are rejected at resolve time rather than silently served from the shared
 * database — the failure mode of quietly reading the wrong school's data is
 * far worse than a clear "not yet supported here".
 */
import { Injectable, Logger } from "@nestjs/common";
import type { Tenant, TenantMode } from "../../prisma/generated/control-client";
import { ControlPrismaService } from "./control-prisma.service";
import { decryptSecret, encryptSecret } from "../common/crypto.util";

/** What the rest of the app needs to know about a school. Never the credentials. */
export interface ResolvedTenant {
  tenantId: number;
  /** `schools.id` inside the tenant's own database — what every query scopes by. */
  schoolId: number;
  schoolCode: string;
  displayName: string;
  mode: TenantMode;
  erpInstanceId: number;
  trustId: number | null;
  status: string;
}

const CACHE_TTL_MS = 30_000;

@Injectable()
export class TenantRegistryService {
  private readonly logger = new Logger(TenantRegistryService.name);
  /**
   * Short-lived memo. Every SSO login hits this lookup, and the registry
   * changes rarely — but 30s is short enough that suspending a school takes
   * effect while an operator is still watching, rather than at the next deploy.
   */
  private readonly cache = new Map<string, { at: number; value: ResolvedTenant | null }>();

  constructor(private readonly control: ControlPrismaService) {}

  get available(): boolean {
    return this.control.available;
  }

  private toResolved(t: Tenant): ResolvedTenant {
    return {
      tenantId: t.id,
      schoolId: t.localSchoolId,
      schoolCode: t.schoolCode,
      displayName: t.displayName,
      mode: t.mode,
      erpInstanceId: t.erpInstanceId,
      trustId: t.trustId,
      status: t.status,
    };
  }

  /**
   * Resolve the school an SSO token refers to. Returns null when the registry
   * has no such school — the caller must refuse the login rather than guess.
   */
  async resolve(erpInstanceId: number, schoolCode: string): Promise<ResolvedTenant | null> {
    const key = `${erpInstanceId}|${schoolCode.toLowerCase()}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

    const client = this.control.client;
    if (!client) return null;

    const row = await client.tenant.findUnique({
      where: { erpInstanceId_schoolCode: { erpInstanceId, schoolCode } },
    });
    const value = row ? this.toResolved(row) : null;
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  /**
   * Find a school by the `school_id` it uses inside its own database.
   *
   * This is unambiguous only while every tenant is `shared` — under
   * `dedicated` mode local ids repeat across databases, which is exactly why
   * Phase 9.5 puts `tenantId` in the session token and this method goes away.
   * Until then it returns null rather than a guess when more than one matches,
   * so it can never resolve to the wrong school.
   */
  async byLocalSchoolId(schoolId: number): Promise<ResolvedTenant | null> {
    const client = this.control.client;
    if (!client) return null;
    const rows = await client.tenant.findMany({ where: { localSchoolId: schoolId }, take: 2 });
    if (rows.length !== 1) {
      if (rows.length > 1) {
        this.logger.warn(
          `school_id ${schoolId} maps to ${rows.length} tenants — resolve by school code instead (§17.3)`,
        );
      }
      return null;
    }
    return this.toResolved(rows[0]);
  }

  /** By platform id — used by the Platform Console and provisioning (9.3, 9.8). */
  async byId(tenantId: number): Promise<ResolvedTenant | null> {
    const client = this.control.client;
    if (!client) return null;
    const row = await client.tenant.findUnique({ where: { id: tenantId } });
    return row ? this.toResolved(row) : null;
  }

  /** Every school in the registry, newest last. Platform Console listing. */
  async list(): Promise<ResolvedTenant[]> {
    const client = this.control.client;
    if (!client) return [];
    const rows = await client.tenant.findMany({ orderBy: { id: "asc" } });
    return rows.map((r) => this.toResolved(r));
  }

  /** The ERP installation whose key verifies a token, selected by its `kid`. */
  async erpInstanceByKid(kid: string) {
    const client = this.control.client;
    if (!client) return null;
    return client.erpInstance.findFirst({ where: { kid, isActive: true } });
  }

  async erpInstanceByIssuer(issuer: string) {
    const client = this.control.client;
    if (!client) return null;
    return client.erpInstance.findFirst({ where: { issuer, isActive: true } });
  }

  /**
   * The connection URL for a dedicated tenant, decrypted.
   *
   * Kept here, next to the encryption, so the plaintext exists only inside this
   * method's caller — it must never reach a response, a log line or an error
   * message. Phase 9.4's connection registry is its only intended consumer.
   */
  async connectionUrlFor(tenantId: number): Promise<string | null> {
    const client = this.control.client;
    if (!client) return null;
    const row = await client.tenant.findUnique({
      where: { id: tenantId },
      select: { mode: true, dbUrlEncrypted: true },
    });
    if (!row || row.mode !== "dedicated") return null;
    if (!row.dbUrlEncrypted) {
      throw new Error(`Tenant ${tenantId} is 'dedicated' but has no stored connection URL`);
    }
    return decryptSecret(row.dbUrlEncrypted);
  }

  /** Store (or rotate) a dedicated tenant's connection URL. Write-only by design. */
  async setConnectionUrl(tenantId: number, url: string): Promise<void> {
    const client = this.control.require();
    await client.tenant.update({
      where: { id: tenantId },
      // Uint8Array.from, not the Buffer itself: the control client is generated
      // separately and types Bytes as Uint8Array<ArrayBuffer>, which Node's
      // Buffer<ArrayBufferLike> does not satisfy structurally.
      data: { mode: "dedicated", dbUrlEncrypted: Uint8Array.from(encryptSecret(url)) },
    });
    this.cache.clear();
  }

  /** Drop the memo — after provisioning, suspension or a mode change. */
  invalidate(): void {
    this.cache.clear();
  }
}
