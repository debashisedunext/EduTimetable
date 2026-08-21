import { useState } from "react";
import { PERMISSIONS, type Permission } from "@edutimetable/shared";
import { api } from "../api";
import { Card, DataTable, ErrorNote } from "../components";
import { useApi } from "../hooks";

interface Overview {
  allPermissions: Permission[];
  roles: { id: number; name: string; isSystem: boolean; permissions: string[] }[];
  erpMappings: { id: number; erpRole: string; roleId: number; roleName: string }[];
  users: {
    id: number; name: string; email: string; roleId: number; roleName: string;
    roleOverridden: boolean; teacherId: number | null; teacherName: string | null; teacherLinked: boolean;
  }[];
  audit: { id: string; action: string; detail: unknown; createdAt: string }[];
}

const GROUPS: { label: string; perms: Permission[] }[] = [
  { label: "Timetable visibility (row-level scope)", perms: [PERMISSIONS.TIMETABLE_VIEW_ALL, PERMISSIONS.TIMETABLE_VIEW_CLASS, PERMISSIONS.TIMETABLE_VIEW_OWN] },
  { label: "Build & Manage", perms: [PERMISSIONS.MASTERS_MANAGE, PERMISSIONS.TIMETABLE_GENERATE, PERMISSIONS.TIMETABLE_EDIT, PERMISSIONS.TIMETABLE_PUBLISH, PERMISSIONS.SUBSTITUTE_MANAGE] },
  { label: "Reports & AI", perms: [PERMISSIONS.REPORTS_VIEW, PERMISSIONS.REPORTS_EXPORT, PERMISSIONS.NOTIFICATIONS_VIEW, PERMISSIONS.AI_CHAT, PERMISSIONS.AI_REPORTS] },
  { label: "Administration", perms: [PERMISSIONS.ROLES_MANAGE, PERMISSIONS.AI_CONFIGURE] },
];

