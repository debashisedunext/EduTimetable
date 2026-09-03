/**
 * §15.3 Phase 25.1 — a school created by the person who will run it.
 *
 * The ERP path (`school-provisioning.service.ts`) brings the local database in
 * line with what an SSO token says. This is the other half: a self-serve admin
 * types a name, because nobody else knows it.
 *
 * **A login may create a school. It may never create a DATABASE.** §17.3's rule
 * is intact, and the distinction is the whole design: a self-serve school is a
 * `schools` row plus a `tenants` entry with `mode = shared`, which is instant
 * and costs nothing. Moving a school to its own database stays
 * `pnpm tenant:create` — an operator command, unreachable from a form.
 *
 * **Roles are seeded by the same code the ERP path uses.** A school with no
 * permission registry is a school nobody can sign in to, and two ways of
 * writing that registry would eventually disagree about what a Teacher may do.
 */
import { BadRequestException, ForbiddenException, Injectable, Logger } from "@nestjs/common";
import { PrismaBaseService } from "../prisma/prisma-base.service";
import { ControlPrismaService } from "./control-prisma.service";
import { SchoolProvisioningService } from "./school-provisioning.service";
import { TenantRegistryService } from "./tenant-registry.service";

/**
 * How many schools one account may create before an operator has to agree.
 *
 * A verified human running a trust rarely needs more; a script always does.
 * Raising it is a deployment decision, not a support ticket.
 */
const DEFAULT_SCHOOL_CAP = Number(process.env.SELF_SERVE_SCHOOL_CAP ?? 10);

/**
 * The ERP installation self-serve schools are filed under.
 *
 * NOT null, and this is the non-obvious part. `tenants` is unique on
 * `(erp_instance_id, school_code)`, and **MySQL allows any number of NULLs in a
 * unique index** — so a null instance would give self-serve schools no
 * uniqueness at all, and two accounts could register the same code.
 * `resolveByCode` then finds two rows, returns null, and routes the school to
 * the default connection: a silent, data-losing failure. One clearly-named
 * sentinel row keeps the existing key working exactly as it does for the ERP.
 */
const SELF_SERVE_INSTANCE = "Self-serve (no ERP installation)";

export interface CreateSchoolInput {
  name: string;
  shortName?: string;
  timezone?: string;
  trustName?: string;
}

@Injectable()
export class SelfServeProvisioningService {
  private readonly logger = new Logger(SelfServeProvisioningService.name);

  constructor(
    private readonly prisma: PrismaBaseService,
    private readonly control: ControlPrismaService,
    private readonly provisioning: SchoolProvisioningService,
    private readonly registry: TenantRegistryService,
  ) {}

