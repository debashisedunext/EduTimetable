/**
 * §15.3 Phase 25.4d–g — steps 8 and 10: rooms, and the settings.
 *
 * Both are *suggested* steps, and the shape is the same: the suggester
 * proposes, the screen shows the proposal as ordinary editable rows, and
 * anything edited is stored in the draft under its own key. The server reads
 * that key if it is there and re-proposes if it is not — so going back to step
 * 7 to add a teacher and forward again changes the proposal, while an edit made
 * here survives.
 *
 * **Curriculum and Mapping used to be steps 9 and 10 of this file.** §28 merged
 * them into one Allocation grid (`Allocation.tsx`), because they were the same
 * decision seen twice — the proof being `withCurriculumPeriods`, which exists
 * only to stop the second step quoting a number the first had since changed.
 *
 * That move also retired a rule this header used to state: *"load and capacity
 * limits are deliberately not re-implemented in the browser — a second opinion
 * here that the server then contradicts would be worse than no opinion at
 * all."* The reasoning was right and the Allocation screen needs the opinion
 * anyway. It is not a second opinion any more: `computeLoads` in
 * `packages/shared` is one function, and the server calls it too.
 *
 * `coverageGaps` was always shared that way, for exactly the same reason — what
 * the screen says in green and what Next says in red cannot drift apart.
 */
import { useMemo } from "react";
import {
  suggestCurriculum, suggestRooms, weeklyCapacity,
  type SubjectAnswer, type SuggestedRoom, type WingAnswer,
} from "@edutimetable/shared";
import { Note, type WeekAnswer } from "./Structure";
import { cell, Heading, label, LinkButton, Scroll, td, th, input } from "./ui";

/** The week each wing actually got on step 5 — the ceiling for everything here. */
function weeksOf(answers: Record<string, any>) {
  const wings: WingAnswer[] = answers.wings ?? [];
  const weeks: Record<string, WeekAnswer> = answers.weeks ?? {};
  const capacity: Record<string, number> = {};
  const days: Record<string, number> = {};
  for (const w of wings) {
    const week = weeks[w.name];
    const workingDays = week?.workingDays ?? [1, 2, 3, 4, 5];
    capacity[w.name] = weeklyCapacity(week?.periodsPerDay ?? 8, workingDays);
    days[w.name] = workingDays.length;
  }
  return { wings, capacity, days };
}

// ───────────────────────────────────────────────────────────── step 8: rooms

