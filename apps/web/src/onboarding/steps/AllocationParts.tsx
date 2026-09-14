/**
 * §15.3 Phase 28 — the three pieces the Allocation grid opens onto.
 *
 * Split out of `Allocation.tsx` purely for length; they are not reusable and
 * not meant to be. What they share is one rule worth stating: **the grid is for
 * reading, these are for changing.** Every fact a cell abbreviates away — the
 * teacher's real name, their load, why that room, who the class teacher is — is
 * readable on hover, so nobody has to open a dialog to understand a cell. The
 * dialog is only ever the second step.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api";
import { asMessage } from "../../components";
import {
  CLASS_LADDER, computeLoads, defaultsFor, subjectAppliesTo, subjectStartsAt, subjectSuitsClass,
  type CurriculumCell, type LoadRemedy, type MappingSuggestion, type SubjectAnswer, type Swatch,
  type TeacherAnswer, type TeacherLoad,
} from "@edutimetable/shared";

/** A class's rung, 1-based; 0 for a name the ladder does not have (§27.15). */
const LADDER_AT = (className: string): number => CLASS_LADDER.indexOf(className as never) + 1;

// Re-declared rather than imported to keep the two files' imports acyclic.
const BAND_COLOUR: Record<string, string> = {
  ok: "var(--steel)", warn: "var(--amber)", full: "var(--brand)", over: "var(--signal)",
};
const shortLabel = (l: string) => l.replace(/^Class\s+/i, "");
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export interface AllocModel {
  wings: unknown[];
  /** The wing whose tab is open — named, because its week is what is being changed. */
  wingName: string;
  subjects: SubjectAnswer[];
  staff: Array<{ code: string; name: string; subjects: string[]; guest: boolean; classes: string[] }>;
  classes: Array<{ className: string; sections: string[] }>;
  capacity: number;
  days: number;
  daysByWing: Record<string, number>;
  /** Employee code → the initials every cell shows (§27). */
  initialsOf: Map<string, string>;
  /** Minutes in one period, for this wing (§28). */
  minutes: number;
  /**
   * The curriculum cells, as `CurriculumCell` rather than a structural copy of
   * four of its fields. The copy silently stopped matching when §31.10 added
   * the block columns — a shape written out twice is a shape that drifts, and
   * this one drifted the first time the original grew.
   */
  cells: CurriculumCell[];
  mappings: MappingSuggestion[];
  classTeachers: Array<{ classSection: string; employeeCode: string }>;
  rooms: string[];
  swatches: Record<string, Swatch>;
  loads: TeacherLoad[];
  byCode: Map<string, TeacherLoad>;
  gaps: number;
}

function verdictOf(t: TeacherLoad): { tone: "ok" | "warn" | "bad" | "good"; text: string } {
  if (t.band === "over") {
    return { tone: "bad", text: `${plural(t.used - t.cap, "period")} over the limit — Readiness will refuse to generate.` };
  }
  if (t.band === "full") return { tone: "good", text: "Exactly at their limit. Nothing more can be given to them." };
  if (t.band === "warn") return { tone: "warn", text: `Getting full — ${plural(t.cap - t.used, "period")} left.` };
  return { tone: "ok", text: `${plural(t.cap - t.used, "period")} spare.` };
}

// ───────────────────────────────────────────────────────── shared bits

const Head = ({ swatch, title, sub, badge }: {
  swatch?: Swatch; title: string; sub: string;
  /** What goes in the square. Defaults to the first two letters of the title. */
  badge?: string;
}) => (
  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
    <span style={{
      width: 26, height: 26, borderRadius: 7, display: "grid", placeItems: "center", flexShrink: 0,
      font: "700 10.5px/1 var(--font-mono, monospace)",
      background: swatch?.bg ?? "var(--steel-pale)", color: swatch?.fg ?? "var(--brand-dark)",
    }}>{badge ?? title.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase()}</span>
    <span style={{ minWidth: 0 }}>
      <span style={{ font: "700 13px/1.25 Inter", color: "var(--ink)", display: "block" }}>{title}</span>
      <span style={{ fontSize: 10.5, color: "var(--ink-faint)" }}>{sub}</span>
    </span>
  </div>
);

const Defs = ({ children }: { children: React.ReactNode }) => (
  <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 10px", alignItems: "baseline", margin: 0 }}>
    {children}
  </dl>
);
const Row = ({ k, children }: { k: string; children: React.ReactNode }) => (
  <>
    <dt style={{
      font: "700 9.5px/1.5 Inter", letterSpacing: "0.05em", textTransform: "uppercase",
      color: "var(--ink-faint)", whiteSpace: "nowrap",
    }}>{k}</dt>
    <dd style={{ color: "var(--ink-soft)", margin: 0 }}>{children}</dd>
  </>
);
const Num = ({ children }: { children: React.ReactNode }) => (
  <strong style={{ fontFamily: "var(--font-mono, monospace)", color: "var(--ink)" }}>{children}</strong>
);
export const MiniBar = ({ pct, colour }: { pct: number; colour: string }) => (
  <span style={{ display: "block", height: 4, borderRadius: 2, background: "var(--line)", marginTop: 4, overflow: "hidden" }}>
    <span style={{
      display: "block", height: "100%", borderRadius: 2, background: colour,
      width: `${Math.min(100, Math.round(pct * 100))}%`,
    }} />
  </span>
);
const Verdict = ({ tone, children }: { tone: string; children: React.ReactNode }) => (
  <div style={{
    marginTop: 7, padding: "6px 8px", borderRadius: 6, fontSize: 11, lineHeight: 1.45,
    background: tone === "bad" ? "var(--signal-bg)" : tone === "warn" ? "var(--amber-bg)"
      : tone === "good" ? "var(--accent-bg)" : "var(--offwhite)",
    color: tone === "bad" ? "var(--signal)" : tone === "warn" ? "var(--amber)"
      : tone === "good" ? "var(--accent)" : "var(--ink-soft)",
  }}>{children}</div>
);
const Foot = ({ children }: { children: React.ReactNode }) => (
  <div style={{
    marginTop: 8, paddingTop: 7, borderTop: "1px solid var(--line)", fontSize: 10.5, color: "var(--ink-faint)",
  }}>{children}</div>
);

// ─────────────────────────────────────────────────────────── hover cards

export type Hover =
  | { kind: "cell"; section: string; subject: string }
  | { kind: "teacher"; code: string }
  | { kind: "load"; className: string }
  | { kind: "ct"; section: string }
  | { kind: "subject"; subject: string };

