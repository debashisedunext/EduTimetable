import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { LockRibbon } from "../locks";
import { asMessage } from "../components";
import { useApi, useConfigCtx } from "../hooks";

interface SectionDiff {
  classSectionId: number;
  label: string;
  added: number;
  removed: number;
  changed: number;
  unallocated: number;
  details: string[];
}
/** §22 — a named draft, as the picker needs it. */
interface DraftRow {
  id: number;
  draftNo: number;
  label: string | null;
  status: "draft" | "published" | "archived" | "discarded";
  generationPct: number | null;
}

interface Preview {
  draftCount: number;
  publishedCount: number;
  /** §22 — which draft this diff is for */
  draftId: number | null;
  demandTotal: number;
  unallocatedTotal: number;
  changedTotal: number;
  unchangedSections: number;
  sections: SectionDiff[];
  currentVersion: number | null;
  currentPublishedAt: string | null;
  nextVersion: number;
}

/** Screen 6 (§8) — Publish Confirmation: reviewable diff vs. the live version,
 *  unallocated warnings, then ONE transaction flips draft→published (task 3.7). */
export function Publish() {
  const { current, refetch: refetchConfigs } = useConfigCtx();
  const navigate = useNavigate();
  // §22 — the draft to publish. It can arrive three ways, and they have to
  // agree: deep-linked from the Draft Board's Compare row, chosen in the picker
  // below, or left to the server when a school has only one. The URL is kept in
  // step with the picker so a refresh or a shared link still means this draft.
  const [params, setParams] = useSearchParams();
  const draftQ = params.get("draftId");
  const draftId = draftQ && /^\d+$/.test(draftQ) ? Number(draftQ) : null;
  const { data: drafts } = useApi<DraftRow[]>(
    current ? `/timetable-configs/${current.id}/drafts` : null,
  );
  const { data, refetch } = useApi<Preview>(
    current
      ? `/timetable-configs/${current.id}/board/publish/preview${draftId !== null ? `?draftId=${draftId}` : ""}`
      : null,
  );
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ version: number; slotCount: number; draftNo: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** §3.14 — the confirmation for taking the live timetable down. */
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawn, setWithdrawn] = useState<Withdrawal | null>(null);
  /** §29.1 — settling the published week, or releasing it. */
  const [freezing, setFreezing] = useState(false);
  const frozenAt = current?.frozenAt ?? null;
  /*
    Both directions through one helper, because they differ only in the verb.
    `refetchConfigs` is what makes the banner appear and disappear: the flag
    lives on the config the whole app shares, not on this page's own state, so
    every other screen learns about it at the same moment.
  */
  const setFrozen = async (on: boolean) => {
    if (!current) return;
    setFreezing(true);
    try {
      await api(`/timetable-configs/${current.id}/${on ? "freeze" : "unfreeze"}`, { method: "POST" });
      setError(null);
      await refetchConfigs?.();
      refetch();
    } catch (e) {
      setError(asMessage(e));
    } finally {
      setFreezing(false);
    }
  };
  const freeze = () => setFrozen(true);
  const unfreeze = () => setFrozen(false);

  if (!current) return <p className="screen-sub">Select a timetable first.</p>;
  if (!data) return <p className="screen-sub">Computing diff…</p>;

  // Publishing is what MAKES a draft the published one, so only a draft that
  // still holds a week can be published. Publishing flips its rows in place
  // (§22.4), so a draft that has already been published — or been archived by
  // a later publish — has no draft rows left and would publish nothing.
  const publishable = (drafts ?? []).filter((d) => d.status === "draft");
  // Whatever the server actually diffed, until the reader picks something else.
  const shownDraftId = draftId ?? data.draftId ?? null;
  const shown = (drafts ?? []).find((d) => d.id === shownDraftId) ?? null;
  const chooseDraft = (id: number) => {
    const next = new URLSearchParams(params);
    next.set("draftId", String(id));
    setParams(next, { replace: true });
  };

  const publish = async () => {
    // Name the draft in the confirmation. "Publish v3?" is not a question a
    // person with five drafts can answer.
    const which = shown ? `Draft #${shown.draftNo}${shown.label ? ` — ${shown.label}` : ""}` : "this draft";
    if (!window.confirm(
      `Publish ${which} as v${data.nextVersion}?\n\n` +
        `This replaces the live timetable for every teacher and class-section in one transaction. ` +
        `Your other drafts are untouched.`,
    )) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ version: number; slotCount: number }>(
        `/timetable-configs/${current.id}/board/publish`,
        // Send the draft that is ON SCREEN, not only one that came in the URL:
        // otherwise arriving from the nav and picking a draft would publish
        // whichever the server thought was current, not the one being reviewed.
        { method: "POST", body: JSON.stringify(shownDraftId !== null ? { draftId: shownDraftId } : {}) },
      );
      setDone({ ...res, draftNo: shown?.draftNo ?? null });
    } catch (e) {
      const msg = (e as Error).message.replace(/^\d+: /, "");
      try { setError(JSON.parse(msg).message ?? msg); } catch { setError(msg); }
    } finally {
      setBusy(false);
      refetch();
    }
  };

  if (done) {
    return (
      <div className="card" style={{ textAlign: "center", padding: 48 }}>
        <div style={{ fontSize: 40, marginBottom: 10 }}>🎉</div>
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 600, marginBottom: 6 }}>
          v{done.version} is live
        </h2>
        <p className="screen-sub">
          {done.draftNo !== null ? `Draft #${done.draftNo} · ` : ""}
          {done.slotCount} slots published in one transaction.
          {" "}Your other drafts are untouched — the school keeps them for the next revision (§22.4).
        </p>
        <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 14 }}>
          <button className="btn" onClick={() => navigate("/matrix")}>View Allocation Matrix</button>
          <button className="btn btn-primary" onClick={() => navigate("/board")}>Back to Draft Board</button>
        </div>
        <InviteTeachersPrompt />
      </div>
    );
  }

  const fmtDate = (d: string | null) =>
    d ? new Date(d).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : null;

  return (
    <div>
      <h2 style={{ fontFamily: "var(--font-display)", fontSize: 21, fontWeight: 600, marginBottom: 4 }}>Publish Confirmation</h2>
      <p className="screen-sub" style={{ marginBottom: 14 }}>
        Review changes before this draft replaces the live timetable for every teacher and class-section.
      </p>

      {/*
        §29.1 — a frozen timetable says so before anything else on the page.

        Above the diff, not beside a button, because it changes what every
        control below it will do. The server refuses regardless (`FreezeService`
        guards the write, not the button), so this exists to explain rather than
        to enforce — which is why it names the one action that IS available.
      */}
      {frozenAt && (
        <>
          {/*
            §29.8 — the scoped answer first, the wide one underneath.

            The old banner offered exactly one way out, and it was the widest
            one available: unfreeze everything to change one class. The ribbon
            puts the narrow door first and lists what is already open; the full
            unfreeze stays, because a school re-planning the whole week still
            needs it and one that froze by mistake has no other way back.
          */}
          <LockRibbon
            configId={current.id}
            configName={current.name}
            frozenAt={frozenAt}
            onChanged={() => { void refetchConfigs?.(); refetch(); }}
          />
          <p style={{ fontSize: 11.8, color: "var(--ink-faint)", margin: "-8px 0 16px" }}>
            Re-planning the whole week instead?{" "}
            <button className="linkish" disabled={freezing} onClick={() => unfreeze()}
              style={{
                border: "none", background: "none", padding: 0, font: "inherit",
                color: "var(--brand)", cursor: "pointer", textDecoration: "underline",
              }}>
              {freezing ? "Working…" : "Unlock the whole timetable"}
            </button>{" "}
            — this also closes every unlock above.
          </p>
        </>
      )}

      {/* Says where the week WENT. A screen that simply stops showing a
          published version leaves somebody wondering whether it worked. */}
      {withdrawn && (
        <div className="card" style={{
          borderColor: "var(--accent)", background: "var(--accent-bg)", padding: "12px 14px",
          marginBottom: 18, fontSize: 12.6, lineHeight: 1.55,
        }}>
          <strong>
            {withdrawn.version ? `v${withdrawn.version} has been withdrawn` : "The timetable has been withdrawn"}
          </strong>{" "}
          — {withdrawn.slotCount} lessons are back in <strong>Draft #{withdrawn.draftNo}</strong>
          {withdrawn.reused ? ", the draft they were published from" : " (a new draft)"}. Nothing is live for this
          timetable now. Edit it on the <Link to="/board">Draft Board</Link> and publish again when it is ready
          {withdrawn.substitutions > 0 && (
            <>; the {withdrawn.substitutions} recorded substitution{withdrawn.substitutions === 1 ? "" : "s"} are
            kept and line up again when you do</>
          )}.
        </div>
      )}

      {/* §22 — WHICH draft is being published. Without this the screen showed a
          version number and a diff for a draft it never named, and a school
          with five of them had no way to tell which one it was about to make
          live, nor to choose a different one without going back to the Board. */}
      {publishable.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
          <span className="section-label">Publish</span>
          <select
            value={shownDraftId ?? ""}
            onChange={(e) => chooseDraft(Number(e.target.value))}
            style={{ padding: "8px 11px", border: "1px solid var(--brand)", borderRadius: 8, fontWeight: 700, fontSize: 13, color: "var(--brand)", background: "var(--steel-pale)" }}
          >
            {publishable.map((d) => (
              <option key={d.id} value={d.id}>
                Draft #{d.draftNo}{d.label ? ` — ${d.label}` : ""}
                {d.generationPct !== null ? ` · ${d.generationPct}%` : ""}
              </option>
            ))}
          </select>
          <Link to="/board" style={{ fontSize: 12.5, color: "var(--brand)", fontWeight: 600 }}>
            Compare them on the Draft Board →
          </Link>
        </div>
      )}

      {/* A draft that is already published, or was archived by a later publish,
          has no draft rows left (§22.4 flips them in place) — so it would
          publish nothing. Say that, rather than leaving a disabled button. */}
      {shown && shown.status !== "draft" && (
        <div className="card" style={{ borderColor: "var(--amber)", background: "var(--amber-bg, #FBF0DE)", padding: "12px 14px", marginBottom: 20, fontSize: 12.5 }}>
          <strong>Draft #{shown.draftNo} is {shown.status}</strong> — publishing flips a draft's rows in place, so this one
          has no working copy left to publish. Pick an editable draft above, or regenerate this one on the Generate screen.
        </div>
      )}

      <div className="grid2" style={{ gap: 16, marginBottom: 22 }}>
        <div className="card" style={{ padding: 20 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--ink-faint)", marginBottom: 12 }}>Currently Published</div>
          <div style={{ fontFamily: "var(--font-display)", fontSize: 20, fontWeight: 600 }}>
            {data.currentVersion ? `v${data.currentVersion}` : "— none yet"}
          </div>
          <div style={{ fontSize: 12, color: "var(--ink-faint)", marginTop: 2 }}>
            {data.currentVersion
              ? `Effective since ${fmtDate(data.currentPublishedAt)} · ${data.publishedCount} slots`
              : "This will be the first published version"}
          </div>
          {/*
            §3.14 — the way back, and it lives HERE.

            Beside the version it withdraws, rather than among the actions at
            the bottom: those are all about the draft being published, and a
            control that takes the live timetable DOWN standing next to the one
            that puts a new one up is a mis-click with a school-wide audience.
          */}
          {data.publishedCount > 0 && !frozenAt && (
            <div style={{ display: "flex", gap: 14, marginTop: 12, flexWrap: "wrap" }}>
              <button
                onClick={() => setWithdrawing(true)}
                style={{
                  border: "none", background: "none", padding: 0, cursor: "pointer",
                  fontSize: 12, fontWeight: 600, color: "var(--signal)",
                }}>
                ↩ Withdraw {data.currentVersion ? `v${data.currentVersion}` : "it"} back to a draft
              </button>
              {/*
                §29.1 — beside the version it settles, and only once there IS
                one. Freezing an unpublished timetable protects nothing and
                would only lock a school out of its own planning; the server
                refuses it by name, and offering the button anyway would be
                inviting that refusal.
              */}
              <button
                onClick={() => freeze()}
                disabled={freezing}
                title="Settle this published week — no allocation changes until it is unfrozen"
                style={{
                  border: "none", background: "none", padding: 0, cursor: "pointer",
                  fontSize: 12, fontWeight: 600, color: "var(--brand)",
                }}>
                {freezing ? "Working…" : "🔒 Freeze this timetable"}
              </button>
            </div>
          )}
        </div>
        <div className="card" style={{ padding: 20, borderColor: "var(--accent)" }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--accent)", marginBottom: 12 }}>
            Publishing {shown ? `Draft #${shown.draftNo}` : "this draft"}
          </div>
          <div style={{ fontFamily: "var(--font-display)", fontSize: 20, fontWeight: 600 }}>
            {shown ? `Draft #${shown.draftNo}` : "Draft"} → v{data.nextVersion}
            {shown?.label && <span style={{ fontSize: 13, fontWeight: 400, color: "var(--ink-soft)" }}> · {shown.label}</span>}
          </div>
          <div style={{ fontSize: 12, color: "var(--ink-faint)", marginTop: 2 }}>
            {data.draftCount} / {data.demandTotal} required slots filled
            {data.unallocatedTotal > 0 ? ` · ${data.unallocatedTotal} unallocated` : " · complete"}
          </div>
        </div>
      </div>

      {data.unallocatedTotal > 0 && (
        <div className="card" style={{ borderColor: "var(--amber)", background: "var(--amber-bg)", marginBottom: 18, padding: 14 }}>
          <b style={{ color: "var(--amber)" }}>⚠ {data.unallocatedTotal} period(s) are still unallocated.</b>{" "}
          <span style={{ fontSize: 12.5 }}>You can publish anyway, but those classes will have empty slots — place them on the <Link to="/board">Draft Board</Link> first for a complete timetable.</span>
        </div>
      )}

      <div className="card" style={{ marginBottom: 22, padding: 0, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead>
            <tr style={{ background: "var(--offwhite)" }}>
              <th style={th}>Change</th><th style={th}>Class-Section</th><th style={th}>Detail</th>
            </tr>
          </thead>
          <tbody>
            {data.sections.map((s) => (
              <tr key={s.classSectionId} style={{ borderTop: "1px solid var(--line)" }}>
                <td style={{ ...td, whiteSpace: "nowrap" }}>
                  {s.added > 0 && <span className="badge badge-ok" style={{ marginRight: 4 }}>{s.added} added</span>}
                  {s.changed > 0 && <span className="badge badge-ok" style={{ marginRight: 4 }}>{s.changed} changed</span>}
                  {s.removed > 0 && <span className="badge badge-neutral" style={{ marginRight: 4 }}>{s.removed} removed</span>}
                  {s.unallocated > 0 && <span className="badge badge-warn">{s.unallocated} unallocated</span>}
                </td>
                <td style={{ ...td, fontWeight: 700 }}>{s.label}</td>
                <td style={td}>
                  {s.details.slice(0, 4).join(" · ")}
                  {s.details.length > 4 ? ` · +${s.added + s.changed + s.removed - 4} more` : ""}
                </td>
              </tr>
            ))}
            {data.unchangedSections > 0 && (
              <tr style={{ borderTop: "1px solid var(--line)" }}>
                <td style={td}><span className="badge badge-neutral">Unchanged</span></td>
                <td style={{ ...td, fontWeight: 700 }}>{data.unchangedSections} section(s)</td>
                <td style={td}>No changes from {data.currentVersion ? `v${data.currentVersion}` : "the current draft"}</td>
              </tr>
            )}
            {data.sections.length === 0 && data.unchangedSections === 0 && (
              <tr><td style={td} colSpan={3}>Nothing to compare yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {error && <div className="card" style={{ borderColor: "var(--signal)", background: "var(--signal-bg)", color: "var(--signal)", padding: 12, marginBottom: 16, fontWeight: 600, fontSize: 12.5 }}>{error}</div>}

      {withdrawing && current && (
        <WithdrawDialog
          configId={current.id}
          onClose={() => setWithdrawing(false)}
          onDone={(r) => { setWithdrawing(false); setWithdrawn(r); refetch(); }}
        />
      )}

      <div style={{ display: "flex", gap: 10 }}>
        <Link to="/board" className="btn" style={{ textDecoration: "none" }}>Back to Draft Board</Link>
        <button className="btn btn-primary" onClick={publish} disabled={busy || data.draftCount === 0}>
          {busy
            ? "Publishing…"
            : `Confirm & Publish ${shown ? `Draft #${shown.draftNo} ` : ""}as v${data.nextVersion}`}
        </button>
        {data.draftCount === 0 && (
          <span style={{ alignSelf: "center", fontSize: 12, color: "var(--ink-faint)" }}>
            Nothing to publish — this draft holds no lessons.
          </span>
        )}
      </div>
    </div>
  );
}

// ───────────────────────────────────────────── §3.14 withdrawing a version

interface UnpublishPreview {
  slotCount: number;
  version: number | null;
  publishedAt: string | null;
  into: { kind: "existing" | "new"; draftNo: number | null; label: string | null };
  substitutions: number;
  extras: number;
}
interface Withdrawal {
  slotCount: number;
  version: number | null;
  draftNo: number;
  reused: boolean;
  substitutions: number;
}

/**
 * §3.14 — take the published timetable off the wall, back into a draft.
 *
 * The lifecycle had no way back: a school could publish, and publish again, and
 * that was all. Two other screens told them otherwise — §27.11's allocation
 * reset and §27.15's cell delete both refuse published work with "unpublish it
 * first", which was advice about a button that did not exist.
 *
 * It asks the server what withdrawing would do before offering to do it,
 * because the three facts a person needs are all things only the server knows:
 * how many lessons come down, which draft they land in, and what happens to the
 * substitutions recorded against them. A confirmation that cannot answer those
 * is just a second OK button.
 */
function WithdrawDialog({ configId, onClose, onDone }: {
  configId: number;
  onClose: () => void;
  onDone: (r: Withdrawal) => void;
}) {
  const [plan, setPlan] = useState<UnpublishPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api<UnpublishPreview>(`/timetable-configs/${configId}/board/publish/unpublish-preview`)
      .then((p) => { if (live) setPlan(p); })
      .catch((e) => { if (live) setError(msgOf(e)); });
    return () => { live = false; };
  }, [configId]);

  const run = async () => {
    setBusy(true); setError(null);
    try {
      onDone(await api<Withdrawal>(`/timetable-configs/${configId}/board/publish/unpublish`, { method: "POST" }));
    } catch (e) {
      setError(msgOf(e));
      setBusy(false);
    }
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Withdraw the published timetable"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 500, background: "rgba(11,31,68,.45)",
        display: "grid", placeItems: "center", padding: 18,
      }}>
      <div className="card" style={{ width: "min(500px,100%)", maxHeight: "90vh", overflow: "auto", padding: 0 }}>
        <div style={{ padding: "15px 18px 12px", borderBottom: "1px solid var(--line)", display: "flex", gap: 10 }}>
          <span aria-hidden style={{
            width: 34, height: 34, borderRadius: 9, display: "grid", placeItems: "center", flexShrink: 0,
            background: "var(--signal-bg)", color: "var(--signal)", fontSize: 17,
          }}>⚠</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ font: "700 15px/1.25 Inter" }}>
              Withdraw {plan?.version ? `v${plan.version}` : "the published timetable"}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--ink-faint)", marginTop: 3 }}>
              {plan ? `${plan.slotCount} lessons are live right now` : "Working out what this would do…"}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close"
            style={{ border: "none", background: "none", cursor: "pointer", fontSize: 16, color: "var(--ink-faint)" }}>✕</button>
        </div>

        <div style={{ padding: "15px 18px", display: "flex", flexDirection: "column", gap: 12, fontSize: 12.7, lineHeight: 1.6 }}>
          {error && (
            <div style={{
              borderLeft: "3px solid var(--signal)", background: "var(--signal-bg)", padding: "9px 12px",
              borderRadius: "0 8px 8px 0", color: "var(--ink-soft)",
            }}>{error}</div>
          )}

          {plan && (
            <>
              <p style={{ margin: 0, color: "var(--ink-soft)" }}>
                <strong style={{ color: "var(--ink)" }}>Every teacher and class-section stops seeing a
                timetable</strong> until this is published again. My Timetable, My Classes, the Matrix and
                the printed grids all go empty for this wing.
              </p>
              <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 5, color: "var(--ink-soft)" }}>
                <li>
                  The {plan.slotCount} lessons move into{" "}
                  <strong style={{ color: "var(--ink)" }}>
                    {plan.into.kind === "existing" ? `Draft #${plan.into.draftNo}` : "a new draft"}
                  </strong>
                  {plan.into.kind === "existing"
                    ? ", the draft they were published from — the same rows, unchanged"
                    : ", because the draft they came from is no longer empty"}.
                </li>
                {/* Named because it is the surprising one, and because it is
                    what makes this reversible rather than destructive. */}
                {plan.substitutions > 0 && (
                  <li>
                    {plan.substitutions} recorded substitution{plan.substitutions === 1 ? " is" : "s are"} kept.
                    They disappear from the Substitute Center while this is a draft, and line up again the
                    moment you publish.
                  </li>
                )}
                {plan.extras > 0 && (
                  <li>{plan.extras} extra/guest class{plan.extras === 1 ? "" : "es"} stay exactly as they are (§18).</li>
                )}
                <li>Your other drafts are untouched.</li>
              </ul>
              <p style={{ margin: 0, color: "var(--ink-faint)", fontSize: 12 }}>
                {/* The reason this is not framed as a deletion: nothing is lost,
                    and pressing Publish puts the same rows back. */}
                Nothing is deleted. Publishing this draft again restores exactly what is on the wall today
                {plan.version ? `, as v${plan.version + 1}` : ""}.
              </p>
            </>
          )}
        </div>

        <div style={{
          padding: "12px 18px", borderTop: "1px solid var(--line)", background: "var(--offwhite)",
          display: "flex", gap: 9, alignItems: "center",
        }}>
          <button className="btn" onClick={onClose}>Leave it published</button>
          <span style={{ flex: 1 }} />
          <button className="btn" disabled={busy || !plan || plan.slotCount === 0}
            onClick={() => void run()}
            style={{ background: "var(--signal)", borderColor: "var(--signal)", color: "#fff" }}>
            {busy ? "Withdrawing…" : "Withdraw it"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The server's own sentence, not "500: {…}". */
function msgOf(e: unknown): string {
  const raw = (e as Error).message.replace(/^\d+: /, "");
  try { return JSON.parse(raw).message ?? raw; } catch { return raw; }
}

const th: React.CSSProperties = { textAlign: "left", padding: "9px 14px", fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--ink-faint)" };
const td: React.CSSProperties = { padding: "9px 14px", verticalAlign: "top" };

/**
 * §24.7 Phase 25.6f — the moment a login is worth having.
 *
 * Publishing is the first point at which there is anything for a teacher to
 * look at, so it is the honest place to ask. Before it, an invitation lands
 * somebody in an empty app.
 *
 * It asks the SERVER rather than guessing, and it asks with the dry run the
 * Users & Access screen uses — so this card and that screen cannot disagree
 * about who is missing a login. Anything other than a usable answer renders
 * nothing at all: a teacher reaching this screen gets a 403, an ERP school gets
 * a 403 (its people come from the ERP), a school where everyone already has a
 * login gets an empty list. Silence is right in all three, and none of them is
 * an error worth putting in front of somebody who has just published.
 */
function InviteTeachersPrompt() {
  const [names, setNames] = useState<string[] | null>(null);
  const [sent, setSent] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ wouldInvite?: string[] }>("/users/invite-teachers", {
      method: "POST",
      body: JSON.stringify({ dryRun: true }),
    })
      .then((r) => setNames(r.wouldInvite ?? []))
      .catch(() => setNames([])); // not allowed, or an ERP school — say nothing
  }, []);

  if (sent !== null) {
    return (
      <p style={{ fontSize: 12.5, color: "var(--ink-soft)", marginTop: 18 }}>
        {sent} invitation{sent === 1 ? "" : "s"} sent. They can sign in and see their own timetable.
      </p>
    );
  }
  if (!names || names.length === 0) return null;

  return (
    <div style={{
      marginTop: 22, textAlign: "left", borderLeft: "3px solid var(--brand)",
      background: "var(--steel-pale)", padding: "14px 16px", borderRadius: "0 9px 9px 0",
    }}>
      <strong style={{ fontSize: 13.5, display: "block", marginBottom: 3 }}>
        {names.length} teacher{names.length === 1 ? " has" : "s have"} no login yet
      </strong>
      <p style={{ fontSize: 12.5, color: "var(--ink-soft)", margin: "0 0 10px" }}>
        {names.slice(0, 6).join(", ")}{names.length > 6 ? `, and ${names.length - 6} more` : ""}.
        {" "}They cannot see the timetable you have just published until they can sign in.
      </p>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button className="btn btn-primary" style={{ fontSize: 12.5 }} disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await api<{ invited?: string[] }>("/users/invite-teachers", {
                method: "POST", body: JSON.stringify({}),
              });
              setSent((r.invited ?? []).length);
            } catch {
              // The screen that owns this can say why properly; a publish
              // confirmation is the wrong place to explain a mail failure.
              setNames([]);
            } finally {
              setBusy(false);
            }
          }}>
          {busy ? "Sending…" : `Invite ${names.length === 1 ? "them" : "all of them"}`}
        </button>
        <Link to="/users" style={{ fontSize: 12.5 }}>Choose individually on Users &amp; Access →</Link>
      </div>
    </div>
  );
}