export function StepRooms({ answers, onChange }: {
  answers: Record<string, any>;
  onChange: (patch: Record<string, any>) => void;
}) {
  const { wings, capacity, days } = weeksOf(answers);
  const subjects: SubjectAnswer[] = answers.subjects ?? [];

  const proposed = useMemo(() => {
    const curriculum = suggestCurriculum(wings, subjects, capacity, days);
    return suggestRooms(wings, subjects, { curriculum, capacityByWing: capacity });
  }, [JSON.stringify([wings, subjects, capacity, days])]);

  const rooms: SuggestedRoom[] = answers.rooms ?? proposed;
  const edited = Array.isArray(answers.rooms);
  const set = (next: SuggestedRoom[]) => onChange({ rooms: next });
  const edit = (i: number, patch: Partial<SuggestedRoom>) =>
    set(rooms.map((r, n) => (n === i ? { ...r, ...patch } : r)));

  const byType = (t: string) => rooms.filter((r) => r.type === t).length;

  return (
    <>
      <Heading title="Where do the lessons happen?">
        Worked out from the classes and subjects you entered: a home room for every section, enough
        labs for the lab periods the week actually needs, and a room for each activity subject.
      </Heading>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        {[["classroom", "home rooms"], ["lab", "labs"], ["activity", "activity rooms"], ["hall", "halls"]]
          .filter(([t]) => byType(t) > 0)
          .map(([t, name]) => (
            <span key={t} style={{
              font: "600 11.5px/1 Inter", padding: "6px 10px", borderRadius: 20,
              background: "var(--steel-pale)", color: "var(--brand-dark)",
            }}>{byType(t)} {name}</span>
          ))}
        {edited && (
          <LinkButton onClick={() => onChange({ rooms: undefined })}>Start again from the suggestion</LinkButton>
        )}
      </div>

      <Scroll max={300}>
        <thead><tr>
          <th style={{ ...th, width: "34%" }}>Room</th>
          <th style={{ ...th, width: 104 }}>Type</th>
          <th style={{ ...th, width: 74 }}>Seats</th>
          <th style={{ ...th }}>Used for</th>
          <th style={{ ...th, width: 30 }} />
        </tr></thead>
        <tbody>
          {rooms.map((r, i) => (
            <tr key={`${r.name}-${i}`}>
              <td style={td}>
                <input style={cell} value={r.name} aria-label={`Room ${i + 1}`}
                  onChange={(e) => edit(i, { name: e.target.value })} />
              </td>
              <td style={td}>
                <select style={{ ...cell, fontSize: 11.5 }} value={r.type} aria-label={`Type of ${r.name}`}
                  onChange={(e) => edit(i, { type: e.target.value as SuggestedRoom["type"] })}>
                  {["classroom", "lab", "activity", "hall"].map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </td>
              <td style={td}>
                <input type="number" min={1} max={200} style={{ ...cell, textAlign: "center" }}
                  value={r.capacity ?? ""} placeholder="—" aria-label={`Seats in ${r.name}`}
                  onChange={(e) => edit(i, { capacity: e.target.value === "" ? null : Number(e.target.value) })} />
              </td>
              <td style={{ ...td, fontSize: 11.5, color: "var(--ink-faint)", padding: "6px 9px" }}>
                {/* Two different facts, and the difference matters (§19): a home
                    room belongs to a section; a lab's subject list is what stops
                    it being a general room that serves everything. */}
                {r.homeRoomFor
                  ? <>Home room for <strong style={{ color: "var(--ink-soft)" }}>{r.homeRoomFor}</strong></>
                  : r.subjects.length > 0
                    ? r.subjects.join(", ")
                    : <em>anything — no subject listed</em>}
              </td>
              <td style={{ ...td, textAlign: "right" }}>
                <LinkButton tone="danger" onClick={() => set(rooms.filter((_, n) => n !== i))}>✕</LinkButton>
              </td>
            </tr>
          ))}
        </tbody>
      </Scroll>

      <button className="btn" style={{ padding: "4px 10px", fontSize: 12, marginTop: 10 }}
        onClick={() => set([...rooms, { name: "", type: "classroom", isShared: false, capacity: null, subjects: [], because: "added by hand" }])}>
        + Add a room
      </button>

      <Note>
        A lab with <em>no subject listed</em> is a general-purpose room that serves everything (§19).
        The labs above are mapped to their subjects, which is what makes the solver put Science in the
        Science Lab and nothing else there.
      </Note>
    </>
  );
}

// ────────────────────────────────────────────────────────── step 10: settings

export interface SettingsAnswer {
  classTeacherFirstPeriod: boolean;
  allowConsecutive: boolean;
  interWingTeaching: boolean;
  minPeriodsPerDay: number;
  /**
   * §28.1 — the % of a teacher's weekly limit at which the app says so.
   *
   * The one setting here that is NOT a constraint. Everything else on this step
   * is a hard rule the solver honours; this changes only what Readiness and the
   * Allocation rail report, and nothing refuses to generate because of it.
   */
  loadAlertPct: number;
}

export const defaultSettings = (): SettingsAnswer => ({
  classTeacherFirstPeriod: false,
  allowConsecutive: true,
  interWingTeaching: false,
  // ZERO, not the application's own default of 3 (§20). "At least three periods
  // or none" is a reasonable rule a school can choose; imposed silently on a
  // staff list nobody has looked at yet, it makes a part-time teacher's week
  // arithmetically impossible and Readiness refuses the school for a rule
  // nobody asked for.
  minPeriodsPerDay: 0,
  // The app's own default. A teacher at 75% still has a quarter of their week.
  loadAlertPct: 75,
});

function Toggle({ on, onChange, title, children }: {
  on: boolean; onChange: (v: boolean) => void; title: string; children: React.ReactNode;
}) {
  return (
    <label style={{
      display: "flex", gap: 11, alignItems: "flex-start", padding: "12px 14px",
      border: `1px solid ${on ? "var(--brand)" : "var(--line)"}`, borderRadius: 10,
      background: on ? "var(--steel-pale)" : "var(--paper)", cursor: "pointer",
    }}>
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: 2 }} />
      <span>
        <strong style={{ fontSize: 13, display: "block", marginBottom: 2 }}>{title}</strong>
        <span style={{ fontSize: 12.3, color: "var(--ink-soft)" }}>{children}</span>
      </span>
    </label>
  );
}

