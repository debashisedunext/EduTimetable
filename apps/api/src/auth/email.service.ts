/**
 * §15.3 Phase 25.0 — sending the three links that make local accounts work.
 *
 * Verification, password reset and (from 25.6) invitation. Three messages, one
 * shape: a one-shot link that expires.
 *
 * **The transport is a seam, not a decision taken now.** Which provider sends
 * production mail is an operational choice that has not been made, and guessing
 * one would mean a dependency and a set of credentials nobody asked for. So
 * this is an interface with a `log` transport that ships today, and one place
 * to add SMTP or an API client when the choice is made.
 *
 * **Dev capture is not a convenience, it is how the flow is testable.** A
 * verification link that only exists inside an email nobody can read makes the
 * whole registration path un-smoke-testable — which is precisely the path that
 * most needs a test. Captured messages go into Redis under a school-less
 * `mail:` prefix with a short TTL, readable only through a dev-gated endpoint.
 */
import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type Redis from "ioredis";
import { REDIS } from "../redis/redis.module";

export type MailKind = "verify" | "reset" | "invite";

export interface OutboundMail {
  to: string;
  kind: MailKind;
  subject: string;
  /** the one-shot URL the recipient is meant to open */
  link: string;
  body: string;
  at: string;
}

/** Long enough for a test or a developer to read it; short enough to be litter. */
const CAPTURE_TTL_SECONDS = 60 * 30;
const CAPTURE_MAX = 20;

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(
    private readonly config: ConfigService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  private get transport(): string {
    return this.config.get<string>("MAIL_TRANSPORT") ?? "log";
  }

  private get webUrl(): string {
    return this.config.get<string>("WEB_APP_URL") ?? "http://localhost:5174";
  }

  /** Where a captured message lives. Keyed by address, newest first. */
  private key(to: string) {
    return `mail:${to.trim().toLowerCase()}`;
  }

  async sendVerify(to: string, name: string, token: string): Promise<void> {
    const link = `${this.webUrl}/verify?token=${encodeURIComponent(token)}`;
    await this.send({
      to,
      kind: "verify",
      subject: "Confirm your email address",
      link,
      body:
        `Hello ${name},\n\n` +
        `Confirm this address to finish setting up your EduTimetable account:\n\n${link}\n\n` +
        `The link works once and expires in 24 hours.\n\n` +
        `If you did not create an account, you can ignore this message — nothing has been set up.`,
    });
  }

  async sendReset(to: string, name: string, token: string): Promise<void> {
    const link = `${this.webUrl}/reset?token=${encodeURIComponent(token)}`;
    await this.send({
      to,
      kind: "reset",
      subject: "Reset your password",
      link,
      body:
        `Hello ${name},\n\n` +
        `Use this link to choose a new password:\n\n${link}\n\n` +
        `The link works once and expires in 1 hour. Your current password keeps working until you do.\n\n` +
        `If you did not ask for this, you can ignore it — but if it keeps happening, somebody may know your address.`,
    });
  }

  /** Phase 25.6 uses this; it lives here so all three messages stay together. */
  async sendInvite(to: string, name: string, schoolName: string, token: string): Promise<void> {
    const link = `${this.webUrl}/invite?token=${encodeURIComponent(token)}`;
    await this.send({
      to,
      kind: "invite",
      subject: `${schoolName} has invited you to view your timetable`,
      link,
      body:
        `Hello ${name},\n\n` +
        `${schoolName} has set up an EduTimetable login for you. Choose a password to get started:\n\n${link}\n\n` +
        `The link works once and expires in 7 days.`,
    });
  }

  private async send(mail: Omit<OutboundMail, "at">): Promise<void> {
    const full: OutboundMail = { ...mail, at: new Date().toISOString() };

    if (this.transport === "log") {
      // Deliberately the whole link. In dev there is no inbox, and a log line
      // reading "sent an email" with no way to open it is not a workable
      // developer experience.
      this.logger.log(`[mail:${full.kind}] → ${full.to}\n${full.link}`);
    } else {
      // The seam. Add an SMTP or provider client here; nothing above changes.
      this.logger.warn(
        `MAIL_TRANSPORT=${this.transport} is not implemented — the ${full.kind} message to ` +
          `${full.to} was not sent. Set MAIL_TRANSPORT=log, or wire a transport in email.service.ts.`,
      );
    }

    await this.capture(full);
  }

  /**
   * Keep the message where a test can read it.
   *
   * Runs for every transport, including a real one, because "was the reset mail
   * actually generated?" is a question worth being able to answer in staging
   * without reading somebody's inbox.
   */
  private async capture(mail: OutboundMail): Promise<void> {
    try {
      const key = this.key(mail.to);
      await this.redis.lpush(key, JSON.stringify(mail));
      await this.redis.ltrim(key, 0, CAPTURE_MAX - 1);
      await this.redis.expire(key, CAPTURE_TTL_SECONDS);
    } catch (e) {
      // Never let a capture failure break a sign-up.
      this.logger.warn(`Could not capture ${mail.kind} mail: ${(e as Error).message}`);
    }
  }

  /** Dev-gated read-back. See `dev-mail.controller.ts`. */
  async captured(to: string, limit = 5): Promise<OutboundMail[]> {
    const raw = await this.redis.lrange(this.key(to), 0, limit - 1);
    return raw.map((r) => JSON.parse(r) as OutboundMail);
  }
}