/** §15.4 — Roles & Responsibility page. Server enforces; this edits the registry. */
export function Roles() {
  const { data, refetch } = useApi<Overview>("/admin/overview");
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState<Record<number, Set<string>>>({});

  if (!data) return <p className="screen-sub">Loading roles…</p>;

  const held = (roleId: number): Set<string> =>
    dirty[roleId] ?? new Set(data.roles.find((r) => r.id === roleId)?.permissions ?? []);

  const toggle = (roleId: number, perm: string) => {
    const s = new Set(held(roleId));
    if (s.has(perm)) s.delete(perm);
    else s.add(perm);
    setDirty((d) => ({ ...d, [roleId]: s }));
  };

  const save = async () => {
    setError(null);
    try {
      for (const [roleId, perms] of Object.entries(dirty)) {
        await api(`/admin/roles/${roleId}/permissions`, {
          method: "PUT",
          body: JSON.stringify({ permissions: [...perms] }),
        });
      }
      setDirty({});
      refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const superAdmin = data.roles.find((r) => r.name === "Super Admin");

  return (
    <div style={{ maxWidth: 980 }}>
      <div style={{ background: "var(--brand-deep)", color: "var(--steel-light)", borderRadius: 10, padding: "12px 16px", fontSize: 12.5, marginBottom: 18 }}>
        🔒 Users sign in through the <b style={{ color: "#fff" }}>Edunext ERP → Timetable menu (SSO)</b> — this app has no login of its own.
        Changes here are audit-logged and enforced server-side on the next request.
      </div>
      <ErrorNote message={error} />

      <Card
        title="Permission Matrix"
        sub="What each role can do. Super Admin is fixed; everything else is editable."
        actions={
          <button className="btn btn-primary" onClick={save} disabled={Object.keys(dirty).length === 0}>
            Save changes
          </button>
        }
      >
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: "8px 10px", fontSize: 10.5, color: "var(--ink-faint)", textTransform: "uppercase" }}>Permission</th>
                {data.roles.map((r) => (
                  <th key={r.id} style={{ padding: "8px 10px", fontSize: 11, textAlign: "center" }}>{r.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {GROUPS.map((g) => (
                <GroupRows key={g.label} group={g} roles={data.roles} superAdminId={superAdmin?.id} held={held} toggle={toggle} />
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
        <Card title="ERP Role Mapping" sub="Incoming ERP roles get this timetable role on first SSO login.">
          <DataTable
            headers={["ERP Role", "Timetable Role"]}
            rows={data.erpMappings.map((m) => [
              <span className="chip mono" key="a">{m.erpRole}</span>,
              <select
                key="b"
                defaultValue={m.roleId}
                style={{ padding: "6px 9px", border: "1px solid var(--line)", borderRadius: 7 }}
                onChange={async (e) => {
                  try {
                    await api("/admin/erp-mappings", { method: "PUT", body: JSON.stringify({ erpRole: m.erpRole, roleId: Number(e.target.value) }) });
                    refetch();
                  } catch (err) {
                    setError(err instanceof Error ? err.message : String(err));
                  }
                }}
              >
                {data.roles.map((r) => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>,
            ])}
          />
        </Card>

        <Card title="Users & Overrides" sub="Role overrides win over the ERP mapping. Teacher link powers scoped views.">
          <DataTable
            headers={["User", "Role", "Teacher link"]}
            rows={data.users.map((u) => [
              <span key="a">{u.name}<br /><span style={{ fontSize: 11, color: "var(--ink-faint)" }}>{u.email}</span></span>,
              <select
                key="b"
                defaultValue={u.roleId}
                style={{ padding: "6px 9px", border: "1px solid var(--line)", borderRadius: 7 }}
                onChange={async (e) => {
                  try {
                    await api(`/admin/users/${u.id}`, { method: "PUT", body: JSON.stringify({ roleId: Number(e.target.value) }) });
                    refetch();
                  } catch (err) {
                    setError(err instanceof Error ? err.message : String(err));
                  }
                }}
              >
                {data.roles.map((r) => (
                  <option key={r.id} value={r.id}>{r.name}{u.roleOverridden && r.id === u.roleId ? " (override)" : ""}</option>
                ))}
              </select>,
              u.teacherId === null ? (
                <span key="c" className="badge" style={{ background: "var(--steel-pale)", color: "var(--steel)" }}>— staff —</span>
              ) : u.teacherLinked ? (
                <span key="c" className="badge badge-ok">✓ {u.teacherName}</span>
              ) : (
                <span key="c" className="badge badge-error">⚠ not linked</span>
              ),
            ])}
          />
        </Card>
      </div>

      <Card title="Recent Changes" sub="Audit log — who changed what, effective on next request.">
        <DataTable
          headers={["When", "Action", "Detail"]}
          rows={data.audit.map((a) => [
            new Date(a.createdAt).toLocaleString(),
            <span key="x" className="chip mono">{a.action}</span>,
            <span key="y" style={{ fontSize: 11.5, color: "var(--ink-soft)", fontFamily: "var(--font-mono)" }}>{JSON.stringify(a.detail)?.slice(0, 80)}</span>,
          ])}
          empty="No changes yet."
        />
      </Card>
    </div>
  );
}

function GroupRows({
  group, roles, superAdminId, held, toggle,
}: {
  group: { label: string; perms: Permission[] };
  roles: Overview["roles"];
  superAdminId?: number;
  held: (roleId: number) => Set<string>;
  toggle: (roleId: number, perm: string) => void;
}) {
  return (
    <>
      <tr>
        <td colSpan={roles.length + 1} style={{ background: "var(--offwhite)", padding: "6px 10px", fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--steel)", fontWeight: 700 }}>
          {group.label}
        </td>
      </tr>
      {group.perms.map((p) => (
        <tr key={p}>
          <td style={{ padding: "7px 10px", fontSize: 12.5, borderBottom: "1px solid var(--line)" }}>
            <span className="mono" style={{ fontSize: 11.5 }}>{p}</span>
          </td>
          {roles.map((r) => (
            <td key={r.id} style={{ textAlign: "center", borderBottom: "1px solid var(--line)" }}>
              <input
                type="checkbox"
                checked={held(r.id).has(p)}
                disabled={r.id === superAdminId}
                onChange={() => toggle(r.id, p)}
                style={{ width: 15, height: 15, accentColor: "var(--brand)" }}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
