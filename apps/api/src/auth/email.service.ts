/**
 * §15.3 Phase 25.0 — sending the three links that make local accounts work.
 *
 * Verification, password reset and (from 25.6) invitation. Three messages, one
 * shape: a one-shot link that expires.
 *
 * **Two transports.** `smtp` is the real one and speaks the protocol every mail
 * provider offers, so choosing between SES, Postmark, Mailgun or a school's own
 * server is a matter of credentials rather than code. `log` writes the link to
 * the application log and is the default, because a deployment with no mail
 * server configured should be obviously un-configured rather than quietly
 * failing to deliver.
 *
 * The transport is checked at STARTUP, not at the first send. A missing
 * `MAIL_HOST` discovered when somebody registers is a broken sign-up; the same
 * mistake discovered when the container boots is a line in the log before
 * anybody has tried.
 *
 * **Dev capture is not a convenience, it is how the flow is testable.** A
 * verification link that only exists inside an email nobody can read makes the
 * whole registration path un-smoke-testable — which is precisely the path that
 * most needs a test. Captured messages go into Redis under a school-less
 * `mail:` prefix with a short TTL, readable only through a dev-gated endpoint.
 */
import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createTransport, type Transporter } from "nodemailer";
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
export class EmailService implements OnModuleInit {
  private readonly logger = new Logger(EmailService.name);
  private smtp: Transporter | null = null;

  constructor(
    private readonly config: ConfigService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  private get transport(): string {
    return this.config.get<string>("MAIL_TRANSPORT") ?? "log";
  }

  /** The address messages come FROM. Some providers refuse anything else. */
  private get from(): string {
    return this.config.get<string>("MAIL_FROM") ?? "EduTimetable <no-reply@edutimetable.local>";
  }

  /**
   * Built once, at startup, and said out loud.
   *
   * A pool because the bulk teacher invite sends one message per teacher and
   * opening a TLS connection per message is how a fifty-teacher school times
   * out. Nodemailer verifies the connection here rather than at the first send,
   * so a wrong host or a rejected password is a boot-time log line instead of a
   * failed sign-up.
   */
  async onModuleInit(): Promise<void> {
    if (this.transport !== "smtp") {
      this.logger.log(`Mail transport: ${this.transport} (links are written to this log, not sent)`);
      return;
    }
    const host = this.config.get<string>("MAIL_HOST");
    if (!host) {
      this.logger.error(
        "MAIL_TRANSPORT=smtp but MAIL_HOST is not set — no mail can be sent. " +
          "Set MAIL_HOST/MAIL_PORT (and MAIL_USER/MAIL_PASSWORD if the server wants them), " +
          "or set MAIL_TRANSPORT=log.",
      );
      return;
    }
    const port = Number(this.config.get<string>("MAIL_PORT") ?? 587);
    const user = this.config.get<string>("MAIL_USER");
    const pass = this.config.get<string>("MAIL_PASSWORD");
    this.smtp = createTransport({
      host,
      port,
      // Implicit TLS on 465; everything else negotiates STARTTLS, which is what
      // 587 and a local relay both expect.
      secure: this.config.get<string>("MAIL_SECURE") === "true" || port === 465,
      ...(user ? { auth: { user, pass } } : {}),
      pool: true,
      maxConnections: 3,
    });
    try {
      await this.smtp.verify();
      this.logger.log(`Mail transport: smtp via ${host}:${port}${user ? ` as ${user}` : " (no auth)"}`);
    } catch (e) {
      // Kept, not discarded: a mail server that is down at boot is usually up
      // again by the first send, and refusing to start the API over it would
      // take the whole application down with the mail server.
      this.logger.error(`SMTP at ${host}:${port} did not answer at startup: ${(e as Error).message}`);
    }
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
    // PATH, not a query string — `/invite/:token` is the route (§24.8). It was
    // written as `?token=` and matched nothing, so every invitation link ever
    // sent would have landed on a page that does not exist.
    const link = `${this.webUrl}/invite/${encodeURIComponent(token)}`;
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

  /**
   * Send, and THROW if it could not be sent.
   *
   * Deliberately not swallowed. A caller that would rather carry on — sign-up,
   * where the account is already usable and the confirmation can be re-sent —
   * catches it and says so; one that cannot — an invitation, whose entire
   * content is a link only the recipient can use — lets it surface, so the
   * administrator learns now rather than when the teacher says nothing arrived.
   */
  private async send(mail: Omit<OutboundMail, "at">): Promise<void> {
    const full: OutboundMail = { ...mail, at: new Date().toISOString() };
    // Captured FIRST, so a message that fails to send is still inspectable —
    // "was it even generated?" is the first question when nothing arrives.
    await this.capture(full);

    if (this.transport === "log") {
      // Deliberately the whole link. With no mail server there is no inbox, and
      // a log line reading "sent an email" with no way to open it is not a
      // workable developer experience.
      this.logger.log(`[mail:${full.kind}] → ${full.to}\n${full.link}`);
      return;
    }
    if (this.transport !== "smtp") {
      throw new Error(
        `MAIL_TRANSPORT=${this.transport} is not a transport this build knows. Use "smtp" or "log".`,
      );
    }
    if (!this.smtp) {
      throw new Error("SMTP is selected but not configured — MAIL_HOST is missing.");
    }

    await this.smtp.sendMail({
      from: this.from,
      to: full.to,
      subject: full.subject,
      text: full.body,
      html: this.html(full),
    });
    this.logger.log(`Sent ${full.kind} mail to ${full.to}`);
  }

  /**
   * A plain, deliberately unstyled HTML part.
   *
   * The text part is the message; this exists so the link is clickable in
   * clients that hide bare URLs. No images, no external stylesheet, no tracking
   * pixel — a school's verification mail should survive the strictest filter
   * its IT department has, and every one of those is a reason to be quarantined.
   */
  private html(mail: OutboundMail): string {
    const escape = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const paragraphs = mail.body
      .split("\n\n")
      // The link is rendered as a link rather than repeated as text.
      .filter((p) => p.trim() !== "" && p.trim() !== mail.link)
      .map((p) => `<p style="margin:0 0 14px">${escape(p).replace(/\n/g, "<br>")}</p>`)
      .join("");
    return (
      `<div style="font:14px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#141B26;max-width:520px">` +
      paragraphs +
      `<p style="margin:0 0 18px"><a href="${escape(mail.link)}" ` +
      `style="display:inline-block;background:#2563EB;color:#fff;text-decoration:none;` +
      `padding:11px 18px;border-radius:8px;font-weight:600">${escape(mail.subject)}</a></p>` +
      `<p style="margin:0;color:#8695A9;font-size:12px">If the button does not work, paste this into your browser:<br>` +
      `${escape(mail.link)}</p></div>`
    );
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