export function HoverBody({ what, m, periodsOf, mappingIndexOf, classTeacherOf, totalOf, nameOf }: {
  what: Hover;
  m: AllocModel;
  periodsOf: (className: string, subject: string) => number;
  mappingIndexOf: (section: string, subject: string) => number;
  classTeacherOf: (section: string) => string;
  totalOf: (className: string) => number;
  nameOf: (code: string) => string;
}) {
  if (what.kind === "teacher") {
    const t = m.byCode.get(what.code);
    if (!t) return null;
    const v = verdictOf(t);
    const byClass = new Map<string, number>();
    for (const i of t.rows) {
      const row = m.mappings[i];
      if (!row) continue;
      const cls = (row.classSections[0] ?? "").replace(/-[^-]+$/, "");
      const cost = row.periodsPerWeek * (row.merged ? 1 : Math.max(1, row.classSections.length));
      byClass.set(cls, (byClass.get(cls) ?? 0) + cost);
    }
    const ctOf = m.classTeachers.filter((c) => c.employeeCode === what.code).map((c) => shortLabel(c.classSection));
    return (
      <>
        <Head title={t.name} badge={m.initialsOf.get(what.code) ?? what.code}
          sub={`${m.initialsOf.get(what.code) ?? what.code} · ${t.subjects.join(", ") || "nothing assigned"} · ${plural(t.sections.length, "section")}`} />
        <Defs>
          <Row k="Load">
            <Num>{t.used}</Num> of <Num>{t.cap}</Num> a week · {Math.round(t.pct * 100)}%
            <MiniBar pct={t.pct} colour={BAND_COLOUR[t.band]} />
          </Row>
          <Row k="Across">
            <span style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 10.5 }}>
              {[...byClass].map(([c, n]) => `${shortLabel(c)} ${n}p`).join(" · ") || "—"}
            </span>
          </Row>
          {ctOf.length > 0 && <Row k="Class teacher">{ctOf.join(", ")}</Row>}
        </Defs>
        {/*
          Two limits, two lines. `dayBound` is Check 3 rather than Check 2, and
          it has a different fix — more days or fewer sections, not a bigger
          weekly cap. Folding them into one percentage would name neither.
        */}
        {t.dayBound && (
          <Verdict tone="warn">
            Their subjects allow {plural(t.reach, "period")} a day, so {m.days} days hold at most{" "}
            {t.reachCap} — fewer than the {t.used} assigned.
          </Verdict>
        )}
        <Verdict tone={v.tone}>{v.text}</Verdict>
        <Foot>Click the chip to show only their cells</Foot>
      </>
    );
  }

  if (what.kind === "subject") {
    const s = m.subjects.find((x) => x.name === what.subject);
    if (!s) return null;
    const demand = m.classes.reduce(
      (n, c) => n + periodsOf(c.className, s.name) * c.sections.length, 0);
    const staff = m.staff.filter((t) => t.subjects.includes(s.name));
    const used = staff.reduce((n, t) => n + (m.byCode.get(t.code)?.used ?? 0), 0);
    const cap = staff.reduce((n, t) => n + (m.byCode.get(t.code)?.cap ?? 0), 0);
    const gaps = m.classes.flatMap((c) => c.sections
      .filter((sec) => periodsOf(c.className, s.name) > 0 && mappingIndexOf(`${c.className}-${sec}`, s.name) < 0));
    const d = defaultsFor(s.name);
    return (
      <>
        <Head swatch={m.swatches[s.name]} title={s.name}
          sub={`${(s.category ?? d.category) === "co_scholastic" ? "Co-scholastic" : "Scholastic"} · priority ${s.priority ?? d.priority}`} />
        <Defs>
          <Row k="Demand"><Num>{demand}</Num> periods a week in this wing</Row>
          <Row k="Staff">
            {staff.map((t) => t.code).join(", ") || "nobody listed"}
            {cap > 0 && <> — <Num>{used}</Num>/<Num>{cap}</Num><MiniBar pct={used / cap} colour="var(--steel)" /></>}
          </Row>
        </Defs>
        {gaps.length > 0
          ? <Verdict tone="bad">{plural(gaps.length, "section")} still without a teacher.</Verdict>
          : <Verdict tone="good">Every section has somebody.</Verdict>}
      </>
    );
  }

  if (what.kind === "load") {
    const total = totalOf(what.className);
    const rows = m.subjects
      .filter((s) => periodsOf(what.className, s.name) > 0)
      .sort((a, b) => periodsOf(what.className, b.name) - periodsOf(what.className, a.name));
    const tone = total > m.capacity ? "bad" : total < m.capacity ? "warn" : "good";
    return (
      <>
        <Head title={what.className} sub={`${m.capacity} periods a week · ${m.days} working days`} />
        <Defs>
          <Row k="Period length">
            <Num>{m.minutes}</Num> minutes — the whole wing's, set on step 5
          </Row>
          <Row k="Taught time">
            <Num>{total * m.minutes}</Num> minutes a week
            {" "}({Math.floor((total * m.minutes) / 60)}h {(total * m.minutes) % 60}m)
          </Row>
          <Row k="Subjects">
            <span style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 10.5 }}>
              {rows.map((s) => `${s.name.slice(0, 4)} ${periodsOf(what.className, s.name)}`).join(" · ")}
            </span>
          </Row>
        </Defs>
        <Verdict tone={tone}>
          {total > m.capacity ? `${total - m.capacity} more than the week holds — this class can never be timetabled.`
            : total < m.capacity ? `${plural(m.capacity - total, "free period")} a week nobody has decided about.`
              : "Fills the week exactly."}
        </Verdict>
        <Foot>One number for the whole class — every section carries the same curriculum</Foot>
      </>
    );
  }

  if (what.kind === "ct") {
    const code = classTeacherOf(what.section);
    if (!code) {
      return (
        <>
          <Head title={shortLabel(what.section)} sub="No class teacher" />
          <Verdict tone="warn">The first-period rule has nobody to attach to for this section.</Verdict>
          <Foot>Open a cell this teacher takes and tick “make class teacher”</Foot>
        </>
      );
    }
    const t = m.byCode.get(code);
    const here = m.mappings
      .filter((r) => r.employeeCode === code && r.classSections.some((cs) => cs.trim() === what.section))
      .map((r) => r.subjectName);
    return (
      <>
        <Head title={nameOf(code)} badge={m.initialsOf.get(code) ?? code}
          sub={`Class teacher of ${shortLabel(what.section)}`} />
        <Defs>
          <Row k="Teaches here">{here.join(", ") || "nothing in this section"}</Row>
          {t && <Row k="Total load">
            <Num>{t.used}</Num>/<Num>{t.cap}</Num><MiniBar pct={t.pct} colour={BAND_COLOUR[t.band]} />
          </Row>}
        </Defs>
        <Foot>The person the §4.7 first-period rule attaches to</Foot>
      </>
    );
  }

  // ── a cell ──────────────────────────────────────────────────────────────
  const className = what.section.replace(/-[^-]+$/, "");
  const s = m.subjects.find((x) => x.name === what.subject);
  const sectionCount = m.classes.find((c) => c.className === className)?.sections.length ?? 1;
  const p = periodsOf(className, what.subject);
  const idx = mappingIndexOf(what.section, what.subject);
  const row = idx >= 0 ? m.mappings[idx] : null;
  const d = s ? defaultsFor(s.name) : null;
  const head = (
    <Head swatch={s ? m.swatches[s.name] : undefined} title={`${what.subject} · ${shortLabel(what.section)}`}
      sub={`${((s?.category ?? d?.category) === "co_scholastic") ? "Co-scholastic" : "Scholastic"}${s?.isLab ? " · lab subject" : ""}`} />
  );

  if (p <= 0) {
    /**
     * §27.15 — an empty cell that says why it is empty.
     *
     * The proposal now skips subjects that do not belong to a class's rung, so
     * "no Biology in Pre-Nursery" is a decision the page made. Left unexplained
     * it is indistinguishable from the page having lost it. `null` for a class
     * name that is not on the ladder: a school with its own names gets no
     * opinion rather than a wrong one.
     */
    const rung = LADDER_AT(className) > 0 && !subjectSuitsClass(what.subject, LADDER_AT(className))
      ? subjectStartsAt(what.subject)
      : null;
    /**
     * §27.16 — the school's own answer outranks the rung, and reads differently.
     *
     * A rung is this file guessing from a name, so its sentence ends "…type a
     * number to teach it here anyway". A declaration is the school telling us,
     * so the sentence names where it was said instead: the invitation to
     * override belongs on the screen that owns the statement, not here, or the
     * two writers start disagreeing about the same fact.
     */
    const declared = s && !subjectAppliesTo(s, className) ? (s.classes ?? []) : null;
    return (
      <>{head}
        <Verdict tone="ok">Not taught in {className}.</Verdict>
        <Foot>
          {declared
            ? `${what.subject} is set for ${declared.join(", ")} on the Subjects screen`
            : rung
              ? `${what.subject} usually starts at ${rung} — type a number to teach it here anyway`
              : "Type a number, or press Enter to add it"}
        </Foot>
      </>
    );
  }

  if (!row) {
    const who = m.loads
      .filter((t) => !t.guest && m.staff.find((x) => x.code === t.employeeCode)?.subjects.includes(what.subject)
        && t.used + p <= t.cap)
      .sort((a, b) => a.pct - b.pct)[0];
    return (
      <>{head}
        <Defs><Row k="Periods">
          <Num>{p}</Num> a week — set on {className}, shared by all {sectionCount} sections
        </Row></Defs>
        <Verdict tone="bad">
          Nobody teaches this. Readiness will refuse to generate until it has somebody.
        </Verdict>
        <Foot>{who
          ? `${who.name} (${who.employeeCode}) has ${plural(who.cap - who.used, "period")} spare — click to assign`
          : `Nobody who teaches ${what.subject} has room to spare`}</Foot>
      </>
    );
  }

  const t = m.byCode.get(row.employeeCode);
  const listed = m.staff.find((x) => x.code === row.employeeCode)?.subjects.includes(what.subject) ?? false;
  const merged = !!row.merged && row.classSections.length > 1;
  const room = row.room || `${shortLabel(what.section)} room`;
  const isCT = classTeacherOf(what.section) === row.employeeCode;
  const ct = classTeacherOf(what.section);
  return (
    <>{head}
      <Defs>
        <Row k="Periods">
          <Num>{p}</Num> a week — set on {className}, shared by all {sectionCount} sections
        </Row>
        {/* The multiplication nobody does in their head, and the one a parent
            actually asks about: how much time is this subject getting? */}
        <Row k="Time"><Num>{p} × {m.minutes}</Num> = <Num>{p * m.minutes}</Num> minutes a week</Row>
        {merged && (
          <Row k="Merged">
            {row.classSections.map(shortLabel).join(" + ")} — one lesson, {row.classSections.length} sections
            in {room}. It costs <Num>{p}</Num>, not <Num>{p * row.classSections.length}</Num>.
          </Row>
        )}
        <Row k="Teacher">
          {/* The cell shows initials; this is where they are connected to a
              person, and to the employee code the importer keys on. */}
          <strong style={{ color: "var(--ink)" }}>{t?.name ?? row.employeeCode}</strong>
          {" "}({m.initialsOf.get(row.employeeCode) ?? row.employeeCode} · {row.employeeCode})
          {t && <> — <Num>{t.used}</Num>/<Num>{t.cap}</Num><MiniBar pct={t.pct} colour={BAND_COLOUR[t.band]} /></>}
        </Row>
        <Row k="Room">
          {room}{row.room
            ? (s?.isLab ? " — a lab mapped to this subject" : " — chosen for these periods")
            : " — the section's own home room"}
        </Row>
        <Row k="Class teacher">
          {isCT ? "this is the lesson the ring marks"
            : ct ? `${nameOf(ct)} (${ct}), in another subject`
              : `${shortLabel(what.section)} has none yet`}
        </Row>
      </Defs>
      {!listed && (
        <Verdict tone="warn">{t?.name ?? row.employeeCode} did not list {what.subject} as a subject they teach.</Verdict>
      )}
      {t && <Verdict tone={verdictOf(t).tone}>{t.name}: {verdictOf(t).text}</Verdict>}
      <Foot>Click, or press Enter, to change the teacher, periods or room</Foot>
    </>
  );
}

// ─────────────────────────────────────────────────────────────── advisor

