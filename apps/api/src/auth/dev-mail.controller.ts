/**
 * Dev-only: read the messages the app would have emailed.
 *
 * The registration and reset flows are exactly the paths that most need a live
 * test, and both of them hinge on a one-shot link that exists only inside an
 * email. Without a way to read it, the smoke test can prove that a mail was
 * *attempted* and nothing else — which is the half that never breaks.
 *
 * Gated on `NODE_ENV !== "production"` in the same way `dev-erp.controller.ts`
 * is, and registered only when the dev module is. It reads a short-lived Redis
 * capture and can therefore expose a live reset link, which is precisely why it
 * must never exist in production.
 */
import { Controller, ForbiddenException, Get, Query } from "@nestjs/common";
import { Public } from "./decorators";
import { EmailService } from "./email.service";

@Controller("dev/mail")
export class DevMailController {
  constructor(private readonly email: EmailService) {}

  private assertDev() {
    if (process.env.NODE_ENV === "production") {
      throw new ForbiddenException("Not available");
    }
  }

  /** The most recent captured messages for one address, newest first. */
  @Public()
  @Get()
  async list(@Query("to") to: string, @Query("limit") limit?: string) {
    this.assertDev();
    if (!to) return [];
    return this.email.captured(to, Math.min(Number(limit) || 5, 20));
  }

  /**
   * The token out of the newest message of a kind — what a test actually wants.
   *
   * Returns the raw token rather than the link so the caller does not have to
   * parse a URL to use it.
   */
  @Public()
  @Get("token")
  async token(@Query("to") to: string, @Query("kind") kind?: string) {
    this.assertDev();
    const wanted = kind ?? "verify";
    const found = (await this.email.captured(to, 20)).find((m) => m.kind === wanted);
    if (!found) return { token: null };
    const url = new URL(found.link);
    // Two link shapes, because they are two different routes. Verify and reset
    // land on query-string screens; an invitation is `/invite/:token`, a PATH,
    // so that a link pasted into a chat window survives intact. Reading only
    // the query string made every invitation look unsent.
    const token = url.searchParams.get("token")
      ?? (url.pathname.match(/\/invite\/([^/]+)$/)?.[1] ?? null);
    return { token: token ? decodeURIComponent(token) : null, link: found.link, at: found.at };
  }
}
