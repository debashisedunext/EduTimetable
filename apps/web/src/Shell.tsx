import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { io } from "socket.io-client";
import { PERMISSIONS, type MeResponse, type Permission } from "@edutimetable/shared";
import { api, clearToken, getToken } from "./api";
import { useConfigCtx } from "./hooks";

interface NavEntry {
  label: string;
  to: string;
  requires?: Permission;
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
    label: "Administration",
    items: [{ label: "Roles & Access", to: "/roles", requires: PERMISSIONS.ROLES_MANAGE }],
  },
  {
    label: "System",
    items: [{ label: "Status & Jobs", to: "/system" }],
  },
  // Manage / My Timetable / Intelligence / Reference groups arrive with Phases 2-7.
];

const TITLES: Record<string, [string, string]> = {
  "/": ["Build", "Timetables"],
  "/setup": ["Build", "Setup Wizard"],
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
      (i) => (!i.requires || held.has(i.requires)) && (!i.requiresTeacher || me.teacherId !== null),
    ),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <span /><span /><span /><span />
          </div>
          <div>
            <div className="brand-name">Timetable AI</div>
            <div className="brand-sub">Edunext ERP</div>
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
