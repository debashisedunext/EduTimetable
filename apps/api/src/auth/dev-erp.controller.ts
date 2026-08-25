import { Body, Controller, NotFoundException, Post } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Public } from "./decorators";
import { ErpKeysService } from "./erp-keys.service";
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
}
