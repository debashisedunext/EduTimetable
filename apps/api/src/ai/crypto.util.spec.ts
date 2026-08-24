import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, maskKey } from "./crypto.util";

describe("AI key custody (§13.2)", () => {
  it("round-trips a key through AES-256-GCM", () => {
    const key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
    const blob = encryptSecret(key);
    expect(decryptSecret(blob)).toBe(key);
  });

  it("never stores the plaintext inside the ciphertext", () => {
    const key = "sk-ant-secret-value-9876";
    const blob = encryptSecret(key);
    expect(blob.toString("utf8")).not.toContain("sk-ant");
    expect(blob.toString("hex")).not.toContain(Buffer.from(key).toString("hex"));
  });

  it("uses a fresh IV per encryption, so the same key never yields the same blob", () => {
    const key = "sk-ant-same-key";
    expect(encryptSecret(key).toString("hex")).not.toBe(encryptSecret(key).toString("hex"));
  });

  it("refuses to decrypt tampered ciphertext (GCM auth tag)", () => {
    const blob = encryptSecret("sk-ant-tamper-me");
    blob[blob.length - 1] ^= 0xff;
    expect(() => decryptSecret(blob)).toThrow();
  });

  it("masks a key to a shape hint only", () => {
    const masked = maskKey("sk-ant-api03-abcdefghijklmnop");
    expect(masked).toBe("sk-…mnop");
    expect(masked).not.toContain("api03");
    expect(maskKey("short")).toBe("••••");
  });
});
