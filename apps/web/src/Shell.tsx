import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { io } from "socket.io-client";
import { PERMISSIONS, type MeResponse, type Permission } from "@edutimetable/shared";
import { api, clearToken, getToken, switchSchool } from "./api";
import { useConfigCtx } from "./hooks";

interface NavEntry {
  label: string;
  to: string;
  requires?: Permission;
  /** platform administration sits above every school, so it is not a school
   *  permission — see §17.6 */
  requiresPlatform?: boolean;
  /** personal views only make sense for a login linked to a teacher record */
  requiresTeacher?: boolean;
}
interface NavGroup {
  label: string;
  items: NavEntry[];
}

/** Nav mirrors the mockup's groups; entries render only when the role holds the
 *  permission — cosmetic convenience, the server guard is the authority (§15.3). */
const NAV: NavGroup[] = [
  {
    label: "Build",
    items: [
      { label: "Timetables", to: "/", requires: PERMISSIONS.MASTERS_MANAGE },
      { label: "Setup Wizard", to: "/setup", requires: PERMISSIONS.MASTERS_MANAGE },
      { label: "Import from Excel", to: "/import", requires: PERMISSIONS.MASTERS_MANAGE },
      { label: "Readiness", to: "/readiness", requires: PERMISSIONS.TIMETABLE_GENERATE },
      { label: "Generate", to: "/generate", requires: PERMISSIONS.TIMETABLE_GENERATE },
    ],
  },
  {
    label: "Manage",
    items: [
      { label: "Allocation Matrix", to: "/matrix", requires: PERMISSIONS.TIMETABLE_VIEW_ALL },
      { label: "Draft Board", to: "/board", requires: PERMISSIONS.TIMETABLE_EDIT },
      { label: "Publish", to: "/publish", requires: PERMISSIONS.TIMETABLE_PUBLISH },
      { label: "Substitute Center", to: "/substitutes", requires: PERMISSIONS.SUBSTITUTE_MANAGE },
      { label: "Extra & Guest Classes", to: "/extra-classes", requires: PERMISSIONS.TIMETABLE_EDIT },
    ],
  },
  {
    label: "My Timetable",
    items: [
      { label: "My Timetable", to: "/my-timetable", requires: PERMISSIONS.TIMETABLE_VIEW_OWN, requiresTeacher: true },
      { label: "My Classes", to: "/my-classes", requires: PERMISSIONS.TIMETABLE_VIEW_CLASS, requiresTeacher: true },
    ],
  },
  {
    label: "Reference",
    items: [
      { label: "Reports", to: "/reports", requires: PERMISSIONS.REPORTS_VIEW },
      { label: "Notifications", to: "/notifications", requires: PERMISSIONS.NOTIFICATIONS_VIEW },
    ],
  },
  {
    label: "Intelligence",
    items: [
      { label: "Ask AI", to: "/ask-ai", requires: PERMISSIONS.AI_CHAT },
      { label: "AI Settings", to: "/ai-settings", requires: PERMISSIONS.AI_CONFIGURE },
    ],
  },
  {
    label: "Administration",
    items: [
      { label: "School Profile", to: "/school", requires: PERMISSIONS.MASTERS_MANAGE },
      { label: "Roles & Access", to: "/roles", requires: PERMISSIONS.ROLES_MANAGE },
    ],
  },
  {
    label: "System",
    items: [
      { label: "Status & Jobs", to: "/system" },
      { label: "Platform Console", to: "/platform", requiresPlatform: true },
    ],
  },
  // Manage / My Timetable / Intelligence / Reference groups arrive with Phases 2-7.
];

const TITLES: Record<string, [string, string]> = {
  "/": ["Build", "Timetables"],
  "/setup": ["Build", "Setup Wizard"],
  "/import": ["Build", "Import Master Data"],
  "/readiness": ["Build", "Readiness Dashboard"],
  "/generate": ["Build", "Generate Timetable"],
  "/matrix": ["Manage", "Full Allocation Matrix"],
  "/board": ["Manage", "Draft Board"],
  "/publish": ["Manage", "Publish Confirmation"],
  "/substitutes": ["Manage", "Substitute Teacher Center"],
  "/reports": ["Reference", "Reports"],
  "/notifications": ["Reference", "Notification Center"],
  "/my-timetable": ["My Timetable", "My Weekly Timetable"],
  "/my-classes": ["My Timetable", "My Classes"],
  "/ask-ai": ["Intelligence", "Ask AI"],
  "/ai-settings": ["Intelligence", "AI Settings"],
  "/school": ["Administration", "School Profile"],
  "/platform": ["System", "Platform Console"],
  "/roles": ["Administration", "Roles & Access"],
  "/system": ["System", "Status & Jobs"],
};

/** §9 in-app channel: live unread badge, incremented over Socket.IO. */
function Bell() {
  const { pathname } = useLocation();
  const [count, setCount] = useState(0);
  useEffect(() => {
    const load = () => api<{ count: number }>("/notifications/unread-count").then((r) => setCount(r.count)).catch(() => {});
    load();
    const socket = io({ auth: { token: getToken() } });
    socket.on("notification:new", load);
    return () => { socket.disconnect(); };
  }, [pathname]);
  return (
    <Link to="/notifications" title="Notifications" style={{ position: "relative", textDecoration: "none", fontSize: 18, lineHeight: 1 }}>
      🔔
      {count > 0 && (
        <span style={{
          position: "absolute", top: -6, right: -9, background: "var(--signal)", color: "#fff",
          borderRadius: 9, fontSize: 9.5, fontWeight: 800, padding: "1.5px 5px", minWidth: 16, textAlign: "center",
        }}>
          {count > 99 ? "99+" : count}
        </span>
      )}
    </Link>
  );
}


