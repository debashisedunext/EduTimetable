/**
 * §25 Phase 26 — "does this session run as one year, or as terms?"
 *
 * One set of controls, two containers, because the same question is asked in
 * two places that write at different times:
 *
 *  - `TermsEditor` — the Academic Years screen and the Setup Wizard, where the
 *    session already exists, so the terms are loaded and saved here.
 *  - `DraftTerms` — the guided setup's session step, where the academic year
 *    does not exist yet. It only collects; step 2's commit writes the terms
 *    right after the importer creates the year.
 *
 * Both render `TermFields`, so the rules cannot drift between them — and, since
 * a term boundary decides which timetable a Tuesday in October belongs to, that
 * is not a cosmetic concern.
 *
 * Two behaviours the controls exist to make obvious:
 *
 *  - **Changing the count re-splits the dates; editing a date never does.**
 *    Asking for 3 terms is asking "where would the boundaries be?"; once
 *    somebody has moved a boundary by hand, nothing moves it back for them.
 *  - **Validation is `validateTerms` from `packages/shared`** — the very
 *    function the server refuses with, so the message on screen is the message
 *    that would come back, not a second and kinder set of rules.
 */
import { useCallback, useEffect, useState } from "react";
import { formatSpan, splitSession, validateTerms, type TermIssue } from "@edutimetable/shared";
import { api } from "../api";
import { asMessage, ErrorNote } from "../components";

export interface TermRow {
  id?: number | null;
  name: string;
  startDate: string;
  endDate: string;
}

interface Session {
  /** The session's own span — every term has to fit inside it. */
  startDate: string;
  endDate: string;
}

const input: React.CSSProperties = {
  width: "100%", padding: "7px 10px", border: "1px solid var(--line)", borderRadius: 8,
  fontSize: 13, fontFamily: "inherit", background: "var(--paper)", color: "var(--ink)",
};
const label: React.CSSProperties = {
  display: "block", font: "600 11px/1.4 Inter", textTransform: "uppercase",
  letterSpacing: "0.06em", color: "var(--steel)", marginBottom: 5,
};

