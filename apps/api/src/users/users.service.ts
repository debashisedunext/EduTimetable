/**
 * §24.8 Phase 25.6 — who may sign in to this school, and as what.
 *
 * The whole module rests on one distinction that is easy to blur: **an account
 * is a person, a user row is a membership.** Credentials live once in the
 * control plane; `users` is one row per school per person, carries the role and
 * the teacher link, and is what every scope filter in §15 and §17 reads. So
 * inviting somebody is two writes in two databases, and they mean different
 * things — the account may already exist and belong to someone with their own
 * schools, while the membership is always new and always this school's business.
 *
 * Three rules the endpoints enforce, each of which would be a real hole:
 *
 *  - **`roles.manage`, not `masters.manage`.** Deciding who signs in is the
 *    same authority as deciding what a role may do; anything less would let
 *    whoever maintains the teacher list mint logins.
 *  - **Refused outright for an ERP school.** There, the ERP owns identity and
 *    provisions on login (§15.1). A user created here would be overwritten,
 *    or worse, would survive as a second way in that the ERP cannot revoke.
 *  - **Deactivate, never delete.** A user named in `audit_log` must stay
 *    resolvable, and the row is what makes the name resolvable.
 */
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { AccountService } from "../auth/account.service";
import { PrismaService } from "../prisma/prisma.service";
import { ControlPrismaService } from "../control/control-prisma.service";

/** The role an invited teacher gets unless somebody says otherwise. */
const TEACHER_ROLE = "Teacher";

