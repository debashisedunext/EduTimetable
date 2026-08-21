import { NavLink, Outlet } from "react-router-dom";
import { PERMISSIONS, type MeResponse, type Permission } from "@edutimetable/shared";
import { clearToken } from "./api";

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
      { label: "Generate", to: "/generate", requires: PERMISSIONS.TIMETABLE_GENERATE },
    ],
  },
  {
    label: "Manage",
    items: [
      { label: "Allocation Matrix", to: "/matrix", requires: PERMISSIONS.TIMETABLE_VIEW_ALL },
      { label: "Draft Board", to: "/board", requires: PERMISSIONS.TIMETABLE_EDIT },
      { label: "Publish", to: "/publish", requires: PERMISSIONS.TIMETABLE_PUBLISH },
      { label: "Substitutes", to: "/substitutes", requires: PERMISSIONS.SUBSTITUTE_MANAGE },
    ],
  },
  {
    label: "My Timetable",
    items: [
      { label: "My Timetable", to: "/my-timetable", requires: PERMISSIONS.TIMETABLE_VIEW_OWN },
      { label: "My Classes", to: "/my-classes", requires: PERMISSIONS.TIMETABLE_VIEW_CLASS },
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
];

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
        <div className="topbar">
          <div>
            <div className="topbar-eyebrow">Phase 0</div>
            <div className="topbar-title">Foundation</div>
          </div>
          <span className="badge badge-ok">● Docker stack</span>
        </div>
        <div className="content">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