/** The controls themselves — no loading, no saving, no opinion about either. */
function TermFields({
  rows,
  session,
  onRows,
}: {
  rows: TermRow[];
  session: Session;
  onRows: (next: TermRow[]) => void;
}) {
  const termWise = rows.length > 0;

  /**
   * Where N boundaries would fall — `splitSession` from `packages/shared`, the
   * same function the server validates against. Deliberately not an endpoint:
   * the guided setup asks this before the academic year exists, so a server
   * call could not answer it there, and two implementations of "six months
   * each" would eventually round differently.
   */
  const propose = (count: number) => {
    const spans = splitSession(session.startDate, session.endDate, count, rows.map((r) => r.name));
    // Existing ids ride along in order, so a re-split MOVES those terms rather
    // than replacing them — every slot is filed under a term id.
    onRows(spans.map((s, i) => ({ ...s, id: rows[i]?.id ?? null })));
  };

  const patch = (i: number, change: Partial<TermRow>) =>
    onRows(rows.map((r, j) => (j === i ? { ...r, ...change } : r)));

  const issues: TermIssue[] = termWise ? validateTerms(rows, session) : [];
  const issueFor = (i: number) => issues.find((x) => x.index === i);

  return (
    <>
      <label style={label}>How is this session timetabled?</label>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        {[
          { on: false, title: "Whole year", body: "One timetable, all year." },
          { on: true, title: "Terms", body: "A timetable per term, each with its own dates." },
        ].map((choice) => (
          <button
            key={choice.title}
            type="button"
            onClick={() => (choice.on ? (rows.length === 0 ? propose(2) : undefined) : onRows([]))}
            style={{
              flex: "1 1 210px", textAlign: "left", font: "inherit", cursor: "pointer", padding: "10px 13px",
              border: `1.5px solid ${termWise === choice.on ? "var(--brand)" : "var(--line)"}`,
              borderRadius: 10,
              background: termWise === choice.on ? "var(--steel-pale)" : "var(--paper)",
            }}
          >
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>{choice.title}</div>
            <div style={{ fontSize: 12, color: "var(--ink-soft)", marginTop: 2 }}>{choice.body}</div>
          </button>
        ))}
      </div>

      {termWise && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
            <span style={{ ...label, marginBottom: 0 }}>How many?</span>
            {[2, 3, 4].map((n) => (
              <button
                key={n} type="button" className="btn"
                onClick={() => propose(n)}
                style={{
                  padding: "4px 12px", fontSize: 12.5,
                  background: rows.length === n ? "var(--brand)" : "var(--paper)",
                  color: rows.length === n ? "#fff" : "var(--ink)",
                  borderColor: rows.length === n ? "var(--brand)" : "var(--line)",
                }}
              >{n}</button>
            ))}
            <button type="button" className="btn"
              style={{ padding: "4px 12px", fontSize: 12.5, borderColor: "var(--line)" }}
              onClick={() => propose(rows.length + 1)} disabled={rows.length >= 6}>
              ＋ Add a term
            </button>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>
              Changing the number re-splits the dates. Editing a date leaves them alone.
            </span>
          </div>

          <div style={{ border: "1px solid var(--line)", borderRadius: 10, overflow: "hidden" }}>
            {rows.map((t, i) => {
              const bad = issueFor(i);
              return (
                <div key={t.id ?? `new-${i}`} style={{
                  padding: "10px 13px",
                  borderBottom: i < rows.length - 1 ? "1px solid var(--line)" : "none",
                  background: bad ? "var(--signal-bg)" : "var(--paper)",
                }}>
                  <div style={{ display: "grid", gap: 10, gridTemplateColumns: "1.4fr 1fr 1fr auto", alignItems: "end" }}>
                    <div>
                      {i === 0 && <label style={label}>Term</label>}
                      <input style={input} value={t.name} maxLength={30}
                        aria-label={`Name of term ${i + 1}`}
                        onChange={(e) => patch(i, { name: e.target.value })} />
                    </div>
                    <div>
                      {i === 0 && <label style={label}>From</label>}
                      <input style={input} type="date" value={t.startDate}
                        aria-label={`${t.name} start date`}
                        min={session.startDate} max={session.endDate}
                        onChange={(e) => patch(i, { startDate: e.target.value })} />
                    </div>
                    <div>
                      {i === 0 && <label style={label}>To</label>}
                      <input style={input} type="date" value={t.endDate}
                        aria-label={`${t.name} end date`}
                        min={session.startDate} max={session.endDate}
                        onChange={(e) => patch(i, { endDate: e.target.value })} />
                    </div>
                    <div style={{ fontSize: 11.5, color: "var(--ink-faint)", paddingBottom: 8, whiteSpace: "nowrap" }}>
                      {t.startDate && t.endDate ? formatSpan(t) : "—"}
                    </div>
                  </div>
                  {bad && (
                    <div style={{ fontSize: 12, color: "var(--signal)", marginTop: 7 }}>
                      {bad.message} <span style={{ color: "var(--ink-soft)" }}>{bad.fix}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {issues.filter((x) => x.index === -1).map((x) => (
            <div key={x.message} style={{ fontSize: 12, color: "var(--signal)", marginTop: 8 }}>
              {x.message} <span style={{ color: "var(--ink-soft)" }}>{x.fix}</span>
            </div>
          ))}
        </>
      )}
    </>
  );
}

/** Every problem with the current rows — exported so a wizard step can block Next on it. */
export const termProblems = (rows: TermRow[], session: Session): TermIssue[] =>
  rows.length > 0 ? validateTerms(rows, session) : [];

/**
 * The saved form: loads the session's terms, and writes them.
 *
 * The whole set goes in one PUT. No overlaps and at-least-two-terms are rules
 * about the *set*, and saving a row at a time would walk through illegal states
 * and could stop in one.
 */
export function TermsEditor({
  academicYearId,
  session,
  onSaved,
}: {
  academicYearId: number;
  session: Session;
  onSaved?: (terms: TermRow[]) => void;
}) {
  const [saved, setSaved] = useState<TermRow[] | null>(null);
  const [rows, setRows] = useState<TermRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const load = useCallback(async () => {
    try {
      const terms = await api<TermRow[]>(`/academic-years/${academicYearId}/terms`);
      setSaved(terms);
      setRows(terms);
    } catch (e) {
      setError(asMessage(e));
    }
  }, [academicYearId]);
  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const back = await api<TermRow[]>(`/academic-years/${academicYearId}/terms`, {
        method: "PUT",
        body: JSON.stringify({ terms: rows }),
      });
      setSaved(back);
      setRows(back);
      setDone(true);
      onSaved?.(back);
    } catch (e) {
      // The server re-validates and is the authority. Its refusals know things
      // this screen cannot — chiefly how much timetable is already filed under
      // a term somebody is about to remove.
      setError(asMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (saved === null && error === null) {
    return <p style={{ fontSize: 12.5, color: "var(--ink-faint)" }}>Loading terms…</p>;
  }

  const issues = termProblems(rows, session);
  const dirty = JSON.stringify(saved ?? []) !== JSON.stringify(rows);

  return (
    <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--line)" }}>
      <ErrorNote message={error} />
      <TermFields rows={rows} session={session} onRows={(next) => { setDone(false); setRows(next); }} />
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
        <button className="btn btn-primary" onClick={() => void save()}
          disabled={busy || issues.length > 0 || !dirty}>
          {busy ? "Saving…" : rows.length > 0 ? "Save terms" : "Save — run as a whole year"}
        </button>
        {done && !dirty && (
          <span style={{ fontSize: 12.5, color: "var(--accent)" }}>
            {rows.length > 0
              ? `Saved — this session runs as ${rows.length} terms.`
              : "Saved — this session runs as one whole year."}
          </span>
        )}
        {dirty && (
          <span style={{ fontSize: 12, color: "var(--ink-faint)" }}>Nothing is written until you save.</span>
        )}
      </div>
    </div>
  );
}

/**
 * The draft form, for the guided setup's session step.
 *
 * Writes nothing: the answer lives in the draft like every other answer, and
 * step 2's commit creates the terms straight after the importer creates the
 * year they belong to.
 */
export function DraftTerms({
  session,
  value,
  onChange,
}: {
  session: Session;
  value: TermRow[];
  onChange: (rows: TermRow[]) => void;
}) {
  return (
    <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--line)" }}>
      <TermFields rows={value} session={session} onRows={onChange} />
    </div>
  );
}
