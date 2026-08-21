/**
 * Phase A — Feasibility Engine (§4). Six pure checks over a snapshot; every
 * failure names the exact entity and the fix. This module is the "always 100%"
 * guarantee: Phase B (the solver) only runs when this returns zero blockers.
 */
import type {
  FeasibilityIssue,
  FeasibilityResult,
  FeasibilitySnapshot,
  SnapshotSubjectRequirement,
  SnapshotTeacher,
} from "./types";

const DAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function runFeasibility(snap: FeasibilitySnapshot): FeasibilityResult {
  const issues: FeasibilityIssue[] = [];
  const days = snap.config.workingDays.length;
  const perDay = snap.config.periodsPerDay;
  const available = days * perDay;

  const sectionsByClass = new Map<number, typeof snap.classSections>();
  for (const cs of snap.classSections) {
    const list = sectionsByClass.get(cs.classId) ?? [];
    list.push(cs);
    sectionsByClass.set(cs.classId, list);
  }
  const reqsByClass = new Map<number, SnapshotSubjectRequirement[]>();
  for (const r of snap.subjectRequirements) {
    const list = reqsByClass.get(r.classId) ?? [];
    list.push(r);
    reqsByClass.set(r.classId, list);
  }

  if (snap.classSections.length === 0 || snap.subjectRequirements.length === 0) {
    issues.push({
      code: "NO_DATA",
      severity: "warning",
      message:
        snap.classSections.length === 0
          ? "No class-sections are assigned to this timetable yet — add classes in the Setup Wizard."
          : "No curriculum is mapped yet — add subjects per class in Curriculum Mapping.",
      entity: { type: "config", id: snap.config.id, label: snap.config.name },
      fix: "Complete the Setup Wizard steps for this timetable.",
    });
    return finalize(snap, issues, 0, available);
  }

  let totalRequired = 0;

  // ---------- Check 1 — slot capacity per class-section (§4.1) ----------
  for (const cs of snap.classSections) {
    const reqs = reqsByClass.get(cs.classId) ?? [];
    const required = reqs.reduce((s, r) => s + r.periodsPerWeek, 0);
    totalRequired += required;
    if (required > available) {
      issues.push({
        code: "SLOT_OVERFLOW",
        severity: "blocker",
        message: `${cs.label} needs ${required} periods/week but only ${available} slots exist (${days} days × ${perDay} periods).`,
        entity: { type: "class_section", id: cs.id, label: cs.label },
        fix: `Reduce subject periods for ${cs.label}'s class by ${required - available}, or increase periods/day.`,
      });
    } else if (required > 0 && required < available) {
      issues.push({
        code: "SLOT_UNDERFLOW",
        severity: "warning",
        message: `${cs.label} has ${available - required} free slots/week — mark them as Library/Study or add subject periods.`,
        entity: { type: "class_section", id: cs.id, label: cs.label },
      });
    }
  }

  // ---------- Check 2 — teacher weekly load, pattern-aware (§4.2, §4.7, §3.10) ----------
  const demandByTeacher = new Map<number, number>();
  for (const m of snap.mappings) {
    demandByTeacher.set(m.teacherId, (demandByTeacher.get(m.teacherId) ?? 0) + m.periodsPerWeek);
  }
  for (const g of snap.mergedGroups) {
    demandByTeacher.set(g.teacherId, (demandByTeacher.get(g.teacherId) ?? 0) + g.periodsPerWeek);
  }

  for (const t of snap.teachers) {
    const localDemand = demandByTeacher.get(t.id) ?? 0;
    const cross = snap.crossConfigTeacherLoad[t.id];
    const demand = localDemand + (cross?.periods ?? 0);
    if (demand === 0) continue;

    const capacity = teacherWeeklyCapacity(t, snap.config.workingDays, perDay, issues, snap);
    if (demand > capacity) {
      const biggest = snap.mappings
        .filter((m) => m.teacherId === t.id)
        .sort((a, b) => b.periodsPerWeek - a.periodsPerWeek)[0];
      const crossNote = cross?.periods
        ? ` (includes ${cross.periods} periods/week in ${cross.otherConfigNames.join(", ")} — cross-timetable loads count together)`
        : "";
      issues.push({
        code: "TEACHER_OVERLOAD",
        severity: "blocker",
        message: `${t.name} is assigned ${demand} periods/week but their capacity is ${capacity}${crossNote}. Over by ${demand - capacity}.`,
        entity: { type: "teacher", id: t.id, label: t.name },
        fix: biggest
          ? `Reassign [${biggest.classSectionLabel} ${biggest.subjectName}: ${biggest.periodsPerWeek} periods] to another teacher, or raise ${t.name}'s max load.`
          : `Reduce ${t.name}'s assignments or raise their max load.`,
      });
    } else if (capacity > 0 && demand / capacity >= 0.9) {
      // ---------- Check 4b — tightness score (§4.4) ----------
      issues.push({
        code: "TEACHER_TIGHT",
        severity: "warning",
        message: `${t.name} is at ${Math.round((demand / capacity) * 100)}% of capacity (${demand}/${capacity}) — at risk of unsolvable local conflicts.`,
        entity: { type: "teacher", id: t.id, label: t.name },
      });
    }

    // ---------- Check 4a — daily pigeonhole (§4.4) ----------
    // Lower bound: demand spread as evenly as possible still forces some day to
    // carry ceil(weekly/days) periods. Pattern days shrink the divisor.
    const spreadDays =
      t.periodPattern === "alternate_day"
        ? (t.alternateDaySet?.filter((d) => snap.config.workingDays.includes(d)).length ??
          Math.ceil(days / 2))
        : days;
    const minMaxDaily = spreadDays > 0 ? Math.ceil(localDemand / spreadDays) : Infinity;
    const dailyCap = Math.min(
      t.periodPattern === "alternate_period" ? Math.floor((perDay + 1) / 2) : perDay,
      t.maxPeriodsPerDay,
    );
    if (localDemand > 0 && minMaxDaily > dailyCap) {
      issues.push({
        code: "DAILY_PIGEONHOLE",
        severity: "blocker",
        message: `${t.name}'s ${localDemand} periods/week over ${spreadDays} day(s) force at least ${minMaxDaily} periods on some day, but their daily cap is ${dailyCap}.`,
        entity: { type: "teacher", id: t.id, label: t.name },
        fix: `Spread ${t.name}'s load across more teachers, or raise their daily max.`,
      });
    }
  }

  // ---------- Check 3 — daily distribution & block feasibility (§4.3, §4.8) ----------
  for (const [classId, reqs] of reqsByClass) {
    const sections = sectionsByClass.get(classId) ?? [];
    if (sections.length === 0) continue;
    const classLabel = sections[0].label.split("-")[0];
    for (const r of reqs) {
      checkDailyDistribution(r, classLabel, days, perDay, snap.config.daySegments, issues);
      // ---------- Check 6c — same-period-across-week (§4.6) ----------
      if (r.samePeriodAcrossWeek) {
        if (r.periodsPerWeek > days) {
          issues.push({
            code: "SAME_PERIOD_IMPOSSIBLE",
            severity: "blocker",
            message: `${r.subjectName} (Class ${classLabel}) is set to the same period every day, but needs ${r.periodsPerWeek} periods in a ${days}-day week.`,
            entity: { type: "class_subject", id: r.id, label: `${classLabel} · ${r.subjectName}` },
            fix: `Reduce to ≤ ${days} periods/week or turn off same-period-across-week.`,
          });
        } else if (r.periodsPerWeek < days) {
          issues.push({
            code: "SAME_PERIOD_PICK_DAYS",
            severity: "warning",
            message: `${r.subjectName} (Class ${classLabel}) runs same-period on only ${r.periodsPerWeek} of ${days} days — pick which days, rather than letting the solver guess.`,
            entity: { type: "class_subject", id: r.id, label: `${classLabel} · ${r.subjectName}` },
          });
        }
      }
    }
  }

  // ---------- Check 6d — mapping coverage per section (§4.6) ----------
  for (const cs of snap.classSections) {
    for (const r of reqsByClass.get(cs.classId) ?? []) {
      const mapped = snap.mappings
        .filter((m) => m.classSectionId === cs.id && m.subjectId === r.subjectId)
        .reduce((s, m) => s + m.periodsPerWeek, 0);
      const merged = snap.mergedGroups
        .filter((g) => g.subjectId === r.subjectId && g.memberClassSectionIds.includes(cs.id))
        .reduce((s, g) => s + g.periodsPerWeek, 0);
      const covered = mapped + merged;
      if (covered < r.periodsPerWeek) {
        issues.push({
          code: "UNDER_MAPPED",
          severity: "blocker",
          message:
            covered === 0
              ? `No teacher is mapped for ${r.subjectName} in ${cs.label} (${r.periodsPerWeek} periods/week required).`
              : `${r.subjectName} in ${cs.label} has only ${covered} of ${r.periodsPerWeek} periods/week mapped to a teacher.`,
          entity: { type: "class_section", id: cs.id, label: `${cs.label} · ${r.subjectName}` },
          fix: `Add a Subject Mapping for ${r.subjectName} in ${cs.label} covering ${r.periodsPerWeek - covered} periods/week.`,
        });
      } else if (covered > r.periodsPerWeek) {
        issues.push({
          code: "OVER_MAPPED",
          severity: "blocker",
          message: `${r.subjectName} in ${cs.label} has ${covered} periods/week mapped but the curriculum needs only ${r.periodsPerWeek}.`,
          entity: { type: "class_section", id: cs.id, label: `${cs.label} · ${r.subjectName}` },
          fix: `Reduce the mapping by ${covered - r.periodsPerWeek} periods/week.`,
        });
      }
    }
  }

  // ---------- Check 5 — shared/special room contention (§4.5) ----------
  const labSet = new Set(snap.labSubjectIds);
  let labDemand = 0;
  for (const cs of snap.classSections) {
    for (const r of reqsByClass.get(cs.classId) ?? []) {
      if (labSet.has(r.subjectId)) labDemand += r.periodsPerWeek;
    }
  }
  if (labDemand > 0) {
    const labSupply = snap.labRoomCount * available;
    if (snap.labRoomCount === 0) {
      issues.push({
        code: "LAB_NONE",
        severity: "blocker",
        message: `${labDemand} lab periods/week are required but no lab room exists.`,
        entity: { type: "config", id: snap.config.id, label: snap.config.name },
        fix: "Add a room with type 'lab' in the Rooms step.",
      });
    } else if (labDemand > labSupply) {
      issues.push({
        code: "LAB_OVERFLOW",
        severity: "blocker",
        message: `${labDemand} lab periods/week are required but ${snap.labRoomCount} lab room(s) supply only ${labSupply} lab slots.`,
        entity: { type: "config", id: snap.config.id, label: snap.config.name },
        fix: "Add a lab room or reduce lab-subject periods.",
      });
    } else if (labDemand >= 0.8 * labSupply) {
      issues.push({
        code: "LAB_TIGHT",
        severity: "warning",
        message: `Lab usage will be ${Math.round((labDemand / labSupply) * 100)}% of the ${snap.labRoomCount} lab room(s) — the solver must spread lab periods thin; confirm this is acceptable.`,
        entity: { type: "config", id: snap.config.id, label: snap.config.name },
      });
    }
  }

  // ---------- Check 6a/6b — class-teacher structure (§4.6, §8.1b) ----------
  const p1Teachers = new Map<number, string[]>(); // teacherId -> section labels where CT with P1 rule
  const teacherById = new Map(snap.teachers.map((t) => [t.id, t]));
  for (const cs of snap.classSections) {
    if (cs.classTeacherId === null) {
      issues.push({
        code: "CT_UNASSIGNED",
        severity: "warning",
        message: `${cs.label} has no class teacher assigned.`,
        entity: { type: "class_section", id: cs.id, label: cs.label },
        fix: `Assign a class teacher for ${cs.label} in the Teacher Mapping step.`,
      });
      continue;
    }
    const t = teacherById.get(cs.classTeacherId);
    if (t?.classTeacherPeriodRule === "always_first_period") {
      const list = p1Teachers.get(t.id) ?? [];
      list.push(cs.label);
      p1Teachers.set(t.id, list);
    }
  }
  for (const [teacherId, labels] of p1Teachers) {
    if (labels.length > 1) {
      const t = teacherById.get(teacherId)!;
      issues.push({
        code: "CT_P1_DEADLOCK",
        severity: "blocker",
        message: `${t.name} is class teacher of ${labels.join(" and ")} with the "always first period" rule — one person cannot take Period 1 in ${labels.length} sections at once.`,
        entity: { type: "teacher", id: teacherId, label: t.name },
        fix: `Keep ${t.name} as class teacher of one section, or set their Period-1 rule to 'random'.`,
      });
    }
  }
  const ctAnywhere = new Set(
    snap.classSections.map((c) => c.classTeacherId).filter((x): x is number => x !== null),
  );
  for (const t of snap.teachers) {
    if (t.classTeacherPeriodRule === "always_first_period" && !ctAnywhere.has(t.id)) {
      issues.push({
        code: "CT_RULE_INERT",
        severity: "warning",
        message: `${t.name} has the "always first period" class-teacher rule but is not class teacher of any section — the rule has no effect (§4.7).`,
        entity: { type: "teacher", id: t.id, label: t.name },
      });
    }
  }

  return finalize(snap, issues, totalRequired, available);
}

