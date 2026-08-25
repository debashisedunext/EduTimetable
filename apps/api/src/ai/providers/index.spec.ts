/**
 * The provider catalogue (§13.2).
 *
 * Two things worth pinning. First, per-model pricing: a lite model can be five
 * times cheaper than its flagship, so a single per-provider figure would put a
 * badly wrong number on the usage meter. Second, that every provider the
 * catalogue claims is wired actually has an adapter behind it — the screen
 * renders this list, so a mismatch here is a dropdown that lies.
 */
import { describe, expect, it } from "vitest";
import { PROVIDERS, createProvider, priceFor, providerInfo } from "./index";

describe("provider catalogue", () => {
  it("offers the Gemini models the API currently serves", () => {
    const models = providerInfo("google").models.map((m) => m.id);
    expect(models).toContain("gemini-3.5-flash-lite");
    expect(models).toContain("gemini-3.7-flash");
    // The 2.x line is superseded; leaving it listed is how a stale catalogue
    // quietly becomes the default someone picks.
    expect(models.some((m) => m.startsWith("gemini-2."))).toBe(false);
  });

  it("defaults Gemini to the model built for agentic tool use", () => {
    expect(providerInfo("google").defaultModel).toBe("gemini-3.7-flash");
  });

  it("falls back to Anthropic for an unknown provider id", () => {
    expect(providerInfo("nonesuch").id).toBe("anthropic");
    expect(providerInfo(undefined).id).toBe("anthropic");
  });

  it("has an adapter for every provider it claims is wired", () => {
    for (const p of PROVIDERS.filter((x) => x.implemented)) {
      expect(() => createProvider(p.id, "test-key", p.defaultModel)).not.toThrow();
    }
  });

  it("refuses to build a provider it has no adapter for, rather than substituting one", () => {
    // Answering as a different vendor than the one configured would be worse
    // than failing — the school would be billed on a key they did not choose.
    expect(() => createProvider("openai", "test-key", "gpt-5")).toThrow(/not wired yet/);
  });
});

describe("priceFor", () => {
  it("prices each model separately — lite is far cheaper than flagship", () => {
    const lite = priceFor("google", "gemini-3.5-flash-lite");
    const flash = priceFor("google", "gemini-3.5-flash");
    expect(lite.inputPerMillionUsd).toBeLessThan(flash.inputPerMillionUsd);
    expect(lite.outputPerMillionUsd).toBeLessThan(flash.outputPerMillionUsd);
    // The spread is the point: a single per-provider figure would overstate a
    // flash-lite school's spend fivefold.
    expect(flash.inputPerMillionUsd / lite.inputPerMillionUsd).toBeGreaterThanOrEqual(4);
  });

  it("uses the provider's headline price for a model it has never heard of", () => {
    // A model discovered live from the provider, or released after this list
    // was written, must still produce a number rather than NaN.
    const unknown = priceFor("google", "gemini-9-experimental");
    expect(unknown).toEqual(providerInfo("google").price);
    expect(Number.isFinite(unknown.inputPerMillionUsd)).toBe(true);
  });

  it("prices Anthropic models too", () => {
    expect(priceFor("anthropic", "claude-opus-5").inputPerMillionUsd).toBeGreaterThan(0);
  });
});
