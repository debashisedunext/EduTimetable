/**
 * AES-256-GCM at rest for the application's secrets. Ciphertext layout:
 * iv(12) | tag(16) | payload.
 *
 * Two things are protected with it: AI provider API keys (§13.2) and, since
 * Phase 9.2, the connection URLs of tenants that have their own database
 * (§17.3) — both are credentials that must never be selected into a response
 * or written to a log.
 *
 * The key comes from AI_ENCRYPTION_KEY (32 bytes, hex or base64); if unset we
 * derive a stable one from JWT_SECRET so dev works out of the box, and the AI
 * Settings screen says so. The env var name and the derivation salt are kept
 * exactly as they were when this only covered AI keys — changing either would
 * make every already-encrypted secret undecryptable.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const IV_LEN = 12;
const TAG_LEN = 16;

export function encryptionKey(): Buffer {
  const raw = process.env.AI_ENCRYPTION_KEY;
  if (raw) {
    const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
    if (buf.length === 32) return buf;
  }
  // deterministic dev fallback — documented on the AI Settings screen
  return createHash("sha256").update(`edutimetable:ai:${process.env.JWT_SECRET ?? "dev"}`).digest();
}

export function encryptSecret(plain: string): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const payload = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), payload]);
}

export function decryptSecret(blob: Buffer | Uint8Array): string {
  const buf = Buffer.from(blob);
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const payload = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(payload), decipher.final()]).toString("utf8");
}

/** What the UI may see: never the key, only a shape hint. */
export function maskKey(plain: string): string {
  if (plain.length <= 8) return "••••";
  return `${plain.slice(0, 3)}…${plain.slice(-4)}`;
}
