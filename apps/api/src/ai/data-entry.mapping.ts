/**
 * §13.5 Phase C — changing who teaches what.
 *
 * Phase B could change a row where one drafted row meant one database row. The
 * `Subject Mapping` sheet is not like that, which is exactly why it was held
 * back: **one drafted row is not one database row.** A row naming three
 * class-sections creates three `teacher_subject_class_section` rows; the same
 * row with `merged = Yes` creates a single `merged_teaching_group` with three
 * members instead. So "change this row" has no meaning until the row is
 * expanded the way the importer expands it.
 *
 * This module does that expansion, and nothing else does — a second copy of it
 * is precisely how the assistant and the Excel importer would come to disagree
 * about what a row means.
 *
 * Four rules shape it.
 *
 * **Expand first, diff second.** A row becomes *units*: one per class-section
 * for a plain mapping, one for the whole row when merged. Each unit is matched
 * against the database on its own key and diffed on its own.
 *
 * **The key is still never writable, but the key is different per unit.** A
 * plain mapping is keyed `(subject, class-section)`, so the *teacher* is a
 * value — which is what makes "move Class 5-A maths to Rekha" an edit. A merged
 * group is keyed `(subject, teacher, member sections)`, so on that side the
 * teacher is part of the identity and cannot move. Same principle, opposite
 * answer, because the two tables are keyed differently.
 *
 * **The §18 and capacity guards run at PLAN time, not at write time.** The
 * mapping screens refuse an ineligible teacher and an over-capacity load; a
 * conversation must not be a way round either. Running them while planning
 * turns "the Apply button exploded" into a named problem on the preview, next
 * to the row that caused it — which is the contract the rest of this system
 * holds to.
 *
 * **`Class Teachers` rides along** because it is the same kind of thing: a
 * teacher attached to a class-section, governed by the same §18 check, and the
 * thing people ask for in the same breath ("...and make her class teacher of
 * 5-A"). It writes one pointer on a row that already exists.
 */
import { BadRequestException } from "@nestjs/common";
import type { MentionedFields, ValidatedRow } from "@edutimetable/shared";
import { assertWithinWeek, capacityForClassSections } from "../masters/capacity.util";
import { assertCanOwnClass, assertCanTeach } from "../masters/teacher-scope.util";
import { changedFields, MERGED_UPDATABLE, type FieldChange, type RowUpdate } from "./data-entry.update";

const lower = (s: unknown) => String(s ?? "").trim().toLowerCase();

/** An issue in the same shape the validator produces, so the preview is one list. */
export interface MappingIssue {
  sheet: string;
  row: number | null;
  message: string;
  fix: string;
  severity: "error" | "warning";
}

/** Everything these sheets need resolved, read once rather than per row. */
interface Catalogue {
  /** employee code → teacher */
  teachers: Map<string, { id: number; name: string; code: string }>;
  /** room name → id */
  rooms: Map<string, number>;
  /** "class-section" label → id */
  sections: Map<string, number>;
  /** "subject||label" → the plain mapping there */
  mappings: Map<string, { id: number; sectionId: number; values: Record<string, unknown> }>;
  /** "subject|teacherId|sortedSectionIds" → the merged group */
  merged: Map<string, { id: number; values: Record<string, unknown> }>;
  /** subject||sortedSectionIds → an existing group whatever its teacher */
  mergedBySections: Map<string, { id: number; teacherName: string }>;
  /** "class-section" label → its current class teacher */
  classTeachers: Map<string, { sectionId: number; values: Record<string, unknown> }>;
}

