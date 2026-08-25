/**
 * Tenant-tagged logging (§17.7, Phase 9.9).
 *
 * The value of tagging is that no call site has to know about it, so the thing
 * to pin is that the tag comes from the ambient context alone — and, just as
 * important, that a line with no school gains nothing rather than a misleading
 * placeholder.
 */
import { describe, expect, it, vi } from "vitest";
import { TenantAwareLogger } from "./tenant-logger";
import { tenantStorage } from "./tenant-context.service";

/** Capture what the underlying ConsoleLogger was asked to print. */
function capture(fn: (logger: TenantAwareLogger) => void): string {
  const logger = new TenantAwareLogger("Test");
  let printed = "";
  vi.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(logger)), "log").mockImplementation(
    (msg: unknown) => { printed = String(msg); },
  );
  fn(logger);
  vi.restoreAllMocks();
  return printed;
}

describe("TenantAwareLogger", () => {
  it("tags a line with the ambient school", () => {
    const out = capture((logger) =>
      tenantStorage.run({ schoolId: 3 }, () => logger.log("generation finished")),
    );
    expect(out).toBe("[school 3] generation finished");
  });

  it("names the tenant too when there is one", () => {
    // School ids repeat across databases (§17.5), so the school id alone is
    // ambiguous in exactly the situation you most need the log line.
    const out = capture((logger) =>
      tenantStorage.run({ schoolId: 1, tenantId: 7 }, () => logger.log("slots written")),
    );
    expect(out).toBe("[school 1 · tenant 7] slots written");
  });

  it("adds nothing outside a context", () => {
    // Boot, health and the control plane are genuinely school-agnostic; a
    // placeholder there would be worse than nothing.
    expect(capture((logger) => logger.log("API listening"))).toBe("API listening");
  });

  it("adds nothing when the context is deliberately unscoped", () => {
    const out = capture((logger) =>
      tenantStorage.run({ schoolId: null, unscoped: true }, () => logger.log("migrating")),
    );
    expect(out).toBe("migrating");
  });

  it("leaves a non-string message structurally intact", () => {
    // Objects are logged for their structure; prefixing would stringify and
    // destroy it.
    const logger = new TenantAwareLogger("Test");
    let received: unknown;
    vi.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(logger)), "log").mockImplementation(
      (msg: unknown) => { received = msg; },
    );
    const payload = { placed: 120 };
    tenantStorage.run({ schoolId: 3 }, () => logger.log(payload));
    vi.restoreAllMocks();
    expect(received).toBe(payload);
  });
});
