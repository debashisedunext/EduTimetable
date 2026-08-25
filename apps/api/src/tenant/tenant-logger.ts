/**
 * Tenant-tagged logging (§17.7, Phase 9.9).
 *
 * With one school, "which school was this?" is not a question. With many, it is
 * the *first* question about any log line — and answering it by hand at every
 * call site would mean editing hundreds of them and getting the next one wrong,
 * the same trap 9.1 avoided for query scoping.
 *
 * So it is done once, here. This wraps Nest's own console logger and prefixes
 * every line with the ambient school, read from the AsyncLocalStorage the
 * request, socket message or queue job is already running inside. Nothing at
 * any call site changes; a line simply gains `[school 3]` when there is a
 * school to name, and gains nothing when there is not (boot, health, the
 * control plane — all genuinely school-agnostic).
 *
 * The tenant id is included alongside when it differs from the school id, since
 * under §17.5 several schools can share `school_id 1` across databases and the
 * school id alone would be ambiguous in exactly the situation you most need it.
 */
import { ConsoleLogger, type LogLevel } from "@nestjs/common";
import { currentTenantStore } from "./tenant-context.service";

export class TenantAwareLogger extends ConsoleLogger {
  /** `[school 3 · tenant 7]`, or empty when nothing is scoped. */
  private tag(): string {
    const store = currentTenantStore();
    if (!store || store.schoolId === null) return "";
    const tenant = store.tenantId != null ? ` · tenant ${store.tenantId}` : "";
    return `[school ${store.schoolId}${tenant}] `;
  }

  private decorate(message: unknown): unknown {
    const tag = this.tag();
    if (!tag) return message;
    // Only strings are prefixed. Objects are logged for their structure, and
    // stringifying them here would destroy that.
    return typeof message === "string" ? `${tag}${message}` : message;
  }

  log(message: unknown, ...rest: unknown[]) {
    super.log(this.decorate(message), ...(rest as []));
  }
  warn(message: unknown, ...rest: unknown[]) {
    super.warn(this.decorate(message), ...(rest as []));
  }
  error(message: unknown, ...rest: unknown[]) {
    super.error(this.decorate(message), ...(rest as []));
  }
  debug(message: unknown, ...rest: unknown[]) {
    super.debug(this.decorate(message), ...(rest as []));
  }
  verbose(message: unknown, ...rest: unknown[]) {
    super.verbose(this.decorate(message), ...(rest as []));
  }
  fatal(message: unknown, ...rest: unknown[]) {
    super.fatal(this.decorate(message), ...(rest as []));
  }
}

/** Log levels for the deployment; `debug` is noise in production. */
export const logLevels = (): LogLevel[] =>
  process.env.NODE_ENV === "production"
    ? ["log", "warn", "error", "fatal"]
    : ["log", "warn", "error", "fatal", "debug"];
