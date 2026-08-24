import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { ImportIssue, ImportPlan } from "@edutimetable/shared";
import { apiDownload, apiUpload } from "../api";
import { asMessage, Card, ErrorNote } from "../components";

interface DryRun {
  plan: ImportPlan;
  unknownSheets: string[];
  truncated: string[];
  readinessPreview: { timetable: string; before: number; note: string } | null;
  fileName: string;
}
interface CommitResult {
  ok: boolean;
  created: Record<string, number>;
  message: string;
}

const LABELS: Record<string, string> = {
  academicYears: "academic years", classes: "classes", classSections: "class-sections",
  rooms: "rooms", subjects: "subjects", teachers: "teachers",
  teacherUnavailability: "unavailability rows", curriculum: "curriculum rows",
  classTeachers: "class-teacher assignments", mappings: "subject mappings", mergedGroups: "merged groups",
};

/** Screen 13 (§16) — one-file master import: template → fill → preview → commit. */
export function ImportMasters() {
  const [file, setFile] = useState<File | null>(null);
  const [dry, setDry] = useState<DryRun | null>(null);
  const [done, setDone] = useState<CommitResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const reset = () => { setFile(null); setDry(null); setDone(null); setError(null); if (inputRef.current) inputRef.current.value = ""; };

  const download = async (path: string, name: string) => {
    setBusy(name);
    setError(null);
    try { await apiDownload(path, name); } catch (e) { setError(asMessage(e)); } finally { setBusy(null); }
  };

  const choose = async (f: File | null) => {
    setFile(f);
    setDry(null);
    setDone(null);
    setError(null);
    if (!f) return;
    setBusy("checking");
    try {
      setDry(await apiUpload<DryRun>("/import/dry-run", f));
    } catch (e) { setError(asMessage(e)); } finally { setBusy(null); }
  };

  const commit = async () => {
    if (!file) return;
    setBusy("importing");
    setError(null);
    try {
      const res = await apiUpload<CommitResult>("/import/commit", file);
      setDone(res);
      setDry(null);
    } catch (e) { setError(asMessage(e)); } finally { setBusy(null); }
  };

  const errorsOnly = dry?.plan.issues.filter((i) => i.severity === "error") ?? [];
  const warningsOnly = dry?.plan.issues.filter((i) => i.severity === "warning") ?? [];

  if (done) {
    const rows = Object.entries(done.created).filter(([, n]) => n > 0);
    return (
      <div style={{ maxWidth: 760 }}>
        <Card>
          <div style={{ textAlign: "center", padding: "20px 0 8px" }}>
            <div style={{ fontSize: 40 }}>✅</div>
            <h2 style={{ fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 600, margin: "8px 0 4px" }}>
              {rows.length > 0 ? "Import complete" : "Nothing new to import"}
            </h2>
            <p className="screen-sub">{done.message}</p>
          </div>
          {rows.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "center", marginBottom: 18 }}>
              {rows.map(([k, n]) => (
                <div key={k} style={{ background: "var(--offwhite)", borderRadius: 10, padding: "10px 16px", textAlign: "center", minWidth: 120 }}>
                  <div style={{ fontFamily: "var(--font-display)", fontSize: 20, fontWeight: 700, color: "var(--brand)" }}>{n}</div>
                  <div style={{ fontSize: 10.5, color: "var(--ink-faint)" }}>{LABELS[k] ?? k}</div>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
            <Link to="/readiness" className="btn btn-primary" style={{ textDecoration: "none" }}>Check Readiness →</Link>
            <Link to="/setup" className="btn btn-secondary" style={{ textDecoration: "none" }}>Open Setup Wizard</Link>
            <button className="btn btn-secondary" onClick={reset}>Import another file</button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <ErrorNote message={error} />

      <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 18, alignItems: "start" }}>
        <Card title="1 · Get the workbook" sub="One file carries every master: years, classes, sections, rooms, subjects, teachers, curriculum and mappings.">
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button className="btn btn-primary" disabled={busy !== null}
              onClick={() => download("/import/template", "edutimetable-master-template.xlsx")}>
              {busy === "edutimetable-master-template.xlsx" ? "Preparing…" : "⬇ Download template"}
            </button>
            <button className="btn btn-secondary" disabled={busy !== null}
              onClick={() => download("/import/export", "edutimetable-masters.xlsx")}>
              {busy === "edutimetable-masters.xlsx" ? "Preparing…" : "⬇ Export current data"}
            </button>
          </div>
          <p style={{ fontSize: 12, color: "var(--ink-faint)", marginTop: 10, lineHeight: 1.6 }}>
            The template has an <b>Instructions</b> sheet, dropdowns on every choice column, notes on every heading, and a
            <b> Reference</b> sheet listing the names already in your system so you can copy the exact spelling.
            <br />
            <b>Export current data</b> gives you the same workbook filled with what you have — useful as a backup, or to
            bulk-edit and re-upload.
          </p>
        </Card>

        <Card title="How the check works">
          <ul style={{ fontSize: 11.5, color: "var(--ink-soft)", lineHeight: 1.7, paddingLeft: 18 }}>
            <li><b>Nothing is saved</b> until you review the preview and press Import.</li>
            <li><b>All-or-nothing</b> — a single error anywhere stops the whole import.</li>
            <li><b>Nothing is overwritten</b> — rows that already exist are reported and left alone, so re-uploading the same file is safe.</li>
            <li>You can type names (not ids), reorder columns, and reference things you are adding in the same file.</li>
          </ul>
        </Card>
      </div>

      <Card title="2 · Upload and preview" sub="The file is checked in full before anything is written.">
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <input ref={inputRef} type="file" accept=".xlsx" onChange={(e) => choose(e.target.files?.[0] ?? null)}
            style={{ fontSize: 13 }} disabled={busy !== null} />
          {busy === "checking" && <span className="badge badge-warn">Checking…</span>}
          {file && !busy && <button className="btn btn-secondary" onClick={reset}>Clear</button>}
        </div>
      </Card>

      {dry && (
        <>
          <Card
            title={dry.plan.ok ? "✓ This file is ready to import" : `✗ ${dry.plan.totals.errors} problem(s) to fix first`}
            sub={`${dry.fileName} · ${dry.plan.totals.read} data row(s) read · ${dry.plan.totals.create} to add · ${dry.plan.totals.skip} already exist`}
            actions={
              dry.plan.ok ? (
                <button className="btn btn-primary" onClick={commit} disabled={busy !== null || dry.plan.totals.create === 0}>
                  {busy === "importing" ? "Importing…" : `Import ${dry.plan.totals.create} row(s)`}
                </button>
              ) : (
                <button className="btn btn-secondary" disabled={busy !== null}
                  onClick={async () => {
                    if (!file) return;
                    setBusy("annotating");
                    try { await apiDownload("/import/annotate", "errors.xlsx", file); }
                    catch (e) { setError(asMessage(e)); } finally { setBusy(null); }
                  }}>
                  {busy === "annotating" ? "Preparing…" : "⬇ Download file with errors marked"}
                </button>
              )
            }
          >
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <thead>
                <tr style={{ background: "var(--offwhite)" }}>
                  <th style={th}>Sheet</th><th style={thNum}>Rows read</th><th style={thNum}>To add</th>
                  <th style={thNum}>Already exists</th><th style={thNum}>Errors</th>
                </tr>
              </thead>
              <tbody>
                {dry.plan.sheets.map((s) => (
                  <tr key={s.sheet} style={{ borderTop: "1px solid var(--line)", opacity: s.read === 0 ? 0.5 : 1 }}>
                    <td style={td}><b>{s.sheet}</b><div style={{ fontSize: 10.5, color: "var(--ink-faint)" }}>{s.title}</div></td>
                    <td style={tdNum}>{s.read || "—"}</td>
                    <td style={{ ...tdNum, color: s.create > 0 ? "var(--brand)" : undefined, fontWeight: s.create > 0 ? 700 : 400 }}>{s.create || "—"}</td>
                    <td style={tdNum}>{s.skip || "—"}</td>
                    <td style={{ ...tdNum, color: s.errors > 0 ? "var(--signal)" : undefined, fontWeight: s.errors > 0 ? 700 : 400 }}>{s.errors || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {dry.readinessPreview && (
              <p style={{ fontSize: 12, color: "var(--ink-faint)", marginTop: 12 }}>
                <b>{dry.readinessPreview.timetable}</b> is at {dry.readinessPreview.before}% readiness today. {dry.readinessPreview.note}
              </p>
            )}
            {dry.truncated.length > 0 && (
              <p style={{ fontSize: 12, color: "var(--amber)", marginTop: 8 }}>
                ⚠ Only the first 5,000 rows were read from: {dry.truncated.join(", ")}. Split the file and import in parts.
              </p>
            )}
            {dry.unknownSheets.length > 0 && (
              <p style={{ fontSize: 12, color: "var(--ink-faint)", marginTop: 8 }}>
                Ignored extra sheet(s): {dry.unknownSheets.join(", ")}.
              </p>
            )}
          </Card>

          {errorsOnly.length > 0 && <IssueList title={`${errorsOnly.length} error(s) — these block the import`} issues={errorsOnly} kind="error" />}
          {warningsOnly.length > 0 && <IssueList title={`${warningsOnly.length} note(s) — nothing to fix, just so you know`} issues={warningsOnly} kind="warning" />}
        </>
      )}
    </div>
  );
}

function IssueList({ title, issues, kind }: { title: string; issues: ImportIssue[]; kind: "error" | "warning" }) {
  const bySheet = new Map<string, ImportIssue[]>();
  for (const i of issues) {
    const l = bySheet.get(i.sheet) ?? [];
    l.push(i);
    bySheet.set(i.sheet, l);
  }
  const color = kind === "error" ? "var(--signal)" : "var(--amber)";
  const bg = kind === "error" ? "var(--signal-bg)" : "var(--amber-bg)";
  return (
    <Card title={title}>
      {[...bySheet.entries()].map(([sheetName, list]) => (
        <div key={sheetName} style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--ink-faint)", marginBottom: 6 }}>
            {sheetName}
          </div>
          {list.slice(0, 60).map((i, n) => (
            <div key={n} style={{ display: "flex", gap: 10, padding: "8px 11px", borderRadius: 8, background: bg, marginBottom: 5 }}>
              <span className="mono" style={{ fontSize: 10.5, fontWeight: 700, color, minWidth: 74, flexShrink: 0 }}>
                {i.row ? `Row ${i.row}${i.cell ? ` · ${i.cell}` : ""}` : "sheet"}
              </span>
              <span style={{ fontSize: 12.5, lineHeight: 1.5 }}>
                <b style={{ color }}>{i.message}</b>
                {i.value && <span className="mono" style={{ fontSize: 11, color: "var(--ink-faint)" }}> (found: “{i.value}”)</span>}
                <br />
                <span style={{ color: "var(--ink-soft)" }}>{i.fix}</span>
              </span>
            </div>
          ))}
          {list.length > 60 && (
            <div style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>
              …and {list.length - 60} more on this sheet. Download the annotated file to see them all in place.
            </div>
          )}
        </div>
      ))}
    </Card>
  );
}

const th: React.CSSProperties = { textAlign: "left", padding: "8px 12px", fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--ink-faint)" };
const thNum: React.CSSProperties = { ...th, textAlign: "right" };
const td: React.CSSProperties = { padding: "9px 12px", verticalAlign: "top" };
const tdNum: React.CSSProperties = { ...td, textAlign: "right", fontFamily: "var(--font-mono)", fontSize: 12 };
