/**
 * §15.3 Phase 25.0 — the guard for endpoints an account can reach before it is
 * inside any school.
 *
 * Deliberately separate from `JwtAuthGuard`, and deliberately narrow. The two
 * tokens mean different things and must never be interchangeable:
 *
 *   - a **session** token says "you are user 12 in school 3, with role 4" and
 *     unlocks the whole app, scoped to that school;
 *   - an **account** token says only "you are account 42" and unlocks listing
 *     your schools, creating one, and reading your own profile.
 *
 * Anything protected by this guard must be safe for somebody who belongs to no
 * school at all, because that is exactly who holds one of these.
 */
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type { AccountTokenPayload } from "@edutimetable/shared";

export interface AccountRequest {
  account: AccountTokenPayload;
  ip?: string;
}

@Injectable()
export class AccountAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const header: string | undefined = request.headers?.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (!token) throw new UnauthorizedException("Missing bearer token");

    let payload: AccountTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AccountTokenPayload>(token);
    } catch {
      throw new UnauthorizedException("Invalid or expired session");
    }

    // A session token is signed by the same key, so signature alone does not
    // distinguish them. Requiring the discriminator is what stops a school
    // session being spent here — where nothing would be school-scoped.
    if (payload?.typ !== "account" || typeof payload.sub !== "number") {
      throw new UnauthorizedException("This endpoint needs an account sign-in");
    }

    request.account = payload;
    return true;
  }
}