export function Advisor({ items, onApply, onClose }: {
  items: LoadRemedy[];
  onApply: (r: LoadRemedy) => void;
  onClose: () => void;
}) {
  const firstRelax = items.findIndex((r) => r.kind === "relax");
  const colour: Record<string, [string, string]> = {
    redistribute: ["var(--accent-bg)", "var(--accent)"],
    complete: ["var(--steel-pale)", "var(--brand-dark)"],
    relax: ["var(--amber-bg)", "var(--amber)"],
  };
  return (
    <section style={{
      border: "1px solid var(--line)", borderRadius: 10, background: "var(--paper)",
      flexShrink: 0, maxHeight: "38vh", overflow: "auto",
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 9, padding: "8px 12px", background: "var(--offwhite)",
        borderBottom: "1px solid var(--line)", position: "sticky", top: 0, zIndex: 2,
      }}>
        <span style={{
          font: "700 9.5px/1 Inter", letterSpacing: "0.09em", textTransform: "uppercase", color: "var(--steel)",
        }}>Ways to ease it</span>
        <span style={{ fontSize: 11, color: "var(--ink-faint)" }}>
          {items.filter((r) => r.kind !== "relax").length} without loosening a limit
        </span>
        <span style={{ flex: 1 }} />
        <button onClick={onClose} style={{
          border: "none", background: "none", cursor: "pointer", fontSize: 11.5, color: "var(--ink-faint)",
        }}>Close</button>
      </div>

      {items.length === 0 && (
        <div style={{ padding: "11px 12px", fontSize: 12 }}>
          <strong>Nobody is over their limit.</strong>{" "}
          <span style={{ color: "var(--ink-soft)" }}>
            Every teacher is inside their weekly cap and every subject has somebody teaching it.
          </span>
        </div>
      )}

      {items.map((r, i) => (
        <div key={`${r.kind}-${i}`}>
          {/*
            Invariant 19, made visible. A resolver free to loosen limits can
            take any school to a clean board without changing one real thing —
            so the loosening options sit below a line that says what they are.
          */}
          {i === firstRelax && (
            <div style={{
              padding: "8px 12px 2px", fontSize: 11.2, color: "var(--ink-soft)", lineHeight: 1.5,
              borderTop: "2px solid var(--line)",
            }}>
              <strong style={{ color: "var(--amber)" }}>
                Below this line, the rule changes rather than the timetable.
              </strong>{" "}
              Never applied on your behalf — somebody has to agree to each one.
            </div>
          )}
          <div style={{
            display: "flex", gap: 10, alignItems: "flex-start", padding: "9px 12px",
            borderBottom: "1px solid var(--line)",
            background: r.kind === "relax" ? "color-mix(in srgb,var(--amber) 5%,var(--paper))" : undefined,
          }}>
            <span style={{
              flex: "0 0 auto", font: "700 9px/1 Inter", letterSpacing: "0.07em", textTransform: "uppercase",
              padding: "4px 6px", borderRadius: 5, marginTop: 1,
              background: colour[r.kind][0], color: colour[r.kind][1],
            }}>{r.kind}</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <strong style={{ fontSize: 12.2, display: "block" }}>{r.title}</strong>
              <span style={{ fontSize: 11.2, color: "var(--ink-soft)", lineHeight: 1.5, display: "block", marginTop: 2 }}>
                {r.detail}
              </span>
            </span>
            {r.change.type === "none" ? (
              <span style={{ fontSize: 10.5, color: "var(--ink-faint)", alignSelf: "center", whiteSpace: "nowrap" }}>
                nothing to apply
              </span>
            ) : (
              <button className="btn" style={{ padding: "4px 9px", fontSize: 11.5 }}
                onClick={() => onApply(r)}>Apply</button>
            )}
          </div>
        </div>
      ))}
    </section>
  );
}

// ───────────────────────────────────────────────────────── the cell dialog

export interface CellSave {
  className: string;
  periods?: number;
  mappings?: MappingSuggestion[];
  classTeacher?: string;
  /** §28 — the wing's period length, if it was changed here. */
  minutes?: number;
  /**
   * §31.10 — how this subject is blocked for this class.
   *
   * A CLASS fact like the periods beside it (`class_subjects` is keyed by
   * class), so it applies to every section — which is why the dialog says so
   * next to the control rather than leaving it to be discovered.
   */
  block?: { size: number; perWeek: number | null; mayCrossBreak: boolean };
}

/**
 * §31.15 — the selected cell's fields, in the toolbar rather than over the grid.
 *
 * ## Why this replaced the dialog on click
 *
 * A dialog is right for a decision you make once and confirm. This grid is not
 * that: somebody works across a row — Maths 6, English 6, Science 5 — and a
 * popup that opens, takes a value and closes costs two clicks and a re-read of
 * where they were for every cell. Worse, it covers the neighbours, which is the
 * same argument §31.6 made for the strip being a strip and not a popover.
 *
 * So clicking a cell now SELECTS it, the number is typed straight into the
 * grid, and everything the popup held appears here — in the bar the Filter
 * already lives in, above a grid that stays entirely visible.
 *
 * ## Applied immediately, deliberately
 *
 * There is no Save in this bar. The dialog had one because it batched several
 * fields behind a confirmation; a toolbar that asked you to confirm each field
 * would be a dialog wearing a different shape. Every edit lands in the draft as
 * it is made — exactly as typing a digit into a cell already did — and the
 * Master Grid's own Save is what writes it to the school.
 *
 * The refusals are the dialog's, unchanged and computed the same way: a class
 * over its week and a teacher over their cap are both refused with the reason,
 * through the same `computeLoads` the rail uses, so this bar and the chip two
 * inches above it cannot disagree.
 */
