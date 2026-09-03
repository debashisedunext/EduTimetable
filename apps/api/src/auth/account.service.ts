/**
 * §15.3 Phase 25.0 — registering, verifying, signing in, and resetting.
 *
 * Everything here runs against the CONTROL PLANE, never a tenant database: one
 * person has one password however many schools they run, and `users` is one row
 * per school. See the comment above `Account` in `prisma/control/schema.prisma`.
 *
 * Three rules shape almost every method below.
 *
 * **The answer never depends on whether the address exists.** Register, forgot
 * and login all return the same thing for a known and an unknown address, and —
 * for login — take the same TIME, by hashing against a dummy. Otherwise
 * "is this school a customer of yours?" is a question anyone can ask by timing
 * a few requests, and the answer is a list of your customers.
 *
 * **A token is never stored.** Only its SHA-256. A leaked backup of
 * `account_tokens` hands nobody a working link.
 *
 * **A password change invalidates everything outstanding.** Reset tokens,
 * verification links, the lockout counter. Somebody who has just proved control
 * of the mailbox should not be shadowed by a link issued before they did.
 */
import { BadRequestException, Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { createHash, randomBytes } from "node:crypto";
import type { AccountTokenPayload } from "@edutimetable/shared";
import { ControlPrismaService } from "../control/control-prisma.service";
import { EmailService } from "./email.service";
import { LoginThrottleService } from "./login-throttle.service";
import { PasswordService } from "./password.service";
import { ErpKeysService } from "./erp-keys.service";

const VERIFY_TTL_HOURS = 24;
const RESET_TTL_HOURS = 1;
/** A week: long enough to survive a holiday, short enough to be worth re-issuing. */
const INVITE_TTL_HOURS = 24 * 7;
const ACCOUNT_SESSION = "8h";

/**
 * One sentence, used for every outcome of `login`.
 *
 * Wrong password, unknown address, unverified account and locked-out account
 * all produce this. Each of the alternatives ("no such user", "please verify
 * first", "account locked") confirms that the address is real.
 */
const LOGIN_REFUSED = "That email and password do not match an account.";

/** Likewise for register and forgot — the same words whatever we did. */
const CHECK_YOUR_EMAIL =
  "If that address can be used, an email is on its way. Check your inbox, and your spam folder.";

export interface RegisterInput {
  email: string;
  password: string;
  name: string;
  phone?: string;
  organisation?: string;
  country?: string;
  jobRole?: string;
}

@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    private readonly control: ControlPrismaService,
    private readonly passwords: PasswordService,
    private readonly email: EmailService,
    private readonly throttle: LoginThrottleService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly erpKeys: ErpKeysService,
  ) {}

  /**
   * Local accounts need the control plane. A single-school deployment that
   * never ran `migrate:control` has no registry, and rather than half-work it
   * says so — the same posture `ControlPrismaService.require()` takes.
   */
  private db() {
    if (!this.control.available) {
      throw new BadRequestException(
        "Local accounts are not available on this deployment — sign in through your ERP. " +
          "(Operators: this needs CONTROL_DATABASE_URL and `pnpm migrate:control`.)",
      );
    }
    return this.control.require();
  }

  private normalise(email: unknown): string {
    return String(email ?? "").trim().toLowerCase();
  }

  private looksLikeEmail(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 160;
  }

  // ─────────────────────────────────────────────────────────── tokens

  /** A fresh one-shot token: the secret to email, and the hash to store. */
  private mintToken(): { secret: string; hash: string } {
    const secret = randomBytes(32).toString("base64url");
    return { secret, hash: createHash("sha256").update(secret).digest("hex") };
  }

  private hashToken(secret: string): string {
    return createHash("sha256").update(String(secret ?? "")).digest("hex");
  }

  private async issueToken(
    accountId: number,
    purpose: "verify" | "reset" | "invite",
    ttlHours: number,
    meta?: Record<string, unknown>,
  ): Promise<string> {
    const { secret, hash } = this.mintToken();
    await this.db().accountToken.create({
      data: {
        accountId,
        purpose,
        tokenHash: hash,
        expiresAt: new Date(Date.now() + ttlHours * 3_600_000),
        ...(meta ? { meta: meta as never } : {}),
      },
    });
    return secret;
  }

  /**
   * Redeem a token, or refuse.
   *
   * Marking it used and acting on it must not be separable — two requests
   * arriving together would otherwise both find it unused. `updateMany` with
   * `usedAt: null` in the WHERE makes the claim atomic: exactly one of them
   * gets `count: 1`.
   */
  private async consumeToken(secret: string, purpose: "verify" | "reset" | "invite") {
    const db = this.db();
    const row = await db.accountToken.findUnique({
      where: { tokenHash: this.hashToken(secret) },
      include: { account: true },
    });
    if (!row || row.purpose !== purpose) return null;
    if (row.usedAt !== null) return null;
    if (row.expiresAt.getTime() < Date.now()) return null;

    const claimed = await db.accountToken.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (claimed.count !== 1) return null; // somebody else got there first
    return row;
  }

  // ─────────────────────────────────────────────────────────── register

  async register(input: RegisterInput, ip: string): Promise<{ message: string }> {
    const email = this.normalise(input.email);
    const name = String(input.name ?? "").trim();

    if (!this.looksLikeEmail(email)) throw new BadRequestException("Enter a valid email address.");
    if (name.length < 2) throw new BadRequestException("Enter your name.");
    const bad = this.passwords.problemWith(input.password);
    if (bad) throw new BadRequestException(bad);

    if (await this.throttle.signupBudgetExceeded(ip)) {
      throw new BadRequestException("Too many attempts from this connection. Try again later.");
    }

    const db = this.db();
    const existing = await db.account.findUnique({ where: { email } });

    if (existing) {
      // Deliberately NOT an error. "That email is already registered" is the
      // single most common way an application hands over its user list. The
      // real owner of the mailbox is told instead — which is both safe and
      // more useful than a form error the wrong person would see.
      this.logger.warn(`Registration attempted for an existing account (${email})`);
      if (existing.status !== "suspended") {
        const secret = await this.issueToken(existing.id, "reset", RESET_TTL_HOURS);
        await this.tellThem(() => this.email.sendReset(existing.email, existing.name, secret));
      }
      return { message: CHECK_YOUR_EMAIL };
    }

    const account = await db.account.create({
      data: {
        email,
        name,
        passwordHash: await this.passwords.hash(input.password),
        phone: input.phone?.trim() || null,
        organisation: input.organisation?.trim() || null,
        country: input.country?.trim() || null,
        jobRole: input.jobRole?.trim() || null,
        // Registering from the home page is what makes somebody an owner. An
        // account created by an invitation (25.6) is a `member` and can never
        // create a school.
        kind: "owner",
        status: "pending",
      },
    });

    const secret = await this.issueToken(account.id, "verify", VERIFY_TTL_HOURS);
    await this.tellThem(() => this.email.sendVerify(account.email, account.name, secret));
    this.logger.log(`Account ${account.id} registered (${email}) — verification sent`);
    return { message: CHECK_YOUR_EMAIL };
  }

  // ───────────────────────────────────────────────────────────── verify

  /**
   * Confirm the address and sign them straight in.
   *
   * Signing in here rather than bouncing to a login form is deliberate: they
   * have just proved control of the mailbox seconds ago, which is a stronger
   * claim than the password they are about to be asked for.
   */
  async verify(secret: string): Promise<{ accountToken: string; account: PublicAccount }> {
    const row = await this.consumeToken(secret, "verify");
    if (!row) {
      throw new BadRequestException(
        "That link has expired or has already been used. Sign in and we will send a new one.",
      );
    }
    const account = await this.db().account.update({
      where: { id: row.accountId },
      data: {
        status: row.account.status === "suspended" ? "suspended" : "active",
        emailVerifiedAt: row.account.emailVerifiedAt ?? new Date(),
        lastLoginAt: new Date(),
        failedLogins: 0,
        lockedUntil: null,
      },
    });
    if (account.status === "suspended") throw new UnauthorizedException(LOGIN_REFUSED);
    this.logger.log(`Account ${account.id} verified`);
    return { accountToken: await this.signAccountToken(account), account: publicAccount(account) };
  }

  // ────────────────────────────────────────────────────────────── login

  async login(
    emailRaw: string,
    password: string,
    ip: string,
  ): Promise<{ accountToken: string; account: PublicAccount }> {
    const email = this.normalise(emailRaw);
    const plain = typeof password === "string" ? password : "";

    if (await this.throttle.ipBlocked(ip)) {
      throw new UnauthorizedException(
        "Too many failed attempts from this connection. Try again in a few minutes.",
      );
    }

    const db = this.db();
    const account = await db.account.findUnique({ where: { email } });

    // No account: still hash, so this path costs what the real one costs.
    // Skipping it makes "unknown address" ~1 ms and "wrong password" ~113 ms,
    // and that gap is a customer list anybody can read over the network.
    if (!account) {
      await this.passwords.burnEqualTime(plain);
      await this.throttle.recordIpFailure(ip);
      throw new UnauthorizedException(LOGIN_REFUSED);
    }

    // A locked or suspended account is refused with the SAME sentence as a
    // wrong password. "Please verify your email first" would confirm the
    // address is registered.
    //
    // An UNVERIFIED account is deliberately let in. Verification used to gate
    // sign-in, which meant a new customer filled in the form and was then sent
    // to their inbox before they had seen anything at all — the highest-friction
    // moment in the product, spent on a round trip. It still gates what actually
    // needs proving (see `POST /schools`: an unverified account gets its first
    // school and no more), and the email still goes out. What it no longer does
    // is stand between somebody and the thing they just signed up to look at.
    const locked = this.throttle.isLocked(account);
    const ok = await this.passwords.verify(plain, account.passwordHash);

    if (!ok || locked || account.status === "suspended") {
      if (!ok) {
        const next = this.throttle.nextFailureState(account);
        await db.account.update({ where: { id: account.id }, data: next });
        if (next.lockedUntil) {
          this.logger.warn(`Account ${account.id} locked after ${next.failedLogins} failures`);
        }
      }
      await this.throttle.recordIpFailure(ip);
      throw new UnauthorizedException(LOGIN_REFUSED);
    }

    // Success: clear both counters, and quietly upgrade the hash if the cost
    // has been raised since it was made. The plaintext is in hand exactly now
    // and never again, so this is the only moment it can be done without
    // asking anybody to reset anything.
    const rehash = this.passwords.needsRehash(account.passwordHash)
      ? { passwordHash: await this.passwords.hash(plain) }
      : {};
    if (Object.keys(rehash).length > 0) {
      this.logger.log(`Upgraded the password hash for account ${account.id}`);
    }
    const fresh = await db.account.update({
      where: { id: account.id },
      data: { lastLoginAt: new Date(), failedLogins: 0, lockedUntil: null, ...rehash },
    });
    await this.throttle.clearIp(ip);

    return { accountToken: await this.signAccountToken(fresh), account: publicAccount(fresh) };
  }

  // ───────────────────────────────────────────────────── forgot / reset

  async forgot(emailRaw: string, ip: string): Promise<{ message: string }> {
    const email = this.normalise(emailRaw);
    if (await this.throttle.signupBudgetExceeded(ip)) {
      // Same words as success. A different answer here would make this endpoint
      // an address-existence oracle with no password needed at all.
      return { message: CHECK_YOUR_EMAIL };
    }
    const account = await this.db().account.findUnique({ where: { email } });
    if (account && account.status !== "suspended") {
      const secret = await this.issueToken(account.id, "reset", RESET_TTL_HOURS);
      await this.tellThem(() => this.email.sendReset(account.email, account.name, secret));
      this.logger.log(`Password reset requested for account ${account.id}`);
    }
    return { message: CHECK_YOUR_EMAIL };
  }

  async reset(secret: string, newPassword: string): Promise<{ message: string }> {
    const bad = this.passwords.problemWith(newPassword);
    if (bad) throw new BadRequestException(bad);

    const row = await this.consumeToken(secret, "reset");
    if (!row) {
      throw new BadRequestException(
        "That link has expired or has already been used. Ask for a new one.",
      );
    }
    const db = this.db();
    await db.account.update({
      where: { id: row.accountId },
      data: {
        passwordHash: await this.passwords.hash(newPassword),
        // Proving control of the mailbox is at least as strong as clicking a
        // verification link, so a reset also verifies and unlocks.
        status: row.account.status === "suspended" ? "suspended" : "active",
        emailVerifiedAt: row.account.emailVerifiedAt ?? new Date(),
        failedLogins: 0,
        lockedUntil: null,
      },
    });
    // Everything else outstanding dies with it: an older reset link still
    // sitting in an inbox must not be able to change the password again.
    await db.accountToken.updateMany({
      where: { accountId: row.accountId, usedAt: null },
      data: { usedAt: new Date() },
    });
    this.logger.log(`Password reset completed for account ${row.accountId}`);
    return { message: "Your password has been changed. Sign in with it." };
  }

  /**
   * Send, and never let the failure change the answer.
   *
   * `register` and `forgot` return the SAME sentence for a known and an unknown
   * address — that is the whole anti-enumeration property this file is built
   * around. Letting a mail failure become a 500 would break it in the most
   * useful direction for an attacker: a known address errors, an unknown one
   * succeeds, and the difference is a customer list. So it is logged loudly and
   * swallowed.
   *
   * Safe to swallow here in a way it is NOT for an invitation, because these
   * paths have another way through: since Phase 25.7 registration signs the
   * person straight in, and a reset can be asked for again. An invitation is
   * only a link, so `UsersService` deliberately lets that one surface.
   */
  private async tellThem(send: () => Promise<void>): Promise<void> {
    try {
      await send();
    } catch (e) {
      this.logger.error(`Could not send account mail: ${(e as Error).message}`);
    }
  }

  // ───────────────────────────────────────────────────────────── invite

  /**
   * The control-plane half of inviting somebody into a school (§24.8).
   *
   * Returns the account to attach a `users` row to, and the secret to email.
   * The `users` row itself is the caller's business — it lives in a tenant
   * database and this service has never touched one.
   *
   * **An invitation is not a way to take over an account.** Where the address
   * already belongs to somebody, this attaches the invitation to that account
   * and changes nothing else about it: not its password, not its `kind`, not
   * its verification. A school administrator can decide who may enter *their*
   * school; they cannot decide anything about a person who already exists — and
   * an invite that could downgrade an owner to a member would let any admin
   * strip school-creation from anyone whose email address they can guess.
   */
  async invite(input: {
    email: string;
    name: string;
    schoolId: number;
    schoolName: string;
    roleId: number;
    teacherId?: number | null;
  }): Promise<{ accountId: number; secret: string; isNew: boolean; email: string; name: string }> {
    const email = this.normalise(input.email);
    const name = String(input.name ?? "").trim().slice(0, 120);
    if (!this.looksLikeEmail(email)) throw new BadRequestException(`"${input.email}" is not a valid email address.`);
    if (name.length < 2) throw new BadRequestException("Enter the person's name.");

    const db = this.db();
    let account = await db.account.findUnique({ where: { email } });
    const isNew = account === null;

    if (!account) {
      account = await db.account.create({
        data: {
          email,
          name,
          // An unguessable value, not an empty string: until they accept there
          // is no password that works, and there is no state in which a blank
          // or a default one would.
          passwordHash: await this.passwords.hash(randomBytes(32).toString("base64url")),
          // Invited, therefore a member: they may enter the schools they are
          // invited into and can never create one (§17.6's reasoning, one level
          // down — the authority to make a school is not a school's to grant).
          kind: "member",
          status: "pending",
        },
      });
    } else if (account.status === "suspended") {
      throw new BadRequestException(
        "That address belongs to a suspended account and cannot be invited. Contact support.",
      );
    }

    const secret = await this.issueToken(account.id, "invite", INVITE_TTL_HOURS, {
      schoolId: input.schoolId,
      roleId: input.roleId,
      teacherId: input.teacherId ?? null,
    });
    // NOT sent here. The caller sends, after the `users` row exists — otherwise
    // a mail server having a bad minute leaves an account and a live token with
    // no membership to attach them to: nothing on the Users screen, nothing to
    // press Resend on, and an administrator who has to guess what happened.
    this.logger.log(`Prepared an invitation for account ${account.id} into school ${input.schoolId}${isNew ? " (new)" : ""}`);
    return { accountId: account.id, secret, isNew, email: account.email, name: account.name };
  }

  /**
   * What an invitation link says, WITHOUT spending it.
   *
   * The acceptance screen has to show who is being invited before a password is
   * typed, and looking is not accepting: a mail client that pre-fetches links
   * would otherwise burn the invitation before the person ever clicked it.
   */
  async inviteDetails(secret: string): Promise<{ email: string; name: string; needsPassword: boolean } | null> {
    const row = await this.db().accountToken.findUnique({
      where: { tokenHash: this.hashToken(secret) },
      include: { account: true },
    });
    if (!row || row.purpose !== "invite" || row.usedAt !== null) return null;
    if (row.expiresAt.getTime() < Date.now()) return null;
    return {
      email: row.account.email,
      name: row.account.name,
      // Somebody who already has a working password is joining a second school,
      // not creating an identity. Asking them to choose a new one would be
      // asking them to change the password they use everywhere else.
      needsPassword: row.account.status === "pending",
    };
  }

  /**
   * Accept an invitation: set a password if this is a new identity, and hand
   * back a session-less account token.
   *
   * Deliberately control-plane ONLY. It does not create or check the `users`
   * row — `POST /schools/:id/enter` already refuses an account with no active
   * user row in the school, and that is the right place for the check to live:
   * an invitation that was revoked between sending and accepting must be
   * refused at the door, not remembered here.
   */
  async acceptInvite(
    secret: string,
    password: string | undefined,
  ): Promise<{ accountToken: string; account: PublicAccount; schoolId: number | null }> {
    const preview = await this.inviteDetails(secret);
    if (!preview) {
      throw new BadRequestException(
        "That invitation has expired or has already been used. Ask for a new one.",
      );
    }
    if (preview.needsPassword) {
      const bad = this.passwords.problemWith(password ?? "");
      if (bad) throw new BadRequestException(bad);
    }

    const row = await this.consumeToken(secret, "invite");
    if (!row) throw new BadRequestException("That invitation has expired or has already been used.");

    const db = this.db();
    const account = await db.account.update({
      where: { id: row.accountId },
      data: {
        ...(preview.needsPassword && password
          ? { passwordHash: await this.passwords.hash(password) }
          : {}),
        status: "active",
        // Clicking a link in the mailbox proves control of it, exactly as the
        // verification link does.
        emailVerifiedAt: row.account.emailVerifiedAt ?? new Date(),
        failedLogins: 0,
        lockedUntil: null,
      },
    });
    const meta = (row.meta ?? {}) as { schoolId?: number };
    this.logger.log(`Account ${account.id} accepted an invitation into school ${meta.schoolId}`);
    return {
      accountToken: await this.signAccountToken(account),
      account: publicAccount(account),
      schoolId: typeof meta.schoolId === "number" ? meta.schoolId : null,
    };
  }

  // ──────────────────────────────────────────────────────────── session

  private signAccountToken(account: { id: number; email: string; kind: string }): Promise<string> {
    const payload: AccountTokenPayload = {
      typ: "account",
      sub: account.id,
      email: account.email,
      kind: account.kind === "member" ? "member" : "owner",
    };
    return this.jwt.signAsync(payload, { expiresIn: ACCOUNT_SESSION });
  }

  /**
   * What ways in this deployment actually offers.
   *
   * Asked by the home page before it renders a Create account button: a
   * single-school install with no control plane can only be entered through
   * SSO, and a form that always fails is worse than no form.
   */
  methods(): { local: boolean; sso: boolean; dev: boolean } {
    return {
      local: this.control.available,
      sso: true,
      // Whether the dev ERP stub is live, and therefore whether the sign-in
      // screen should offer the demo personas. Asked of the server rather than
      // guessed from a hostname: the stub 404s in production, and a panel of
      // sign-in buttons that all fail is worse than no panel. It reports the
      // SAME condition `POST /dev/erp-token` gates itself on, so the two cannot
      // drift into offering something that is not there.
      dev: this.config.get("NODE_ENV") !== "production" && Boolean(this.erpKeys.privateKey),
    };
  }

  /**
   * An account token for somebody who is already inside a school.
   *
   * Grants strictly LESS than the session token they already hold: the account
   * token reaches `/schools`, which lists the schools they have a `users` row
   * in — the same set the session token's `schoolIds` already names. So this is
   * not an escalation, it is the same authority expressed against the other
   * credential.
   *
   * It exists because the two credentials expire independently. Somebody who
   * signed in eight hours ago and clicks the school name would otherwise be
   * bounced to a login form while holding a perfectly good session — losing the
   * school they were in to reach a screen that lists it.
   */
  async tokenForAccountId(accountId: number): Promise<string | null> {
    const account = await this.db().account.findUnique({ where: { id: accountId } });
    if (!account || account.status === "suspended") return null;
    return this.signAccountToken(account);
  }

  /**
   * The account behind an account token, or null if it can no longer be used.
   *
   * `suspended` and nothing else. This used to require `active`, which — now
   * that an unverified account may sign in — would have handed it a token that
   * every subsequent request rejected: signed in, and unable to load the school
   * list it was signed in to see.
   */
  async byId(id: number): Promise<PublicAccount | null> {
    if (!this.control.available) return null;
    const a = await this.control.require().account.findUnique({ where: { id } });
    return a && a.status !== "suspended" ? publicAccount(a) : null;
  }
}

/** What the browser is allowed to see. Never the hash, never the counters. */
export interface PublicAccount {
  id: number;
  email: string;
  name: string;
  kind: "owner" | "member";
  organisation: string | null;
  country: string | null;
  jobRole: string | null;
  emailVerified: boolean;
}

function publicAccount(a: {
  id: number;
  email: string;
  name: string;
  kind: string;
  organisation: string | null;
  country: string | null;
  jobRole: string | null;
  emailVerifiedAt: Date | null;
}): PublicAccount {
  return {
    id: a.id,
    email: a.email,
    name: a.name,
    kind: a.kind === "member" ? "member" : "owner",
    organisation: a.organisation,
    country: a.country,
    jobRole: a.jobRole,
    emailVerified: a.emailVerifiedAt !== null,
  };
}
