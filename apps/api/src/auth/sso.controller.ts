import { Controller, Get, Query, Res } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Response } from "express";
import { Public } from "./decorators";
import { AuthService } from "./auth.service";

/**
 * The only way into the app (§15.1): the ERP menu opens this callback with a
 * short-lived signed token. On success we redirect into the web app with our
 * own session token in the URL fragment; on failure, a "return to ERP" page —
 * never a local login form.
 */
@Controller("sso")
export class SsoController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Get("callback")
  async callback(@Query("token") token: string, @Res() res: Response) {
    const webUrl = this.config.get<string>("WEB_APP_URL") ?? "http://localhost:5173";
    if (!token) return res.redirect(`${webUrl}/sso-error`);
    try {
      const { sessionToken } = await this.authService.handleSsoToken(token);
      return res.redirect(`${webUrl}/sso#token=${sessionToken}`);
    } catch {
      return res.redirect(`${webUrl}/sso-error`);
    }
  }
}
