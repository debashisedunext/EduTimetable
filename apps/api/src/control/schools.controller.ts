/**
 * §15.3 Phase 25.1 — the schools an account owns, and the way into one.
 *
 * Three endpoints, all behind the ACCOUNT token rather than a session token —
 * whoever calls them may not be inside any school yet, which is the entire
 * reason that second credential exists.
 *
 *   GET  /schools           what this account may open
 *   POST /schools           create one (owners only, verified only, capped)
 *   POST /schools/:id/enter exchange the account token for a school session
 *
 * The exchange is the join between the two halves of §15.3: everything before
 * it is account-level, everything after it is the ordinary app, running on the
 * unchanged `SessionTokenPayload` that every guard and scope filter already
 * reads.
 */
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type { SessionTokenPayload } from "@edutimetable/shared";
import { Public } from "../auth/decorators";
import { AccountAuthGuard, type AccountRequest } from "../auth/account-auth.guard";
import { AccountService } from "../auth/account.service";
import { PrismaBaseService } from "../prisma/prisma-base.service";
import { TenantRegistryService } from "./tenant-registry.service";
import { SelfServeProvisioningService } from "./self-serve-provisioning.service";

@Controller("schools")
// `@Public()` skips the SESSION guard only; `AccountAuthGuard` then requires an
// account token. These are not unauthenticated — they are authenticated by the
// other credential.
@Public()
@UseGuards(AccountAuthGuard)
export class SchoolsController {
  constructor(
    private readonly prisma: PrismaBaseService,
    private readonly accounts: AccountService,
    private readonly selfServe: SelfServeProvisioningService,
    private readonly registry: TenantRegistryService,
    private readonly jwt: JwtService,
  ) {}

  /** The account behind the token, refused if it has gone away or is unverified. */
  private async requireAccount(req: AccountRequest) {
    const account = await this.accounts.byId(req.account.sub);
    if (!account) throw new ForbiddenException("This account is no longer active");
    return account;
  }

  /**
   * Every school this account can open, with just enough to render a card.
   *
   * Deliberately NOT a readiness score per school. Readiness is computed from a
   * feasibility snapshot, and doing that once per school on a list screen would
   * blow the §14 one-second budget the moment somebody runs six schools. The
   * counts below answer the question the screen actually asks — *is this set up,
   * and how far did I get?* — from indexed reads.
   */
  @Get()
  async list(@Req() req: AccountRequest) {
    const account = await this.requireAccount(req);
    const schools = await this.selfServe.schoolsFor(account.id);

    const cards = await Promise.all(
      schools.map(async (s) => {
        const [configs, classes, sections, published] = await Promise.all([
          this.prisma.timetableConfig.count({ where: { schoolId: s.id } }),
          this.prisma.schoolClass.count({ where: { schoolId: s.id } }),
          this.prisma.classSection.count({ where: { schoolId: s.id } }),
          this.prisma.timetablePublication.findFirst({
            where: { schoolId: s.id },
            orderBy: { id: "desc" },
            select: { publishedAt: true },
          }),
        ]);
        return {
          id: s.id,
          code: s.code,
          name: s.name,
          shortName: s.shortName,
          origin: s.origin,
          counts: { configs, classes, sections },
          publishedAt: published?.publishedAt ?? null,
          // What the card's button should say. Computed here so the screen and
          // the API cannot disagree about what "set up" means.
          state: published ? "published" : configs > 0 ? "in-progress" : "empty",
        };
      }),
    );

    return {
      account: {
        id: account.id, name: account.name, email: account.email, kind: account.kind,
        // Since an unverified account may now sign in and create its first
        // school, the screen has to be able to ask for the confirmation that no
        // longer blocks them.
        emailVerified: account.emailVerified,
      },
      schools: cards,
      // An owner may create schools; a member never can. The screen reads this
      // to decide whether to show the tile — and `POST /schools` refuses
      // independently, because hiding a tile is cosmetic (§15).
      canCreate: account.kind === "owner",
      // Counted on schools this account CREATED, not on the list above — since
      // 25.6 the list also holds schools they were invited into, and being a
      // teacher in six schools must not exhaust their allowance to run their own.
      remaining: Math.max(0, this.selfServe.cap - (await this.selfServe.countFor(account.id))),
      cap: this.selfServe.cap,
    };
  }

  @Post()
  async create(@Req() req: AccountRequest, @Body() body: Record<string, string>) {
    const account = await this.requireAccount(req);
    /**
     * An unverified account gets its FIRST school, and no more.
     *
     * The gate used to be absolute, and the reasoning behind it still holds:
     * an unverified address that can create schools is a mail cannon and a way
     * to fill the registry with rows nobody can reach. What it also did was
     * stop a brand-new customer from doing the one thing they signed up for
     * until they had been to their inbox and back.
     *
     * One school keeps the anti-abuse property — registration is already
     * per-IP throttled, so the ceiling on unverified rows is one per address
     * rather than ten — while letting somebody start. Verification is still
     * required to go further, and the email still goes out.
     */
    if (!account.emailVerified && (await this.selfServe.countFor(account.id)) >= 1) {
      throw new ForbiddenException(
        "Confirm your email address before creating another school — check your inbox for the link.",
      );
    }
    const created = await this.selfServe.create(account, {
      name: body.name,
      shortName: body.shortName,
      timezone: body.timezone,
      trustName: body.trustName,
    });
    // Straight into it: the only reason to create a school is to set it up.
    const sessionToken = await this.mintSession(account.id, created.schoolId);
    return { ...created, sessionToken };
  }

  /**
   * Exchange the account token for a session in one school.
   *
   * The authority is the `users` row: an account may enter a school exactly
   * when it has one there. That is the same rule school switching already
   * follows, expressed against a different identity source.
   */
  @Post(":id/enter")
  async enter(@Req() req: AccountRequest, @Param("id") id: string) {
    const account = await this.requireAccount(req);
    const schoolId = Number(id);
    if (!Number.isInteger(schoolId)) throw new BadRequestException("Invalid school id");
    const sessionToken = await this.mintSession(account.id, schoolId);
    return { sessionToken };
  }

  /**
   * Build the ordinary `SessionTokenPayload`.
   *
   * Identical in shape to the one the SSO callback issues — that is the promise
   * that keeps every downstream guard, row-scope filter and audit path
   * untouched. Only where the identity came from differs.
   */
  private async mintSession(accountId: number, schoolId: number): Promise<string> {
    const user = await this.prisma.user.findFirst({
      where: { schoolId, accountId, isActive: true },
      include: { school: true },
    });
    // A school this account has no user row in is *not found*, never a refusal
    // that confirms it exists — the same rule the rest of §17 holds to.
    if (!user) throw new NotFoundException("School not found");

    const mine = await this.selfServe.schoolsFor(accountId);
    const tenants = await Promise.all(mine.map((s) => this.registry.resolveByCode(s.code)));
    const tenantId = (await this.registry.resolveByCode(user.school.code))?.tenantId ?? null;

    const session: SessionTokenPayload = {
      sub: user.id,
      schoolId,
      roleId: user.roleId,
      tenantId,
      // Synthetic but stable, and the same value `users.erp_user_id` holds —
      // which is what lets school switching resolve this person in the target
      // school without an ERP round trip it could never make.
      erpUserId: `local:${accountId}`,
      grants: tenants.filter(Boolean).map((t) => t!.tenantId),
      schoolIds: mine.map((s) => s.id),
    };
    return this.jwt.signAsync(session, { expiresIn: "8h" });
  }
}