async function loadCatalogue(tx: any, schoolId: number): Promise<Catalogue> {
  const [teachers, rooms, sections, mappings, merged] = await Promise.all([
    tx.teacher.findMany({ where: { schoolId } }),
    tx.room.findMany({ where: { schoolId } }),
    tx.classSection.findMany({
      where: { schoolId },
      include: { class: true, section: true, classTeacher: true },
    }),
    tx.teacherSubjectClassSection.findMany({
      where: { schoolId },
      include: {
        teacher: true,
        subject: true,
        preferredRoom: true,
        classSection: { include: { class: true, section: true } },
      },
    }),
    tx.mergedTeachingGroup.findMany({
      where: { schoolId },
      include: { subject: true, room: true, members: true },
    }),
  ]);

  const label = (cs: any) => `${cs.class.name}-${cs.section.name}`;
  const cat: Catalogue = {
    teachers: new Map(),
    rooms: new Map(),
    sections: new Map(),
    mappings: new Map(),
    merged: new Map(),
    mergedBySections: new Map(),
    classTeachers: new Map(),
  };

  for (const t of teachers) cat.teachers.set(lower(t.employeeCode), { id: t.id, name: t.name, code: t.employeeCode });
  for (const r of rooms) cat.rooms.set(lower(r.name), r.id);
  for (const cs of sections) {
    cat.sections.set(lower(label(cs)), cs.id);
    if (cs.classTeacher) {
      cat.classTeachers.set(lower(label(cs)), {
        sectionId: cs.id,
        values: { employeeCode: cs.classTeacher.employeeCode },
      });
    }
  }
  for (const m of mappings) {
    cat.mappings.set(lower(`${m.subject.name}||${label(m.classSection)}`), {
      id: m.id,
      sectionId: m.classSectionId,
      values: {
        employeeCode: m.teacher.employeeCode,
        periodsPerWeek: m.periodsPerWeek,
        room: m.preferredRoom?.name ?? null,
      },
    });
  }
  for (const g of merged) {
    const ids = g.members.map((m: any) => m.classSectionId).sort((a: number, b: number) => a - b);
    cat.merged.set(`${lower(g.subject.name)}|${g.teacherId}|${ids.join(",")}`, {
      id: g.id,
      values: { periodsPerWeek: g.periodsPerWeek, room: g.room?.name ?? null },
    });
    const t = teachers.find((x: any) => x.id === g.teacherId);
    cat.mergedBySections.set(`${lower(g.subject.name)}|${ids.join(",")}`, {
      id: g.id,
      teacherName: t?.name ?? `teacher ${g.teacherId}`,
    });
  }
  return cat;
}

/**
 * Plan the changes for `Subject Mapping` and `Class Teachers`.
 *
 * Returns issues alongside the updates so a refusal reaches the preview rather
 * than the Apply button: an ineligible teacher or an over-capacity load is a
 * named row here, not a 400 thirty minutes later.
 */