export function CellBar({
  m, answers, section, subject, periodsOf, mappingIndexOf, classTeacherOf,
  onChange, onRemove, onMore, compact = false, block = null, lockedBy = null,
}: {
  m: AllocModel;
  answers: Record<string, any>;
  section: string;
  subject: string;
  periodsOf: (className: string, subject: string) => number;
  mappingIndexOf: (section: string, subject: string) => number;
  classTeacherOf: (section: string) => string;
  /** One field at a time — see "Applied immediately" above. */
  onChange: (next: CellSave) => void;
  onRemove: () => void;
  /** The full dialog: the impact preview and the §4.10 merged-group detail,
   *  which genuinely do not fit in a bar. */
  onMore: () => void;
  compact?: boolean;
  /**
   * §31.19 — set when the selected cell is a §4.9 block column.
   *
   * The subject, the teacher, the room and the class-teacher role are then not
   * this bar's to change: a block has three of each at once, and they are set
   * on Split Electives. The bar disables them and says so rather than offering
   * controls that would silently write nothing.
   */
  block?: { id: number; name: string; periodsPerWeek: number;
            options: Array<{ subject: string; teacher: string; room: string }> } | null;
  /**
   * §31.19 — set when the selected cell is an ordinary subject that a block
   * already teaches to this class. It HAS a teacher and a room; they just
   * belong to the block's option rather than to a curriculum row here.
   */
  lockedBy?: string | null;
}) {
  const className = section.replace(/-[^-]+$/, "");
  const idx = mappingIndexOf(section, subject);
  const existing = idx >= 0 ? m.mappings[idx] : null;
  const merged = !!existing?.merged && existing.classSections.length > 1;
  const periods = periodsOf(className, subject);
  const code = existing?.employeeCode ?? "";
  const room = existing?.room ?? "";
  const isCT = !!existing && classTeacherOf(section) === existing.employeeCode;
  const cell = m.cells.find((c) => c.className === className && c.subjectName === subject);
  const blockSize = cell?.consecutiveBlockSize ?? 1;
  const swatch = m.swatches[subject];
  const [refusal, setRefusal] = useState<string | null>(null);
  /* Cleared when the selection moves: a refusal is about the edit that was
     attempted, and carrying it to the next cell reads as that cell refusing. */
  useEffect(() => setRefusal(null), [section, subject]);

  /**
   * §31.19 — whether this bar may write anything but the number.
   *
   * ONE flag, read by every control below, rather than each of them repeating
   * the two conditions: a control that forgot one would be an enabled select
   * writing a mapping for a subject the block already teaches, which is the
   * state this whole change exists to stop.
   */
  const owned = block !== null || lockedBy !== null;
  const ownedBy = block ? block.name : lockedBy;
  const ownedWhy = block
    ? `${block.name} runs ${block.options.length} lessons at once — their subjects, teachers and rooms are set on Split Electives.`
    : `${subject} is taught inside ${lockedBy}. Its teacher and room belong to that block's option.`;

  /** The same eligibility rule the dialog applies, for the same reasons. */
  const eligible = m.staff.filter((t) =>
    t.subjects.includes(subject) && !t.guest
    && (t.classes.length === 0 || t.classes.includes(className)));
  const offered = eligible.length === 0
    ? m.staff
    : [...eligible, ...m.staff.filter((t) => t.code === code && !eligible.some((e) => e.code === t.code))];

  /** What a proposed teacher would be carrying — the rail's own arithmetic. */
  const loadWith = (nextCode: string, nextPeriods: number) => {
    const next: MappingSuggestion[] = idx >= 0
      ? (nextCode
        ? m.mappings.map((x, i) => (i === idx ? { ...x, employeeCode: nextCode } : x))
        : m.mappings.filter((_, i) => i !== idx))
      : (nextCode
        ? [...m.mappings, { employeeCode: nextCode, subjectName: subject, classSections: [section], periodsPerWeek: nextPeriods }]
        : m.mappings);
    const cells = m.cells
      .filter((c) => !(c.className === className && c.subjectName === subject))
      .concat(nextPeriods > 0
        ? [{ className, subjectName: subject, periodsPerWeek: nextPeriods, maxPerDay: Math.max(1, Math.ceil(nextPeriods / m.days)) }]
        : []);
    const after = computeLoads({
      wings: m.wings as never, curriculum: cells, mappings: next,
      teachers: (answers.teachers ?? []) as TeacherAnswer[], subjects: m.subjects,
      daysByWing: m.daysByWing,
    });
    return { mappings: next, byCode: new Map(after.map((t) => [t.employeeCode, t])) };
  };

  const setTeacher = (nextCode: string) => {
    const preview = loadWith(nextCode, periods);
    const now = nextCode ? preview.byCode.get(nextCode) : undefined;
    if (now && now.used > now.cap) {
      setRefusal(`${now.name} would be on ${now.used} against a limit of ${now.cap}.`);
      return;
    }
    setRefusal(null);
    onChange({ className, mappings: preview.mappings });
    // A class teacher has to be somebody: clearing the teacher clears the role
    // rather than leaving it pointing at an employee code no longer in the cell.
    if (isCT && !nextCode) onChange({ className, classTeacher: "" });
  };

  const setRoom = (next: string) => {
    if (idx < 0) return;
    onChange({
      className,
      mappings: m.mappings.map((x, i) => (i === idx ? { ...x, room: next || undefined } : x)),
    });
  };

  const label: React.CSSProperties = {
    font: "800 8.5px/1 Inter, sans-serif", letterSpacing: "0.06em",
    textTransform: "uppercase", color: "var(--ink-faint)", marginBottom: 3, display: "block",
  };
  const box: React.CSSProperties = {
    padding: "4px 6px", border: "1px solid var(--line)", borderRadius: 6,
    fontSize: 12, background: "var(--paper)", color: "var(--ink)",
  };
  const field = (name: string, control: React.ReactNode) => (
    <label style={{ display: "block" }}>
      <span style={label}>{name}</span>
      {control}
    </label>
  );

  return (
    <div style={{
      display: "flex", alignItems: "flex-end", gap: 8, flexWrap: "wrap",
      padding: "4px 8px", borderRadius: 8,
      background: "var(--offwhite)", border: "1px solid var(--line)",
    }}>
      {/* What is being edited, in the subject's own colour (§10.5) — a bar of
          controls with no subject on it is a bar you have to look away from
          the grid to make sense of. */}
      <span style={{
        font: "800 12px/1.5 Inter, sans-serif", padding: "3px 8px", borderRadius: 6,
        whiteSpace: "nowrap", alignSelf: "center",
        background: swatch?.bg ?? "var(--steel-pale)", color: swatch?.fg ?? "var(--brand)",
      }}>
        {section} · {subject}
      </span>
      {/*
        §31.19 — why the controls to the right are grey.

        Said here, once, beside the thing it is about. A row of disabled selects
        with no explanation is a bar that reads as broken, and the reader's next
        move is to try each one.
      */}
      {owned && (
        <span style={{
          font: "600 11px/1.4 Inter", padding: "3px 8px", borderRadius: 6, alignSelf: "center",
          background: "var(--steel-pale)", color: "var(--brand-dark)", whiteSpace: "nowrap",
        }} title={ownedWhy}>
          🔒 {block ? "elective block" : `in ${ownedBy}`}
        </span>
      )}

      {/*
        §31.16 — the periods are NOT here.

        They are typed into the cell, which is a real field now. A second box
        holding the same number is a second answer to "where do I change this?",
        and the one further from the grid always wins the argument by being
        easier to see — which is how the cell came to look read-only in the
        first place. What is left in this bar is exactly what the cell cannot
        show: the teacher, the room, the block and the class-teacher role.

        The count is still stated, because the refusals below quote it and a
        reason that names a number nothing on the bar shows is a reason nobody
        can check.
      */}
      <span style={{ fontSize: 11.5, color: "var(--ink-soft)", alignSelf: "center", whiteSpace: "nowrap" }}
        title={`A CLASS fact — ${className} has ${m.classes.find((c) => c.className === className)?.sections.length ?? 1} section(s) and they all get this`}>
        <strong style={{ fontFamily: "var(--font-mono, monospace)" }}>
          {block ? block.periodsPerWeek : periods}
        </strong>
        {(block ? block.periodsPerWeek : periods) === 1 ? " period" : " periods"} a week
        <span style={{ color: "var(--ink-faint)" }}>
          {/* §31.19 — the one thing a block cell CAN change, so the bar says
              where: this is the number the grid exists to make add up, and
              sending somebody to another screen for it is what made them type
              it into the French column instead. */}
          {block ? " · type in the cell — it updates Split Electives" : " · type in the cell"}
        </span>
      </span>

      {field("Teacher", (
        <select value={owned ? "" : code} onChange={(e) => setTeacher(e.target.value)}
          style={{ ...box, maxWidth: compact ? 150 : 200 }}
          disabled={merged || owned}
          title={owned ? ownedWhy : merged
            ? "Taught as one merged group (§4.10) — change it in the full editor, where the other sections are listed"
            : undefined}>
          {/* §31.19 — a block has several teachers at once, so the empty
              option says how many rather than "Nobody yet", which would be
              false in the most misleading direction. */}
          <option value="">
            {block
              ? `${block.options.length} teacher${block.options.length === 1 ? "" : "s"} — on Split Electives`
              : lockedBy ? `set in ${lockedBy}` : "Nobody yet"}
          </option>
          {/* The load in the option text, exactly as the dialog shows it: the
              question anybody picking a teacher is actually asking is "have
              they got room?", and a name alone cannot answer it. */}
          {offered.map((t) => {
            const l = m.byCode.get(t.code);
            return (
              <option key={t.code} value={t.code}>
                {t.name} ({m.initialsOf.get(t.code) ?? t.code}) — {l?.used ?? 0}/{l?.cap ?? 0}
                {t.subjects.includes(subject) ? "" : " \u00b7 not listed for this subject"}
              </option>
            );
          })}
        </select>
      ))}

      {field("Room", (
        <input value={owned ? "" : room} onChange={(e) => setRoom(e.target.value)}
          disabled={idx < 0 || owned}
          placeholder={owned ? (block ? `${block.options.length} rooms` : "in the block") : idx < 0 ? "—" : "Home room"}
          title={owned ? ownedWhy : undefined}
          style={{ ...box, width: compact ? 84 : 110 }} />
      ))}

      {field("Together", (
        <select
          value={blockSize}
          onChange={(e) => {
            const size = Number(e.target.value);
            onChange({
              className,
              block: {
                size,
                perWeek: size > 1 ? (cell?.consecutiveBlocksPerWeek ?? null) : null,
                mayCrossBreak: size > 1 ? Boolean(cell?.blockMayCrossBreak) : false,
              },
            });
          }}
          style={{ ...box, width: 74 }}
          /* A block needs a curriculum row to be written onto — `setBlock`
             returns early without one, so an enabled control here would be a
             control that silently does nothing. Give the cell periods first. */
          disabled={periods <= 0 || owned}
          title={owned ? ownedWhy : periods <= 0
            ? "Give this subject some periods first — a block is a property of the curriculum row."
            : "§4.8 — how many periods of this subject run back to back. Placed atomically: all of them, or none."}>
          <option value={1}>single</option>
          <option value={2}>double</option>
          <option value={3}>triple</option>
        </select>
      ))}

      {/* Only once there is a block for a break to fall inside. A tick that can
          never mean anything is a tick people try to work out. */}
      {blockSize > 1 && (
        <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11.5, alignSelf: "center", whiteSpace: "nowrap" }}
          title="Yes — one period may sit before lunch and one after. It is permission, not a requirement.">
          <input type="checkbox" checked={Boolean(cell?.blockMayCrossBreak)}
            onChange={(e) => onChange({
              className,
              block: { size: blockSize, perWeek: cell?.consecutiveBlocksPerWeek ?? null, mayCrossBreak: e.target.checked },
            })} />
          break inside
        </label>
      )}

      <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11.5, alignSelf: "center", whiteSpace: "nowrap" }}
        title="Class teacher for this section. A section has one, so ticking here unticks whoever held it.">
        <input type="checkbox" checked={!owned && isCT} disabled={!code || owned}
          onChange={(e) => onChange({ className, classTeacher: e.target.checked ? code : "" })} />
        class tr.
      </label>

      {/*
        §31.19 — a block cell's ⋯ goes to the screen that owns it.

        The full editor edits a curriculum row and a mapping, neither of which a
        block has; opening it here would be a form with nothing behind it.
      */}
      {block ? (
        <Link to="/electives" className="btn"
          style={{ padding: "4px 8px", fontSize: 11.5, alignSelf: "center", textDecoration: "none" }}
          title="Options, teachers, rooms, who attends and when it runs — all on Split Electives">
          ⋯ Split Electives
        </Link>
      ) : (
        <button className="btn" onClick={onMore} style={{ padding: "4px 8px", fontSize: 11.5, alignSelf: "center" }}
          title="The full editor — what this change does to every teacher's week, and the sections a merged group covers">
          ⋯ More
        </button>
      )}
      {/*
        §31.19 — the fix for a row that clashes with a block.

        Same button, same confirmation (§27.15's `RemoveSubject`), different
        words: here it is not "this class does not take French" — it does, five
        periods a week, inside the block — it is "these extra periods are being
        taught on top of it". Offered rather than applied, because it deletes a
        row somebody entered and twenty-seven of them are already in the field.

        A block cell gets neither: its members are Split Electives' to change.
      */}
      {!block && (periods > 0 || idx >= 0) && (
        <button className="btn" onClick={onRemove}
          style={{
            padding: "4px 8px", fontSize: 11.5, alignSelf: "center",
            color: "var(--signal)",
            ...(lockedBy && periods > 0 ? { borderColor: "var(--signal)", fontWeight: 700 } : {}),
          }}
          title={lockedBy && periods > 0
            ? `${subject} is already taught inside ${lockedBy}. These ${periods} periods are on top of it — this deletes them.`
            : "This class does not take this subject — deletes the curriculum row, not just its periods"}>
          {lockedBy && periods > 0
            ? `✕ Clear ${periods} duplicate period${periods === 1 ? "" : "s"}`
            : "✕ Not taught"}
        </button>
      )}

      {refusal && (
        <span style={{
          fontSize: 11.5, color: "var(--signal)", alignSelf: "center",
          maxWidth: 320, lineHeight: 1.3,
        }}>{refusal}</span>
      )}
    </div>
  );
}

