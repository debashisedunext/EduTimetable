/**
 * §8.2 — what a class is taught, on one screen. Read-only, on purpose.
 *
 * The Allocation grid (§27) is where these rows are written, and it is the only
 * place that writes them: a curriculum row and the mapping that teaches it are
 * one decision, and a second editor over them is how two screens come to
 * disagree about who takes 5-A's maths. This answers the other question — "what
 * does 5-A actually do all week?" — which the matrix shape of the Allocation
 * page makes you read column by column.
 *
 * Three row shapes, because a class's week genuinely has three:
 *
 *   - an ordinary lesson: one subject, one teacher, this section
 *   - a §4.10 merged group: one lesson taught to several sections at once,
 *     which costs its teacher ONE period however many sections attend
 *   - a §4.9 split elective: one slot in which several subjects run in
 *     parallel, each with its own teacher and room
 *
 * The elective is the one that has to be here rather than left out for
 * simplicity. Its member row carries no subject (invariant 9), so a class's
 * week rendered from mappings alone shows the period as free — the exact bug
 * `ReportsService.classSectionTimetable` exists to avoid. If this screen cannot
 * show a language block, it is not showing the class's week.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Card, DataTable } from "../components";
import { useApi } from "../hooks";
import { inputStyle } from "./Timetables";

interface Mapping {
  type: "single" | "merged";
  id: number;
  teacherName: string;
  subjectName: string;
  classSectionIds: number[];
  classSectionLabel: string;
  periodsPerWeek: number;
  roomLabel: string;
}

interface ElectiveBlock {
  id: number;
  name: string;
  periodsPerWeek: number;
  members?: Array<{ classSectionId: number; label?: string }>;
  options?: Array<{ subjectName?: string; teacherName?: string; roomName?: string }>;
}

interface ClassSubjectRow {
  classId: number;
  subjectId: number;
  subjectName?: string;
  periodsPerWeek: number;
  consecutiveBlockSize?: number;
}

interface SectionRow {
  id: number;
  label: string;
  classId?: number;
}

export function ClassLessons({ configId }: { configId: number }) {
  const { data: sections } = useApi<any[]>(`/class-sections?timetableConfigId=${configId}`);
  const { data: mappings } = useApi<Mapping[]>("/mappings");
  const { data: blocks } = useApi<ElectiveBlock[]>("/elective-blocks");
  const { data: curriculum } = useApi<ClassSubjectRow[]>("/class-subjects");
  const [sectionId, setSectionId] = useState<number | null>(null);

  const rows: SectionRow[] = useMemo(
    () => (sections ?? []).map((s: any) => ({
      id: s.id,
      label: s.label ?? `${s.className ?? s.class?.name}-${s.sectionName ?? s.section?.name}`,
      classId: s.classId ?? s.class?.id,
    })).sort((a: SectionRow, b: SectionRow) => a.label.localeCompare(b.label, undefined, { numeric: true })),
    [sections],
  );

  const chosen = rows.find((r) => r.id === sectionId) ?? rows[0] ?? null;

  /** How long each lesson of this subject runs — a double period is length 2. */
  const lengthOf = (subjectName: string) =>
    (curriculum ?? []).find((c) => c.classId === chosen?.classId && c.subjectName === subjectName)
      ?.consecutiveBlockSize ?? 1;

  const mine = (mappings ?? []).filter((m) => chosen !== null && m.classSectionIds.includes(chosen.id));
  const myBlocks = (blocks ?? []).filter(
    (b) => chosen !== null && (b.members ?? []).some((m) => m.classSectionId === chosen.id),
  );

  const total = mine.reduce((n, m) => n + m.periodsPerWeek, 0)
    + myBlocks.reduce((n, b) => n + b.periodsPerWeek, 0);

  if (rows.length === 0) {
    return (
      <Card title="Lessons">
        <p className="screen-sub">This timetable has no class-sections yet.</p>
      </Card>
    );
  }

  return (
    <Card
      title="Lessons"
      sub="What this class is taught, week by week. Set it on the Allocation page — this is the reading view."
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <label style={{ fontSize: 12.5, color: "var(--ink-soft)" }} htmlFor="lessons-section">Class-section</label>
        <select id="lessons-section" style={{ ...inputStyle, width: 180 }}
          value={chosen?.id ?? ""} onChange={(e) => setSectionId(Number(e.target.value))}>
          {rows.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
        <span className="mono" style={{ fontSize: 12, color: "var(--ink-faint)" }}>
          {total} period{total === 1 ? "" : "s"}/week
        </span>
        <span style={{ flex: 1 }} />
        <Link to="/allocation" className="btn" style={{ textDecoration: "none", fontSize: 12.5 }}>
          Edit on the Allocation page →
        </Link>
        {chosen && (
          <Link to={`/availability?kind=class&id=${chosen.id}`} className="btn"
            style={{ textDecoration: "none", fontSize: 12.5 }}>
            🕐 Time off
          </Link>
        )}
      </div>

      <DataTable
        headers={["Subject", "Teacher", "Class", "Count", "Length", "Room"]}
        rows={[
          ...mine.map((m) => [
            m.subjectName,
            m.teacherName,
            // A merged group says so here rather than in a footnote: "5.A + 5.B"
            // in the Class column IS the fact that it is one lesson (§4.10).
            m.classSectionLabel,
            <span key="c" className="mono">{m.periodsPerWeek}</span>,
            <span key="l" className="mono">{lengthOf(m.subjectName)}</span>,
            m.roomLabel,
          ]),
          ...myBlocks.flatMap((b) => (b.options ?? []).map((o, i) => [
            <span key="s">
              {o.subjectName ?? "—"}{" "}
              <span className="badge badge-neutral" style={{ fontSize: 10 }}>{b.name}</span>
            </span>,
            o.teacherName ?? "—",
            // Every option runs for the whole block, in the same slot, so the
            // periods belong to the BLOCK and are shown once — on its first
            // option — rather than added up three times over.
            `${chosen?.label ?? ""} (group ${i + 1})`,
            <span key="c" className="mono">{i === 0 ? b.periodsPerWeek : "↑"}</span>,
            <span key="l" className="mono">1</span>,
            o.roomName ?? "—",
          ])),
        ]}
      />
      {mine.length === 0 && myBlocks.length === 0 && (
        <p className="screen-sub" style={{ marginTop: 10 }}>
          Nothing is taught to {chosen?.label} yet. Build its week on the Allocation page.
        </p>
      )}
    </Card>
  );
}