export async function planMappingUpdates(
  tx: any,
  schoolId: number,
  rowsBySheet: Record<string, ValidatedRow[]>,
  mentioned: MentionedFields[],
): Promise<{ updates: RowUpdate[]; issues: MappingIssue[] }> {
  const mapRows = rowsBySheet["Subject Mapping"] ?? [];
  const ctRows = (rowsBySheet["Class Teachers"] ?? []).filter((r) => r.existing);
  if (mapRows.length === 0 && ctRows.length === 0) return { updates: [], issues: [] };

  const said = new Map<string, string[]>();
  for (const m of mentioned) said.set(`${m.sheet}::${m.row}`, m.fields);
  const fieldsOf = (sheet: string, row: number) => said.get(`${sheet}::${row}`) ?? [];

  const cat = await loadCatalogue(tx, schoolId);
  const updates: RowUpdate[] = [];
  const issues: MappingIssue[] = [];
  const fail = (sheet: string, row: number, message: string, fix: string) =>
    issues.push({ sheet, row, message, fix, severity: "error" });

  // ── Subject Mapping ───────────────────────────────────────────────────────
  for (const r of mapRows) {
    const named = fieldsOf("Subject Mapping", r.row);
    const sections: string[] = r.data.classSections ?? [];

    if (r.data.merged === true) {
      const ids = sections.map((s) => cat.sections.get(lower(s))).filter((x): x is number => !!x).sort((a, b) => a - b);
      if (ids.length === 0) continue;
      const teacher = cat.teachers.get(lower(r.data.employeeCode));
      const bySections = cat.mergedBySections.get(`${lower(r.data.subjectName)}|${ids.join(",")}`);
      const exact = teacher
        ? cat.merged.get(`${lower(r.data.subjectName)}|${teacher.id}|${ids.join(",")}`)
        : undefined;

      if (!exact) {
        // Same subject and the same sections, a different teacher. The
        // importer's dedupe key includes the teacher, so this would sail
        // through and create a SECOND merged group over the same children —
        // which is a data problem nobody would notice until the solver
        // double-booked them. Named and refused instead.
        if (bySections) {
          fail(
            "Subject Mapping", r.row,
            `${sections.join(" + ")} already have a merged ${r.data.subjectName} group under ${bySections.teacherName}.`,
            `Changing which teacher takes a merged group is not something the assistant can do — the group is identified by its teacher, so a different one would be a second group over the same children. Change it on the Teacher Mapping screen.`,
          );
        }
        continue; // otherwise it is simply a new group; the create path handles it
      }

      // Only the two non-key fields are candidates; a teacher change already
      // took the `!exact` branch above, which is where it is refused by name.
      const changes = changedFields("Subject Mapping", r.data, exact.values, named, MERGED_UPDATABLE);
      if (changes.length === 0) continue;

      const ppw = changes.find((c) => c.field === "periodsPerWeek");
      if (ppw) {
        const bad = await capacityRefusal(tx, Number(ppw.to), ids);
        if (bad) { fail("Subject Mapping", r.row, bad, capacityFix); continue; }
      }
      updates.push({
        sheet: "Subject Mapping",
        kind: "merged",
        label: `${r.data.subjectName} · ${sections.join(" + ")} (merged)`,
        id: exact.id,
        changes,
      });
      continue;
    }

    // Plain mappings. `existingParts` is the half the validator took away: the
    // sections that already have a teacher for this subject, and so are the
    // only ones an update can be about.
    for (const labelName of r.existingParts ?? []) {
      const current = cat.mappings.get(lower(`${r.data.subjectName}||${labelName}`));
      if (!current) continue;
      const changes = changedFields("Subject Mapping", r.data, current.values, named);
      if (changes.length === 0) continue;

      const teacherChange = changes.find((c) => c.field === "employeeCode");
      if (teacherChange) {
        const next = cat.teachers.get(lower(teacherChange.to));
        if (!next) {
          fail("Subject Mapping", r.row, `There is no teacher with employee code ${teacherChange.to}.`,
            `Check the code on the Teachers screen, or add the teacher first.`);
          continue;
        }
        // §18 — the same refusal the Mapping screen gives, at the same point.
        const bad = await scopeRefusal(tx, next.id, [current.sectionId], "this subject");
        if (bad) { fail("Subject Mapping", r.row, bad, scopeFix); continue; }
      }
      const ppw = changes.find((c) => c.field === "periodsPerWeek");
      if (ppw) {
        const bad = await capacityRefusal(tx, Number(ppw.to), [current.sectionId]);
        if (bad) { fail("Subject Mapping", r.row, bad, capacityFix); continue; }
      }
      const roomChange = changes.find((c) => c.field === "room");
      if (roomChange && roomChange.to !== null && !cat.rooms.get(lower(roomChange.to))) {
        fail("Subject Mapping", r.row, `There is no room called "${roomChange.to}".`,
          `Use a room that exists, or leave Room blank to use the class's home room.`);
        continue;
      }

      updates.push({
        sheet: "Subject Mapping",
        kind: "mapping",
        label: `${r.data.subjectName} · ${labelName}`,
        id: current.id,
        changes,
      });
    }
  }

  // ── Class Teachers ────────────────────────────────────────────────────────
  for (const r of ctRows) {
    const current = cat.classTeachers.get(lower(r.data.classSection));
    if (!current) continue;
    const changes = changedFields("Class Teachers", r.data, current.values, fieldsOf("Class Teachers", r.row));
    if (changes.length === 0) continue;

    const next = cat.teachers.get(lower(r.data.employeeCode));
    if (!next) {
      fail("Class Teachers", r.row, `There is no teacher with employee code ${r.data.employeeCode}.`,
        `Check the code on the Teachers screen, or add the teacher first.`);
      continue;
    }
    // A class teacher owns the class, so they must be able to teach it (§18) —
    // the same check `PUT /classes/:id/class-teacher` makes.
    const bad = await scopeRefusal(tx, next.id, [current.sectionId], "this class", true);
    if (bad) { fail("Class Teachers", r.row, bad, scopeFix); continue; }

    updates.push({
      sheet: "Class Teachers",
      kind: "classTeacher",
      label: `${r.data.classSection} — class teacher`,
      id: current.sectionId,
      changes,
    });
  }

  return { updates, issues };
}

