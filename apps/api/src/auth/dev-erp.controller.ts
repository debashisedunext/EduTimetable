import { Body, Controller, Get, NotFoundException, Post } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Public } from "./decorators";
import { ErpKeysService } from "./erp-keys.service";
import { PrismaBaseService } from "../prisma/prisma-base.service";
import type { ErpSchoolClaim, ErpTrustClaim } from "@edutimetable/shared";

interface DevErpTokenBody {
  erpUserId: string;
  erpRole: string;
  name: string;
  email: string;
  teacherId?: number;
  /** Legacy numeric id — still honoured, but names no school. Defaults to 1. */
  schoolId?: number;
  /** §17.4: the school this session opens in, as the ERP describes it. */
  school?: ErpSchoolClaim;
  /** Every school the user may work in — what the in-app switcher offers. */
  schools?: ErpSchoolClaim[];
  /** The trust these schools belong to. */
  trust?: ErpTrustClaim;
}

/**
 * Dev-only stand-in for the Edunext ERP's SSO issuer: signs a short-lived
 * RS256 token with the in-memory dev key so the real /sso/callback flow can be
 * exercised locally. Hard-disabled in production (and the dev private key
 * doesn't exist there anyway — ErpKeysService requires ERP_PUBLIC_KEY).
 */
@Controller("dev")
export class DevErpController {
  constructor(
    private readonly erpKeys: ErpKeysService,
    private readonly config: ConfigService,
    /** Unscoped by necessity: this is read before anybody has a session. */
    private readonly base: PrismaBaseService,
  ) {}

  @Public()
  @Post("erp-token")
  issue(@Body() body: DevErpTokenBody) {
    if (this.config.get("NODE_ENV") === "production" || !this.erpKeys.privateKey) {
      throw new NotFoundException();
    }
    const token = this.erpKeys.signDevErpToken({
      erpUserId: body.erpUserId,
      erpRole: body.erpRole,
      name: body.name,
      email: body.email,
      // The real ERP sends `school` (and `schools`/`trust` for a trust user);
      // `schoolId` remains for the pre-9.5 shape.
      ...(body.school ? { school: body.school } : { schoolId: Number(body.schoolId ?? 1) }),
      ...(body.schools ? { schools: body.schools } : {}),
      ...(body.trust ? { trust: body.trust } : {}),
      teacherId: body.teacherId ?? null,
    });
    return { token };
  }

  /**
   * Which school the sign-in screen's demo personas should open, and who to be.
   *
   * Asked of the server rather than hardcoded, because the answer changes: the
   * panel used to name `SCHOOL-1`, which the master seed left with two classes
   * and no timetable at all — four buttons into an empty app, which demonstrates
   * nothing. The school with the most PUBLISHED lessons is by definition the one
   * worth showing, and re-seeding moves the target without anybody editing the
   * front end.
   *
   * The teacher is chosen the same way: the busiest one who is also a class
   * teacher, so both My Timetable and My Classes have something in them. A
   * Teacher persona pointing at a teacher who teaches nothing demonstrates the
   * opposite of the point.
   *
   * **Dev only**, gated exactly where `/dev/erp-token` is — the personas walk
   * the real SSO hand-off, so this is only ever useful where the stub is live.
   */
  @Public()
  @Get("demo-target")
  async demoTarget() {
    if (this.config.get("NODE_ENV") === "production" || !this.erpKeys.privateKey) {
      throw new NotFoundException();
    }
    // Unscoped by necessity: nobody is signed in yet, so there is no tenant
    // context to scope by, and the question is precisely "which school".
    const bySchool = await this.base.timetableSlot.groupBy({
      by: ["schoolId"],
      where: { status: "published" },
      _count: { _all: true },
      orderBy: { _count: { schoolId: "desc" } },
      take: 1,
    });
    const schoolId = bySchool[0]?.schoolId ?? null;
    if (schoolId === null) return { school: null, teacher: null, published: 0 };

    const school = await this.base.school.findUnique({ where: { id: schoolId } });
    if (!school) return { school: null, teacher: null, published: 0 };

    // The busiest teacher who also owns a class-section.
    const load = await this.base.timetableSlot.groupBy({
      by: ["teacherId"],
      where: { schoolId, status: "published", teacherId: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { teacherId: "desc" } },
      take: 40,
    });
    let teacher: { id: number; name: string; periods: number } | null = null;
    for (const row of load) {
      if (row.teacherId === null) continue;
      const owns = await this.base.classSection.count({ where: { classTeacherId: row.teacherId } });
      if (owns === 0) continue;
      const t = await this.base.teacher.findUnique({ where: { id: row.teacherId } });
      if (!t) continue;
      teacher = { id: t.id, name: t.name, periods: row._count._all };
      break;
    }

    /**
     * The ERP roles this school actually maps.
     *
     * The panel renders only these, so it can never offer a button that dies at
     * the callback with "no role mapping" — which is what a Timetable Admin
     * persona did, because the seeded mappings are ADMIN, PRINCIPAL, TEACHER
     * and FRONT_OFFICE and nothing else. A demo that offers a door with no room
     * behind it is worse than one that offers four.
     */
    const mappings = await this.base.erpRoleMapping.findMany({
      where: { schoolId },
      select: { erpRole: true },
    });

    return {
      school: { code: school.code, name: school.name },
      teacher,
      published: bySchool[0]._count._all,
      erpRoles: mappings.map((m) => m.erpRole),
    };
  }
}
