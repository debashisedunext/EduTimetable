import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { windowLabel, type MeResponse } from "@edutimetable/shared";
import { api } from "../api";
import { asMessage, Card, DataTable, ErrorNote, Field } from "../components";
import { useConfigCtx } from "../hooks";
import { inputStyle } from "./Timetables";
import { PrintSheet, type PrintContext } from "./PrintSheet";
import { WeekGrid, type GridPayload } from "./WeekGrid";

/** The report kinds whose payload is a week grid — as opposed to a table. */
const GRID_KINDS = new Set(["class-section", "teacher", "room", "subject"]);

type ReportKind = "class-section" | "teacher" | "room" | "subject" | "rooms" | "load";

interface Options {
  scope?: string;
  sections: { id: number; label: string }[];
  teachers: { id: number; name: string }[];
  configs: { id: number; name: string }[];
  /** §10.6 — offered only to view.all, because only they can open those cards. */
  rooms: { id: number; name: string; type: string }[];
  subjects: { id: number; name: string }[];
}

/** §10 Reports screen — filter bar, on-screen grid ≤1s (Redis-cached compact
 *  payloads), Print (browser print-style PDF) and CSV export. */
export function Reports({ me }: { me: MeResponse | null }) {
  const { current } = useConfigCtx();
  // a report card from Ask AI deep-links here with the filters it chose (§13.1)
  const [params] = useSearchParams();
  const [options, setOptions] = useState<Options | null>(null);
  const [kind, setKind] = useState<ReportKind>((params.get("kind") as ReportKind) || "class-section");
  const [sectionId, setSectionId] = useState(params.get("sectionId") ?? "");
  const [teacherId, setTeacherId] = useState(params.get("teacherId") ?? "");
  const [roomId, setRoomId] = useState(params.get("roomId") ?? "");
  const [subjectId, setSubjectId] = useState(params.get("subjectId") ?? "");
  const [date, setDate] = useState("");
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * §10 — the sheets handed to the printer.
   *
   * They live in the DOM (hidden on screen) rather than in a new window,
   * because a popup inherits none of the app's stylesheet and every browser
   * blocks it about half the time. `window.print()` after a render is the
   * boring, reliable path.
   */
  const [sheets, setSheets] = useState<GridPayload[] | null>(null);
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null);

  useEffect(() => {
    api<Options>("/reports/options")
      .then((o) => {
        setOptions(o);
        // deep-linked ids win; otherwise fall back to the first visible option
        if (!params.get("sectionId") && o.sections[0]) setSectionId(String(o.sections[0].id));
        if (!params.get("teacherId") && o.teachers[0]) setTeacherId(String(o.teachers[0].id));
        if (!params.get("roomId") && o.rooms?.[0]) setRoomId(String(o.rooms[0].id));
        if (!params.get("subjectId") && o.subjects?.[0]) setSubjectId(String(o.subjects[0].id));
      })
      .catch((e) => setError(asMessage(e)));
  }, []);

  const load = useCallback(async () => {
    setError(null);
    setData(null);
    try {
      const q = date ? `?date=${date}` : "";
      if (kind === "class-section" && sectionId) setData(await api(`/reports/class-section/${sectionId}${q}`));
      else if (kind === "teacher" && teacherId) setData(await api(`/reports/teacher/${teacherId}${q}`));
      else if (kind === "room" && roomId) setData(await api(`/reports/room/${roomId}${q}`));
      else if (kind === "subject" && subjectId) setData(await api(`/reports/subject/${subjectId}${q}`));
      else if (kind === "rooms" && current) setData(await api(`/reports/rooms/${current.id}`));
      else if (kind === "load" && current) setData(await api(`/reports/teacher-load/${current.id}`));
    } catch (e) { setError(asMessage(e)); }
  }, [kind, sectionId, teacherId, roomId, subjectId, date, current]);

  useEffect(() => { load(); }, [load]);

  /**
   * Render sheets, let the browser lay them out, then print.
   *
   * The `requestAnimationFrame` pair is not superstition: `window.print()`
   * blocks, and calling it in the same tick as the state update prints the
   * PREVIOUS render — an empty page. Two frames is the cheap, reliable way to
   * be sure the sheets are on the page first.
   */
  const printSheets = (payloads: GridPayload[]) => {
    setSheets(payloads);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        window.print();
        // Kept until after the dialog closes, so a cancelled print can be
        // retried without refetching everything.
        setTimeout(() => setSheets(null), 1000);
      }),
    );
  };

  const printOne = () => {
    if (data && GRID_KINDS.has(data.kind)) printSheets([data as GridPayload]);
    else window.print();
  };

  /**
   * Every class-section (or every teacher) in one run — the ask that turns a
   * morning of clicking Print fifty-six times into one action.
   *
   * Fetched a few at a time rather than all at once: these are Redis-cached
   * (§14) so they are fast, but firing sixty parallel requests at the API is
   * how a report screen becomes an outage.
   */
  const printAll = async () => {
    const targets =
      kind === "teacher"
        ? (options?.teachers ?? []).map((t) => ({ id: t.id, path: `/reports/teacher/${t.id}` }))
        : (options?.sections ?? []).map((s) => ({ id: s.id, path: `/reports/class-section/${s.id}` }));
    if (targets.length === 0) return;
    setError(null);
    setBatch({ done: 0, total: targets.length });
    const q = date ? `?date=${date}` : "";
    const out: GridPayload[] = [];
    try {
      for (let i = 0; i < targets.length; i += 4) {
        const chunk = targets.slice(i, i + 4);
        const got = await Promise.all(chunk.map((t) => api<GridPayload>(`${t.path}${q}`)));
        out.push(...got);
        setBatch({ done: Math.min(targets.length, i + chunk.length), total: targets.length });
      }
      printSheets(out);
    } catch (e) {
      setError(asMessage(e));
    } finally {
      setBatch(null);
    }
  };

  const printCtx: PrintContext = {
    me,
    timetableName: current?.name ?? null,
    // §30.5 — null for an undated timetable, so nothing is printed for the
    // schools that never use this.
    timetableWindow: current ? windowLabel(current) : null,
    printedAt: new Date(),
  };

  /** The line under a grid card's title — one sentence per kind, all in one place. */
  const gridSub = (g: any) => {
    const overlay = g.date ? ` \u00b7 substitutions overlaid for ${g.date}` : "";
    if (g.kind === "teacher") return `${g.weeklyLoad}/${g.maxPeriodsPerWeek} periods per week${overlay}`;
    if (g.kind === "room") return `${g.roomType ?? "room"}${overlay}`;
    if (g.kind === "subject") {
      return `${g.weeklyLessons} lessons a week across the school \u00b7 each cell counts the sections taught then, busiest is ${g.busiest}${overlay}`;
    }
    return `${g.classTeacher ? `Class teacher: ${g.classTeacher}` : "No class teacher assigned"}${overlay}`;
  };

  const exportCsv = () => {
    if (!data) return;
    let rows: string[][] = [];
    let name = "report";
    if (data.kind === "rooms") {
      name = "room-utilization";
      rows = [["Room", "Type", "Periods used", "Capacity", "Utilization %"],
        ...data.rows.map((r: any) => [r.name, r.type, String(r.used), String(data.capacityPerRoom), String(r.pct)])];
    } else if (data.kind === "load") {
      name = "teacher-load";
      rows = [["Teacher", "Assigned/week", "Capacity", "Sections", "Gaps", "Overloaded"],
        ...data.rows.map((r: any) => [r.name, String(r.assigned), String(r.capacity), String(r.sections), String(r.gaps), r.over ? "YES" : ""])];
    } else {
      name = `${data.kind}-${data.label}`;
      const g = data as GridPayload;
      // §10.6 — the wing column earns its place only on a card that spans more
      // than one; on every existing report the CSV is byte-for-byte what it was.
      const manyWings = (g.wings?.length ?? 0) > 1;
      rows = [[...(manyWings ? ["Wing"] : []), "Period", ...g.dayNames]];
      for (const p of g.periods.filter((x) => !x.isBreak && x.periodNumber !== 0)) {
        rows.push([
          ...(manyWings ? [p.wing] : []),
          `P${p.periodNumber}`,
          ...g.workingDays.map((d) => {
            const c = g.grid[`${d}:${p.key}`];
            if (!c) return "Free";
            // §10.6 — a subject cell is a count, not a lesson.
            if (c.count !== undefined) return `${c.count}: ${(c.sections ?? []).join(" | ")}`;
            // §4.9: an elective cell is several lessons. Flattening it to the
            // block name would export a timetable that hides which language a
            // child is actually in.
            if (c.electiveOptions?.length) {
              return `${c.blockName ?? c.subject ?? "Elective"}: ${c.electiveOptions
                .map((o) => `${o.subject} — ${o.teacher ?? ""}${o.room ? `, ${o.room}` : ""}${o.substituted ? " [SUB]" : ""}`)
                .join(" | ")}`;
            }
            const headlinesClass = g.kind === "teacher" || g.kind === "room";
            const main = headlinesClass ? c.classSection : c.subject;
            const sub = g.kind === "room"
              ? [c.subject, c.teacher].filter(Boolean).join(" · ")
              : g.kind === "teacher" ? c.subject : c.teacher;
            return `${main ?? ""} (${sub ?? ""}${c.room ? `, ${c.room}` : ""})${c.substituted ? " [SUB]" : ""}`;
          }),
        ]);
      }
    }
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `${name.replace(/\s+/g, "-").toLowerCase()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      {/* Hidden on screen, and the only thing on the page in print. Rendering
          them here rather than in a popup means they inherit the app's
          stylesheet, so the printed grid is the grid people already know. */}
      {sheets && (
        <div className="print-root">
          {sheets.map((g, i) => (
            <PrintSheet key={`${g.kind}-${g.label}-${i}`} ctx={printCtx} grid={g} />
          ))}
        </div>
      )}

      {/* Everything below is the SCREEN. Marking the whole of it, rather than
          tagging each card, means a card added later cannot accidentally end
          up on the printout — which is the failure this replaced. */}
      <div className="screen-only">
      <Card title="Reports" sub="All reports read the PUBLISHED timetable (§10); pick a date to overlay that day's substitutions.">
        <ErrorNote message={error} />
        <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1.4fr 1fr auto auto", gap: 10, alignItems: "end" }}>
          <Field label="Report">
            <select style={inputStyle} value={kind} onChange={(e) => setKind(e.target.value as ReportKind)}>
              <option value="class-section">Class-Section Weekly Timetable</option>
              <option value="teacher">Teacher Weekly Timetable</option>
              {options?.scope === "all" && <option value="room">Room Weekly Timetable</option>}
              {options?.scope === "all" && <option value="subject">Subject Across the Week</option>}
              {options?.scope === "all" && <option value="rooms">Room Utilization</option>}
              {options?.scope === "all" && <option value="load">Teacher Load Summary</option>}
            </select>
          </Field>
          {kind === "class-section" && (
            <Field label="Class-Section">
              <select style={inputStyle} value={sectionId} onChange={(e) => setSectionId(e.target.value)}>
                {(options?.sections ?? []).map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </Field>
          )}
          {kind === "teacher" && (
            <Field label="Teacher">
              <select style={inputStyle} value={teacherId} onChange={(e) => setTeacherId(e.target.value)}>
                {(options?.teachers ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
          )}
          {kind === "room" && (
            <Field label="Room">
              <select style={inputStyle} value={roomId} onChange={(e) => setRoomId(e.target.value)}>
                {(options?.rooms ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </Field>
          )}
          {kind === "subject" && (
            <Field label="Subject">
              <select style={inputStyle} value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
                {(options?.subjects ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
          )}
          {(kind === "rooms" || kind === "load") && (
            <Field label="Timetable"><input style={inputStyle} disabled value={current?.name ?? ""} /></Field>
          )}
          {GRID_KINDS.has(kind) ? (
            <Field label="Date (substitution overlay)">
              <input type="date" style={inputStyle} value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
          ) : <div />}
          <button className="btn btn-secondary" style={{ marginBottom: 18 }} onClick={printOne} disabled={!data}>🖨 Print / PDF</button>
          <button className="btn btn-primary" style={{ marginBottom: 18 }} onClick={exportCsv} disabled={!data}>⬇ Excel (CSV)</button>
        </div>

        {(kind === "class-section" || kind === "teacher") && (
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 4, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
            <button className="btn btn-secondary" onClick={printAll} disabled={batch !== null}>
              {batch
                ? `Preparing ${batch.done} of ${batch.total}…`
                : kind === "teacher"
                  ? `🖨 Print all ${options?.teachers.length ?? 0} teachers`
                  : `🖨 Print all ${options?.sections.length ?? 0} class-sections`}
            </button>
            <span style={{ fontSize: 12, color: "var(--ink-faint)" }}>
              One sheet per {kind === "teacher" ? "teacher" : "class"}, each on its own page — print to PDF for a single file
              {date ? `, with ${date}'s substitutions overlaid` : ""}.
            </span>
          </div>
        )}
      </Card>

      {data && GRID_KINDS.has(data.kind) && (
        <Card title={`${data.label} — weekly timetable`} sub={gridSub(data)}>
          {/* §10.6 — a card that spans two wings says so, because its rows then
              interleave by clock and "P3" alone stops being an answer. */}
          {(data.wings?.length ?? 0) > 1 && (
            <p style={{ fontSize: 12, color: "var(--ink-soft)", margin: "0 0 10px" }}>
              Across <b>{data.wings.length} wings</b> ({data.wings.map((w: any) => w.name).join(", ")}) —
              rows are ordered by clock time, and each names the wing its period number belongs to.
            </p>
          )}
          <WeekGrid data={data} />
        </Card>
      )}

      {data?.kind === "rooms" && (
        <Card title="Room Utilization" sub={`Capacity per room: ${data.capacityPerRoom} periods/week. Flags under- and over-used special rooms (§10).`}>
          <DataTable
            headers={["Room", "Type", "Used", "Utilization", ""]}
            rows={data.rows.map((r: any) => [
              <b key="n">{r.name}</b>,
              <span key="t" className="chip mono">{r.type}</span>,
              `${r.used} / ${data.capacityPerRoom}`,
              <div key="p" style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 160 }}>
                <div style={{ flex: 1, height: 7, background: "var(--offwhite)", borderRadius: 4, overflow: "hidden" }}>
                  <div style={{ width: `${Math.min(100, r.pct)}%`, height: "100%", background: r.pct > 85 ? "var(--signal)" : "var(--brand)" }} />
                </div>
                <span className="mono" style={{ fontSize: 11.5 }}>{r.pct}%</span>
              </div>,
              r.pct === 0 ? <span key="f" className="badge badge-warn">unused</span> : r.pct > 85 ? <span key="f" className="badge badge-error">heavily used</span> : "",
            ])}
          />
        </Card>
      )}

      {data?.kind === "load" && (
        <Card title="Teacher Load Summary" sub="Doubles as an ongoing feasibility-health report (§10).">
          <DataTable
            headers={["Teacher", "Assigned / Capacity", "Sections", "Gap periods", ""]}
            rows={data.rows.map((r: any) => [
              <b key="n">{r.name}</b>,
              <span key="l" className={`badge ${r.over ? "badge-error" : "badge-ok"}`}>{r.assigned} / {r.capacity}</span>,
              r.sections,
              r.gaps,
              r.over ? <span key="o" className="badge badge-error">overloaded</span> : "",
            ])}
          />
        </Card>
      )}
      </div>
    </>
  );
}