export interface InviteInput {
  email?: unknown;
  name?: unknown;
  roleId?: unknown;
  teacherId?: unknown;
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountService,
    private readonly control: ControlPrismaService,
  ) {}

  /**
   * An ERP school's people come from the ERP, and only from the ERP.
   *
   * Checked on every write rather than once at the screen: hiding the button is
   * cosmetic (§15), and this is the kind of endpoint somebody reaches for with
   * curl when a colleague is locked out on a Monday morning.
   */
  private async assertSelfServe(schoolId: number) {
    const school = await this.prisma.school.findUnique({
      where: { id: schoolId },
      select: { origin: true, name: true },
    });
    if (!school) throw new NotFoundException("School not found");
    if (school.origin === "erp") {
      throw new ForbiddenException(
        `${school.name} signs in through your ERP, so its users are managed there. ` +
          "Add the person in the ERP and they will appear here when they first sign in.",
      );
    }
    return school;
  }

  /** Everybody with a login here, plus what state their account is in. */
  async list(schoolId: number) {
    const users = await this.prisma.user.findMany({
      where: { schoolId },
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
      include: { role: { select: { id: true, name: true } } },
    });

    // The teacher link is a name on screen, and the ids come from the same
    // school by construction — one query rather than one per row.
    const teacherIds = [...new Set(users.map((u) => u.teacherId).filter((t): t is number => t !== null))];
    const teachers = teacherIds.length
      ? await this.prisma.teacher.findMany({
          where: { id: { in: teacherIds } },
          select: { id: true, name: true, employeeCode: true },
        })
      : [];
    const teacherById = new Map(teachers.map((t) => [t.id, t]));

    // Account state lives in the control plane. Absent (a deployment with no
    // registry, or an ERP user) simply means there is nothing to say about it.
    const accountIds = [...new Set(users.map((u) => u.accountId).filter((a): a is number => a !== null))];
    const accounts = this.control.available && accountIds.length
      ? await this.control.require().account.findMany({
          where: { id: { in: accountIds } },
          select: { id: true, status: true, emailVerifiedAt: true, lastLoginAt: true },
        })
      : [];
    const accountById = new Map(accounts.map((a) => [a.id, a]));

    return users.map((u) => {
      const account = u.accountId ? accountById.get(u.accountId) : undefined;
      return {
        id: u.id,
        name: u.name,
        email: u.email,
        roleId: u.roleId,
        roleName: u.role.name,
        isActive: u.isActive,
        teacher: u.teacherId ? (teacherById.get(u.teacherId) ?? null) : null,
        lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
        // `local:` is the marker for somebody who signs in with a password;
        // anyone else arrived through SSO and has no account to describe.
        isLocal: u.erpUserId.startsWith("local:"),
        /**
         * Three states worth distinguishing on screen, and the middle one is
         * the reason this is not a boolean: "invited but never accepted" looks
         * exactly like "active" in a list of names, and it is the single
         * commonest thing an administrator needs to see.
         */
        state: !u.isActive
          ? "deactivated"
          : account?.status === "pending"
            ? "invited"
            : account
              ? "active"
              : "sso",
      };
    });
  }

  /** Invite one person: an account in the control plane, a membership here. */
  async invite(schoolId: number, input: InviteInput) {
    const school = await this.assertSelfServe(schoolId);
    const email = String(input.email ?? "").trim().toLowerCase();
    const name = String(input.name ?? "").trim();

    const role = await this.prisma.role.findFirst({
      where: { id: Number(input.roleId) || 0 },
      select: { id: true, name: true },
    });
    if (!role) throw new BadRequestException("Choose a role for this person.");

    const teacherId = Number(input.teacherId) || null;
    if (teacherId) await this.assertTeacherFree(schoolId, teacherId);

    // Refused BEFORE the account is created: a second membership would fail on
    // the unique key anyway, and failing after the invitation email has gone
    // out is the version somebody has to explain to the recipient.
    const existing = await this.prisma.user.findFirst({ where: { schoolId, email } });
    if (existing) {
      throw new BadRequestException(
        existing.isActive
          ? `${existing.name} already has a login here. Edit their role instead, or resend their invitation.`
          : `${existing.name} had a login here that was deactivated. Reactivate it rather than inviting them again.`,
      );
    }

    const account = await this.accounts.invite({
      email, name, schoolId, schoolName: school.name, roleId: role.id, teacherId,
    });

    const user = await this.prisma.user.create({
      data: {
        schoolId,
        // The same synthetic identity the self-serve creator gets, so the
        // unique key, the session token and every scope filter keep working.
        erpUserId: `local:${account.accountId}`,
        accountId: account.accountId,
        name: account.name,
        email: account.email,
        roleId: role.id,
        teacherId,
        // Active from the start, and it is not a hole: until they accept, the
        // account has an unguessable password and `status: pending`, so there
        // is nothing to sign in with. What this buys is that revoking an
        // un-accepted invitation is the same action as revoking a real login.
        isActive: true,
      },
    });
    this.logger.log(`Invited ${email} into school ${schoolId} as ${role.name}`);
    return { id: user.id, email: account.email, name: account.name, isNewAccount: account.isNew, role: role.name };
  }

  /**
   * §18 — one teacher, one login.
   *
   * Two users linked to the same teacher would each see "my timetable" and both
   * be right, and the substitute screen would have two people to notify for one
   * absence.
   */
  private async assertTeacherFree(schoolId: number, teacherId: number, exceptUserId?: number) {
    const teacher = await this.prisma.teacher.findFirst({ where: { id: teacherId, schoolId } });
    if (!teacher) throw new NotFoundException("Teacher not found");
    const taken = await this.prisma.user.findFirst({
      where: { schoolId, teacherId, ...(exceptUserId ? { id: { not: exceptUserId } } : {}) },
    });
    if (taken) {
      throw new BadRequestException(
        `${teacher.name} is already linked to ${taken.name}'s login. Unlink that one first.`,
      );
    }
  }

  /**
   * Invite every teacher who does not have a login yet (§24.8, 25.6d).
   *
   * What it reports is as important as what it does. Three groups are named
   * rather than folded into a count, because each has a different fix:
   * teachers who already have a login (nothing to do), teachers with no email
   * address (add one on the teacher screen), and `guest` teachers, who are
   * deliberately excluded — §18 keeps them out of the regular curriculum
   * entirely, so there is nothing for them to look at.
   */
  async inviteTeachers(
    schoolId: number,
    input: { wing?: unknown; roleId?: unknown; teacherIds?: unknown; dryRun?: unknown },
  ) {
    await this.assertSelfServe(schoolId);

    const role = Number(input.roleId)
      ? await this.prisma.role.findFirst({ where: { id: Number(input.roleId) } })
      : await this.prisma.role.findUnique({ where: { schoolId_name: { schoolId, name: TEACHER_ROLE } } });
    if (!role) {
      throw new BadRequestException(
        `This school has no "${TEACHER_ROLE}" role, so there is no view-only role to invite people into. ` +
          "Create one on the Roles & Access screen, or choose a role.",
      );
    }

    const only = Array.isArray(input.teacherIds)
      ? input.teacherIds.map((t) => Number(t)).filter((t) => Number.isInteger(t) && t > 0)
      : null;
    const wing = typeof input.wing === "string" && input.wing.trim() !== "" ? input.wing.trim() : null;

    const teachers = await this.prisma.teacher.findMany({
      where: {
        schoolId,
        isActive: true,
        ...(only ? { id: { in: only } } : {}),
      },
      orderBy: { name: "asc" },
    });

    // A wing is a `timetable_config`, and a teacher belongs to one through the
    // §18 eligibility rows — there is no `teachers.wing` column, and inventing
    // one here would be a second answer to a question §18 already answers.
    let inWing: Set<number> | null = null;
    if (wing) {
      const config = await this.prisma.timetableConfig.findFirst({ where: { schoolId, name: wing } });
      if (!config) throw new BadRequestException(`There is no timetable called "${wing}".`);
      const sections = await this.prisma.classSection.findMany({
        where: { schoolId, timetableConfigId: config.id },
        select: { classId: true },
      });
      const classIds = [...new Set(sections.map((s) => s.classId))];
      const scoped = classIds.length
        ? await this.prisma.teacherClassEligibility.findMany({
            where: { schoolId, classId: { in: classIds } },
            select: { teacherId: true },
          })
        : [];
      inWing = new Set(scoped.map((s) => s.teacherId));
    }

    const existing = await this.prisma.user.findMany({ where: { schoolId }, select: { email: true, teacherId: true } });
    const takenEmails = new Set(existing.map((u) => u.email.toLowerCase()));
    const takenTeachers = new Set(existing.map((u) => u.teacherId).filter((t): t is number => t !== null));

    const invite: typeof teachers = [];
    const alreadyIn: string[] = [];
    const noEmail: string[] = [];
    const guests: string[] = [];
    const notInWing: string[] = [];

    for (const t of teachers) {
      if (t.employmentType === "guest") { guests.push(t.name); continue; }
      if (inWing && !inWing.has(t.id)) { notInWing.push(t.name); continue; }
      if (takenTeachers.has(t.id) || (t.email && takenEmails.has(t.email.toLowerCase()))) {
        alreadyIn.push(t.name);
        continue;
      }
      // Reported, never dropped: a count that quietly excluded them would say
      // "invited 40 of 40" while eight people got nothing.
      if (!t.email?.trim()) { noEmail.push(t.name); continue; }
      invite.push(t);
    }

    const summary = {
      invited: [] as string[],
      alreadyHaveALogin: alreadyIn,
      noEmailAddress: noEmail,
      guestTeachers: guests,
      ...(wing ? { notInThisWing: notInWing } : {}),
      role: role.name,
      wouldInvite: invite.map((t) => t.name),
    };
    // A dry run is the screen's preview. The same arithmetic, no email sent —
    // so the confirmation cannot describe something different from the write.
    if (input.dryRun) return summary;

    for (const t of invite) {
      try {
        await this.invite(schoolId, { email: t.email, name: t.name, roleId: role.id, teacherId: t.id });
        summary.invited.push(t.name);
      } catch (e) {
        // One bad address must not abandon the other thirty-nine, and the
        // person it failed for has to be named rather than silently missing.
        summary.noEmailAddress.push(`${t.name} (${(e as Error).message})`);
      }
    }
    this.logger.log(`Bulk invite in school ${schoolId}: ${summary.invited.length} sent, role ${role.name}`);
    return summary;
  }

  /** Send the invitation again — a new token, and the old one dies with it. */
  async resend(schoolId: number, userId: number) {
    // OWNERSHIP FIRST, policy second — and the order is not cosmetic. Asked
    // about a row it does not own, this must answer 404 whatever else is true
    // of the school; answering "this school signs in through your ERP" tells a
    // stranger their id matched something. The §17.8 sweep found it, by the
    // rule it exists to enforce: a route that refuses everyone proves nothing.
    const user = await this.requireLocalUser(schoolId, userId);
    const school = await this.assertSelfServe(schoolId);

    if (this.control.available && user.accountId) {
      // Everything outstanding for this account is spent first. Two live
      // invitations to the same school is one more than anyone needs, and the
      // older link is the one that will be clicked from a stale inbox.
      await this.control.require().accountToken.updateMany({
        where: { accountId: user.accountId, purpose: "invite", usedAt: null },
        data: { usedAt: new Date() },
      });
    }
    await this.accounts.invite({
      email: user.email, name: user.name, schoolId,
      schoolName: school.name, roleId: user.roleId, teacherId: user.teacherId,
    });
    return { ok: true, email: user.email };
  }

  /**
   * Take the login away, keep the person.
   *
   * Never a delete: a user named in `audit_log` must stay resolvable, and the
   * row is what resolves them. It also makes revocation reversible, which
   * matters on the morning somebody deactivates the wrong Sharma.
   */
  async setActive(schoolId: number, userId: number, isActive: boolean) {
    // Ownership first — see `resend`.
    const user = await this.requireLocalUser(schoolId, userId);
    await this.assertSelfServe(schoolId);

    if (!isActive) {
      // The last way in must not be closable from inside. Counted on the ROLE's
      // permissions rather than its name, because a school may rename Super
      // Admin or build its own — the question is who can still manage roles.
      const admins = await this.prisma.user.findMany({
        where: { schoolId, isActive: true, id: { not: user.id } },
        select: { roleId: true },
      });
      const roleIds = [...new Set(admins.map((a) => a.roleId))];
      const withRoles = roleIds.length
        ? await this.prisma.rolePermission.findMany({
            where: { roleId: { in: roleIds }, permission: "roles.manage" },
            select: { roleId: true },
          })
        : [];
      if (withRoles.length === 0) {
        throw new BadRequestException(
          "This is the only login that can manage users here. Give somebody else that role first, " +
            "or the school would be locked out of its own administration.",
        );
      }
    }

    await this.prisma.user.update({ where: { id: user.id }, data: { isActive } });
    this.logger.log(`${isActive ? "Reactivated" : "Deactivated"} user ${user.id} in school ${schoolId}`);
    return { ok: true, isActive };
  }

  /**
   * The row, or a 404.
   *
   * Explicitly checked rather than relying on a scoped `updateMany` matching
   * nothing: another school's id is a 404, never a successful no-op (§17) —
   * `{ok: true}` for a write that did not happen is indistinguishable from one
   * that did, and becomes a real hole the moment somebody swaps in `update`.
   */
  private async requireLocalUser(schoolId: number, userId: number) {
    const user = await this.prisma.user.findFirst({ where: { id: userId, schoolId } });
    if (!user) throw new NotFoundException("User not found");
    if (!user.erpUserId.startsWith("local:")) {
      throw new ForbiddenException(
        `${user.name} signs in through the ERP, so their access is managed there.`,
      );
    }
    return user;
  }
}
