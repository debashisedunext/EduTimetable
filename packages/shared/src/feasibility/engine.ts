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

  // ---------- Check 8 — teaching scope and engagement (§18) ----------
  //
  // The endpoints refuse an out-of-scope mapping at the point it is made, so
  // in a healthy school this finds nothing. It exists for the data that did
  // not come through those endpoints: rows created before the rule, an import
  // written against an older build, or a scope narrowed *after* the mappings
  // were made — which is the case a person is most likely to cause and least
  // likely to notice.
  const teacherForScope = new Map(snap.teachers.map((t) => [t.id, t]));
  const classOfSection = new Map(snap.classSections.map((cs) => [cs.id, cs.classId]));
  const classNameOfSection = new Map(snap.classSections.map((cs) => [cs.id, cs.label]));

  /** Every (teacher, class-section) the timetable currently depends on. */
  const attachments: Array<{ teacherId: number; classSectionId: number; what: string }> = [];
  for (const m of snap.mappings) {
    attachments.push({ teacherId: m.teacherId, classSectionId: m.classSectionId, what: m.subjectName });
  }
  for (const g of snap.mergedGroups) {
    for (const cs of g.memberClassSectionIds) {
      attachments.push({ teacherId: g.teacherId, classSectionId: cs, what: `${g.subjectName} (merged)` });
    }
  }
  for (const b of snap.electiveBlocks) {
    for (const o of b.options) {
      for (const cs of b.memberClassSectionIds) {
        attachments.push({ teacherId: o.teacherId, classSectionId: cs, what: `${o.subjectName} in ${b.name}` });
      }
    }
  }

  const reportedScope = new Set<string>();
  const guestSeen = new Set<number>();
  for (const a of attachments) {
    const t = teacherForScope.get(a.teacherId);
    if (!t) continue;

    if (t.employmentType === "guest" && !guestSeen.has(t.id)) {
      guestSeen.add(t.id);
      issues.push({
        code: "GUEST_IN_CURRICULUM",
        severity: "blocker",
        message: `${t.name} is engaged as a guest teacher but is mapped into the regular timetable (${a.what}, ${classNameOfSection.get(a.classSectionId) ?? "?"}).`,
        entity: { type: "teacher", id: t.id, label: t.name },
        fix: `Either change ${t.name}'s engagement to permanent or adhoc, or move this teaching to the Extra Classes screen.`,
      });
    }

    if (t.eligibleClassIds.length === 0) continue; // covered by the warning below
    const classId = classOfSection.get(a.classSectionId);
    if (classId === undefined || t.eligibleClassIds.includes(classId)) continue;

    const key = `${t.id}:${classId}`;
    if (reportedScope.has(key)) continue; // one line per teacher-and-class, not per section
    reportedScope.add(key);
    issues.push({
      code: "TEACHER_NOT_ELIGIBLE",
      severity: "blocker",
      message: `${t.name} is assigned ${a.what} to ${classNameOfSection.get(a.classSectionId) ?? "a class"}, which is outside their teaching scope.`,
      entity: { type: "teacher", id: t.id, label: t.name },
      fix: `Add that class to ${t.name}'s teaching scope on the Teachers screen, or give the periods to a teacher who covers it.`,
    });
  }

  // A teacher with no scope at all is not refused — it is simply unstated, and
  // saying so is more useful than pretending they may teach everything.
  //
  // One line for all of them, not one each. A school that has never filled
  // this in has *every* teacher unscoped, and a hundred identical rows would
  // drown the dashboard in something nobody can act on row by row — the point
  // of §4 is that each line names a fix worth doing.
  const unscoped = snap.teachers.filter(
    (t) => t.eligibleClassIds.length === 0 && attachments.some((a) => a.teacherId === t.id),
  );
  if (unscoped.length > 0) {
    const names = unscoped.slice(0, 3).map((t) => t.name).join(", ");
    issues.push({
      code: "TEACHER_SCOPE_UNSET",
      severity: "warning",
      message:
        unscoped.length === 1
          ? `${unscoped[0].name} has no teaching scope recorded, so nothing stops them being given any class.`
          : `${unscoped.length} teachers have no teaching scope recorded (${names}${unscoped.length > 3 ? ", …" : ""}), so nothing stops them being given any class.`,
      entity: { type: "teacher", id: unscoped[0].id, label: unscoped[0].name },
      fix: "Set which classes each teacher covers on the Teachers screen — the Import workbook has a Teaching Scope column for doing it in bulk.",
    });
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

  // ---------- Check 9 — fixed room assignment (§19) ----------
  //
  // Until Phase 12 a recorded home room was decorative: the solver wrote
  // `room_id = NULL` for every ordinary lesson. Now it claims the room, which
  // makes two things checkable that were previously invisible.
  const roomName = (id: number) => snap.roomNames[id] ?? `room #${id}`;

  // (a) Two sections cannot sit in the same room all week. Before the room was
  // claimed this was merely wrong on paper; now it is a hard collision the
  // solver would hit late, so it is caught here with both names.
  const sectionsByHomeRoom = new Map<number, string[]>();
  for (const cs of snap.classSections) {
    const room = snap.homeRoomBySection[cs.id];
    if (room == null) continue;
    const list = sectionsByHomeRoom.get(room) ?? [];
    list.push(cs.label);
    sectionsByHomeRoom.set(room, list);
  }
  for (const [room, labels] of sectionsByHomeRoom) {
    if (labels.length > 1) {
      issues.push({
        code: "HOME_ROOM_SHARED",
        severity: "blocker",
        message: `${roomName(room)} is the home room of ${labels.join(" and ")} — both are timetabled all week, so they cannot share it.`,
        entity: { type: "room", id: room, label: roomName(room) },
        fix: `Give ${labels.slice(1).join(" and ")} a different home room on the Class-Sections screen.`,
      });
    }
  }

  const unroomed = snap.classSections.filter((cs) => snap.homeRoomBySection[cs.id] == null);
  if (unroomed.length > 0) {
    issues.push({
      code: "HOME_ROOM_UNSET",
      severity: "warning",
      message:
        unroomed.length === 1
          ? `${unroomed[0].label} has no home room, so its lessons will show no room.`
          : `${unroomed.length} class-sections have no home room (${unroomed.slice(0, 3).map((c) => c.label).join(", ")}${unroomed.length > 3 ? ", …" : ""}), so their lessons will show no room.`,
      entity: { type: "class_section", id: unroomed[0].id, label: unroomed[0].label },
      fix: "Set a home room for each class-section — the Rooms screen can do it from either side.",
    });
  }

  // (b) A lab subject needs a lab that actually teaches it. Check 5 above asks
  // whether there are enough lab periods in total; this asks whether the RIGHT
  // labs exist, which is the question a school with a Bio lab and a Physics lab
  // actually has.
  for (const subjectId of snap.labSubjectIds) {
    const rooms = snap.labRoomsBySubject[subjectId] ?? [];
    let demandForSubject = 0;
    let subjectName = `subject #${subjectId}`;
    for (const cs of snap.classSections) {
      for (const r of reqsByClass.get(cs.classId) ?? []) {
        if (r.subjectId !== subjectId) continue;
        subjectName = r.subjectName;
        demandForSubject += r.periodsPerWeek;
      }
    }
    if (demandForSubject === 0) continue;

    if (rooms.length === 0) {
      issues.push({
        code: "LAB_SUBJECT_UNSERVED",
        severity: "blocker",
        message: `${subjectName} needs a lab for ${demandForSubject} periods/week, but no lab room is set up for it.`,
        entity: { type: "config", id: snap.config.id, label: snap.config.name },
        fix: `Add a lab room for ${subjectName}, or mark an existing lab as serving it on the Rooms screen.`,
      });
      continue;
    }
    const supply = rooms.length * available;
    if (demandForSubject > supply) {
      issues.push({
        code: "LAB_SUBJECT_OVERFLOW",
        severity: "blocker",
        message: `${subjectName} needs ${demandForSubject} lab periods/week but its ${rooms.length} lab(s) — ${rooms.map(roomName).join(", ")} — supply only ${supply}.`,
        entity: { type: "config", id: snap.config.id, label: snap.config.name },
        fix: `Add another lab for ${subjectName}, mark an existing lab as also serving it, or reduce its periods.`,
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
