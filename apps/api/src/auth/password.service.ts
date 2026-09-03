/**
 * §15.3 Phase 25.0 — hashing a password, and knowing when to rehash it.
 *
 * Until this phase the app held no secrets belonging to a person: SSO meant the
 * ERP owned every credential and we only verified its signature. Selling the
 * Timetable module on its own means owning the credential, and the cost of
 * getting that wrong is not a bad screen, it is somebody else's password.
 *
 * **Argon2id, not bcrypt.** Argon2id is memory-hard: an attacker with a GPU
 * farm has to buy RAM per guess rather than just cores, which is the property
 * bcrypt lacks and the reason it is no longer the default recommendation.
 *
 * **Parameters travel with the hash.** `@node-rs/argon2` writes them into the
 * encoded string (`$argon2id$v=19$m=65536,t=3,p=1$…`), so `verify` reads the
 * parameters the hash was MADE with, not today's. That is what lets the cost be
 * raised later: `needsRehash` reports an old hash, the caller re-hashes it
 * during the next successful sign-in — when the plaintext is legitimately in
 * hand — and nobody is forced to reset anything.
 *
 * **Cost is measured, not guessed.** 64 MiB / t=3 / p=1 measures ~113 ms on the
 * api container, which is the usual target: slow enough to make offline
 * guessing expensive, fast enough that a login does not feel broken. Raise
 * `PASSWORD_MEMORY_KIB` if the hardware gets faster; old hashes keep verifying.
 */
import { Injectable, Logger } from "@nestjs/common";
import { hash as argonHash, verify as argonVerify, Algorithm } from "@node-rs/argon2";
import { timingSafeEqual } from "node:crypto";

/** OWASP's shape, tuned up to ~113 ms on this image. */
const MEMORY_KIB = Number(process.env.PASSWORD_MEMORY_KIB ?? 65536);
const TIME_COST = Number(process.env.PASSWORD_TIME_COST ?? 3);
const PARALLELISM = 1;

/**
 * The shortest password we will store.
 *
 * Twelve, and no composition rules. A rule that demands a symbol and a digit
 * produces `Password1!` — which is in every cracking dictionary — while
 * forbidding a four-word passphrase that is orders of magnitude stronger.
 * Length is the property that actually costs an attacker something.
 */
export const MIN_PASSWORD_LENGTH = 12;

/** Bcrypt's ancient 72-byte truncation does not apply, but a bound still must. */
const MAX_PASSWORD_BYTES = 1024;

@Injectable()
export class PasswordService {
  private readonly logger = new Logger(PasswordService.name);

  /**
   * Why a password is unacceptable, or null when it is fine.
   *
   * Returns the whole reason in one sentence rather than a checklist, because a
   * form that reveals its rules one failure at a time is a form people fight.
   */
  problemWith(plain: unknown): string | null {
    if (typeof plain !== "string" || plain.length === 0) {
      return "Choose a password.";
    }
    if (plain.length < MIN_PASSWORD_LENGTH) {
      return `Passwords need at least ${MIN_PASSWORD_LENGTH} characters — a few ordinary words together is both stronger and easier to remember than a short one with symbols in it.`;
    }
    if (Buffer.byteLength(plain, "utf8") > MAX_PASSWORD_BYTES) {
      return "That password is too long.";
    }
    return null;
  }

  async hash(plain: string): Promise<string> {
    return argonHash(plain, {
      algorithm: Algorithm.Argon2id,
      memoryCost: MEMORY_KIB,
      timeCost: TIME_COST,
      parallelism: PARALLELISM,
    });
  }

  /**
   * Check a password against a stored hash.
   *
   * Never throws on a malformed or empty stored hash — it returns false. That
   * matters more than it looks: `verify` is also called on the *dummy* hash
   * below for addresses that do not exist, and an exception there would make
   * "no such account" measurably different from "wrong password", which is
   * exactly the leak the dummy exists to prevent.
   */
  async verify(plain: string, storedHash: string): Promise<boolean> {
    if (!storedHash) return false;
    try {
      return await argonVerify(storedHash, plain);
    } catch {
      return false;
    }
  }

  /**
   * True when this hash was made with weaker parameters than today's.
   *
   * The caller rehashes on the next successful sign-in, which is the only
   * moment the plaintext is legitimately available. Nobody is asked to reset.
   */
  needsRehash(storedHash: string): boolean {
    const m = /\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(storedHash);
    if (!m) return true; // not argon2id at all — an older scheme, or nonsense
    return Number(m[1]) < MEMORY_KIB || Number(m[2]) < TIME_COST;
  }

  /**
   * A real Argon2id hash of a value nobody knows, made once at start-up.
   *
   * **This is the anti-enumeration mechanism, and it is easy to leave out.**
   * A login for an unknown address that returns early does no hashing, so it
   * answers in ~1 ms while a known address takes ~113 ms — and that difference
   * is measurable over the network, so "is this person a customer?" becomes a
   * question anyone can ask a few hundred times. Verifying against this dummy
   * makes the two paths cost the same.
   */
  private dummy: string | null = null;

  async dummyHash(): Promise<string> {
    if (!this.dummy) {
      this.dummy = await this.hash(`no-such-account-${process.pid}-${Date.now()}`);
    }
    return this.dummy;
  }

  /** Burn the same time an unknown address would have spent being right. */
  async burnEqualTime(plain: string): Promise<void> {
    await this.verify(plain, await this.dummyHash());
  }

  /**
   * Constant-time comparison for two hex digests.
   *
   * The hex validation is not decoration. `Buffer.from("zz", "hex")` does not
   * throw — it stops at the first invalid character and returns an EMPTY
   * buffer, so two pieces of garbage decode to two empty buffers of equal
   * length and `timingSafeEqual` cheerfully reports them equal. A comparison
   * that answers "yes" for nonsense is worse than one that throws.
   */
  static safeEqualHex(a: string, b: string): boolean {
    const isHex = (s: string) => typeof s === "string" && s.length > 0 && s.length % 2 === 0 && /^[0-9a-f]+$/i.test(s);
    if (!isHex(a) || !isHex(b) || a.length !== b.length) return false;
    try {
      return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
    } catch {
      return false;
    }
  }
}