const scopeFix =
  "Widen the teacher's teaching scope on the Teachers screen, or name a teacher who covers that class.";
const capacityFix = "Reduce the periods per week, or lengthen the timetable's week.";

/**
 * Runs the §18 check and returns its message rather than throwing.
 *
 * `owns` picks `assertCanOwnClass` over `assertCanTeach` — the same rule with
 * the wording a class-teacher assignment needs.
 */
async function scopeRefusal(
  tx: any,
  teacherId: number,
  sectionIds: number[],
  what: string,
  owns = false,
): Promise<string | null> {
  try {
    if (owns) await assertCanOwnClass(tx, teacherId, sectionIds[0]);
    else await assertCanTeach(tx, teacherId, sectionIds, { what });
    return null;
  } catch (e) {
    if (e instanceof BadRequestException) return String((e.getResponse() as any)?.message ?? e.message);
    throw e;
  }
}

/** The same, for the weekly-capacity ceiling. */
async function capacityRefusal(tx: any, periodsPerWeek: number, sectionIds: number[]): Promise<string | null> {
  try {
    assertWithinWeek(periodsPerWeek, await capacityForClassSections(tx, sectionIds));
    return null;
  } catch (e) {
    if (e instanceof BadRequestException) return String((e.getResponse() as any)?.message ?? e.message);
    throw e;
  }
}

/**
 * Write the accepted mapping changes.
 *
 * Names become ids here and only here: the diff the admin read is in the same
 * vocabulary they typed (`ZZAI-T1 → ZZAI-T2`, `Lab 1 → Lab 2`), and resolving
 * it any earlier would have shown them a pair of integers.
 */
export async function applyMappingUpdates(
  tx: any,
  schoolId: number,
  updates: RowUpdate[],
): Promise<number> {
  const relevant = updates.filter((u) => u.kind && u.kind !== "row");
  if (relevant.length === 0) return 0;
  const cat = await loadCatalogue(tx, schoolId);
  const valueOf = (changes: FieldChange[], field: string) => changes.find((c) => c.field === field)?.to;
  let n = 0;

  for (const u of relevant) {
    const teacherCode = valueOf(u.changes, "employeeCode");
    const room = valueOf(u.changes, "room");
    const ppw = valueOf(u.changes, "periodsPerWeek");
    const roomId = room === undefined ? undefined : room === null || room === "" ? null : (cat.rooms.get(lower(room)) ?? null);

    if (u.kind === "classTeacher") {
      const t = cat.teachers.get(lower(teacherCode));
      if (!t) continue;
      await tx.classSection.update({ where: { id: u.id }, data: { classTeacherId: t.id } });
      n++;
      continue;
    }
    if (u.kind === "merged") {
      await tx.mergedTeachingGroup.update({
        where: { id: u.id },
        data: {
          ...(ppw !== undefined ? { periodsPerWeek: Number(ppw) } : {}),
          ...(roomId !== undefined ? { roomId } : {}),
        },
      });
      n++;
      continue;
    }
    // plain mapping
    const t = teacherCode === undefined ? undefined : cat.teachers.get(lower(teacherCode));
    if (teacherCode !== undefined && !t) continue;
    await tx.teacherSubjectClassSection.update({
      where: { id: u.id },
      data: {
        ...(t ? { teacherId: t.id } : {}),
        ...(ppw !== undefined ? { periodsPerWeek: Number(ppw) } : {}),
        ...(roomId !== undefined ? { preferredRoomId: roomId } : {}),
      },
    });
    n++;
  }
  return n;
}