/** §4.2/§4.7: capacity depends on the teacher's placement pattern. */
export function teacherWeeklyCapacity(
  t: SnapshotTeacher,
  workingDays: number[],
  perDay: number,
  issues?: FeasibilityIssue[],
  snap?: FeasibilitySnapshot,
): number {
  const effectiveDays = workingDays.filter((d) => !t.unavailableFullDays.includes(d));
  let pattern: number;
  switch (t.periodPattern) {
    case "alternate_period":
      // max non-adjacent periods per day = floor((n+1)/2)
      pattern = effectiveDays.length * Math.floor((perDay + 1) / 2);
      break;
    case "alternate_day": {
      if (t.alternateDaySet && t.alternateDaySet.length > 0) {
        const usable = t.alternateDaySet.filter((d) => effectiveDays.includes(d));
        pattern = usable.length * perDay;
      } else {
        pattern = Math.ceil(effectiveDays.length / 2) * perDay;
        issues?.push({
          code: "ALT_DAY_UNSET",
          severity: "warning",
          message: `${t.name} is set to alternate days but no day-set is chosen — the solver will auto-pick ${Math.ceil(effectiveDays.length / 2)} best-fit days (e.g. ${effectiveDays
            .filter((_, i) => i % 2 === 0)
            .map((d) => DAY_NAMES[d])
            .join("/")}). Confirm or pick the days explicitly.`,
          entity: { type: "teacher", id: t.id, label: t.name },
        });
      }
      break;
    }
    default:
      pattern = effectiveDays.length * perDay;
  }
  void snap;
  return Math.max(0, Math.min(t.maxPeriodsPerWeek, pattern - t.unavailablePeriodCount));
}

