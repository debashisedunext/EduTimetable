/**
 * §15.3 Phase 25.0 — rate limiting sign-in, on both axes.
 *
 * **Two counters, because there are two attacks and either one alone misses
 * half of them.**
 *
 *   - *Credential stuffing* hammers ONE address with many passwords. A per-IP
 *     limit catches it only while the attacker uses one address; a per-account
 *     counter catches it regardless.
 *   - *Password spraying* tries ONE common password against thousands of
 *     addresses. No single account ever accumulates failures, so a per-account
 *     counter never fires. Only a per-IP counter sees it.
 *
 * Limiting one axis and calling it rate limiting is the usual mistake.
 *
 * **The per-IP half lives in Redis; the per-account half lives on the row.**
 * That is not arbitrary: an IP counter must be cheap and disposable, and a
 * lockout that survives a Redis restart is a property an account deserves and
 * an IP does not.
 *
 * **Failures are counted, successes reset.** And a lockout answers with the
 * same message as a wrong password — telling an attacker "this account is now
 * locked" confirms the address exists, which is the thing the whole login path
 * is written to avoid.
 */
import { Inject, Injectable, Logger } from "@nestjs/common";
import type Redis from "ioredis";
import { REDIS } from "../redis/redis.module";

/** Failures from one source address before it is asked to wait. */
const IP_MAX_FAILURES = 20;
const IP_WINDOW_SECONDS = 15 * 60;

/** Failures against one account before it is locked. */
export const ACCOUNT_MAX_FAILURES = 8;
export const ACCOUNT_LOCK_MINUTES = 15;

/** Registrations and reset requests from one source address per window. */
const SIGNUP_MAX = 10;
const SIGNUP_WINDOW_SECONDS = 60 * 60;

@Injectable()
export class LoginThrottleService {
  private readonly logger = new Logger(LoginThrottleService.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /**
   * Redis keys here carry no school prefix, and that is correct rather than an
   * oversight (§17): none of this happens inside a school. At sign-in time
   * nobody has chosen one yet, and an IP is not a tenant's property.
   */
  private ipKey(ip: string, bucket: string) {
    return `throttle:${bucket}:ip:${ip}`;
  }

  /** True when this source address has failed too often lately. */
  async ipBlocked(ip: string): Promise<boolean> {
    const n = await this.redis.get(this.ipKey(ip, "login"));
    return Number(n ?? 0) >= IP_MAX_FAILURES;
  }

  /** Count one failure against the source address. */
  async recordIpFailure(ip: string): Promise<void> {
    const key = this.ipKey(ip, "login");
    const n = await this.redis.incr(key);
    if (n === 1) await this.redis.expire(key, IP_WINDOW_SECONDS);
    if (n === IP_MAX_FAILURES) {
      this.logger.warn(`${ip} reached ${IP_MAX_FAILURES} failed sign-ins — throttled`);
    }
  }

  /** A success clears the source address, so one fat-fingered user is not punished. */
  async clearIp(ip: string): Promise<void> {
    await this.redis.del(this.ipKey(ip, "login"));
  }

  /**
   * Registration and forgot-password are cheap for us and expensive for the
   * person whose address is being used, so they get their own, tighter budget:
   * without it, "forgot password" is a free mail cannon pointed at anyone.
   */
  async signupBudgetExceeded(ip: string): Promise<boolean> {
    const key = this.ipKey(ip, "signup");
    const n = await this.redis.incr(key);
    if (n === 1) await this.redis.expire(key, SIGNUP_WINDOW_SECONDS);
    if (n > SIGNUP_MAX) {
      this.logger.warn(`${ip} exceeded the sign-up / reset budget (${n} in the window)`);
      return true;
    }
    return false;
  }

  /** Whether an account's own lockout is still running. */
  isLocked(account: { lockedUntil: Date | null }): boolean {
    return account.lockedUntil !== null && account.lockedUntil.getTime() > Date.now();
  }

  /** What the row should become after one more failure. */
  nextFailureState(account: { failedLogins: number }): { failedLogins: number; lockedUntil: Date | null } {
    const failedLogins = account.failedLogins + 1;
    const lockedUntil =
      failedLogins >= ACCOUNT_MAX_FAILURES
        ? new Date(Date.now() + ACCOUNT_LOCK_MINUTES * 60_000)
        : null;
    return { failedLogins, lockedUntil };
  }
}