export function CellDialog({ m, answers, section, subject, onClose, onSave, onRemove,
                             periodsOf, mappingIndexOf, classTeacherOf, totalOf }: {
  m: AllocModel;
  answers: Record<string, any>;
  section: string;
  subject: string;
  onClose: () => void;
  onSave: (next: CellSave) => void;
  /** §27.15 — hand over to the removal confirmation, and close. */
  onRemove: () => void;
  periodsOf: (className: string, subject: string) => number;
  mappingIndexOf: (section: string, subject: string) => number;
  classTeacherOf: (section: string) => string;
  totalOf: (className: string) => number;
}) {
  const className = section.replace(/-[^-]+$/, "");
  const sectionCount = m.classes.find((c) => c.className === className)?.sections.length ?? 1;
  const idx = mappingIndexOf(section, subject);
  const existing = idx >= 0 ? m.mappings[idx] : null;
  const merged = !!existing?.merged && existing.classSections.length > 1;

  const [periods, setPeriods] = useState(periodsOf(className, subject));
  const [code, setCode] = useState(existing?.employeeCode ?? "");
  const [room, setRoom] = useState(existing?.room ?? "");
  const [isCT, setIsCT] = useState(!!existing && classTeacherOf(section) === existing.employeeCode);
  const [minutes, setMinutes] = useState(m.minutes);
  /**
   * §31.10 — consecutive blocks, at last reachable from the screen.
   *
   * The columns have existed since §4.8 and the solver has placed blocks
   * atomically all along; the Excel Curriculum sheet has carried Block Size and
   * Blocks/Week since the importer shipped. What was missing was any way to say
   * it here, so a school not using spreadsheets could not.
   */
  const cell = m.cells.find((c) => c.className === className && c.subjectName === subject);
  const [blockSize, setBlockSize] = useState(cell?.consecutiveBlockSize ?? 1);
  const [blocksPerWeek, setBlocksPerWeek] = useState<number | null>(cell?.consecutiveBlocksPerWeek ?? null);
  const [crossBreak, setCrossBreak] = useState(Boolean(cell?.blockMayCrossBreak));
  /** §27 — start narrow, widen on request. See the note by the select. */
  const [showAll, setShowAll] = useState(false);

  const s = m.subjects.find((x) => x.name === subject);
  const swatch = s ? m.swatches[s.name] : undefined;

  /**
   * What this change would do — recomputed through the SAME `computeLoads` the
   * rail uses, over a hypothetical plan.
   *
   * Not a hand-rolled "used minus this plus that": that arithmetic is exactly
   * where a merged group gets counted four times, and the dialog would then
   * disagree with the chip two inches above it.
   */
  const preview = useMemo(() => {
    const next: MappingSuggestion[] = idx >= 0
      ? (code
        ? m.mappings.map((x, i) => (i === idx ? { ...x, employeeCode: code, room: room || undefined } : x))
        : m.mappings.filter((_, i) => i !== idx))
      : (code
        ? [...m.mappings, { employeeCode: code, subjectName: subject, classSections: [section], periodsPerWeek: periods, room: room || undefined }]
        : m.mappings);
    const cells = m.cells
      .filter((c) => !(c.className === className && c.subjectName === subject))
      .concat(periods > 0
        ? [{ className, subjectName: subject, periodsPerWeek: periods, maxPerDay: Math.max(1, Math.ceil(periods / m.days)) }]
        : []);
    const after = computeLoads({
      wings: m.wings as never, curriculum: cells, mappings: next,
      teachers: (answers.teachers ?? []) as TeacherAnswer[], subjects: m.subjects,
      daysByWing: m.daysByWing,
    });
    return { mappings: next, byCode: new Map(after.map((t) => [t.employeeCode, t])) };
  }, [idx, code, room, periods, m, subject, section, className, answers.teachers]);

  /**
   * Who the dropdown offers, and why.
   *
   * Guests are out of the default list rather than merely labelled: §18 refuses
   * them the regular curriculum entirely, so offering one as an ordinary choice
   * is offering something the commit will reject.
   */
  const eligible = m.staff.filter((t) =>
    t.subjects.includes(subject) &&
    !t.guest &&
    // §27.9 — and scoped to THIS class. Offering somebody who takes Class 9-10
    // for a Class 5 cell offers something the commit refuses; an empty list is
    // "not stated", never "no classes".
    (t.classes.length === 0 || t.classes.includes(className)));
  const nobodyTeachesIt = eligible.length === 0;
  const offered = showAll || nobodyTeachesIt
    ? m.staff
    // The teacher already in the cell is always present, whatever the filter
    // says — a select whose value matches no option renders blank and reassigns
    // on save.
    : [...eligible, ...m.staff.filter((t) => t.code === code && !eligible.some((e) => e.code === t.code))];

  const before = totalOf(className);
  const afterTotal = before - periodsOf(className, subject) + periods;
  const oldCode = existing?.employeeCode ?? "";

  // ── the refusals, and the reason in each ───────────────────────────────
  let blocked: string | null = null;
  if (afterTotal > m.capacity) {
    blocked = `${className} would need ${afterTotal} periods and the week holds ${m.capacity}. ` +
      `Reduce another subject, or give this wing a longer week on step 5.`;
  }
  const now = code ? preview.byCode.get(code) : undefined;
  if (!blocked && now && now.used > now.cap) {
    blocked = `${now.name} would be on ${now.used} periods against a limit of ${now.cap}. ` +
      `Give this class to somebody with room, or raise the limit under “Ease the load”.`;
  }
  if (!blocked && isCT && !code) blocked = "A class teacher has to be somebody — pick a teacher first.";

  const lines: string[] = [];
  if (afterTotal !== before) lines.push(`${className} week ${before} → ${afterTotal} of ${m.capacity}`);
  if (oldCode && oldCode !== code) {
    const t = preview.byCode.get(oldCode);
    if (t) lines.push(`${oldCode} ${m.byCode.get(oldCode)?.used ?? 0} → ${t.used} of ${t.cap}`);
  }
  if (now) lines.push(`${code} ${m.byCode.get(code)?.used ?? 0} → ${now.used} of ${now.cap}`);

  const save = () => {
    const next: CellSave = { className };
    if (periods !== periodsOf(className, subject)) next.periods = periods;
    // Only when it actually moved. An unchanged value would still be written
    // into the draft, and `commitWeeks({changedOnly})` would then rebuild the
    // wing's whole period grid for nothing.
    if (minutes !== m.minutes) next.minutes = minutes;
    next.mappings = preview.mappings;
    const currentCT = classTeacherOf(section);
    if (isCT && code) next.classTeacher = code;
    else if (!isCT && currentCT === oldCode && currentCT) next.classTeacher = "";
    // Only when something about the block actually moved — an unchanged value
    // written back would churn the draft and mark the step dirty for nothing.
    if (blockSize !== (cell?.consecutiveBlockSize ?? 1)
      || blocksPerWeek !== (cell?.consecutiveBlocksPerWeek ?? null)
      || crossBreak !== Boolean(cell?.blockMayCrossBreak)) {
      next.block = { size: blockSize, perWeek: blocksPerWeek, mayCrossBreak: crossBreak };
    }
    onSave(next);
  };

  return (
    <div role="dialog" aria-modal="true" aria-label={`${subject} in ${section}`}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 400, background: "rgba(11,31,68,.45)",
        display: "grid", placeItems: "center", padding: 18,
      }}>
      <div style={{
        background: "var(--paper)", border: "1px solid var(--line)", borderRadius: 14,
        boxShadow: "0 24px 64px rgba(11,31,68,.3)", width: "min(430px,100%)", maxHeight: "90vh", overflow: "auto",
      }}>
        <div style={{ padding: "14px 17px 11px", borderBottom: "1px solid var(--line)", display: "flex", gap: 10 }}>
          <span style={{
            width: 36, height: 36, borderRadius: 9, display: "grid", placeItems: "center", flexShrink: 0,
            font: "700 14px/1 var(--font-mono, monospace)",
            background: swatch?.bg ?? "var(--steel-pale)", color: swatch?.fg ?? "var(--brand-dark)",
          }}>{subject.slice(0, 2).toUpperCase()}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ font: "700 14px/1.25 Inter" }}>{subject} · {shortLabel(section)}</div>
            <div style={{ fontSize: 11, color: "var(--ink-faint)", marginTop: 3 }}>
              {className} has {sectionCount} section{sectionCount === 1 ? "" : "s"}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close"
            style={{ border: "none", background: "none", cursor: "pointer", fontSize: 16, color: "var(--ink-faint)" }}>✕</button>
        </div>

        <div style={{ padding: "14px 17px", display: "flex", flexDirection: "column", gap: 13 }}>
          <Field label="Periods a week">
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <button className="btn" style={{ width: 31, height: 31, padding: 0, justifyContent: "center" }}
                aria-label="One fewer" onClick={() => setPeriods(Math.max(0, periods - 1))}>−</button>
              <input type="number" min={0} max={20} value={periods}
                onChange={(e) => setPeriods(Math.max(0, Math.min(20, Number(e.target.value))))}
                style={{
                  flex: 1, padding: "7px 9px", border: "1px solid var(--line)", borderRadius: 8,
                  textAlign: "center", font: "700 14px/1 var(--font-mono, monospace)",
                  background: "var(--paper)", color: "var(--ink)",
                }} />
              <button className="btn" style={{ width: 31, height: 31, padding: 0, justifyContent: "center" }}
                aria-label="One more" onClick={() => setPeriods(Math.min(20, periods + 1))}>+</button>
            </div>
            <Hint>
              Recorded against <strong>{className}</strong>, not one section — changing this changes all{" "}
              {sectionCount}. Only the teacher and room below belong to {shortLabel(section)} alone.
            </Hint>
          </Field>

          {/*
            §28 — how long a period IS.

            A property of the WING's week, not of a class or a subject: the
            solver places into period numbers on one shared grid, so two classes
            in a wing cannot have different period lengths. It is editable here
            because this is the screen somebody is looking at when they ask how
            much time a subject gets — and the label says whose setting it is,
            rather than implying the change is local.
          */}
          {/*
            §31.10 — consecutive periods, and whether a break may fall inside
            one.

            Only offered once the class actually has periods: a block is a shape
            for teaching that exists, and a "2-period block" on a subject nobody
            is taught is a number with nothing to apply to.

            A CLASS fact, said out loud — `class_subjects` is keyed by class, so
            this is every section of Pre-Nursery at once, exactly like the
            periods above it.
          */}
          {periods > 0 && (
            <Field label="Consecutive periods">
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <select
                  value={blockSize}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    setBlockSize(n);
                    // Clearing with the block, so the two companions never
                    // outlive it — the same rule the API and the importer
                    // apply on write.
                    if (n <= 1) { setBlocksPerWeek(null); setCrossBreak(false); }
                  }}
                  style={{
                    width: 150, padding: "7px 9px", border: "1px solid var(--line)", borderRadius: 8,
                    fontSize: 12.5, background: "var(--paper)", color: "var(--ink)",
                  }}
                >
                  <option value={1}>Single periods</option>
                  <option value={2}>Double (2 together)</option>
                  <option value={3}>Triple (3 together)</option>
                  <option value={4}>Four together</option>
                </select>
                {blockSize > 1 && (
                  <>
                    <select
                      value={blocksPerWeek ?? ""}
                      onChange={(e) => setBlocksPerWeek(e.target.value === "" ? null : Number(e.target.value))}
                      style={{
                        width: 150, padding: "7px 9px", border: "1px solid var(--line)", borderRadius: 8,
                        fontSize: 12.5, background: "var(--paper)", color: "var(--ink)",
                      }}
                    >
                      {/* Blank means "as many as fit", which is what the solver
                          does with a null — never a hidden default of 1. */}
                      <option value="">as many as fit</option>
                      {Array.from({ length: Math.floor(periods / blockSize) }, (_, i) => i + 1).map((n) => (
                        <option key={n} value={n}>{n} block{n === 1 ? "" : "s"} a week</option>
                      ))}
                    </select>
                    <span style={{ fontSize: 12, color: "var(--ink-soft)" }}>
                      {(() => {
                        const blocks = blocksPerWeek ?? Math.floor(periods / blockSize);
                        const singles = periods - blocks * blockSize;
                        return `${blocks} × ${blockSize}${singles > 0 ? ` + ${singles} single${singles === 1 ? "" : "s"}` : ""} of ${periods}`;
                      })()}
                    </span>
                  </>
                )}
              </div>
              {blockSize > 1 && (
                <label style={{
                  display: "flex", alignItems: "flex-start", gap: 8, marginTop: 9,
                  fontSize: 12.2, color: "var(--ink-soft)", lineHeight: 1.5, cursor: "pointer",
                }}>
                  <input type="checkbox" checked={crossBreak}
                    onChange={(e) => setCrossBreak(e.target.checked)}
                    style={{ marginTop: 2 }} />
                  <span>
                    <strong style={{ color: "var(--ink)" }}>A break may fall inside the block</strong>
                    <span style={{ display: "block" }}>
                      {/* The exact meaning, because "allow" and "require" are
                          one word apart and only one of them is true: this
                          WIDENS where the block may go. A block that fits
                          inside an unbroken run still lands there. */}
                      {crossBreak
                        ? "One period either side of lunch or the short bell is allowed — not required, so it will still sit inside an unbroken run when it can."
                        : "The periods must run without a break between them."}
                    </span>
                  </span>
                </label>
              )}
              <div style={{ fontSize: 11.5, color: "var(--ink-faint)", marginTop: 7, lineHeight: 1.5 }}>
                Applies to every section of {className} — periods and their shape are a class fact.
                The solver places a block whole or not at all.
              </div>
            </Field>
          )}

          <Field label="Period length">
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}
                style={{
                  width: 120, padding: "7px 9px", border: "1px solid var(--line)", borderRadius: 8,
                  fontSize: 12.5, background: "var(--paper)", color: "var(--ink)",
                }}>
                {/*
                  The presets, PLUS whatever this wing actually has.

                  Second Branch runs a 37-minute period. A fixed list without it
                  makes the select fall back to its first option, so the control
                  read "30 minutes" while the sentence beside it read "37" —
                  and a school that opened the dropdown for any other reason
                  would have been shown a value nobody set. A control must be
                  able to display the value it holds.
                */}
                {[...new Set([...[30, 35, 40, 45, 50, 55, 60], m.minutes])]
                  .sort((a, b) => a - b)
                  .map((n) => (
                    <option key={n} value={n}>
                      {n} minutes{n === m.minutes ? " (current)" : ""}
                    </option>
                  ))}
              </select>
              <span style={{ fontSize: 12, color: "var(--ink-soft)" }}>
                {subject} gets{" "}
                <strong style={{ fontFamily: "var(--font-mono, monospace)", color: "var(--ink)" }}>
                  {periods * minutes}
                </strong>{" "}
                minutes a week
                {minutes !== m.minutes && (
                  <span style={{ color: "var(--amber)" }}>
                    {" "}(was {periods * m.minutes})
                  </span>
                )}
              </span>
            </div>
            <Hint>
              {minutes === m.minutes ? (
                <>This is <strong>{m.wingName}</strong>'s period length, set on step 5. Every class in the
                  wing shares one period grid, so it cannot differ between them.</>
              ) : (
                <span style={{ color: "var(--amber)" }}>
                  This changes <strong>every class in this wing</strong>, not just {className} — one period
                  grid serves all of them. The day would run{" "}
                  {Math.abs((minutes - m.minutes) * (m.capacity / m.days))} minutes{" "}
                  {minutes > m.minutes ? "longer" : "shorter"}.
                </span>
              )}
            </Hint>
          </Field>

          {/*
            §27 — the people who teach this subject, not all 122 of them.

            The list used to be every teacher on the staff list, with anyone
            who had not listed the subject marked " · not listed". At a real
            school that is 122 options to find the three Maths teachers in, and
            the marker is doing the filtering's job in a place nobody can act
            on it.

            The escape hatch stays, because the reason for the old behaviour
            was sound: a school reassigning in a hurry knows something the
            subject list does not, and the importer checks §18 scope anyway. It
            is one click away instead of being the default.

            Two things this must not do:
             - **Hide the teacher who is already in the cell.** Filtering them
               out would leave the select with no matching option, which renders
               as blank and silently reassigns on save.
             - **Show an empty list.** If nobody has listed the subject, the
               filter has nothing useful to say, so it shows everybody and says
               why rather than presenting a dropdown with one dash in it.
          */}
          <Field label="Teacher">
            <select value={code} onChange={(e) => setCode(e.target.value)}
              style={{
                width: "100%", padding: "7px 9px", border: "1px solid var(--line)", borderRadius: 8,
                fontSize: 12.5, background: "var(--paper)", color: "var(--ink)",
              }}>
              <option value="">— nobody yet —</option>
              {offered.map((t) => {
                const l = m.byCode.get(t.code);
                return (
                  <option key={t.code} value={t.code}>
                    {t.name} ({m.initialsOf.get(t.code) ?? t.code}) — {l?.used ?? 0}/{l?.cap ?? 0}
                    {t.subjects.includes(subject) ? "" : " · not listed for this subject"}
                    {t.guest ? " · guest" : ""}
                  </option>
                );
              })}
            </select>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, color: "var(--ink-faint)" }}>
                {nobodyTeachesIt
                  ? `Nobody who teaches ${subject} is scoped to ${className} — showing all ${m.staff.length}.`
                  : showAll
                    ? `All ${m.staff.length} teachers.`
                    : `${eligible.length} of ${m.staff.length} teach ${subject} in ${className}.`}
              </span>
              {!nobodyTeachesIt && (
                <button onClick={() => setShowAll(!showAll)}
                  style={{
                    border: "none", background: "none", cursor: "pointer", padding: 0,
                    fontSize: 11.5, color: "var(--brand)", textDecoration: "underline",
                  }}>
                  {showAll ? `Only those who take ${subject} here` : `Show all ${m.staff.length}`}
                </button>
              )}
            </div>
            {showAll && !nobodyTeachesIt && (
              <Hint>
                A school reassigning in a hurry knows something the subject list does not. §18 teaching
                scope is still checked when this is committed, and a <strong>guest</strong> teacher is
                refused the regular curriculum outright.
              </Hint>
            )}
          </Field>

          {merged && (
            <div style={{
              borderLeft: "3px solid var(--steel-light)", background: "var(--offwhite)", padding: "8px 11px",
              borderRadius: "0 8px 8px 0", fontSize: 11.4, color: "var(--ink-soft)", lineHeight: 1.5,
            }}>
              This is one lesson taught to {existing!.classSections.map(shortLabel).join(", ")} together (§4.10).
              Changing the teacher or the room changes it for <strong>all of them</strong> — it is a single
              lesson, not {existing!.classSections.length}.
            </div>
          )}

          <Field label="Room">
            <select value={room} onChange={(e) => setRoom(e.target.value)}
              style={{
                width: "100%", padding: "7px 9px", border: "1px solid var(--line)", borderRadius: 8,
                fontSize: 12.5, background: "var(--paper)", color: "var(--ink)",
              }}>
              {/* Blank is not "no room" — §19 gives every non-lab lesson the
                  section's home room, and that is the right default. */}
              <option value="">{shortLabel(section)} room (the section's home room)</option>
              {m.rooms.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </Field>

          <button onClick={() => setIsCT(!isCT)}
            style={{
              display: "flex", alignItems: "center", gap: 10, padding: "9px 11px", width: "100%",
              border: `1px solid ${isCT ? "var(--brand)" : "var(--line)"}`, borderRadius: 9, cursor: "pointer",
              background: isCT ? "var(--steel-pale)" : "var(--offwhite)", textAlign: "left",
            }}>
            <span style={{
              font: "700 9px/1 var(--font-mono, monospace)", borderRadius: "50%", width: 18, height: 18,
              display: "grid", placeItems: "center", flexShrink: 0,
              color: isCT ? "var(--brand-dark)" : "var(--ink-faint)",
              background: isCT ? "var(--paper)" : "transparent",
              border: isCT ? "1px solid var(--brand)" : "1px dashed var(--line)",
            }}>{isCT
              ? (code ? m.initialsOf.get(code) ?? code : "—")
              : (classTeacherOf(section) ? m.initialsOf.get(classTeacherOf(section)) ?? classTeacherOf(section) : "—")}</span>
            <span style={{ flex: 1 }}>
              <strong style={{ fontSize: 12.3, display: "block" }}>
                {isCT ? `${code ? m.byCode.get(code)?.name ?? code : "This teacher"} is ${shortLabel(section)}'s class teacher`
                      : `Make this the class teacher of ${shortLabel(section)}`}
              </strong>
              <span style={{ fontSize: 11, color: "var(--ink-soft)" }}>
                {isCT ? "The person the first-period rule attaches to."
                  : classTeacherOf(section)
                    ? `Currently ${m.byCode.get(classTeacherOf(section))?.name ?? classTeacherOf(section)}. One per section.`
                    : "This section has none yet."}
              </span>
            </span>
          </button>

          <div style={{
            borderLeft: `3px solid ${blocked ? "var(--signal)" : "var(--accent)"}`,
            background: blocked ? "var(--signal-bg)" : "var(--accent-bg)",
            padding: "9px 11px", borderRadius: "0 8px 8px 0", fontSize: 11.5, lineHeight: 1.55,
            color: "var(--ink-soft)",
          }}>
            {blocked ? (
              <>
                <strong style={{ color: "var(--signal)" }}>This cannot be saved.</strong><br />{blocked}
              </>
            ) : lines.length > 0 ? lines.join(" · ") : "Nothing changes yet."}
          </div>
        </div>

        <div style={{
          padding: "11px 17px", borderTop: "1px solid var(--line)", background: "var(--offwhite)",
          display: "flex", gap: 9,
        }}>
          <button onClick={onClose} style={{
            border: "none", background: "none", cursor: "pointer", fontSize: 11.5, color: "var(--ink-faint)",
          }}>Cancel</button>
          {/*
            §27.15 — the destructive action, on the far side of the footer from
            Save and shown only when there is something to remove.

            "Not taught here" rather than "Delete": what is being removed is a
            fact about this class, not a record. Setting the periods to 0 above
            is the other half of the same idea and does NOT do this — it leaves
            the teacher mapped to a subject nobody is taught.
          */}
          {(periodsOf(className, subject) > 0 || idx >= 0) && (
            <button onClick={onRemove} title={`Take ${subject} off ${className} entirely`}
              style={{
                border: "none", background: "none", cursor: "pointer", fontSize: 11.5,
                color: "var(--signal)", marginLeft: 14,
              }}>✕ Not taught in {className}</button>
          )}
          <span style={{ flex: 1 }} />
          <button className="btn btn-primary" disabled={!!blocked} onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div>
    <label style={{
      display: "block", font: "700 9.5px/1 Inter", letterSpacing: "0.07em", textTransform: "uppercase",
      color: "var(--steel)", marginBottom: 5,
    }}>{label}</label>
    {children}
  </div>
);
const Hint = ({ children }: { children: React.ReactNode }) => (
  <small style={{ display: "block", fontSize: 11, color: "var(--ink-faint)", marginTop: 5, lineHeight: 1.45 }}>
    {children}
  </small>
);

// ─────────────────────────────────────────────── §27.11 clear the allocation

interface ResetLine { label: string; count: number; effect: "deleted" | "cleared" }
interface ResetPlan {
  name: string; academicYear: string; lines: ResetLine[];
  total: number; blocked: string | null; keeps: string[];
}

/**
 * Clearing the Allocation page — the destructive one.
 *
 * §27.10's "Start again" rebuilds the DRAFT from the suggestion and leaves the
 * database alone, which is right while a school is still setting itself up.
 * Once a step has been committed the §16 importer skips rows that already exist
 * by natural key, so re-proposing changes the grid and not the school. This is
 * the tool for that: it deletes the curriculum, the mappings and the class
 * teachers, and it says so with the counts before it does.
 *
 * The confirmation is a **typed word**, not a second OK. Every count on this
 * card is a row somebody entered, and "are you sure?" is a question people
 * learn to answer without reading.
 */
export function ResetAllocation({ configId, onDone, onClose }: {
  configId: number;
  onDone: () => void;
  onClose: () => void;
}) {
  const [plan, setPlan] = useState<ResetPlan | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api<ResetPlan>(`/timetable-configs/${configId}/allocation-reset`)
      .then((p) => { if (live) setPlan(p); })
      .catch((e) => { if (live) setError(asMessage(e)); });
    return () => { live = false; };
  }, [configId]);

  const run = async () => {
    setBusy(true); setError(null);
    try {
      await api(`/timetable-configs/${configId}/allocation-reset`, { method: "POST" });
      onDone();
    } catch (e) {
      setError(asMessage(e));
      setBusy(false);
    }
  };

  const real = (plan?.lines ?? []).filter((l) => l.count > 0);
  const armed = typed.trim().toLowerCase() === "clear";

  return (
    <div role="dialog" aria-modal="true" aria-label="Clear the allocation"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 500, background: "rgba(11,31,68,.45)",
        display: "grid", placeItems: "center", padding: 18,
      }}>
      <div style={{
        background: "var(--paper)", border: "1px solid var(--line)", borderRadius: 14,
        boxShadow: "0 24px 64px rgba(11,31,68,.3)", width: "min(500px,100%)",
        maxHeight: "90vh", overflow: "auto",
      }}>
        <div style={{
          padding: "15px 18px 12px", borderBottom: "1px solid var(--line)",
          display: "flex", alignItems: "flex-start", gap: 10,
        }}>
          <span style={{
            width: 34, height: 34, borderRadius: 9, display: "grid", placeItems: "center",
            flexShrink: 0, background: "var(--signal-bg)", color: "var(--signal)", fontSize: 17,
          }} aria-hidden>⚠</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ font: "700 15px/1.25 Inter" }}>Clear this timetable&rsquo;s allocation</div>
            <div style={{ fontSize: 11.5, color: "var(--ink-faint)", marginTop: 3 }}>
              {plan ? `${plan.name} · ${plan.academicYear}` : "Counting what this would remove…"}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close"
            style={{ border: "none", background: "none", cursor: "pointer", fontSize: 16, color: "var(--ink-faint)" }}>✕</button>
        </div>

        <div style={{ padding: "15px 18px", display: "flex", flexDirection: "column", gap: 13 }}>
          {error && (
            <div style={{
              borderLeft: "3px solid var(--signal)", background: "var(--signal-bg)", padding: "9px 12px",
              borderRadius: "0 8px 8px 0", fontSize: 12.3, color: "var(--ink-soft)", lineHeight: 1.5,
            }}>{error}</div>
          )}

          {plan?.blocked && (
            <div style={{
              borderLeft: "3px solid var(--signal)", background: "var(--signal-bg)", padding: "10px 12px",
              borderRadius: "0 8px 8px 0", fontSize: 12.4, color: "var(--ink-soft)", lineHeight: 1.55,
            }}>
              <strong style={{ color: "var(--signal)" }}>This cannot be cleared.</strong><br />
              {plan.blocked}
            </div>
          )}

          {plan && !plan.blocked && (
            <>
              <p style={{ fontSize: 12.8, color: "var(--ink-soft)", lineHeight: 1.6, margin: 0 }}>
                {plan.total === 0
                  ? "There is nothing here to clear yet — this timetable has no curriculum or mappings."
                  : <>This <strong style={{ color: "var(--signal)" }}>permanently deletes</strong> what
                    the Allocation page has written for {plan.name}. It cannot be undone.</>}
              </p>

              {real.length > 0 && (
                <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 5 }}>
                  {real.map((l) => (
                    <li key={l.label} style={{ fontSize: 12.5, color: "var(--ink-soft)", lineHeight: 1.5 }}>
                      <strong style={{ fontFamily: "var(--font-mono, monospace)", color: "var(--signal)" }}>
                        {l.count}
                      </strong>{" "}
                      {l.label}
                      {l.effect === "cleared" && (
                        <span style={{ color: "var(--ink-faint)" }}> — cleared, not deleted</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {/* Named in advance, so a reset that leaves electives standing
                  reads as a boundary rather than as having half-worked. */}
              {plan.keeps.length > 0 && (
                <div style={{
                  borderLeft: "3px solid var(--steel-light)", background: "var(--offwhite)",
                  padding: "9px 12px", borderRadius: "0 8px 8px 0", fontSize: 12,
                  color: "var(--ink-soft)", lineHeight: 1.55,
                }}>
                  <strong style={{ color: "var(--ink)" }}>Not touched:</strong>{" "}
                  {plan.keeps.join("; ")}.
                </div>
              )}

              {plan.total > 0 && (
                <div>
                  <label style={{
                    display: "block", font: "700 9.5px/1 Inter", letterSpacing: "0.07em",
                    textTransform: "uppercase", color: "var(--steel)", marginBottom: 5,
                  }} htmlFor="reset-confirm">
                    Type <strong style={{ color: "var(--signal)" }}>clear</strong> to confirm
                  </label>
                  <input id="reset-confirm" value={typed} autoComplete="off"
                    onChange={(e) => setTyped(e.target.value)}
                    placeholder="clear"
                    style={{
                      width: "100%", padding: "8px 10px", border: `1px solid ${armed ? "var(--signal)" : "var(--line)"}`,
                      borderRadius: 8, fontSize: 13, background: "var(--paper)", color: "var(--ink)",
                    }} />
                </div>
              )}
            </>
          )}
        </div>

        <div style={{
          padding: "12px 18px", borderTop: "1px solid var(--line)", background: "var(--offwhite)",
          display: "flex", gap: 9, alignItems: "center",
        }}>
          <button className="btn" onClick={onClose}>Keep it</button>
          <span style={{ flex: 1 }} />
          <button
            className="btn"
            disabled={busy || !plan || !!plan.blocked || plan.total === 0 || !armed}
            onClick={() => void run()}
            style={{
              background: armed ? "var(--signal)" : "var(--offwhite)",
              borderColor: armed ? "var(--signal)" : "var(--line)",
              color: armed ? "#fff" : "var(--ink-faint)",
            }}>
            {busy ? "Clearing…" : "Clear the allocation"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────── §27.15 a class does not take a subject

interface CellPlan {
  className: string; subjectName: string; academicYear: string;
  lines: Array<{ label: string; count: number }>;
  total: number; blocked: string | null; keeps: string[];
}

/**
 * "Biology is not taught in Pre-Nursery" — said once, and meant.
 *
 * Two writes, and the difference between them is the reason this asks before
 * acting. The DRAFT loses the cell immediately, which is all that is needed
 * while the school is still setting itself up. Once the step has been committed
 * the curriculum row is in the database, and the §16 importer never removes
 * anything — so without the server call the cell would empty on screen while
 * Readiness went on demanding four periods of Biology a week for a class of
 * four-year-olds. An empty cell that does not mean "not taught" is worse than
 * no delete button, because it is believed.
 *
 * **No typed word here**, unlike §27.11's reset. That deletes a whole
 * timetable's planning and cannot be undone by hand; this deletes one class's
 * one subject, and putting it back is clicking the same cell and typing a
 * number. The counts are still shown in full — what is being deleted is rows
 * somebody entered, however few.
 */
export function RemoveSubject({ configId, className, subjectName, sectionCount, onDone, onClose }: {
  /** Absent until the wing has been committed — then there is nothing saved. */
  configId?: number;
  className: string;
  subjectName: string;
  sectionCount: number;
  onDone: () => void;
  onClose: () => void;
}) {
  const [plan, setPlan] = useState<CellPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState(configId === undefined);

  useEffect(() => {
    if (configId === undefined) return;
    let live = true;
    const q = `className=${encodeURIComponent(className)}&subjectName=${encodeURIComponent(subjectName)}`;
    api<CellPlan>(`/timetable-configs/${configId}/allocation-cell?${q}`)
      .then((p) => { if (live) { setPlan(p); setAsked(true); } })
      // A school that has not committed this wing yet has no class row to count
      // against, and that is not an error worth stopping for — the draft edit is
      // the whole of the change in that case.
      .catch(() => { if (live) setAsked(true); });
    return () => { live = false; };
  }, [configId, className, subjectName]);

  const run = async () => {
    setBusy(true); setError(null);
    try {
      if (configId !== undefined && (plan?.total ?? 0) > 0) {
        await api(`/timetable-configs/${configId}/allocation-cell/delete`, {
          method: "POST",
          body: JSON.stringify({ className, subjectName }),
        });
      }
      onDone();
    } catch (e) {
      setError(asMessage(e));
      setBusy(false);
    }
  };

  const real = (plan?.lines ?? []).filter((l) => l.count > 0);

  return (
    <div role="dialog" aria-modal="true" aria-label={`Remove ${subjectName} from ${className}`}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 500, background: "rgba(11,31,68,.45)",
        display: "grid", placeItems: "center", padding: 18,
      }}>
      <div style={{
        background: "var(--paper)", border: "1px solid var(--line)", borderRadius: 14,
        boxShadow: "0 24px 64px rgba(11,31,68,.3)", width: "min(460px,100%)",
        maxHeight: "90vh", overflow: "auto",
      }}>
        <div style={{
          padding: "15px 18px 12px", borderBottom: "1px solid var(--line)",
          display: "flex", alignItems: "flex-start", gap: 10,
        }}>
          <span style={{
            width: 34, height: 34, borderRadius: 9, display: "grid", placeItems: "center",
            flexShrink: 0, background: "var(--signal-bg)", color: "var(--signal)", fontSize: 17,
          }} aria-hidden>⚠</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ font: "700 15px/1.25 Inter" }}>
              {className} does not take {subjectName}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--ink-faint)", marginTop: 3 }}>
              {/* Said out loud because periods are a CLASS fact (§3.11) and the
                  click that led here was on one section's cell. */}
              All {sectionCount} section{sectionCount === 1 ? "" : "s"} of {className}
              {plan?.academicYear ? ` · ${plan.academicYear}` : ""}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close"
            style={{ border: "none", background: "none", cursor: "pointer", fontSize: 16, color: "var(--ink-faint)" }}>✕</button>
        </div>

        <div style={{ padding: "15px 18px", display: "flex", flexDirection: "column", gap: 13 }}>
          {error && (
            <div style={{
              borderLeft: "3px solid var(--signal)", background: "var(--signal-bg)", padding: "9px 12px",
              borderRadius: "0 8px 8px 0", fontSize: 12.3, color: "var(--ink-soft)", lineHeight: 1.5,
            }}>{error}</div>
          )}

          {plan?.blocked ? (
            <div style={{
              borderLeft: "3px solid var(--signal)", background: "var(--signal-bg)", padding: "10px 12px",
              borderRadius: "0 8px 8px 0", fontSize: 12.4, color: "var(--ink-soft)", lineHeight: 1.55,
            }}>
              <strong style={{ color: "var(--signal)" }}>This cannot be removed.</strong><br />
              {plan.blocked}
            </div>
          ) : (
            <>
              <p style={{ fontSize: 12.8, color: "var(--ink-soft)", lineHeight: 1.6, margin: 0 }}>
                The cell goes empty, and an empty cell means <strong style={{ color: "var(--ink)" }}>this
                class is not taught this subject</strong>. Other classes keep it, and clicking the cell
                again puts it back.
              </p>

              {real.length > 0 && (
                <>
                  <p style={{ fontSize: 12.4, color: "var(--ink-soft)", margin: 0, lineHeight: 1.55 }}>
                    {/* The distinction that matters: a draft edit is undone by
                        "Start again", these rows are not. */}
                    It has already been saved, so this also{" "}
                    <strong style={{ color: "var(--signal)" }}>deletes</strong>:
                  </p>
                  <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 5 }}>
                    {real.map((l) => (
                      <li key={l.label} style={{ fontSize: 12.5, color: "var(--ink-soft)", lineHeight: 1.5 }}>
                        <strong style={{ fontFamily: "var(--font-mono, monospace)", color: "var(--signal)" }}>
                          {l.count}
                        </strong>{" "}
                        {l.label}
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {asked && real.length === 0 && (
                <div style={{
                  borderLeft: "3px solid var(--steel-light)", background: "var(--offwhite)",
                  padding: "9px 12px", borderRadius: "0 8px 8px 0", fontSize: 12,
                  color: "var(--ink-soft)", lineHeight: 1.55,
                }}>
                  Nothing has been saved for this cell yet, so this only changes the plan on this page.
                </div>
              )}

              {plan && plan.keeps.length > 0 && real.length > 0 && (
                <div style={{
                  borderLeft: "3px solid var(--steel-light)", background: "var(--offwhite)",
                  padding: "9px 12px", borderRadius: "0 8px 8px 0", fontSize: 12,
                  color: "var(--ink-soft)", lineHeight: 1.55,
                }}>
                  <strong style={{ color: "var(--ink)" }}>Not touched:</strong> {plan.keeps.join("; ")}.
                </div>
              )}
            </>
          )}
        </div>

        <div style={{
          padding: "12px 18px", borderTop: "1px solid var(--line)", background: "var(--offwhite)",
          display: "flex", gap: 9, alignItems: "center",
        }}>
          <button className="btn" onClick={onClose}>Keep it</button>
          <span style={{ flex: 1 }} />
          <button className="btn" disabled={busy || !asked || !!plan?.blocked}
            onClick={() => void run()}
            style={{ background: "var(--signal)", borderColor: "var(--signal)", color: "#fff" }}>
            {busy ? "Removing…" : `Remove ${subjectName}`}
          </button>
        </div>
      </div>
    </div>
  );
}


/**
 * §31.19a — clear every curriculum row a §4.9 block already teaches.
 *
 * The per-cell ✕ is right for one; the reference school has twenty-seven across
 * eight blocks, and a Readiness score that needs twenty-seven confirmations is
 * a score nobody reaches.
 *
 * **It deletes the SERVER rows, not just the draft.** Check 1 counts what is in
 * the database, so a grid that only tidied its own plan would go on showing 0%
 * and the person who pressed the button would have no way to tell why. The
 * draft is cleaned by the caller afterwards, or the §16 importer would write
 * every row straight back on the next Save.
 *
 * Every row is listed with its periods and the block that owns it — §27.11's
 * rule that a count and its delete are declared together, so the confirmation
 * cannot under-report what it is about to do. Reuses the same
 * `/allocation-cell/delete` endpoint the single ✕ uses: one call per pair, not
 * a new bulk route, because the rule about what a delete does belongs in one
 * place on the server.
 */
export function ClearDuplicates({ rows, configId, onDone, onClose }: {
  rows: Array<{ className: string; subject: string; periods: number; blockName: string }>;
  /** Absent until the wing is committed — then there is nothing saved to delete. */
  configId?: number;
  onDone: () => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  const total = rows.reduce((n, r) => n + r.periods, 0);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      if (configId !== undefined) {
        /*
          Sequential, not `Promise.all`. Each delete runs inside its own
          transaction on the same class rows, and firing twenty-seven at a
          server that is also recomputing readiness is how a deadlock gets
          found by a school rather than here.
        */
        for (const r of rows) {
          try {
            await api(`/timetable-configs/${configId}/allocation-cell/delete`, {
              method: "POST",
              body: JSON.stringify({ className: r.className, subjectName: r.subject }),
            });
          } catch (e) {
            /*
              A 404 here is "that class or subject is not committed in this
              timetable yet", which is the ordinary case for a row that exists
              only in the draft — and the draft is cleaned by the caller either
              way. Aborting the whole run over it would leave the earlier rows
              deleted and the plan untouched, which is the one outcome worse
              than doing nothing. Anything else still stops.
            */
            if (!/not found|no class/i.test(asMessage(e))) throw e;
          }
          setDone((n) => n + 1);
        }
      }
      onDone();
    } catch (e) {
      // Named, and the draft is NOT cleaned: some rows are gone and some are
      // not, so the honest thing is to leave the grid showing what is left and
      // let the button be pressed again. Every delete is idempotent.
      setError(asMessage(e));
      setBusy(false);
    }
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Clear duplicate periods"
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 500, background: "rgba(11,31,68,.45)",
        display: "grid", placeItems: "center", padding: 18,
      }}>
      <div style={{
        background: "var(--paper)", border: "1px solid var(--line)", borderRadius: 14,
        boxShadow: "0 24px 64px rgba(11,31,68,.3)", width: "min(520px,100%)",
        maxHeight: "88vh", display: "flex", flexDirection: "column",
      }}>
        <header style={{ padding: "15px 18px 12px", borderBottom: "1px solid var(--line)" }}>
          <h3 style={{ margin: 0, fontFamily: "Fraunces, Georgia, serif", fontSize: 18 }}>
            Clear {total} duplicate period{total === 1 ? "" : "s"}?
          </h3>
          <p style={{ fontSize: 12.3, color: "var(--ink-soft)", margin: "6px 0 0" }}>
            Each of these subjects is already taught inside an elective block, so these curriculum
            rows are the same lessons counted a second time. Deleting them leaves the block —
            and the children&rsquo;s teaching — exactly as it is.
          </p>
        </header>

        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "10px 18px" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.3 }}>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.className}::${r.subject}`}>
                  <td style={{ padding: "3px 0", whiteSpace: "nowrap" }}><strong>{r.className}</strong> {r.subject}</td>
                  <td style={{ padding: "3px 8px", textAlign: "right", fontFamily: "var(--font-mono, monospace)" }}>
                    {r.periods}
                  </td>
                  <td style={{ padding: "3px 0", color: "var(--ink-faint)", fontSize: 11 }}>
                    in {r.blockName}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <footer style={{
          borderTop: "1px solid var(--line)", padding: "11px 18px",
          display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap",
        }}>
          <span style={{ flex: 1, minWidth: 160, fontSize: 11.5 }}>
            {error
              ? <span style={{ color: "var(--signal)" }}>{error}</span>
              : busy
                ? <span style={{ color: "var(--ink-faint)" }}>{done} of {rows.length} cleared…</span>
                : <span style={{ color: "var(--ink-faint)" }}>{rows.length} curriculum row(s)</span>}
          </span>
          <button className="btn" style={{ fontSize: 12.5, border: "1px solid var(--line)" }}
            disabled={busy} onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" style={{ fontSize: 12.5 }} disabled={busy} onClick={run}>
            {busy ? "Clearing…" : `Clear ${total} period${total === 1 ? "" : "s"}`}
          </button>
        </footer>
      </div>
    </div>
  );
}