  /**
   * A URL-safe, stable key derived from the name.
   *
   * `schools.code` is the identity that survives across databases, so it has to
   * be unique and it has to be stable. Derived from the name for readability,
   * then suffixed until it is free — never re-derived later, because a school
   * that renames itself must keep the code its rows were filed under.
   */
  private async freeCode(name: string): Promise<string> {
    const base =
      name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) ||
      "school";
    for (let n = 0; n < 200; n++) {
      const code = n === 0 ? base : `${base}-${n + 1}`;
      const [local, tenant] = await Promise.all([
        this.prisma.school.findUnique({ where: { code } }),
        this.control.client?.tenant.findFirst({ where: { schoolCode: code } }) ?? Promise.resolve(null),
      ]);
      if (!local && !tenant) return code;
    }
    throw new BadRequestException("Could not derive a free code for that name — try a different one.");
  }

  /** How many schools this account has already created. */
  async countFor(accountId: number): Promise<number> {
    return this.prisma.school.count({ where: { createdByAccountId: accountId } });
  }

  /**
   * Create a school owned by this account, and the creator's user row in it.
   *
   * Runs unscoped by construction: it is deciding which school exists, so it
   * cannot already be inside one. The caller is responsible for having verified
   * the account — see the guards in the controller.
   */
  async create(
    account: { id: number; email: string; name: string; kind: string },
    input: CreateSchoolInput,
  ): Promise<{ schoolId: number; tenantId: number | null; code: string; userId: number }> {
    // Two refusals that belong here rather than in the controller, because they
    // are properties of provisioning rather than of a request.
    if (account.kind !== "owner") {
      throw new ForbiddenException(
        "Your account was invited into a school, so it cannot create new ones. " +
          "Ask the administrator who invited you.",
      );
    }
    const name = String(input.name ?? "").trim().slice(0, 120);
    if (name.length < 2) throw new BadRequestException("Enter the school's name.");

    const already = await this.countFor(account.id);
    if (already >= DEFAULT_SCHOOL_CAP) {
      throw new ForbiddenException(
        `You have created ${already} schools, which is the limit on this account. ` +
          `Contact support if you need more.`,
      );
    }

    const code = await this.freeCode(name);
    const school = await this.prisma.school.create({
      data: {
        code,
        name,
        origin: "self_serve",
        createdByAccountId: account.id,
        shortName: input.shortName?.trim().slice(0, 40) || null,
        timezone: input.timezone?.trim().slice(0, 40) || "Asia/Kolkata",
        trustName: input.trustName?.trim().slice(0, 120) || null,
      },
    });

    // The same registry the ERP path seeds. A second copy of DEFAULT_ROLES
    // would drift from the first the moment either changed.
    await this.provisioning.seedRoles(school.id);
    const tenantId = await this.registerTenant(school.id, code, name);

    const superAdmin = await this.prisma.role.findUnique({
      where: { schoolId_name: { schoolId: school.id, name: "Super Admin" } },
    });
    if (!superAdmin) {
      throw new Error(`Role seeding failed for school ${school.id} — no Super Admin role`);
    }

    // The creator's user row. `erp_user_id` carries a synthetic but stable
    // identity so the unique key, the session token and every scope filter keep
    // working untouched (§15.3).
    const user = await this.prisma.user.create({
      data: {
        schoolId: school.id,
        erpUserId: `local:${account.id}`,
        accountId: account.id,
        name: account.name,
        email: account.email,
        roleId: superAdmin.id,
        lastLoginAt: new Date(),
      },
    });

    this.logger.log(
      `Account ${account.id} created school '${name}' (${code}) as school_id ${school.id}` +
        (tenantId ? ` / tenant ${tenantId}` : " (no registry)"),
    );
    return { schoolId: school.id, tenantId, code, userId: user.id };
  }

  /**
   * File the school in the tenant registry as `shared`.
   *
   * Never `dedicated`: this path cannot conjure a database, and pretending
   * otherwise would register a school whose connection does not exist.
   */
  private async registerTenant(
    localSchoolId: number,
    code: string,
    name: string,
  ): Promise<number | null> {
    const control = this.control.client;
    if (!control) return null;

    const instance =
      (await control.erpInstance.findFirst({ where: { name: SELF_SERVE_INSTANCE } })) ??
      (await control.erpInstance.create({ data: { name: SELF_SERVE_INSTANCE, publicKeyPem: "" } }));

    const tenant = await control.tenant.create({
      data: {
        erpInstanceId: instance.id,
        schoolCode: code,
        displayName: name,
        mode: "shared",
        localSchoolId,
        status: "active",
      },
    });
    this.registry.invalidate();
    return tenant.id;
  }

  /** Keep the registry's display name in step when a self-serve school renames. */
  async renameTenant(code: string, name: string): Promise<void> {
    const control = this.control.client;
    if (!control) return;
    await control.tenant.updateMany({ where: { schoolCode: code }, data: { displayName: name } });
    this.registry.invalidate();
  }

  /**
   * Every school this account may enter.
   *
   * Keyed on the **`users` row**, not on who created the school. Creation is a
   * fact about provenance; access is a fact about membership, and Phase 25.6
   * makes the two come apart for the first time — an invited teacher created
   * nothing, and a list keyed on `createdByAccountId` would have shown them
   * nothing to enter while `mintSession` was perfectly willing to let them in.
   *
   * This is also the rule `POST /schools/:id/enter` already states in words:
   * *an account may enter a school exactly when it has a user row there.* Two
   * places asserting the same thing differently is how the list and the door
   * end up disagreeing.
   */
  async schoolsFor(accountId: number) {
    const memberships = await this.prisma.user.findMany({
      where: { accountId, isActive: true },
      select: { schoolId: true },
    });
    const ids = [...new Set(memberships.map((m) => m.schoolId))];
    if (ids.length === 0) return [];
    return this.prisma.school.findMany({
      where: { id: { in: ids }, isActive: true },
      orderBy: { id: "asc" },
    });
  }

  get cap(): number {
    return DEFAULT_SCHOOL_CAP;
  }
}
