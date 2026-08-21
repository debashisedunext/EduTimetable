import { NavLink, Outlet, useLocation } from "react-router-dom";
import { PERMISSIONS, type MeResponse, type Permission } from "@edutimetable/shared";
import { clearToken } from "./api";
import { useConfigCtx } from "./hooks";

interface NavEntry {
  label: string;
  to: string;
  requires?: Permission;
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
  "/roles": ["Administration", "Roles & Access"],
  "/system": ["System", "Status & Jobs"],
};

function Topbar() {
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
              style={{ fontWeight: 700, fontSize: 13, color: "var(--forest)", border: "1px solid var(--sage-pale)", background: "var(--sage-pale)", borderRadius: 7, padding: "5px 9px" }}
            >
              {configs.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
        )}
        <span className="badge badge-ok">● Live</span>
      </div>
    </div>
  );
}

export function Shell({ me }: { me: MeResponse }) {
  const held = new Set(me.permissions);
  const groups = NAV.map((g) => ({
    ...g,
    items: g.items.filter((i) => !i.requires || held.has(i.requires)),
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
        <Topbar />
        <div className="content">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
