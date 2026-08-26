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

  // A §4.9 elective block reserves the same slot in every member section's
  // grid, so its periods are real demand on each of them — but they are NOT in
  // the curriculum, because the section spends 5 periods on "a language", not
  // 5 on each of three languages. Counted once per section, here.
  const blockPeriodsBySection = new Map<number, number>();
  for (const b of snap.electiveBlocks) {
    for (const cs of b.memberClassSectionIds) {
      blockPeriodsBySection.set(cs, (blockPeriodsBySection.get(cs) ?? 0) + b.periodsPerWeek);
    }
  }

  // ---------- Check 1 — slot capacity per class-section (§4.1) ----------
  for (const cs of snap.classSections) {
    const reqs = reqsByClass.get(cs.classId) ?? [];
    const required =
      reqs.reduce((s, r) => s + r.periodsPerWeek, 0) + (blockPeriodsBySection.get(cs.id) ?? 0);
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
  // Every option runs for the whole block, so each option's teacher carries the
  // block's full weekly periods — once, however many sections attend.
  for (const b of snap.electiveBlocks) {
    for (const o of b.options) {
      demandByTeacher.set(o.teacherId, (demandByTeacher.get(o.teacherId) ?? 0) + b.periodsPerWeek);
    }
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

  // ---------- Check 6e — block subject taught by an alternate-period teacher ----------
  // A consecutive block is internally adjacent, which the alternate_period hard
  // rule forbids (§4.7) — contradictory configuration, caught before solving.
  const teacherById2 = new Map(snap.teachers.map((t) => [t.id, t]));
  for (const m of snap.mappings) {
    const cs = snap.classSections.find((c) => c.id === m.classSectionId);
    const req = cs
      ? snap.subjectRequirements.find((r) => r.classId === cs.classId && r.subjectId === m.subjectId)
      : undefined;
    const t = teacherById2.get(m.teacherId);
    if (req && req.consecutiveBlockSize > 1 && t?.periodPattern === "alternate_period") {
      issues.push({
        code: "BLOCK_TEACHER_PATTERN",
        severity: "blocker",
        message: `${t.name} teaches ${m.subjectName} in ${m.classSectionLabel} as ${req.consecutiveBlockSize}-period blocks, but their alternate-period pattern forbids adjacent periods — contradictory configuration.`,
        entity: { type: "mapping", id: m.id, label: `${m.classSectionLabel} · ${m.subjectName}` },
        fix: `Assign a different teacher for ${m.subjectName} in ${m.classSectionLabel}, or remove the block/pattern rule.`,
      });
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

  // ---------- Check 7 — split electives (§4.9) ----------
  //
  // The mirror of a merged group: one slot held open across every member
  // section, with several lessons running inside it at once. Everything that
  // can go wrong here is structural or arithmetic, which means it can be caught
  // now rather than as a solver that quietly fails to place the block.
  const sectionLabelById = new Map(snap.classSections.map((cs) => [cs.id, cs.label]));
  for (const b of snap.electiveBlocks) {
    const where = { type: "elective_block" as const, id: b.id, label: b.name };

    if (b.memberClassSectionIds.length === 0) {
      issues.push({
        code: "ELECTIVE_NO_MEMBERS",
        severity: "blocker",
        message: `${b.name} has no class-sections attending it, so nothing would ever be scheduled.`,
        entity: where,
        fix: `Add the class-sections whose students take ${b.name}.`,
      });
    }

    // One option is not a choice — it is an ordinary subject, and modelling it
    // as a block only hides it from the curriculum.
    if (b.options.length < 2) {
      issues.push({
        code: "ELECTIVE_TOO_FEW_OPTIONS",
        severity: "blocker",
        message: `${b.name} offers ${b.options.length} option(s) — a split elective needs at least 2.`,
        entity: where,
        fix:
          b.options.length === 1
            ? `Add another option to ${b.name}, or make it an ordinary subject in the curriculum instead.`
            : `Add the subject/teacher/room choices students pick between in ${b.name}.`,
      });
    }

    // The options all run in the SAME period, so a teacher or a room appearing
    // twice is a person or a place being asked to be in two lessons at once.
    // The DB would refuse it at write time; saying so now names the row.
    const seenTeacher = new Map<number, string>();
    const seenRoom = new Map<number, string>();
    for (const o of b.options) {
      const clashT = seenTeacher.get(o.teacherId);
      if (clashT) {
        issues.push({
          code: "ELECTIVE_TEACHER_CLASH",
          severity: "blocker",
          message: `${o.teacherName} teaches both ${clashT} and ${o.subjectName} in ${b.name} — every option runs in the same period, so one person cannot cover both.`,
          entity: { type: "teacher", id: o.teacherId, label: o.teacherName },
          fix: `Give ${o.subjectName} in ${b.name} a different teacher.`,
        });
      } else seenTeacher.set(o.teacherId, o.subjectName);

      const clashR = seenRoom.get(o.roomId);
      if (clashR) {
        issues.push({
          code: "ELECTIVE_ROOM_CLASH",
          severity: "blocker",
          message: `${o.roomName} is used by both ${clashR} and ${o.subjectName} in ${b.name} — the options run at the same time, so they need different rooms.`,
          entity: { type: "room", id: o.roomId, label: o.roomName },
          fix: `Give ${o.subjectName} in ${b.name} a different room.`,
        });
      } else seenRoom.set(o.roomId, o.subjectName);
    }

    // ---- daily distribution, the §4.3 pigeonhole applied to the block ----
    if (b.periodsPerWeek > days * b.maxPeriodsPerDay) {
      issues.push({
        code: "ELECTIVE_DAILY_PIGEONHOLE",
        severity: "blocker",
        message: `${b.name} needs ${b.periodsPerWeek} periods/week but is capped at ${b.maxPeriodsPerDay}/day over ${days} working day(s) — at most ${days * b.maxPeriodsPerDay} can be placed.`,
        entity: where,
        fix: `Reduce ${b.name} to ${days * b.maxPeriodsPerDay} periods/week, or raise its max periods/day.`,
      });
    }

    // ---- the days ALL option teachers can actually work (§4.7) ----
    // One alternate_day teacher constrains the whole block, because every
    // option has to run on the same day as the others. This is the check that
    // is genuinely hard to see by eye.
    if (b.options.length > 0) {
      let commonDays: number[] = [...snap.config.workingDays];
      const limiters: string[] = [];
      for (const o of b.options) {
        const t = snap.teachers.find((x) => x.id === o.teacherId);
        if (!t || t.periodPattern !== "alternate_day") continue;
        const allowed =
          t.alternateDaySet && t.alternateDaySet.length > 0
            ? t.alternateDaySet.filter((d) => snap.config.workingDays.includes(d))
            : snap.config.workingDays.filter((_, i) => i % 2 === 0);
        commonDays = commonDays.filter((d) => allowed.includes(d));
        limiters.push(`${t.name} (${allowed.map((d) => DAY_NAMES[d]).join(", ")})`);
      }
      if (limiters.length > 0 && b.periodsPerWeek > commonDays.length * b.maxPeriodsPerDay) {
        issues.push({
          code: "ELECTIVE_DAY_INTERSECTION",
          severity: "blocker",
          message:
            commonDays.length === 0
              ? `${b.name} has no day when all of its option teachers can teach — ${limiters.join("; ")} leave no day in common.`
              : `${b.name} needs ${b.periodsPerWeek} periods/week but all its options can only meet on ${commonDays.map((d) => DAY_NAMES[d]).join(", ")} — ${limiters.join("; ")} — allowing at most ${commonDays.length * b.maxPeriodsPerDay}.`,
          entity: where,
          fix: `Replace an alternate-day teacher in ${b.name}, widen their days, or reduce the block to ${commonDays.length * b.maxPeriodsPerDay} periods/week.`,
        });
      }
    }

    // ---- an option subject must not ALSO sit in the curriculum ----
    // If it does, the class is charged for the block AND for the subject, and
    // the subject then demands its own per-section mapping it will never get.
    for (const csId of b.memberClassSectionIds) {
      const cs = snap.classSections.find((x) => x.id === csId);
      if (!cs) continue;
      for (const o of b.options) {
        const dup = (reqsByClass.get(cs.classId) ?? []).find((r) => r.subjectId === o.subjectId);
        if (dup) {
          issues.push({
            code: "ELECTIVE_SUBJECT_DOUBLE_COUNTED",
            severity: "blocker",
            message: `${o.subjectName} is both an option in ${b.name} and a ${dup.periodsPerWeek}-period curriculum subject for ${sectionLabelById.get(csId) ?? `#${csId}`}'s class — it would be counted, and taught, twice.`,
            entity: { type: "class_section", id: csId, label: `${sectionLabelById.get(csId) ?? csId} · ${o.subjectName}` },
            fix: `Remove ${o.subjectName} from the curriculum — the block already accounts for those periods.`,
          });
        }
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
