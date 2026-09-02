/**
 * §5.1 variable & domain construction. Hard teacher rules (§4.7) are enforced
 * here as domain pruning — illegal slots never exist for the search to try.
 */
import type { SnapshotTeacher } from "../feasibility/types";
import type { SolverInput, SolverVariable } from "./types";

export interface TeacherCtx {
  info: SnapshotTeacher;
  /** blocked (day,period) cells incl. full-day unavailability expansion */
  blocked: Set<string>;
  /** days this teacher may be scheduled at all (alternate_day, §4.7) */
  allowedDays: Set<number>;
  /** sections where this teacher is class teacher with always_first_period */
  p1OwnSections: Set<number>;
  hasP1Rule: boolean;
}

export const cellKey = (day: number, period: number) => `${day}:${period}`;

export function buildTeacherCtx(input: SolverInput): Map<number, TeacherCtx> {
  const { snapshot } = input;
  const days = snapshot.config.workingDays;
  const perDay = snapshot.config.periodsPerDay;
  const ctx = new Map<number, TeacherCtx>();

  const unavailByTeacher = new Map<number, Array<{ dayOfWeek: number; periodNumber: number | null }>>();
  for (const u of input.teacherUnavailability) {
    const list = unavailByTeacher.get(u.teacherId) ?? [];
    list.push(u);
    unavailByTeacher.set(u.teacherId, list);
  }

  for (const t of snapshot.teachers) {
    const blocked = new Set<string>();
    for (const u of unavailByTeacher.get(t.id) ?? []) {
      if (u.periodNumber === null) {
        for (let p = 1; p <= perDay; p++) blocked.add(cellKey(u.dayOfWeek, p));
      } else {
        blocked.add(cellKey(u.dayOfWeek, u.periodNumber));
      }
    }
    let allowedDays = new Set(days);
    if (t.periodPattern === "alternate_day") {
      const set =
        t.alternateDaySet && t.alternateDaySet.length > 0
          ? t.alternateDaySet.filter((d) => days.includes(d))
          : days.filter((_, i) => i % 2 === 0); // auto-pick: alternating from first working day (§4.7)
      allowedDays = new Set(set);
    }
    const p1OwnSections = new Set(
      snapshot.classSections.filter((cs) => cs.classTeacherId === t.id).map((cs) => cs.id),
    );
    ctx.set(t.id, {
      info: t,
      blocked,
      allowedDays,
      p1OwnSections,
      hasP1Rule: t.classTeacherPeriodRule === "always_first_period",
    });
  }
  return ctx;
}

/** segment id per period (1-based), derived from daySegments — blocks may not cross breaks (§4.8) */
export function segmentOfPeriod(daySegments: number[], perDay: number): number[] {
  const seg: number[] = new Array(perDay + 1).fill(0);
  if (daySegments.length === 0) return seg; // no layout yet → one segment
  let p = 1;
  daySegments.forEach((len, i) => {
    for (let k = 0; k < len && p <= perDay; k++, p++) seg[p] = i;
  });
  for (; p <= perDay; p++) seg[p] = daySegments.length - 1;
  return seg;
}