/**
 * A school's identity for the UI. Tenant id when there is one, because school
 * ids repeat across databases; the school id otherwise (§17.5).
 */
const schoolKey = (s: { id: number; tenantId: number | null }) =>
  s.tenantId != null ? `t${s.tenantId}` : `s${s.id}`;

/**
 * Which school this session is in (§17.4).
 *
 * The name is never hardcoded here — it comes from the ERP on the SSO token and
 * is refreshed on every login, so renaming a school in the ERP renames it here.
 * The dropdown appears only when the ERP granted more than one school; a
 * single-school user just sees the name, and a trust administrator can move
 * between their schools without going back to the ERP menu.
 */
function SchoolPicker({ me }: { me: MeResponse }) {
  const [busy, setBusy] = useState(false);
  const many = me.schools.length > 1;

  const change = async (key: string) => {
    const target = me.schools.find((s) => schoolKey(s) === key);
    if (!target || schoolKey(target) === schoolKey(me.school)) return;
    setBusy(true);
    try {
      await switchSchool(target);
      // Everything on screen belongs to the school that was active when it was
      // fetched, so replace all of it at once rather than patching pieces.
      window.location.href = "/";
    } catch {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
      <span style={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--ink-faint)", fontWeight: 700, marginBottom: 2 }}>
        {me.trust ? me.trust.name : "School"}
      </span>
      {many ? (
        <select
          value={schoolKey(me.school)}
          disabled={busy}
          onChange={(e) => change(e.target.value)}
          title="Switch school"
          style={{ fontWeight: 700, fontSize: 13, color: "var(--brand-deep)", border: "1px solid var(--line)", background: "#fff", borderRadius: 7, padding: "5px 9px", maxWidth: 220 }}
        >
          {me.schools.map((s) => (
            <option key={schoolKey(s)} value={schoolKey(s)}>{s.name}</option>
          ))}
        </select>
      ) : (
        <span style={{ display: "flex", alignItems: "center", gap: 7, fontWeight: 700, fontSize: 13, color: "var(--brand-deep)", padding: "5px 0" }}>
          {me.school.logoUrl && (
            <img
              src={me.school.logoUrl}
              alt=""
              style={{ width: 18, height: 18, objectFit: "contain", borderRadius: 4 }}
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
            />
          )}
          {me.school.name}
        </span>
      )}
    </div>
  );
}

function Topbar({ me }: { me: MeResponse }) {
  const { pathname } = useLocation();
  const { configs, current, setCurrentId } = useConfigCtx();
  const [eyebrow, title] = TITLES[pathname] ?? ["", "Timetable AI"];
  return (
    <div className="topbar">
      <div>
        <div className="topbar-eyebrow">{eyebrow}</div>
        <div className="topbar-title">{title}</div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <SchoolPicker me={me} />
        {configs.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
            <span style={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--ink-faint)", fontWeight: 700, marginBottom: 2 }}>
              Viewing timetable
            </span>
            <select
              value={current?.id ?? ""}
              onChange={(e) => setCurrentId(Number(e.target.value))}
              style={{ fontWeight: 700, fontSize: 13, color: "var(--brand)", border: "1px solid var(--steel-pale)", background: "var(--steel-pale)", borderRadius: 7, padding: "5px 9px" }}
            >
              {configs.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
        )}
        {me.permissions.includes(PERMISSIONS.NOTIFICATIONS_VIEW) && <Bell />}
        <span className="badge badge-ok">● Live</span>
      </div>
    </div>
  );
}

export function Shell({ me }: { me: MeResponse }) {
  const held = new Set(me.permissions);
  const groups = NAV.map((g) => ({
    ...g,
    items: g.items.filter(
      (i) =>
        (!i.requires || held.has(i.requires)) &&
        (!i.requiresTeacher || me.teacherId !== null) &&
        (!i.requiresPlatform || me.platformAdmin),
    ),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">
          {/* The school's own logo when it has one (§17.4), falling back to the
              product mark. `onError` hides a URL the browser cannot reach so a
              broken image never sits in the sidebar. */}
          {me.school.logoUrl ? (
            <img
              src={me.school.logoUrl}
              alt=""
              className="brand-logo"
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
            />
          ) : (
            <div className="brand-mark">
              <span /><span /><span /><span />
            </div>
          )}
          <div style={{ minWidth: 0 }}>
            <div className="brand-name">Timetable AI</div>
            <div className="brand-sub" title={me.school.name}>
              {me.school.shortName || me.school.name}
            </div>
          </div>
        </div>
        <div className="sidebar-nav">
          {groups.map((g) => (
            <div key={g.label}>
              <div className="nav-group-label">{g.label}</div>
              {g.items.map((i) => (
                <NavLink
                  key={i.to}
                  to={i.to}
                  className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}
                >
                  {i.label}
                </NavLink>
              ))}
            </div>
          ))}
        </div>
        <div className="sidebar-foot">
          <div className="who">
            <div className="avatar">
              {me.name.split(" ").map((p) => p[0]).slice(0, 2).join("")}
            </div>
            <div>
              <div className="who-name">{me.name}</div>
              <div className="who-role">{me.role}</div>
            </div>
          </div>
          <button
            className="logout-btn"
            onClick={() => {
              clearToken();
              window.location.href = "/";
            }}
          >
            Sign out (back to ERP)
          </button>
        </div>
      </nav>
      <div className="main">
        <Topbar me={me} />
        <div className="content">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
