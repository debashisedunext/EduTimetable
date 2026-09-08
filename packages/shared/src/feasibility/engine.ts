/**
 * Phase A — Feasibility Engine (§4). Six pure checks over a snapshot; every
 * failure names the exact entity and the fix. This module is the "always 100%"
 * guarantee: Phase B (the solver) only runs when this returns zero blockers.
 */
import { lunchAllows } from "../solver/variables";
import type {
  FeasibilityIssue,
  FeasibilityResult,
  FeasibilitySnapshot,
  SnapshotElectiveBlock,
  SnapshotSubjectRequirement,
  SnapshotTeacher,
} from "./types";
import { largestFeasibleMin, minDayPlan, teacherAvailableDays, teacherDailyCap, teacherDailyReach } from "./min-day";
import { alternatingDays, dayList, loadByTeacher, pickFreeRoom, pickLabForSubject, pickTeacher, remedy } from "./remedy";

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

  /** §21: remedies in the teacher loop need a section's class. */
  const classOfSectionForRemedy = new Map(snap.classSections.map((cs) => [cs.id, cs.classId]));
  /** §20: the most periods each teacher's own subjects could put in one day. */
  const dailyReach = teacherDailyReach(snap);
  /** §20 teachers whose minimum cannot be met as written — reported as one row. */
  const minRelaxed: Array<{ id: number; name: string; declared: number; effective: number; why: string }> = [];
  /** §28.1 teachers past the school's own alert line — reported as one row. */
  const nearingLimit: Array<{ name: string; demand: number; capacity: number }> = [];

  for (const t of snap.teachers) {
    const localDemand = demandByTeacher.get(t.id) ?? 0;
    const cross = snap.crossConfigTeacherLoad[t.id];
    const demand = localDemand + (cross?.periods ?? 0);
    if (demand === 0) continue;

    const capacity = teacherWeeklyCapacity(t, snap.config.workingDays, perDay, issues, snap);
    // §28.1 — noted whether or not they are over. Somebody exactly at their
    // limit belongs on this list too: "at or above" is what the school asked
    // to hear about, and an over-limit teacher is already a blocker below.
    if (capacity > 0 && demand >= capacity * (snap.config.loadAlertPct / 100)) {
      nearingLimit.push({ name: t.name, demand, capacity });
    }
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
        // §21: move work off them until they fit, smallest mapping first, so
        // the least teaching changes hands. Raising the cap instead is the
        // *other* half of the printed fix and is deliberately not offered
        // here — it is a `relax`, it lands in 14.2, and it would let one
        // button take any school to 100 by making the limit meaningless.
        ...(() => {
          const over = demand - capacity;
          const held = snap.mappings
            .filter((m) => m.teacherId === t.id)
            .sort((a, b) => a.periodsPerWeek - b.periodsPerWeek);
          const changes = [];
          const names: string[] = [];
          const pending = new Map<number, number>();
          let shed = 0;
          for (const m of held) {
            if (shed >= over) break;
            const classId = classOfSectionForRemedy.get(m.classSectionId);
            if (classId === undefined) continue;
            const pick = pickTeacher(snap, { classId, periods: m.periodsPerWeek, exclude: [t.id], pending });
            if (!pick) continue;
            pending.set(pick.teacher.id, (pending.get(pick.teacher.id) ?? 0) + m.periodsPerWeek);
            shed += m.periodsPerWeek;
            names.push(`${m.classSectionLabel} ${m.subjectName} (${m.periodsPerWeek}) → ${pick.teacher.name}`);
            changes.push({ op: "set" as const, entity: "mapping" as const, id: m.id, field: "teacherId", from: t.id, to: pick.teacher.id });
          }
          // Partly shedding the load leaves the teacher still overloaded — a
          // fix that does not fix it is worse than none, so it is all or none.
          return shed >= over && changes.length > 0
            ? { remedy: remedy("redistribute", `Move ${names.join(", ")} — ${t.name} drops to ${demand - shed}/${capacity}`, changes) }
            : {};
        })(),
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
        // §21 relax: give them the day they actually need. Bounded by the day
        // itself and — for an alternate-period teacher, who must leave a gap
        // between lessons — by every other period of it: past that the number
        // is not what is stopping them, so raising it would fix nothing.
        ...(() => {
          const patternCap =
            t.periodPattern === "alternate_period" ? Math.floor((perDay + 1) / 2) : perDay;
          if (minMaxDaily > patternCap) return {};
          return {
            remedy: remedy(
              "relax",
              `Raise ${t.name}'s maximum periods/day from ${t.maxPeriodsPerDay} to ${minMaxDaily}`,
              [{ op: "set" as const, entity: "teacher" as const, id: t.id, field: "maxPeriodsPerDay", from: t.maxPeriodsPerDay, to: minMaxDaily }],
            ),
          };
        })(),
      });
    }

    // ---------- Check 10 — minimum periods per day (§20) ----------
    // The mirror of the pigeonhole check above: that one asks whether the load
    // can be spread thinly enough, this one whether it can be packed densely
    // enough. A day is either free or carries at least the minimum, so the
    // load has to divide into whole days of [minimum, daily cap].
    if (localDemand > 0 && t.minPeriodsPerDay > 1) {
      const availableDays = teacherAvailableDays(t, snap.config.workingDays).length;
      const cap = teacherDailyCap(t, perDay, dailyReach.get(t.id));
      const plan = minDayPlan(t.minPeriodsPerDay, localDemand, cap, availableDays);
      if (!plan.feasible) {
        issues.push({
          code: "MIN_DAY_IMPOSSIBLE",
          severity: "blocker",
          message:
            plan.minDays > availableDays
              ? `${t.name}'s ${localDemand} periods/week need at least ${plan.minDays} working days, but only ${availableDays} are available to them.`
              : `${t.name} has ${localDemand} periods/week, a minimum of ${plan.effectiveMin}/day and a maximum of ${cap}/day — no whole number of days adds up to ${localDemand} within those bounds.`,
          entity: { type: "teacher", id: t.id, label: t.name },
          fix: `Set ${t.name}'s minimum periods/day to ${Math.max(1, plan.effectiveMin - 1)}, raise their daily maximum, or change their weekly load.`,
          ...(() => {
            // §21 relax: the largest minimum this load can actually keep.
            const target = largestFeasibleMin(localDemand, cap, availableDays, plan.effectiveMin - 1);
            return target > 0 && target < t.minPeriodsPerDay
              ? { remedy: remedy("relax", `Lower ${t.name}'s minimum periods/day from ${t.minPeriodsPerDay} to ${target}`, [
                  { op: "set" as const, entity: "teacher" as const, id: t.id, field: "minPeriodsPerDay", from: t.minPeriodsPerDay, to: target },
                ]) }
              : {};
          })(),
        });
      } else if (plan.relaxedBy) {
        minRelaxed.push({
          id: t.id,
          name: t.name,
          declared: plan.declared,
          effective: plan.effectiveMin,
          why:
            plan.relaxedBy === "weekly-load"
              ? `only ${localDemand} periods/week in total`
              : `at most ${cap} period(s) of their own subjects in a day`,
        });
      }
    }
  }

  if (minRelaxed.length > 0) {
    const first = minRelaxed.slice(0, 3);
    issues.push({
      code: "MIN_DAY_RELAXED",
      severity: "warning",
      message: `${minRelaxed.length} teacher(s) cannot reach their minimum periods/day: ${first
        .map((r) => `${r.name} (${r.declared} → ${r.effective}, ${r.why})`)
        .join("; ")}${minRelaxed.length > 3 ? `, and ${minRelaxed.length - 3} more` : ""}. Their days will be as full as their load allows.`,
      entity: { type: "config", id: snap.config.id, label: snap.config.name },
      fix: "Give these teachers more periods, or lower their minimum to match the work they actually have.",
      // §21 relax: write down the minimum each of them can actually keep. This
      // changes no timetable — the solver already uses the effective value
      // (§20) — it only stops the record claiming a rule the school cannot
      // honour. Still a `relax`, because it is a stated policy being lowered.
      remedy: remedy(
        "relax",
        `Lower the minimum periods/day of ${minRelaxed.length} teacher(s) to what their load allows`,
        minRelaxed.map((r) => ({
          op: "set" as const, entity: "teacher" as const, id: r.id,
          field: "minPeriodsPerDay", from: r.declared, to: r.effective,
        })),
      ),
    });
  }

  // ---------- Check 12 — teacher load alert (§28.1) ----------
  //
  // A WARNING, and that is the whole design. A teacher at 80% of their limit is
  // a normally employed teacher; refusing to generate at a number the school
  // chose for its own reporting would make most real schools ungenerable, and
  // the request was for an alert rather than a refusal.
  //
  // ONE grouped row, not one per teacher. At 122 staff a per-teacher warning
  // buries every real blocker under thirty rows of "this is fine, but".
  //
  // No remedy, deliberately. Every way to lower the percentage is either a
  // `redistribute` the Allocation advisor already offers on the screen where
  // the work is done, or a `relax` that raises the very cap the percentage is
  // measured against — a fix whose only effect is to move the goalposts.
  if (nearingLimit.length > 0) {
    const pct = snap.config.loadAlertPct;
    const worst = [...nearingLimit].sort(
      (a, b) => b.demand / b.capacity - a.demand / a.capacity,
    );
    const named = worst.slice(0, 3)
      .map((t) => `${t.name} ${t.demand}/${t.capacity}`)
      .join(", ");
    issues.push({
      code: "TEACHER_LOAD_ALERT",
      severity: "warning",
      message:
        `${worst.length} teacher(s) are at or above ${pct}% of their weekly limit — ` +
        `${named}${worst.length > 3 ? `, and ${worst.length - 3} more` : ""}.`,
      entity: { type: "config", id: snap.config.id, label: snap.config.name },
      fix:
        `They can still be timetabled. Move a class to somebody with room on the ` +
        `Allocation screen, or raise the alert level above ${pct}% if this is the ` +
        `load the school intends.`,
    });
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
            // §21 relax: drop the rule, not the periods. Cutting periods/week
            // would change what the children are taught to satisfy a
            // scheduling preference, which is the wrong way round.
            remedy: remedy(
              "relax",
              `Turn off same-period-across-week for ${r.subjectName} (Class ${classLabel})`,
              [{ op: "set", entity: "classSubject", id: r.id, field: "samePeriodAcrossWeek", from: true, to: false }],
            ),
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
        // §21: move the teaching, never the rule. Clearing the teacher's
        // alternate-period pattern would fix this row by changing a working
        // condition somebody agreed to — a redistribute is the honest answer.
        ...(() => {
          const pick = cs
            ? pickTeacher(snap, {
                classId: cs.classId,
                periods: m.periodsPerWeek,
                exclude: [m.teacherId],
                allowPattern: (x) => x.periodPattern !== "alternate_period",
              })
            : null;
          return pick
            ? { remedy: remedy("redistribute", `Give ${m.classSectionLabel} ${m.subjectName} to ${pick.teacher.name}`, [
                { op: "set" as const, entity: "mapping" as const, id: m.id, field: "teacherId", from: m.teacherId, to: pick.teacher.id },
              ]) }
            : {};
        })(),
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
          // §21: two different shapes of the same shortfall.
          //   - Nobody is mapped at all → find a teacher and create the row.
          //   - Somebody covers part of it → top up what they already hold,
          //     rather than splitting one subject between two people, which
          //     is a staffing decision nobody asked the software to make.
          ...(() => {
            const short = r.periodsPerWeek - covered;
            const existing = snap.mappings
              .filter((m) => m.classSectionId === cs.id && m.subjectId === r.subjectId)
              .sort((a, b) => b.periodsPerWeek - a.periodsPerWeek)[0];
            if (existing) {
              const t = snap.teachers.find((x) => x.id === existing.teacherId);
              const load = t ? (loadByTeacher(snap).get(t.id) ?? 0) : 0;
              if (!t || load + short > t.maxPeriodsPerWeek) return {};
              return {
                remedy: remedy(
                  "complete",
                  `Raise ${t.name}'s ${cs.label} ${r.subjectName} from ${existing.periodsPerWeek} to ${existing.periodsPerWeek + short} periods/week`,
                  [{ op: "set" as const, entity: "mapping" as const, id: existing.id, field: "periodsPerWeek", from: existing.periodsPerWeek, to: existing.periodsPerWeek + short }],
                ),
              };
            }
            const pick = pickTeacher(snap, { classId: cs.classId, periods: short });
            return pick
              ? { remedy: remedy("redistribute", `Map ${pick.teacher.name} to ${cs.label} ${r.subjectName} for ${short} periods/week`, [
                  { op: "create" as const, entity: "mapping" as const, data: {
                    teacherId: pick.teacher.id, subjectId: r.subjectId, classSectionId: cs.id, periodsPerWeek: short,
                  } },
                ]) }
              : {}; // nobody eligible has room — a staffing problem, not a data one
          })(),
        });
      } else if (covered > r.periodsPerWeek) {
        issues.push({
          code: "OVER_MAPPED",
          severity: "blocker",
          message: `${r.subjectName} in ${cs.label} has ${covered} periods/week mapped but the curriculum needs only ${r.periodsPerWeek}.`,
          entity: { type: "class_section", id: cs.id, label: `${cs.label} · ${r.subjectName}` },
          fix: `Reduce the mapping by ${covered - r.periodsPerWeek} periods/week.`,
          // §21 relax: trim the mappings back to what the curriculum asks
          // for, largest first. The curriculum is the stated policy and the
          // mapping is the thing that drifted — but this still takes periods
          // off a real person's week, so it asks.
          ...(() => {
            let excess = covered - r.periodsPerWeek;
            const held = snap.mappings
              .filter((m) => m.classSectionId === cs.id && m.subjectId === r.subjectId)
              .sort((a, b) => b.periodsPerWeek - a.periodsPerWeek);
            const changes = [];
            const names: string[] = [];
            for (const m of held) {
              if (excess <= 0) break;
              // Never to nothing: a mapping of zero periods is a row that says
              // a teacher teaches a class they do not, which is a different
              // kind of wrong. Removing one is the admin's call.
              const take = Math.min(excess, m.periodsPerWeek - 1);
              if (take <= 0) continue;
              excess -= take;
              names.push(`${m.teacherName} ${m.periodsPerWeek} → ${m.periodsPerWeek - take}`);
              changes.push({ op: "set" as const, entity: "mapping" as const, id: m.id, field: "periodsPerWeek", from: m.periodsPerWeek, to: m.periodsPerWeek - take });
            }
            return excess === 0 && changes.length > 0
              ? { remedy: remedy("relax", `Trim ${cs.label} ${r.subjectName} to the curriculum's ${r.periodsPerWeek} periods/week (${names.join(", ")})`, changes) }
              : {};
          })(),
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
          // §21: somebody not already inside this block. Every option runs at
          // once, so the replacement must be free of the block entirely, not
          // merely free of this one option.
          ...(() => {
            const classId = snap.classSections.find((c) => c.id === b.memberClassSectionIds[0])?.classId;
            if (classId === undefined) return {};
            const pick = pickTeacher(snap, {
              classId,
              periods: b.periodsPerWeek,
              exclude: b.options.map((x) => x.teacherId),
            });
            return pick
              ? { remedy: remedy("redistribute", `Give ${o.subjectName} in ${b.name} to ${pick.teacher.name}`, [
                  { op: "set" as const, entity: "electiveOption" as const, id: o.id, field: "teacherId", from: o.teacherId, to: pick.teacher.id },
                ]) }
              : {};
          })(),
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
          // §21: any room this block is not already using. A member section's
          // own room is fine and is in fact where these lessons usually meet —
          // those students are out of their room for the period anyway.
          ...(() => {
            const used = new Set(b.options.map((x) => x.roomId));
            const free = (snap.rooms ?? []).find((r) => !used.has(r.id) && r.roomType !== "lab");
            return free
              ? { remedy: remedy("redistribute", `Move ${o.subjectName} in ${b.name} to ${free.name}`, [
                  { op: "set" as const, entity: "electiveOption" as const, id: o.id, field: "roomId", from: o.roomId, to: free.id },
                ]) }
              : {};
          })(),
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
        // §21 relax: raising the block's daily cap means a student can have
        // two of their language periods in one day. Real, and worth showing —
        // but better than cutting the subject's periods to fit.
        ...(() => {
          const needed = Math.ceil(b.periodsPerWeek / days);
          return needed <= perDay
            ? { remedy: remedy("relax", `Raise ${b.name} to ${needed} period(s)/day — students may get ${needed} in one day`, [
                { op: "set" as const, entity: "electiveBlock" as const, id: b.id, field: "maxPeriodsPerDay", from: b.maxPeriodsPerDay, to: needed },
              ]) }
            : {};
        })(),
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

    // ---- Check 7b — placement (§4.9, Phase 15) ----
    //
    // Pinning is the one thing on this screen a school can set that the solver
    // cannot route around: it removes cells rather than preferring them. So
    // every way a pin can be wrong is caught here, by name, before Generate.
    //
    // Every remedy below is `relax` and every one of them turns the PIN off
    // rather than touching the block's teaching. That is the §21 rule: a relax
    // remedy changes the rule, never what children are taught or who takes
    // them. Letting the solver choose the slot again is exactly that.
    const unpin = (why: string) =>
      remedy("relax", `Let the solver choose when ${b.name} runs — ${why}`, [
        { op: "set" as const, entity: "electiveBlock" as const, id: b.id, field: "placement", from: b.placement, to: "solver" },
      ]);

    if (b.placement === "same_period" && b.periodsPerWeek > days) {
      issues.push({
        code: "ELECTIVE_SAME_PERIOD_TIGHT",
        severity: "blocker",
        message: `${b.name} is held to one period number across the week but needs ${b.periodsPerWeek} periods over ${days} working day(s) — the same period can only come round once a day.`,
        entity: where,
        fix: `Reduce ${b.name} to ${days} periods/week, or let the solver choose its slots.`,
        remedy: unpin(`${b.periodsPerWeek} periods will not fit into ${days} day(s) at one fixed period`),
      });
    }

    if (b.placement === "fixed") {
      const pins = b.fixedSlots;
      if (pins.length !== b.periodsPerWeek) {
        issues.push({
          code: "ELECTIVE_PIN_COUNT",
          severity: "blocker",
          message:
            pins.length === 0
              ? `${b.name} is set to fixed slots but none have been chosen.`
              : `${b.name} needs ${b.periodsPerWeek} periods/week but ${pins.length} slot(s) have been fixed.`,
          entity: where,
          fix:
            pins.length < b.periodsPerWeek
              ? `Choose ${b.periodsPerWeek - pins.length} more slot(s) for ${b.name}, or let the solver place the rest.`
              : `Remove ${pins.length - b.periodsPerWeek} slot(s) from ${b.name}, or raise its periods/week.`,
          remedy: unpin(`${pins.length} slot(s) chosen for ${b.periodsPerWeek} period(s)`),
        });
      }

      // A cell outside the timetable is not a slot the solver could ever offer.
      const bad = pins.filter(
        (p) => !snap.config.workingDays.includes(p.day) || p.period < 1 || p.period > perDay,
      );
      for (const p of bad) {
        issues.push({
          code: "ELECTIVE_PIN_INVALID",
          severity: "blocker",
          message: `${b.name} is fixed to ${DAY_NAMES[p.day] ?? `day ${p.day}`} period ${p.period}, which is not a teaching slot in this timetable (${snap.config.workingDays.map((d) => DAY_NAMES[d]).join(", ")}, periods 1–${perDay}).`,
          entity: where,
          fix: `Move that slot inside the timetable's days and periods, or let the solver choose.`,
          remedy: unpin(`${DAY_NAMES[p.day] ?? `day ${p.day}`} P${p.period} is outside the timetable`),
        });
      }

      // Two occurrences on one day are legal when the block allows it, more
      // than that is not — and the same cell twice never is: one slot cannot
      // hold the block twice over.
      const perCell = new Map<string, number>();
      const perDayCount = new Map<number, number>();
      for (const p of pins) {
        const k = `${p.day}:${p.period}`;
        perCell.set(k, (perCell.get(k) ?? 0) + 1);
        perDayCount.set(p.day, (perDayCount.get(p.day) ?? 0) + 1);
      }
      for (const [k, n] of perCell) {
        if (n < 2) continue;
        const [d, p] = k.split(":").map(Number);
        issues.push({
          code: "ELECTIVE_PIN_DUPLICATE",
          severity: "blocker",
          message: `${b.name} is fixed to ${DAY_NAMES[d]} period ${p} ${n} times — one slot cannot hold the block more than once.`,
          entity: where,
          fix: `Spread those ${n} periods across different slots.`,
          remedy: unpin(`${DAY_NAMES[d]} P${p} is named ${n} times`),
        });
      }
      for (const [d, n] of perDayCount) {
        if (n <= b.maxPeriodsPerDay) continue;
        issues.push({
          code: "ELECTIVE_PIN_DUPLICATE",
          severity: "blocker",
          message: `${b.name} is fixed to ${n} periods on ${DAY_NAMES[d]} but is capped at ${b.maxPeriodsPerDay}/day.`,
          entity: where,
          fix: `Move ${n - b.maxPeriodsPerDay} of ${DAY_NAMES[d]}'s periods to another day, or raise ${b.name}'s max periods/day to ${n}.`,
          // The other half of this fix — raising the cap — is a real relax too,
          // and the one that keeps the school's chosen shape. Offer that.
          remedy:
            n <= perDay
              ? remedy("relax", `Raise ${b.name} to ${n} period(s)/day — students may get ${n} in one day`, [
                  { op: "set", entity: "electiveBlock", id: b.id, field: "maxPeriodsPerDay", from: b.maxPeriodsPerDay, to: n },
                ])
              : unpin(`${n} periods pinned to ${DAY_NAMES[d]}`),
        });
      }

      // A pinned cell has to be a cell every option teacher can actually work.
      // One of them out on Wednesday takes the whole block off Wednesday,
      // because the options all run at once.
      for (const p of pins) {
        for (const o of b.options) {
          const t = snap.teachers.find((x) => x.id === o.teacherId);
          if (!t) continue;
          const offDay = t.unavailableFullDays.includes(p.day);
          const altDays =
            t.periodPattern === "alternate_day"
              ? t.alternateDaySet && t.alternateDaySet.length > 0
                ? t.alternateDaySet.filter((d) => snap.config.workingDays.includes(d))
                : snap.config.workingDays.filter((_, i) => i % 2 === 0)
              : null;
          const offPattern = altDays !== null && !altDays.includes(p.day);
          if (!offDay && !offPattern) continue;
          issues.push({
            code: "ELECTIVE_PIN_UNAVAILABLE",
            severity: "blocker",
            message: `${b.name} is fixed to ${DAY_NAMES[p.day]} period ${p.period}, but ${o.teacherName} (${o.subjectName}) ${offDay ? `does not work ${DAY_NAMES[p.day]}` : `only teaches on ${altDays!.map((d) => DAY_NAMES[d]).join(", ")}`} — every option runs at once, so the block cannot meet without them.`,
            entity: { type: "teacher", id: o.teacherId, label: o.teacherName },
            fix: `Move that slot to a day ${o.teacherName} works, give ${o.subjectName} a different teacher, or let the solver choose ${b.name}'s slots.`,
            remedy: unpin(`${o.teacherName} cannot teach on ${DAY_NAMES[p.day]}`),
          });
        }
      }
    }
  }

  // ---- two blocks pinned to the same cell (§4.9, Phase 15) ----
  //
  // Only checkable across blocks, so it sits outside the loop. Sharing a cell
  // is fine — two grades can run their languages at the same time. Sharing a
  // cell AND a section, a teacher or a room is not: that is a double-booking
  // the database would refuse at write time, reported here instead.
  {
    const pinnedCells = new Map<string, SnapshotElectiveBlock[]>();
    for (const b of snap.electiveBlocks) {
      if (b.placement !== "fixed") continue;
      for (const p of b.fixedSlots) {
        const k = `${p.day}:${p.period}`;
        const at = pinnedCells.get(k);
        if (at) at.push(b);
        else pinnedCells.set(k, [b]);
      }
    }
    for (const [k, entries] of pinnedCells) {
      const [d, p] = k.split(":").map(Number);
      const blocks = [...new Map(entries.map((b) => [b.id, b])).values()];
      for (let i = 0; i < blocks.length; i++) {
        for (let j = i + 1; j < blocks.length; j++) {
          const a = blocks[i];
          const c = blocks[j];
          const shared = (() => {
            const sec = a.memberClassSectionIds.find((x) => c.memberClassSectionIds.includes(x));
            if (sec !== undefined) {
              return `${sectionLabelById.get(sec) ?? `#${sec}`} attends both`;
            }
            const t = a.options.find((x) => c.options.some((y) => y.teacherId === x.teacherId));
            if (t) return `${t.teacherName} teaches in both`;
            const r = a.options.find((x) => c.options.some((y) => y.roomId === x.roomId));
            if (r) return `${r.roomName} is used by both`;
            return null;
          })();
          if (!shared) continue;
          issues.push({
            code: "ELECTIVE_PIN_CLASH",
            severity: "blocker",
            message: `${a.name} and ${c.name} are both fixed to ${DAY_NAMES[d]} period ${p}, and ${shared} — they cannot run at the same time.`,
            entity: { type: "elective_block", id: c.id, label: c.name },
            fix: `Move ${c.name} to another slot, or let the solver choose its slots.`,
            remedy: remedy("relax", `Let the solver choose when ${c.name} runs — it collides with ${a.name} on ${DAY_NAMES[d]} P${p}`, [
              { op: "set", entity: "electiveBlock", id: c.id, field: "placement", from: c.placement, to: "solver" },
            ]),
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
        // §21: hand the curriculum periods to somebody who is not a guest.
        // NOT "promote the guest to permanent" — that rewrites the school's
        // employment record to silence a warning, which is the wrong direction
        // entirely (§18: a guest is refused the curriculum on purpose).
        ...(() => {
          const held = snap.mappings.filter((m) => m.teacherId === t.id);
          const changes = [];
          const names: string[] = [];
          const pending = new Map<number, number>();
          for (const m of held) {
            const classId = classOfSection.get(m.classSectionId);
            if (classId === undefined) return {};
            const pick = pickTeacher(snap, { classId, periods: m.periodsPerWeek, exclude: [t.id], pending });
            if (!pick) return {}; // nobody has room — the admin must decide
            pending.set(pick.teacher.id, (pending.get(pick.teacher.id) ?? 0) + m.periodsPerWeek);
            names.push(`${m.classSectionLabel} ${m.subjectName} → ${pick.teacher.name}`);
            changes.push({ op: "set" as const, entity: "mapping" as const, id: m.id, field: "teacherId", from: t.id, to: pick.teacher.id });
          }
          return changes.length > 0
            ? { remedy: remedy("redistribute", `Move ${names.join(", ")}`, changes) }
            : {};
        })(),
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
      // §21: the school has already given them the teaching; the scope simply
      // has not caught up. Widening it states what is already true, and is a
      // far smaller change than moving the periods to somebody else.
      remedy: remedy(
        "complete",
        `Add ${classNameOfSection.get(a.classSectionId) ?? "that class"} to ${t.name}'s teaching scope`,
        [{ op: "link", entity: "teacherClass", id: t.id, otherId: classId }],
      ),
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
      // §21: infer each teacher's scope from the classes they already hold.
      // This is the single most useful fix on a freshly imported school, where
      // nobody has a scope and everybody has mappings.
      remedy: (() => {
        const changes = [];
        for (const t of unscoped) {
          const classes = [
            ...new Set(
              attachments
                .filter((a) => a.teacherId === t.id)
                .map((a) => classOfSection.get(a.classSectionId))
                .filter((c): c is number => c !== undefined),
            ),
          ].sort((x, y) => x - y);
          for (const classId of classes) {
            changes.push({ op: "link" as const, entity: "teacherClass" as const, id: t.id, otherId: classId });
          }
        }
        return changes.length > 0
          ? remedy("complete", `Set the teaching scope of ${unscoped.length} teacher(s) from the classes they already teach`, changes)
          : undefined;
      })(),
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
      // §21: the first section keeps the room; the rest are re-homed into
      // whatever is free. `taken` grows as we go, so two displaced sections
      // never get handed the same replacement.
      const displaced = snap.classSections.filter(
        (cs) => snap.homeRoomBySection[cs.id] === room && labels.indexOf(cs.label) > 0,
      );
      const taken = new Set<number>();
      const changes = [];
      const moved: string[] = [];
      for (const cs of displaced) {
        const free = pickFreeRoom(snap, taken);
        if (!free) break;
        taken.add(free.id);
        moved.push(`${cs.label} → ${free.name}`);
        changes.push({ op: "set" as const, entity: "classSection" as const, id: cs.id, field: "homeRoomId", from: room, to: free.id });
      }
      issues.push({
        code: "HOME_ROOM_SHARED",
        severity: "blocker",
        message: `${roomName(room)} is the home room of ${labels.join(" and ")} — both are timetabled all week, so they cannot share it.`,
        entity: { type: "room", id: room, label: roomName(room) },
        fix: `Give ${labels.slice(1).join(" and ")} a different home room on the Class-Sections screen.`,
        ...(changes.length === displaced.length && changes.length > 0
          ? { remedy: remedy("complete", `Move ${moved.join(", ")}`, changes) }
          : {}),
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
      ...(() => {
        // §21: one remedy for all of them, because a school that has never set
        // home rooms has none set anywhere and fixing them one at a time is
        // not a feature. Stops at the point the rooms run out and says so.
        const taken = new Set<number>();
        const changes = [];
        for (const cs of unroomed) {
          const free = pickFreeRoom(snap, taken);
          if (!free) break;
          taken.add(free.id);
          changes.push({ op: "set" as const, entity: "classSection" as const, id: cs.id, field: "homeRoomId", from: null, to: free.id });
        }
        if (changes.length === 0) return {};
        const short = unroomed.length - changes.length;
        return {
          remedy: remedy(
            "complete",
            `Give ${changes.length} class-section(s) a free room${short > 0 ? ` — ${short} would still have none, the school has run out of rooms` : ""}`,
            changes,
          ),
        };
      })(),
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
        ...(() => {
          const lab = pickLabForSubject(snap, subjectId);
          return lab
            ? { remedy: remedy("complete", `Mark ${lab.name} as also serving ${subjectName}`, [
                { op: "link" as const, entity: "roomSubject" as const, id: lab.id, otherId: subjectId },
              ]) }
            : {}; // no lab to give it — nobody can conjure a room
        })(),
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
        ...(() => {
          // §21: somebody who already teaches this section — a class teacher
          // the children never see would be a worse answer than none. Whoever
          // has the most periods with them, and is not already class teacher
          // somewhere else.
          const already = new Set(
            snap.classSections.map((x) => x.classTeacherId).filter((x): x is number => x !== null),
          );
          const byPeriods = new Map<number, number>();
          for (const m of snap.mappings) {
            if (m.classSectionId !== cs.id) continue;
            byPeriods.set(m.teacherId, (byPeriods.get(m.teacherId) ?? 0) + m.periodsPerWeek);
          }
          const pick = [...byPeriods.entries()]
            .filter(([id]) => !already.has(id))
            .filter(([id]) => teacherById.get(id)?.employmentType !== "guest")
            .sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
          if (!pick) return {};
          const name = teacherById.get(pick[0])?.name ?? `teacher #${pick[0]}`;
          return {
            remedy: remedy("complete", `Make ${name} class teacher of ${cs.label} — they already teach it ${pick[1]} periods/week`, [
              { op: "set" as const, entity: "classSection" as const, id: cs.id, field: "classTeacherId", from: null, to: pick[0] },
            ]),
          };
        })(),
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
        // §21 relax: change the scheduling rule, not who is responsible for a
        // class. Which section a teacher looks after is a pastoral decision
        // the software has no business editing.
        remedy: remedy(
          "relax",
          `Set ${t.name}'s Period-1 rule to 'random' — they stay class teacher of ${labels.join(" and ")}`,
          [{ op: "set", entity: "teacher", id: teacherId, field: "classTeacherPeriodRule", from: "always_first_period", to: "random" }],
        ),
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
        // §21: clearing a rule that does nothing changes no timetable — it
        // only stops the data claiming something it does not mean.
        remedy: remedy("complete", `Clear ${t.name}'s inert Period-1 rule`, [
          { op: "set", entity: "teacher", id: t.id, field: "classTeacherPeriodRule", from: "always_first_period", to: "none" },
        ]),
      });
    }
  }

  // ---------- Check 11 — lunch-side capacity (§26.3) ----------
  //
  // The §26.3 rules are HARD: `lunchRule` and `gapAfterLunch` are pruned out of
  // the solver's domain before search. A hard constraint with no check here is
  // a generation that fails — which is the one thing the two-phase split exists
  // to prevent — so this asks, per class-section, whether the periods a rule
  // confines a subject to can actually hold the periods it needs.
  //
  // Counted per section rather than per class because a class's curriculum row
  // applies to every one of its sections, and each section has its own week to
  // fit it into.
  const lunchAfter = snap.config.lunchAfterPeriod;
  if (lunchAfter !== null) {
    // How many cells a week each side of lunch offers, once the gap rule has
    // taken its bite. Computed with the SAME function the solver prunes with,
    // so Readiness can never promise a cell the search will refuse.
    const cellsFor = (rule: "any" | "before" | "after", gap: boolean, span: number) => {
      let n = 0;
      for (let p = 1; p + span - 1 <= perDay; p++) {
        if (lunchAllows([{ lunchRule: rule, gapAfterLunch: gap }], p, span, lunchAfter)) n += 1;
      }
      return n * days;
    };

    for (const cs of snap.classSections) {
      /**
       * Grouped by the EXACT rule pair, not by side.
       *
       * A subject with only the gap rule — `any time, but not straight after
       * lunch` — has the whole week minus one cell a day, and an earlier draft
       * of this check filed it under "after lunch" and refused a school that
       * was perfectly fine. Its own smoke caught it. Keying on the pair keeps
       * each group's supply exact for its members.
       *
       * Groups still overlap in the cells they compete for, so this UNDER-
       * detects rather than over-detects: two afternoon subjects, one with the
       * gap and one without, are checked separately. That is the right
       * direction to be wrong in — a false blocker stops a school that could
       * have generated, where a missed one leaves the solver to report what it
       * could not place, which it already does well.
       */
      const groups = new Map<string, {
        rule: "any" | "before" | "after"; gap: boolean; periods: number; names: string[];
      }>();
      for (const r of reqsByClass.get(cs.classId) ?? []) {
        const pl = snap.subjectPlacement?.[r.subjectId];
        if (!pl || (pl.lunchRule === "any" && !pl.gapAfterLunch)) continue;
        const key = `${pl.lunchRule}|${pl.gapAfterLunch}`;
        const cur = groups.get(key) ?? { rule: pl.lunchRule, gap: pl.gapAfterLunch, periods: 0, names: [] };
        cur.periods += r.periodsPerWeek;
        cur.names.push(r.subjectName);
        groups.set(key, cur);
      }

      for (const want of groups.values()) {
        const supply = cellsFor(want.rule, want.gap, 1);
        if (want.periods <= supply) continue;
        const named = want.names.slice(0, 3).join(", ") + (want.names.length > 3 ? ", …" : "");
        const where = want.rule === "before" ? "before lunch"
          : want.rule === "after" ? "after lunch"
          : "outside the period straight after lunch";
        issues.push({
          code: "LUNCH_SIDE_CAPACITY",
          severity: "blocker",
          message:
            `${cs.label} needs ${want.periods} periods a week ${where} (${named}), ` +
            `but its week has only ${supply}` +
            (want.gap && want.rule !== "any" ? " once the period straight after lunch is kept free" : "") + ".",
          entity: { type: "class_section", id: cs.id, label: cs.label },
          fix:
            `Set one of those subjects back to "any time" on the Subjects screen, ` +
            `or lengthen the ${want.rule === "before" ? "morning" : "afternoon"} — the week has ` +
            `${perDay} periods a day with lunch after period ${lunchAfter}.`,
          // §21: deliberately no auto-remedy. Every way out of this loosens a
          // rule somebody set for a physical reason — children cannot run on a
          // full stomach — and §21 applies `relax` only with explicit consent,
          // shown as a priced card rather than applied by a standing one.
        });
      }
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
          // §21: writes down the days the solver was going to pick anyway, so
          // the record matches the timetable instead of leaving it implied.
          remedy: remedy(
            "complete",
            `Set ${t.name}'s alternate days to ${dayList(alternatingDays(effectiveDays))}`,
            [{ op: "set", entity: "teacher", id: t.id, field: "alternateDaySet", from: null, to: alternatingDays(effectiveDays) }],
          ),
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
        // §21 relax: fit the blocks to the periods the subject has, rather
        // than giving it more periods to justify the blocks.
        ...(() => {
          const fits = Math.floor(r.periodsPerWeek / size);
          return fits >= 1
            ? { remedy: remedy("relax", `Reduce ${r.subjectName} (Class ${classLabel}) to ${fits} block(s)/week of ${size}`, [
                { op: "set" as const, entity: "classSubject" as const, id: r.id, field: "consecutiveBlocksPerWeek", from: r.consecutiveBlocksPerWeek, to: fits },
              ]) }
            : {}; // not even one block fits — the block size itself is wrong
        })(),
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
        ...(size <= perDay
          ? {
              remedy: remedy(
                "relax",
                `Raise ${r.subjectName} (Class ${classLabel}) to ${size} periods/day, so its ${size}-period block fits`,
                [{ op: "set" as const, entity: "classSubject" as const, id: r.id, field: "maxPeriodsPerDay", from: r.maxPeriodsPerDay, to: size }],
              ),
            }
          : {}),
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
        // §21 relax: shrink the block to the longest run the day actually has.
        // Moving a break is the other half of the printed fix and is NOT
        // offered — the shape of the school day is not a scheduling knob, and
        // a break moved to suit one subject lands on every class in the school.
        ...(() => {
          const longest = Math.max(...daySegments);
          return longest >= 1 && longest < size
            ? { remedy: remedy(
                "relax",
                longest === 1
                  ? `Drop consecutive blocks for ${r.subjectName} (Class ${classLabel}) — no two teaching periods sit together in this day`
                  : `Shorten ${r.subjectName} (Class ${classLabel}) blocks from ${size} to ${longest} periods, the longest run the day has`,
                [{ op: "set" as const, entity: "classSubject" as const, id: r.id, field: "consecutiveBlockSize", from: size, to: longest }],
              ) }
            : {};
        })(),
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
        ...(() => {
          const needed = Math.ceil(r.periodsPerWeek / days);
          return needed > r.maxPeriodsPerDay && needed <= perDay
            ? { remedy: remedy("relax", `Allow ${needed} periods/day of ${r.subjectName} (Class ${classLabel}), up from ${r.maxPeriodsPerDay}`, [
                { op: "set" as const, entity: "classSubject" as const, id: r.id, field: "maxPeriodsPerDay", from: r.maxPeriodsPerDay, to: needed },
              ]) }
            : {};
        })(),
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
      // §21 relax — the same remedy as the block branch above, because this is
      // the same arithmetic without blocks in it. Both sites raise this code,
      // and a remedy on only one of them would leave the other looking
      // unfixable for no reason a school could see.
      ...(() => {
        const needed = Math.ceil(r.periodsPerWeek / days);
        return needed > r.maxPeriodsPerDay && needed <= perDay
          ? { remedy: remedy("relax", `Allow ${needed} periods/day of ${r.subjectName} (Class ${classLabel}), up from ${r.maxPeriodsPerDay}`, [
              { op: "set" as const, entity: "classSubject" as const, id: r.id, field: "maxPeriodsPerDay", from: r.maxPeriodsPerDay, to: needed },
            ]) }
          : {};
      })(),
    });
  }
}

function finalize(
  snap: FeasibilitySnapshot,
  issues: FeasibilityIssue[],
  totalRequired: number,
  available: number,
): FeasibilityResult {
  // §21: one key per issue, assigned here rather than at each of the 38 check
  // sites — a new check cannot forget to do it, and it cannot invent a
  // different scheme. Code and entity identify an issue on their own except
  // where one entity can raise the same code twice (a teacher outside scope
  // for two classes), which the ordinal covers.
  const seen = new Map<string, number>();
  for (const i of issues) {
    const base = `${i.code}:${i.entity.type}:${i.entity.id}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    i.key = n === 1 ? base : `${base}#${n}`;
  }

  const blockers = issues.filter((i) => i.severity === "blocker");
  const warnings = issues.filter((i) => i.severity === "warning");
  const hasData = snap.classSections.length > 0 && snap.subjectRequirements.length > 0;
  /**
   * §28.1 — the load alert is REPORTED but does not move the score.
   *
   * Readiness answers one question: can this school generate? A school where
   * every teacher is inside their limit and every lesson has somebody can
   * generate, so it reads 100 — and it must keep reading 100 after somebody
   * asks to be told when a teacher passes 75%. The first school to try this
   * setting would otherwise watch its own dashboard fall to 98% for saying yes
   * to a report, and would reasonably conclude the setting had broken
   * something.
   *
   * It is a warning rather than an `info` severity because every consumer —
   * the dashboard, the AI tools, the auto-fix screen — already knows what to
   * do with two levels, and a third would need each of them to decide again.
   * The score is the only place the distinction matters, so it is the only
   * place that makes it.
   */
  const scored = warnings.filter((w) => w.code !== "TEACHER_LOAD_ALERT");
  const score = !hasData
    ? 0
    : Math.max(0, 100 - blockers.length * 10 - scored.length * 2);
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
