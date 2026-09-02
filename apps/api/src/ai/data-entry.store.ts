/**
 * §13.5 Phase B — reading current values, and writing the accepted changes.
 *
 * The half of the update path that touches Prisma. Split from
 * `data-entry.update.ts` so the diff rules stay pure and testable, and so the
 * queries live in one place: one lookup per sheet, never one per row.
 */
import type { MentionedFields, ValidatedRow } from "@edutimetable/shared";
import { applyMappingUpdates, planMappingUpdates, type MappingIssue } from "./data-entry.mapping";
import { changedFields, labelOf, type FieldChange, type RowUpdate } from "./data-entry.update";

const lower = (s: unknown) => String(s ?? "").trim().toLowerCase();

/**
 * Current values for the existing rows of one sheet, keyed by natural key.
 *
 * Returns the same field names the import contract uses, so `changedFields`
 * can compare like with like without a second mapping table to keep in step.
 */
async function currentBySheet(
  tx: any,
  schoolId: number,
  sheet: string,
): Promise<Map<string, { id: number; values: Record<string, unknown> }>> {
  const out = new Map<string, { id: number; values: Record<string, unknown> }>();

  switch (sheet) {
    case "Classes": {
      for (const c of await tx.schoolClass.findMany({ where: { schoolId } })) {
        out.set(lower(c.name), { id: c.id, values: { sequence: c.sequence } });
      }
      return out;
    }
    case "Subjects": {
      for (const s of await tx.subject.findMany({ where: { schoolId } })) {
        out.set(lower(s.name), {
          id: s.id,
          values: { code: s.code, isLab: s.isLab, requiresDoublePeriod: s.requiresDoublePeriod },
        });
      }
      return out;
    }
    case "Teachers": {
      for (const t of await tx.teacher.findMany({ where: { schoolId } })) {
        out.set(lower(t.employeeCode), {
          id: t.id,
          values: {
            name: t.name,
            maxPeriodsPerDay: t.maxPeriodsPerDay,
            minPeriodsPerDay: t.minPeriodsPerDay,
            maxPeriodsPerWeek: t.maxPeriodsPerWeek,
            classTeacherPeriodRule: t.classTeacherPeriodRule,
            periodPattern: t.periodPattern,
            alternateDaySet: t.alternateDaySet ?? [],
            employmentType: t.employmentType,
            isActive: t.isActive,
          },
        });
      }
      return out;
    }
    case "Class Sections": {
      const rows = await tx.classSection.findMany({
        where: { schoolId },
        include: { class: true, section: true, academicYear: true, homeRoom: true, timetableConfig: true },
      });
      for (const cs of rows) {
        out.set(lower(`${cs.class.name}||${cs.section.name}||${cs.academicYear.name}`), {
          id: cs.id,
          values: {
            strength: cs.strength,
            homeRoom: cs.homeRoom?.name ?? null,
            timetable: cs.timetableConfig?.name ?? null,
          },
        });
      }
      return out;
    }
    case "Curriculum": {
      const rows = await tx.classSubject.findMany({
        where: { schoolId },
        include: { class: true, subject: true, academicYear: true },
      });
      for (const r of rows) {
        out.set(lower(`${r.class.name}||${r.subject.name}||${r.academicYear.name}`), {
          id: r.id,
          values: {
            periodsPerWeek: r.periodsPerWeek,
            maxPeriodsPerDay: r.maxPeriodsPerDay,
            samePeriodAcrossWeek: r.samePeriodAcrossWeek,
            consecutiveBlockSize: r.consecutiveBlockSize,
            consecutiveBlocksPerWeek: r.consecutiveBlocksPerWeek,
          },
        });
      }
      return out;
    }
    default:
      return out;
  }
}

/** The natural key of a drafted row, in the same shape `currentBySheet` uses. */
function keyOfDraft(sheet: string, d: Record<string, any>): string {
  switch (sheet) {
    case "Classes": return lower(d.name);
    case "Subjects": return lower(d.name);
    case "Teachers": return lower(d.employeeCode);
    case "Class Sections": return lower(`${d.className}||${d.sectionName}||${d.academicYear}`);
    case "Curriculum": return lower(`${d.className}||${d.subjectName}||${d.academicYear}`);
    default: return "";
  }
}

/**
 * Work out what would change, for every existing row of every sheet.
 *
 * The switch above covers the sheets where one drafted row is one database
 * row. `Subject Mapping` and `Class Teachers` are not like that — a mapping row
 * fans out to one row per class-section (or collapses into a merged group), and
 * a class-teacher row writes a pointer onto a class-section — so they are
 * planned by `data-entry.mapping.ts`, which owns that expansion and the §18 and
 * capacity guards that come with attaching a teacher to a class.
 */