export function StepSettings({ answers, onChange }: {
  answers: Record<string, any>;
  onChange: (patch: Record<string, any>) => void;
}) {
  const s: SettingsAnswer = { ...defaultSettings(), ...(answers.settings ?? {}) };
  const set = (patch: Partial<SettingsAnswer>) => onChange({ settings: { ...s, ...patch } });
  const wings: WingAnswer[] = answers.wings ?? [];

  return (
    <>
      <Heading title="A few rules, then we're done">
        Every one of these is a hard constraint the solver honours — not a preference it scores.
        All of them can be changed later without regenerating from scratch.
      </Heading>

      <div style={{ display: "grid", gap: 10 }}>
        <Toggle on={s.classTeacherFirstPeriod} onChange={(v) => set({ classTeacherFirstPeriod: v })}
          title="The class teacher takes the first period">
          Every section starts its day with its own class teacher. Needs a class teacher on every
          section — you set those on the previous step.
        </Toggle>

        <Toggle on={s.allowConsecutive} onChange={(v) => set({ allowConsecutive: v })}
          title="A subject may run two periods back to back">
          Off means no subject is ever timetabled twice in a row for the same class. Leave it on
          unless the school has a rule against it — it is the constraint that most often makes a
          tight week unsolvable.
        </Toggle>

        {wings.length > 1 && (
          <Toggle on={s.interWingTeaching} onChange={(v) => set({ interWingTeaching: v })}
            title="Teachers may work across wings">
            Off — the default — keeps each teacher to the wing you put them in. Turning it on clears
            those limits, so anybody can be given any class.
          </Toggle>
        )}
      </div>

      <div style={{ marginTop: 16, maxWidth: 320 }}>
        <label style={label}>Minimum periods in a working day</label>
        <input style={input} type="number" min={0} max={8} value={s.minPeriodsPerDay}
          onChange={(e) => set({ minPeriodsPerDay: Number(e.target.value) })} />
        <p style={{ fontSize: 11.8, color: "var(--ink-faint)", marginTop: 6 }}>
          Read as <strong>“zero periods, or at least this many”</strong> — never “at least this many
          every day”, which no part-time teacher could satisfy. Zero means no rule, and is the right
          answer until the school has a reason.
        </p>
      </div>

      <div style={{ marginTop: 16, maxWidth: 420 }}>
        <label style={label}>Warn when a teacher passes</label>
        <div style={{ display: "flex", gap: 9, alignItems: "center" }}>
          <input style={{ ...input, width: 90 }} type="number" min={50} max={100}
            value={s.loadAlertPct}
            onChange={(e) => set({ loadAlertPct: Number(e.target.value) })} />
          <span style={{ fontSize: 13 }}>% of their weekly limit</span>
        </div>
        <p style={{ fontSize: 11.8, color: "var(--ink-faint)", marginTop: 6 }}>
          The only setting on this page that is <strong>not</strong> a constraint. Readiness reports
          the teachers above this line and the Allocation grid colours them amber — nothing refuses
          to generate. A teacher at 80% of their limit is a normally employed teacher.
        </p>
      </div>

      <Note tone="ok">
        Pressing <strong>Finish</strong> writes these and takes you to the Readiness dashboard, which
        checks the whole school and names anything still missing before you generate.
      </Note>
    </>
  );
}
