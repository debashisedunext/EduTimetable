/**
 * §24.8 Phase 25.6c — Users & Access.
 *
 * Who may sign in to this school, and as what. List-first, form-second, like
 * every other master screen — but the thing being listed is not master data,
 * and the screen says so in the one place it matters: the **state** column.
 * "Invited but never accepted" looks exactly like "active" in a list of names,
 * and it is the commonest thing an administrator actually needs to see.
 *
 * For an ERP school the whole screen is read-only behind a banner. The server
 * refuses independently — hiding a button is cosmetic (§15) — so this is an
 * explanation, not a control.
 */
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { asMessage, Card } from "../components";

interface Row {
  id: number;
  name: string;
  email: string;
  roleId: number;
  roleName: string;
  isActive: boolean;
  teacher: { id: number; name: string; employeeCode: string } | null;
  lastLoginAt: string | null;
  isLocal: boolean;
  state: "active" | "invited" | "deactivated" | "sso";
}

interface Role { id: number; name: string }
interface Teacher { id: number; name: string; employeeCode: string; employmentType?: string }

interface BulkSummary {
  invited: string[];
  alreadyHaveALogin: string[];
  noEmailAddress: string[];
  guestTeachers: string[];
  notInThisWing?: string[];
  role: string;
  wouldInvite: string[];
}

const STATE_STYLE: Record<Row["state"], { label: string; bg: string; fg: string; title: string }> = {
  active: { label: "Active", bg: "var(--accent-bg)", fg: "var(--accent)", title: "Has signed in" },
  invited: {
    label: "Invited", bg: "var(--amber-bg)", fg: "var(--amber)",
    title: "Invitation sent, not accepted yet — they cannot sign in until they do",
  },
  deactivated: {
    label: "Deactivated", bg: "var(--offwhite)", fg: "var(--ink-faint)",
    title: "Kept so the audit log still resolves their name, but they cannot sign in",
  },
  sso: { label: "ERP", bg: "var(--steel-pale)", fg: "var(--brand)", title: "Signs in through the ERP" },
};