export async function planUpdates(
  tx: any,
  schoolId: number,
  rowsBySheet: Record<string, ValidatedRow[]>,
  mentioned: MentionedFields[],
): Promise<{ updates: RowUpdate[]; issues: MappingIssue[] }> {
  const updates: RowUpdate[] = [];
  // sheet → row number → the fields that row actually named
  const said = new Map<string, string[]>();
  for (const m of mentioned) said.set(`${m.sheet}::${m.row}`, m.fields);
  for (const [sheet, rows] of Object.entries(rowsBySheet)) {
    const existing = rows.filter((r) => r.existing);
    if (existing.length === 0) continue;
    const current = await currentBySheet(tx, schoolId, sheet);
    if (current.size === 0) continue;

    for (const r of existing) {
      const found = current.get(keyOfDraft(sheet, r.data));
      if (!found) continue;
      const changes = changedFields(sheet, r.data, found.values, said.get(`${sheet}::${r.row}`) ?? []);
      if (changes.length > 0) {
        updates.push({ sheet, kind: "row", label: labelOf(sheet, r.data), id: found.id, changes });
      }
    }
  }

  const teaching = await planMappingUpdates(tx, schoolId, rowsBySheet, mentioned);
  return { updates: [...updates, ...teaching.updates], issues: teaching.issues };
}

/** Turn a diff into the Prisma payload for its sheet. */
function payloadFor(sheet: string, changes: FieldChange[]): Record<string, unknown> {
  const v = Object.fromEntries(changes.map((c) => [c.field, c.to]));
  switch (sheet) {
    case "Classes":
      return { ...(v.sequence !== undefined ? { sequence: Number(v.sequence) } : {}) };
    case "Subjects":
      return {
        ...(v.code !== undefined ? { code: v.code === null ? null : String(v.code) } : {}),
        ...(v.isLab !== undefined ? { isLab: Boolean(v.isLab) } : {}),
        ...(v.requiresDoublePeriod !== undefined ? { requiresDoublePeriod: Boolean(v.requiresDoublePeriod) } : {}),
      };
    case "Teachers":
      return {
        ...(v.name !== undefined ? { name: String(v.name) } : {}),
        ...(v.maxPeriodsPerDay !== undefined ? { maxPeriodsPerDay: Number(v.maxPeriodsPerDay) } : {}),
        ...(v.minPeriodsPerDay !== undefined ? { minPeriodsPerDay: Number(v.minPeriodsPerDay) } : {}),
        ...(v.maxPeriodsPerWeek !== undefined ? { maxPeriodsPerWeek: Number(v.maxPeriodsPerWeek) } : {}),
        ...(v.classTeacherPeriodRule !== undefined ? { classTeacherPeriodRule: v.classTeacherPeriodRule } : {}),
        ...(v.periodPattern !== undefined ? { periodPattern: v.periodPattern } : {}),
        ...(v.alternateDaySet !== undefined ? { alternateDaySet: v.alternateDaySet } : {}),
        ...(v.employmentType !== undefined ? { employmentType: v.employmentType } : {}),
        ...(v.isActive !== undefined ? { isActive: Boolean(v.isActive) } : {}),
      };
    case "Class Sections":
      return { ...(v.strength !== undefined ? { strength: v.strength === null ? null : Number(v.strength) } : {}) };
    case "Curriculum":
      return {
        ...(v.periodsPerWeek !== undefined ? { periodsPerWeek: Number(v.periodsPerWeek) } : {}),
        ...(v.maxPeriodsPerDay !== undefined ? { maxPeriodsPerDay: Number(v.maxPeriodsPerDay) } : {}),
        ...(v.samePeriodAcrossWeek !== undefined ? { samePeriodAcrossWeek: Boolean(v.samePeriodAcrossWeek) } : {}),
        ...(v.consecutiveBlockSize !== undefined ? { consecutiveBlockSize: Number(v.consecutiveBlockSize) } : {}),
        ...(v.consecutiveBlocksPerWeek !== undefined
          ? { consecutiveBlocksPerWeek: v.consecutiveBlocksPerWeek === null ? null : Number(v.consecutiveBlocksPerWeek) }
          : {}),
      };
    default:
      return {};
  }
}

/**
 * Apply the diffs. Runs inside the caller's transaction, alongside the creates,
 * so a batch that adds and changes lands as one thing or not at all.
 *
 * `homeRoom` and `timetable` are named rather than written: both resolve to a
 * foreign key, and resolving a name to an id is the importer's job, not a job
 * to do twice. They are reported as changes in the preview and skipped here,
 * which the caller surfaces — better a stated gap than a silent one.
 */
export async function applyUpdates(
  tx: any,
  schoolId: number,
  updates: RowUpdate[],
): Promise<{ updated: number; skipped: string[] }> {
  const skipped: string[] = [];
  // Subject Mapping and Class Teachers land on other tables and need names
  // resolved to ids; that is `data-entry.mapping.ts`'s job, not this one's.
  let updated = await applyMappingUpdates(tx, schoolId, updates);

  for (const u of updates.filter((x) => (x.kind ?? "row") === "row")) {
    const writable = u.changes.filter((c) => !["homeRoom", "timetable"].includes(c.field));
    for (const c of u.changes) {
      if (!writable.includes(c)) skipped.push(`${u.sheet} · ${u.label}: ${c.field}`);
    }
    const data = payloadFor(u.sheet, writable);
    if (Object.keys(data).length === 0) continue;

    switch (u.sheet) {
      case "Classes": await tx.schoolClass.update({ where: { id: u.id }, data }); break;
      case "Subjects": await tx.subject.update({ where: { id: u.id }, data }); break;
      case "Teachers": await tx.teacher.update({ where: { id: u.id }, data }); break;
      case "Class Sections": await tx.classSection.update({ where: { id: u.id }, data }); break;
      case "Curriculum": await tx.classSubject.update({ where: { id: u.id }, data }); break;
      default: continue;
    }
    updated++;
  }
  return { updated, skipped };
}
