/**
 * §15.3 Phase 25.0 — the public sign-in surface.
 *
 * Five endpoints a stranger may call, and one that needs the account token they
 * get back. Everything here is `@Public()` **on purpose and by inspection** —
 * these are the doors, so the §17.8 sweep classifies them as deliberately
 * unauthenticated rather than accidentally so.
 *
 * There is nothing school-scoped in this file, and there must not be: at this
 * point nobody has chosen a school, and for a fresh account none exists.
 */
import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { Public } from "./decorators";
import { AccountService } from "./account.service";
import { AccountAuthGuard, type AccountRequest } from "./account-auth.guard";

/**
 * The source address, for throttling.
 *
 * `X-Forwarded-For` is only trusted when the app sits behind a proxy that sets
 * it — the compose stack does not, so `req.ip` is the honest answer here and
 * the header is read only as a fallback. Getting this backwards behind a load
 * balancer would make every request look like one IP and turn the per-IP limit
 * into a global one.
 */
function sourceIp(req: Request): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(",")[0];
  return (req.ip || first || "unknown").trim();
}

@Controller("auth")
export class LocalAuthController {
  constructor(private readonly accounts: AccountService) {}

  /** Create an account. Always answers the same, whether or not the address is known. */
  @Public()
  @Post("register")
  register(@Req() req: Request, @Body() body: Record<string, string>) {
    return this.accounts.register(
      {
        email: body.email,
        password: body.password,
        name: body.name,
        phone: body.phone,
        organisation: body.organisation,
        country: body.country,
        jobRole: body.jobRole,
      },
      sourceIp(req),
    );
  }

  /**
   * Confirm an address and sign in.
   *
   * POST rather than GET even though it arrives from a link: a GET would be
   * spent by any mail scanner or link previewer that fetches URLs, and the user
   * would meet "this link has already been used" without ever clicking it. The
   * web page reads the token from the query string and posts it.
   */
  @Public()
  @Post("verify")
  verify(@Body("token") token: string) {
    return this.accounts.verify(token);
  }

  @Public()
  @Post("login")
  login(@Req() req: Request, @Body() body: { email: string; password: string }) {
    return this.accounts.login(body?.email, body?.password, sourceIp(req));
  }

  @Public()
  @Post("forgot")
  forgot(@Req() req: Request, @Body("email") email: string) {
    return this.accounts.forgot(email, sourceIp(req));
  }

  @Public()
  @Post("reset")
  reset(@Body() body: { token: string; password: string }) {
    return this.accounts.reset(body?.token, body?.password);
  }

  /**
   * Who the account token belongs to.
   *
   * Distinct from `GET /me`, which describes a user *inside a school* and needs
   * a session token. This one answers for somebody who may not be in any school
   * yet — which is the whole reason the two tokens are separate.
   */
  @Public()
  @UseGuards(AccountAuthGuard)
  @Get("account")
  async account(@Req() req: Request & AccountRequest) {
    const account = await this.accounts.byId(req.account.sub);
    if (!account) throw new UnauthorizedException("This account is no longer active");
    return account;
  }

  /**
   * Whether local accounts work on this deployment at all.
   *
   * The home page asks before it offers a Create account button: a
   * single-school install with no control plane can only be entered through
   * SSO, and offering a form that always fails is worse than not offering it.
   */
  @Public()
  @Get("methods")
  methods() {
    return this.accounts.methods();
  }

  /** Reserved so a query-string arrival has somewhere to land. */
  @Public()
  @Get("verify")
  verifyHint(@Query("token") token: string) {
    return { token: Boolean(token), message: "POST this token to /auth/verify." };
  }
}