function checkDailyDistribution(
  r: SnapshotSubjectRequirement,
  classLabel: string,
  days: number,
  perDay: number,
  daySegments: number[],
  issues: FeasibilityIssue[],
) {
  const cap = Math.min(r.maxPeriodsPerDay, perDay);
  const entity = {
    type: "class_subject" as const,
    id: r.id,
    label: `${classLabel} · ${r.subjectName}`,
  };

  if (r.consecutiveBlockSize > 1) {
    const size = r.consecutiveBlockSize;
    const blocks = r.consecutiveBlocksPerWeek ?? Math.floor(r.periodsPerWeek / size);
    if (size * blocks > r.periodsPerWeek) {
      issues.push({
        code: "BLOCK_MATH_INVALID",
        severity: "blocker",
        message: `${r.subjectName} (Class ${classLabel}): ${blocks} blocks of ${size} periods = ${blocks * size}, more than its ${r.periodsPerWeek} periods/week.`,
        entity,
        fix: `Reduce blocks/week to ≤ ${Math.floor(r.periodsPerWeek / size)} or raise periods/week.`,
      });
      return;
    }
    if (size > r.maxPeriodsPerDay) {
      issues.push({
        code: "BLOCK_EXCEEDS_DAILY_MAX",
        severity: "blocker",
        message: `${r.subjectName} (Class ${classLabel}) needs ${size} consecutive periods in one day, but its max/day is ${r.maxPeriodsPerDay}.`,
        entity,
        fix: `Raise max periods/day for ${r.subjectName} to at least ${size}.`,
      });
      return;
    }
    if (daySegments.length > 0 && Math.max(...daySegments) < size) {
      issues.push({
        code: "BLOCK_FRAGMENTED",
        severity: "blocker",
        message: `${r.subjectName} (Class ${classLabel}) needs a ${size}-period consecutive block, but breaks split the day into runs of at most ${Math.max(...daySegments)} periods — no block can ever fit (§4.8).`,
        entity,
        fix: "Move a break, or reduce the consecutive block size.",
      });
      return;
    }
    const singles = r.periodsPerWeek - blocks * size;
    const blocksPerDayMax = Math.max(1, Math.floor(cap / size));
    const daysNeeded = Math.max(
      Math.ceil(r.periodsPerWeek / cap),
      Math.ceil(blocks / blocksPerDayMax) + (singles > 0 ? 0 : 0),
    );
    if (daysNeeded > days) {
      issues.push({
        code: "DAILY_DISTRIBUTION",
        severity: "blocker",
        message: `${r.subjectName} (Class ${classLabel}) needs ${blocks} block(s) of ${size} + ${singles} single period(s), requiring ${daysNeeded} days — the week has ${days}.`,
        entity,
        fix: `Allow ${Math.ceil(r.periodsPerWeek / days)} periods/day for ${r.subjectName}, or reduce periods/week.`,
      });
    }
    return;
  }

  const daysNeeded = Math.ceil(r.periodsPerWeek / cap);
  if (daysNeeded > days) {
    issues.push({
      code: "DAILY_DISTRIBUTION",
      severity: "blocker",
      message: `${r.subjectName} (Class ${classLabel}) needs ${r.periodsPerWeek} periods/week at max ${cap}/day — that requires ${daysNeeded} days; the week has only ${days}.`,
      entity,
      fix: `Allow ${Math.ceil(r.periodsPerWeek / days)} periods on some days, or reduce to ${days * cap}/week.`,
    });
  }
}

function finalize(
  snap: FeasibilitySnapshot,
  issues: FeasibilityIssue[],
  totalRequired: number,
  available: number,
): FeasibilityResult {
  const blockers = issues.filter((i) => i.severity === "blocker");
  const warnings = issues.filter((i) => i.severity === "warning");
  const hasData = snap.classSections.length > 0 && snap.subjectRequirements.length > 0;
  const score = !hasData
    ? 0
    : Math.max(0, 100 - blockers.length * 10 - warnings.length * 2);
  return {
    score,
    ready: hasData && blockers.length === 0,
    blockers,
    warnings,
    stats: {
      classSections: snap.classSections.length,
      teachers: snap.teachers.length,
      totalRequiredSlots: totalRequired,
      totalAvailableSlots: available * snap.classSections.length,
    },
  };
}