export function Users() {
  const [rows, setRows] = useState<Row[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [school, setSchool] = useState<{ origin?: string; name?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [bulk, setBulk] = useState<BulkSummary | null>(null);
  const [form, setForm] = useState({ email: "", name: "", roleId: 0, teacherId: 0 });

  const erp = school?.origin === "erp";

  const load = async () => {
    try {
      const [u, r, t, s] = await Promise.all([
        api<Row[]>("/users"),
        // Roles come from the Roles screen's own overview — there is no
        // `GET /admin/roles`, and a second endpoint returning the same list
        // is a second thing to keep in step.
        api<{ roles: Role[] }>("/admin/overview").then((o) => o.roles),
        api<Teacher[]>("/teachers").catch(() => [] as Teacher[]),
        api<{ origin?: string; name?: string }>("/school").catch(() => ({})),
      ]);
      setRows(u);
      setRoles(r);
      setTeachers(t);
      setSchool(s);
      if (!form.roleId && r.length) {
        setForm((f) => ({ ...f, roleId: r.find((x) => x.name === "Teacher")?.id ?? r[0].id }));
      }
    } catch (e) {
      setError(asMessage(e));
    }
  };

  useEffect(() => { void load(); }, []);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true); setError(null); setNotice(null);
    try {
      await fn();
      if (ok) setNotice(ok);
      await load();
    } catch (e) {
      setError(asMessage(e));
    } finally {
      setBusy(false);
    }
  };

  /** Teachers with no login yet — what the bulk invite is for. */
  const withoutLogin = useMemo(() => {
    const taken = new Set(rows.map((r) => r.teacher?.id).filter(Boolean));
    const emails = new Set(rows.map((r) => r.email.toLowerCase()));
    return teachers.filter((t) => !taken.has(t.id) && !emails.has((t as { email?: string }).email?.toLowerCase() ?? ""));
  }, [rows, teachers]);

  return (
    <div>
      <h2 className="screen-title">Users &amp; Access</h2>
      <p className="screen-sub">
        Who can sign in to this school, and what they can do once they are in.
      </p>

      {erp && (
        <Card>
          <div style={{
            borderLeft: "3px solid var(--brand)", background: "var(--steel-pale)",
            padding: "12px 14px", borderRadius: "0 9px 9px 0", fontSize: 13, color: "var(--ink-soft)",
          }}>
            <strong>{school?.name} signs in through your ERP.</strong> People are added there and
            appear here the first time they sign in — so this screen is read-only. Changing a role or
            adding a login here would be overwritten on their next sign-in, or would survive as a
            second way in that your ERP cannot revoke.
          </div>
        </Card>
      )}

      {error && (
        <Card>
          <div style={{
            borderLeft: "3px solid var(--signal)", background: "var(--signal-bg)",
            padding: "11px 13px", borderRadius: "0 8px 8px 0", fontSize: 12.8, color: "var(--ink-soft)",
          }}>{error}</div>
        </Card>
      )}
      {notice && (
        <Card>
          <div style={{
            borderLeft: "3px solid var(--accent)", background: "var(--accent-bg)",
            padding: "11px 13px", borderRadius: "0 8px 8px 0", fontSize: 12.8, color: "var(--ink-soft)",
          }}>{notice}</div>
        </Card>
      )}

      <Card
        title={`${rows.filter((r) => r.isActive).length} active`}
        actions={!erp && (
          <div style={{ display: "flex", gap: 8 }}>
            {withoutLogin.length > 0 && (
              <button className="btn" disabled={busy}
                onClick={() => act(async () => {
                  setBulk(await api<BulkSummary>("/users/invite-teachers", {
                    method: "POST", body: JSON.stringify({ dryRun: true }),
                  }));
                })}>
                Invite teachers ({withoutLogin.length})
              </button>
            )}
            <button className="btn btn-primary" onClick={() => setAdding((a) => !a)} disabled={busy}>
              {adding ? "Cancel" : "+ Invite somebody"}
            </button>
          </div>
        )}
      >
        <div style={{ overflowX: "auto" }}>
          <table className="table" style={{ width: "100%", fontSize: 13 }}>
            <thead><tr>
              <th>Name</th><th>Email</th><th>Role</th><th>Teacher</th>
              <th>State</th><th>Last signed in</th><th />
            </tr></thead>
            <tbody>
              {rows.map((u) => {
                const s = STATE_STYLE[u.state];
                return (
                  <tr key={u.id} style={{ opacity: u.isActive ? 1 : 0.6 }}>
                    <td>{u.name}</td>
                    <td style={{ color: "var(--ink-soft)" }}>{u.email}</td>
                    <td>
                      {erp || !u.isLocal ? u.roleName : (
                        <select value={u.roleId} disabled={busy} className="input" style={{ fontSize: 12.5, padding: "4px 6px" }}
                          aria-label={`Role for ${u.name}`}
                          onChange={(e) => act(() => api(`/admin/users/${u.id}`, {
                            method: "PUT", body: JSON.stringify({ roleId: Number(e.target.value) }),
                          }), `${u.name}'s role updated.`)}>
                          {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                        </select>
                      )}
                    </td>
                    <td>
                      {erp || !u.isLocal ? (u.teacher?.name ?? "—") : (
                        <select value={u.teacher?.id ?? 0} disabled={busy} className="input"
                          style={{ fontSize: 12.5, padding: "4px 6px", maxWidth: 190 }}
                          aria-label={`Teacher linked to ${u.name}`}
                          onChange={(e) => act(() => api(`/admin/users/${u.id}`, {
                            method: "PUT", body: JSON.stringify({ teacherId: Number(e.target.value) || null }),
                          }), `${u.name}'s teacher link updated.`)}>
                          <option value={0}>— not a teacher —</option>
                          {teachers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                        </select>
                      )}
                    </td>
                    <td>
                      <span title={s.title} style={{
                        font: "600 10.5px/1 Inter", textTransform: "uppercase", letterSpacing: "0.05em",
                        padding: "4px 8px", borderRadius: 20, background: s.bg, color: s.fg,
                      }}>{s.label}</span>
                    </td>
                    <td style={{ color: "var(--ink-faint)", fontSize: 12 }}>
                      {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString() : "never"}
                    </td>
                    <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
                      {!erp && u.isLocal && (
                        <>
                          {u.state === "invited" && (
                            <button className="btn" style={{ fontSize: 11.5, padding: "3px 8px" }} disabled={busy}
                              onClick={() => act(() => api(`/users/${u.id}/resend`, { method: "POST" }),
                                `A fresh invitation is on its way to ${u.email}.`)}>
                              Resend
                            </button>
                          )}
                          <button className="btn" style={{ fontSize: 11.5, padding: "3px 8px", marginLeft: 6 }} disabled={busy}
                            onClick={() => act(() => api(`/users/${u.id}/${u.isActive ? "deactivate" : "reactivate"}`,
                              { method: "POST" }), `${u.name} ${u.isActive ? "can no longer sign in" : "can sign in again"}.`)}>
                            {u.isActive ? "Deactivate" : "Reactivate"}
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr><td colSpan={7} style={{ color: "var(--ink-faint)", fontSize: 12.5 }}>Nobody yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <p style={{ fontSize: 11.5, color: "var(--ink-faint)", margin: "10px 0 0" }}>
          Logins are <strong>deactivated, never deleted</strong> — a person named in the audit log has
          to stay resolvable.
        </p>
      </Card>

      {adding && !erp && (
        <Card title="Invite somebody">
          <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))" }}>
            <label style={{ fontSize: 12.5 }}>
              Name
              <input className="input" value={form.name} placeholder="e.g. Rekha Devi"
                onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <label style={{ fontSize: 12.5 }}>
              Email
              <input className="input" type="email" value={form.email} placeholder="rekha@school.edu"
                onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </label>
            <label style={{ fontSize: 12.5 }}>
              Role
              <select className="input" value={form.roleId}
                onChange={(e) => setForm({ ...form, roleId: Number(e.target.value) })}>
                {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </label>
            <label style={{ fontSize: 12.5 }}>
              Teacher (optional)
              <select className="input" value={form.teacherId}
                onChange={(e) => setForm({ ...form, teacherId: Number(e.target.value) })}>
                <option value={0}>— not a teacher —</option>
                {teachers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
          </div>
          <p style={{ fontSize: 11.8, color: "var(--ink-faint)", margin: "10px 0 0" }}>
            Linking a teacher is what makes “my timetable” theirs. Without it they see the school's
            grids according to their role, but nothing of their own.
          </p>
          <button className="btn btn-primary" style={{ marginTop: 12 }} disabled={busy || !form.email || !form.name}
            onClick={() => act(async () => {
              await api("/users/invite", { method: "POST", body: JSON.stringify(form) });
              setAdding(false);
              setForm({ ...form, email: "", name: "", teacherId: 0 });
            }, `An invitation is on its way to ${form.email}.`)}>
            Send the invitation
          </button>
        </Card>
      )}

      {bulk && !erp && (
        <Card title="Invite the teachers who have no login">
          {/* The preview and the write run the SAME arithmetic server-side, so
              the confirmation cannot describe something different from what
              happens when the button is pressed. */}
          <Group label={`Will be invited as ${bulk.role}`} names={bulk.wouldInvite} tone="ok" />
          <Group label="Already have a login" names={bulk.alreadyHaveALogin} />
          <Group
            label="No email address — add one on the Teachers screen"
            names={bulk.noEmailAddress}
            tone={bulk.noEmailAddress.length ? "warn" : undefined}
          />
          <Group
            label="Guest teachers, deliberately excluded — they are not on the regular timetable"
            names={bulk.guestTeachers}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <button className="btn btn-primary" disabled={busy || bulk.wouldInvite.length === 0}
              onClick={() => act(async () => {
                const r = await api<BulkSummary>("/users/invite-teachers", {
                  method: "POST", body: JSON.stringify({}),
                });
                setBulk(null);
                setNotice(`${r.invited.length} invitation${r.invited.length === 1 ? "" : "s"} sent.`);
              })}>
              Send {bulk.wouldInvite.length} invitation{bulk.wouldInvite.length === 1 ? "" : "s"}
            </button>
            <button className="btn" onClick={() => setBulk(null)} disabled={busy}>Cancel</button>
          </div>
        </Card>
      )}
    </div>
  );
}

function Group({ label, names, tone }: { label: string; names: string[]; tone?: "ok" | "warn" }) {
  if (names.length === 0) return null;
  const fg = tone === "ok" ? "var(--accent)" : tone === "warn" ? "var(--amber)" : "var(--ink-faint)";
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{
        font: "600 10.5px/1.3 Inter", textTransform: "uppercase", letterSpacing: "0.06em",
        color: fg, marginBottom: 3,
      }}>{label} ({names.length})</div>
      <div style={{ fontSize: 12.5, color: "var(--ink-soft)", lineHeight: 1.5 }}>{names.join(", ")}</div>
    </div>
  );
}