export function buildVariables(input: SolverInput, teacherCtx: Map<number, TeacherCtx>): SolverVariable[] {
  const { snapshot } = input;
  const perDay = snapshot.config.periodsPerDay;
  const days = snapshot.config.workingDays;
  const seg = segmentOfPeriod(snapshot.config.daySegments, perDay);
  const labSubjects = new Set(snapshot.labSubjectIds);
  const sectionById = new Map(snapshot.classSections.map((cs) => [cs.id, cs]));
  const reqByClassSubject = new Map(
    snapshot.subjectRequirements.map((r) => [`${r.classId}:${r.subjectId}`, r]),
  );

  // locked cells consume occurrences of the matching (section, subject, teacher)
  const lockedCount = new Map<string, number>();
  for (const l of input.lockedSlots) {
    const k = `${l.classSectionId}:${l.subjectId}:${l.teacherId}`;
    lockedCount.set(k, (lockedCount.get(k) ?? 0) + 1);
  }

  const vars: SolverVariable[] = [];
  let nextId = 1;

  /**
   * Legal (day, startPeriod) pairs for a variable, after §4.7 pruning.
   *
   * `teacherIds` is a list because a §4.9 elective occupies every option's
   * teacher at once: the block can only run where *all* of them can, so the
   * domain is the intersection. One alternate-day teacher therefore narrows
   * the whole block — which is the point, and why the feasibility engine warns
   * about it before the search ever starts.
   */
  const domainFor = (
    teacherIds: number[],
    span: number,
    sectionIds: number[],
  ): Array<{ day: number; period: number }> => {
    const ctxs = teacherIds.map((id) => teacherCtx.get(id)).filter((x): x is TeacherCtx => !!x);
    const domain: Array<{ day: number; period: number }> = [];
    for (const day of days) {
      if (ctxs.some((tc) => !tc.allowedDays.has(day))) continue; // alternate_day pruning (§4.7)
      for (let p = 1; p + span - 1 <= perDay; p++) {
        if (seg[p] !== seg[p + span - 1]) continue; // block cannot straddle a break (§4.8)
        // always_first_period: such a teacher never takes P1 in any OTHER section
        const p1Blocked = ctxs.some(
          (tc) => tc.hasP1Rule && p === 1 && !sectionIds.every((id) => tc.p1OwnSections.has(id)),
        );
        if (p1Blocked) continue;
        let blockedCell = false;
        for (let s = 0; s < span && !blockedCell; s++) {
          if (ctxs.some((tc) => tc.blocked.has(cellKey(day, p + s)))) blockedCell = true;
        }
        if (!blockedCell) domain.push({ day, period: p });
      }
    }
    return domain;
  };

  // ---- per-mapping variables (singles + consecutive blocks, §4.8) ----
  for (const m of snapshot.mappings) {
    const cs = sectionById.get(m.classSectionId);
    if (!cs) continue;
    const req = reqByClassSubject.get(`${cs.classId}:${m.subjectId}`);
    const maxPerDay = Math.min(req?.maxPeriodsPerDay ?? 1, perDay);
    const blockSize = req?.consecutiveBlockSize ?? 1;
    const remaining = Math.max(
      0,
      m.periodsPerWeek - (lockedCount.get(`${m.classSectionId}:${m.subjectId}:${m.teacherId}`) ?? 0),
    );
    let blocks = 0;
    if (blockSize > 1) {
      blocks = Math.min(
        req?.consecutiveBlocksPerWeek ?? Math.floor(remaining / blockSize),
        Math.floor(remaining / blockSize),
      );
    }
    const singles = remaining - blocks * blockSize;
    const samePeriodKey = req?.samePeriodAcrossWeek ? `${m.classSectionId}:${m.subjectId}` : null;
    const common = {
      classSectionIds: [m.classSectionId],
      classSectionLabels: [m.classSectionLabel],
      subjectId: m.subjectId,
      subjectName: m.subjectName,
      teacherId: m.teacherId,
      mergedGroupId: null,
      electiveBlockId: null,
      options: [],
      dayKey: `S${m.subjectId}`,
      mappingId: m.id,
      needsLabRoom: labSubjects.has(m.subjectId),
      labRoomIds: snapshot.labRoomsBySubject[m.subjectId] ?? [],
      homeRoomId: snapshot.homeRoomBySection[m.classSectionId] ?? null,
      preferredRoomId: input.preferredRoomByMapping[m.id] ?? null,
      samePeriodKey,
      maxPerDay,
    };
    for (let i = 0; i < blocks; i++) {
      vars.push({ ...common, id: nextId++, span: blockSize, domain: domainFor([m.teacherId], blockSize, common.classSectionIds) });
    }
    for (let i = 0; i < singles; i++) {
      vars.push({ ...common, id: nextId++, span: 1, domain: domainFor([m.teacherId], 1, common.classSectionIds) });
    }
  }

  // ---- merged-group variables (§4.9): one variable per occurrence, spanning all members ----
  for (const g of snapshot.mergedGroups) {
    const labels = g.memberClassSectionIds.map((id) => {
      const cs = sectionById.get(id);
      return cs ? cs.label : `#${id}`;
    });
    const anyReq = (() => {
      for (const id of g.memberClassSectionIds) {
        const cs = sectionById.get(id);
        const r = cs && reqByClassSubject.get(`${cs.classId}:${g.subjectId}`);
        if (r) return r;
      }
      return null;
    })();
    for (let i = 0; i < g.periodsPerWeek; i++) {
      vars.push({
        id: nextId++,
        classSectionIds: g.memberClassSectionIds,
        classSectionLabels: labels,
        subjectId: g.subjectId,
        subjectName: g.subjectName,
        teacherId: g.teacherId,
        mergedGroupId: g.id,
        electiveBlockId: null,
        options: [],
        dayKey: `S${g.subjectId}`,
        mappingId: null,
        span: 1,
        needsLabRoom: labSubjects.has(g.subjectId),
        labRoomIds: snapshot.labRoomsBySubject[g.subjectId] ?? [],
        // A merged lesson happens in one place. With no room of its own it
        // falls back to the first member's room, which is where a school would
        // in practice hold it.
        homeRoomId: snapshot.homeRoomBySection[g.memberClassSectionIds[0]] ?? null,
        preferredRoomId: input.mergedGroupRooms[g.id] ?? null,
        samePeriodKey: null,
        maxPerDay: Math.min(anyReq?.maxPeriodsPerDay ?? 1, perDay),
        domain: domainFor([g.teacherId], 1, g.memberClassSectionIds),
      });
    }
  }

  // ---- split-elective variables (§4.9): one variable per occurrence, holding
  // one slot open across every member section while all of its options run ----
  for (const b of snapshot.electiveBlocks) {
    const options = b.options.map((o) => ({
      optionId: o.id,
      subjectId: o.subjectId,
      subjectName: o.subjectName,
      teacherId: o.teacherId,
      roomId: o.roomId,
    }));
    const teacherIds = options.map((o) => o.teacherId);
    const free = domainFor(teacherIds, 1, b.memberClassSectionIds);
    // §4.9 Phase 15 — placement is DOMAIN PRUNING, never a preference score
    // (invariant 2). A pinned occurrence is handed exactly the cell the school
    // named, intersected with what its option teachers can actually work: if
    // that intersection is empty the block will not place, and the feasibility
    // engine has already said so by name rather than letting it fail here.
    const pins = b.placement === "fixed" ? b.fixedSlots : [];
    for (let i = 0; i < b.periodsPerWeek; i++) {
      const pin = pins[i];
      const domain = pin
        ? free.filter((c) => c.day === pin.day && c.period === pin.period)
        : free;
      vars.push({
        id: nextId++,
        classSectionIds: b.memberClassSectionIds,
        classSectionLabels: b.memberLabels,
        subjectId: null,
        subjectName: b.name,
        teacherId: null,
        mergedGroupId: null,
        electiveBlockId: b.id,
        options,
        // Counted against the block: a section takes one language period a day,
        // not one of French and one of German.
        dayKey: `B${b.id}`,
        mappingId: null,
        span: 1,
        // Options carry their own rooms, so the block never draws on the lab
        // pool and the member sections' own rooms stay free.
        needsLabRoom: false,
        labRoomIds: [],
        homeRoomId: null,
        preferredRoomId: null,
        // `same_period` reuses the §4.6 same-period-across-week machinery: the
        // first occurrence to be placed fixes the period number, and every
        // later one must match it. Nothing new in the state machine.
        samePeriodKey: b.placement === "same_period" ? `B${b.id}` : null,
        maxPerDay: Math.min(b.maxPeriodsPerDay, perDay),
        domain,
      });
    }
  }

  return vars;
}
