/**
 * §23 — the source seam.
 *
 * A sync needs five lists of plain rows and a way to turn our school code into
 * whatever the ERP calls that school. Everything above this — reconcile, the
 * ownership table, the preview, the transaction, the screen — is written
 * against these four methods and knows nothing about where the rows came from.
 *
 * One implementation ships — `ErpHttpReader`, GET against the ERP's REST API.
 * The interface stays anyway: it is the seam the stand-in ERP plugs into, so
 * the sync can be driven end to end in a test without a real ERP to call, and
 * without the test reaching around the code it is meant to be exercising.
 */
import type { SyncSheet } from "@edutimetable/shared";

/**
 * The ERP user id of whoever triggered this read, when a person did (§23.8).
 *
 * Passed on every call rather than held on the reader: one reader instance
 * serves every request and every school, so a field holding "who asked" would
 * report one admin's name on another's sync (§17).
 */
export type ActingUser = string | null | undefined;

export interface ErpReader {
  /** One line for the screen: which source this is, and where it points. */
  describe(): string;
  resolveSchool(code: string, actingUser?: ActingUser): Promise<string | number>;
  fetchSheet(sheet: SyncSheet, schoolId: string | number, actingUser?: ActingUser): Promise<Record<string, unknown>[]>;
  /**
   * A few records, unmapped, plus any of our fields the mapping failed to
   * produce. This is what makes the probe useful: it reports the ERP's own
   * shape back, so a wrong column or path is visible rather than inferred.
   */
  sample(sheet: SyncSheet, schoolId: string | number, actingUser?: ActingUser): Promise<{ raw: unknown[]; missing: string[] }>;
  close(): Promise<void>;
}
