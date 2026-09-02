/**
 * §4.9 Phase 15 — reading and writing an elective block's pinned slots.
 *
 * The same list is entered three ways: picked in the UI, typed into a
 * spreadsheet cell ("Mon P4, Wed P4, Fri P4"), and stored as JSON. One module
 * owns all three so the importer and the endpoints cannot disagree about what
 * "Mon P4" means — the mistake that would otherwise show up as a block pinned
 * to a day nobody chose.
 */
import type { ElectivePin, ElectivePlacement } from "../feasibility/types";

export const ELECTIVE_PLACEMENTS: ElectivePlacement[] = ["solver", "same_period", "fixed"];

export const PLACEMENT_LABELS: Record<ElectivePlacement, string> = {
  solver: "Let the solver choose",
  same_period: "Same period every day",
  fixed: "Fixed slots",
};

const DAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_FULL = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export const isElectivePlacement = (v: unknown): v is ElectivePlacement =>
  typeof v === "string" && (ELECTIVE_PLACEMENTS as string[]).includes(v);

/**
 * Read whatever the database holds. Deliberately forgiving in one direction
 * only: anything that is not a well-formed pin is dropped rather than guessed
 * at, because a mis-read pin silently moves a lesson. A block whose pins are
 * dropped falls to "too few slots chosen", which the feasibility engine names.
 */
export function parsePins(value: unknown): ElectivePin[] {
  if (!Array.isArray(value)) return [];
  const out: ElectivePin[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const day = Number((raw as Record<string, unknown>).day);
    const period = Number((raw as Record<string, unknown>).period);
    if (!Number.isInteger(day) || !Number.isInteger(period)) continue;
    if (day < 1 || day > 7 || period < 1) continue;
    out.push({ day, period });
  }
  return out;
}

/** "Mon P4, Wed P4" — what the Excel column and the API accept as text. */
export function formatPins(pins: ElectivePin[]): string {
  return pins.map((p) => `${DAY_NAMES[p.day] ?? p.day} P${p.period}`).join(", ");
}

export interface PinTextResult {
  pins: ElectivePin[];
  /** the entries that could not be read, verbatim, so a message can quote them */
  bad: string[];
}

/**
 * Parse the spreadsheet form. Accepts "Mon P4", "Monday 4", "1:4", "Mon-4" —
 * a person filling a workbook should not have to guess the separator.
 */
export function parsePinText(text: string): PinTextResult {
  const pins: ElectivePin[] = [];
  const bad: string[] = [];
  for (const piece of String(text ?? "").split(/[,;]/)) {
    const entry = piece.trim();
    if (!entry) continue;
    const m = entry.match(/^([A-Za-z]+|[1-7])\s*[-:\s]?\s*[Pp]?\s*(\d{1,2})$/);
    if (!m) {
      bad.push(entry);
      continue;
    }
    const [, dayRaw, periodRaw] = m;
    const day = /^[1-7]$/.test(dayRaw)
      ? Number(dayRaw)
      : (() => {
          const lower = dayRaw.toLowerCase();
          const i = DAY_FULL.findIndex((d) => d.toLowerCase() === lower);
          if (i > 0) return i;
          const j = DAY_NAMES.findIndex((d) => d.toLowerCase() === lower);
          return j > 0 ? j : 0;
        })();
    const period = Number(periodRaw);
    if (day === 0 || !Number.isInteger(period) || period < 1) {
      bad.push(entry);
      continue;
    }
    pins.push({ day, period });
  }
  return { pins, bad };
}
