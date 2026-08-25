import { Body, Controller, NotFoundException, Post } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Public } from "./decorators";
import { ErpKeysService } from "./erp-keys.service";

interface DevErpTokenBody {
  erpUserId: string;
  erpRole: string;
  name: string;
  email: string;
  teacherId?: number;
  /** 9.1: lets the isolation suite sign in as a second school. Defaults to 1. */
  schoolId?: number;
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
      schoolId: Number(body.schoolId ?? 1),
      teacherId: body.teacherId ?? null,
    });
    return { token };
  }
}
