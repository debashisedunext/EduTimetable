import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { io } from "socket.io-client";
import { PERMISSIONS, windowLabel, type MeResponse, type Permission } from "@edutimetable/shared";
import { api, clearToken, getToken, switchSchool } from "./api";
import { useConfigCtx } from "./hooks";
import { Icon, type IconName } from "./icons";
import { useNavCollapsed } from "./nav-collapse";
import { mayLeave } from "./unsaved-guard";
import { NavScroll } from "./nav-scroll";

interface NavEntry {
  /** §8.1d — what the screen IS, and the only thing identifying it when the nav
   *  is collapsed. Required, so a new entry cannot be added without one. */
  icon: IconName;
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
      { icon: "calendar", label: "Timetables", to: "/", requires: PERMISSIONS.MASTERS_MANAGE },
      { icon: "book", label: "Masters", to: "/masters", requires: PERMISSIONS.MASTERS_MANAGE },
      /*
        §31.13 — directly below Masters, and standing where "Allocation" used
        to. The Lesson Grid tab IS the Allocation grid (§31.10), so two entries
        would have led to one screen; `/allocation` still redirects there for
        anybody with the link. It needs only `timetable.view.all` because four
        of its six tabs are read-only — the two editable ones gate themselves.
      */
      { icon: "master", label: "Master Grid", to: "/master-grid", requires: PERMISSIONS.TIMETABLE_VIEW_ALL },
      { icon: "wand", label: "Timetable Week", to: "/setup", requires: PERMISSIONS.MASTERS_MANAGE },
      { icon: "import", label: "Import from Excel", to: "/import", requires: PERMISSIONS.MASTERS_MANAGE },
      // §23 — the same pipeline, with the ERP as its source instead of a file.
      { icon: "sync", label: "Sync from ERP", to: "/sync", requires: PERMISSIONS.MASTERS_MANAGE },
      { icon: "split", label: "Split Electives", to: "/electives", requires: PERMISSIONS.MASTERS_MANAGE },
      // §4.7a — the rule the solver has always enforced, finally sayable.
      { icon: "clock", label: "Availability", to: "/availability", requires: PERMISSIONS.MASTERS_MANAGE },
      { icon: "checklist", label: "Readiness", to: "/readiness", requires: PERMISSIONS.TIMETABLE_GENERATE },
      { icon: "bolt", label: "Generate", to: "/generate", requires: PERMISSIONS.TIMETABLE_GENERATE },
    ],
  },
  {
    label: "Manage",
    items: [
      /*
        §31.13 — the Allocation Matrix and the Draft Board are not listed here
        any more. Both are Master Grid tabs now (Whole and Draft board), and a
        menu that offers the same week twice teaches people that two entries
        must be two different things.

        The ROUTES stay. Generate links to `/matrix`, Publish links to `/board`
        three times, and somebody has both bookmarked — removing a menu entry
        is a change to how a screen is found, not a decision to delete it.
      */
      { icon: "publish", label: "Publish", to: "/publish", requires: PERMISSIONS.TIMETABLE_PUBLISH },
      { icon: "swap", label: "Substitute Center", to: "/substitutes", requires: PERMISSIONS.SUBSTITUTE_MANAGE },
      // §29.2 — beside Substitute Center on purpose: both are "somebody is not
      // taking their classes". A substitution is one day and an overlay; this
      // is permanent and rewrites who owns the class.
      { icon: "swap", label: "Staffing Changes", to: "/staffing", requires: PERMISSIONS.TIMETABLE_PUBLISH },
      { icon: "plus", label: "Extra & Guest Classes", to: "/extra-classes", requires: PERMISSIONS.TIMETABLE_EDIT },
    ],
  },
  {
    label: "My Timetable",
    items: [
      { icon: "user", label: "My Timetable", to: "/my-timetable", requires: PERMISSIONS.TIMETABLE_VIEW_OWN, requiresTeacher: true },
      { icon: "users", label: "My Classes", to: "/my-classes", requires: PERMISSIONS.TIMETABLE_VIEW_CLASS, requiresTeacher: true },
    ],
  },
  {
    label: "Reference",
    items: [
      { icon: "chart", label: "Reports", to: "/reports", requires: PERMISSIONS.REPORTS_VIEW },
      // §10.6 — beside Reports, because it is the same published week read the
      // same way; what differs is that it shows several at once.
      { icon: "grid", label: "Timetable Wall", to: "/wall", requires: PERMISSIONS.REPORTS_VIEW },
      { icon: "bell", label: "Notifications", to: "/notifications", requires: PERMISSIONS.NOTIFICATIONS_VIEW },
    ],
  },
  {
    label: "Intelligence",
    items: [
      { icon: "chat", label: "Ask AI", to: "/ask-ai", requires: PERMISSIONS.AI_CHAT },
      { icon: "sliders", label: "AI Settings", to: "/ai-settings", requires: PERMISSIONS.AI_CONFIGURE },
    ],
  },
  {
    label: "Administration",
    items: [
      { icon: "building", label: "School Profile", to: "/school", requires: PERMISSIONS.MASTERS_MANAGE },
      { icon: "shield", label: "Roles & Access", to: "/roles", requires: PERMISSIONS.ROLES_MANAGE },
      // §24.8 — the same authority: deciding who signs in is deciding what a role may do.
      { icon: "userPlus", label: "Users & Access", to: "/users", requires: PERMISSIONS.ROLES_MANAGE },
    ],
  },
  {
    label: "System",
    items: [
      { icon: "pulse", label: "Status & Jobs", to: "/system" },
      { icon: "server", label: "Platform Console", to: "/platform", requiresPlatform: true },
    ],
  },
  // Manage / My Timetable / Intelligence / Reference groups arrive with Phases 2-7.
];

/**
 * §8.4 — the routes that take the pane's full width and height.
 *
 * Both are frames in their own right: a border, a pinned header and footer, and
 * their own scrolling between them. An inset around one of those is a margin
 * inside a margin, and on the Allocation grid it was costing rows of school.
 */
// §31.13 — `/allocation` is a redirect now, so it never renders anything
// to bleed. `/master-grid` wants the width for the same reason the Allocation
// grid did: it is the widest screen in the app.
const FULL_BLEED = new Set(["/guided-setup", "/master-grid"]);

const TITLES: Record<string, [string, string]> = {
  "/": ["Build", "Timetables"],
  "/masters": ["Build", "Masters"],
  "/master-grid": ["Build", "Master Grid"],
  "/setup": ["Build", "Timetable Week"],
  "/import": ["Build", "Import Master Data"],
  "/sync": ["Build", "Sync Masters from the ERP"],
  "/electives": ["Build", "Split Electives"],
  "/availability": ["Build", "Availability"],
  "/readiness": ["Build", "Readiness Dashboard"],
  "/generate": ["Build", "Generate Timetable"],
  "/matrix": ["Manage", "Full Allocation Matrix"],

  "/board": ["Manage", "Draft Board"],
  "/publish": ["Manage", "Publish Confirmation"],
  "/substitutes": ["Manage", "Substitute Teacher Center"],
  "/staffing": ["Manage", "Staffing Changes"],
  "/reports": ["Reference", "Reports"],
  "/notifications": ["Reference", "Notification Center"],
  "/my-timetable": ["My Timetable", "My Weekly Timetable"],
  "/my-classes": ["My Timetable", "My Classes"],
  "/ask-ai": ["Intelligence", "Ask AI"],
  "/ai-settings": ["Intelligence", "AI Settings"],
  "/school": ["Administration", "School Profile"],
  "/platform": ["System", "Platform Console"],
  "/roles": ["Administration", "Roles & Access"],
  "/users": ["Administration", "Users & Access"],
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

  /**
   * Take a self-serve admin to *My Schools* — switch, or add another.
   *
   * Only for somebody who signed in with a password. An ERP user has no account
   * and no business creating schools here; theirs come from the ERP (§15.1), so
   * for them the name stays a switcher over exactly what the token granted.
   *
   * The account token is fetched fresh rather than read from storage. The two
   * credentials expire independently, and somebody eight hours into a session
   * would otherwise be bounced to a login form while holding a perfectly good
   * one — losing the school they were in to reach the screen that lists it.
   */
  const toMySchools = async () => {
    setBusy(true);
    try {
      const r = await api<{ accountToken: string }>("/auth/account/token", { method: "POST" });
      localStorage.setItem("edutt.accountToken", r.accountToken);
      window.location.href = "/schools";
    } catch {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
      <span style={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--ink-faint)", fontWeight: 700, marginBottom: 2 }}>
        {me.trust ? me.trust.name : "School"}
      </span>
      {me.isLocalAccount ? (
        // One click to the screen that owns schools, rather than a dropdown
        // that can only choose between the ones that already exist.
        <button
          onClick={toMySchools}
          disabled={busy}
          title="Switch school, or add another"
          style={{
            display: "flex", alignItems: "center", gap: 7, fontWeight: 700, fontSize: 13,
            color: "var(--brand-deep)", background: "none", border: "none", padding: "5px 0",
            cursor: busy ? "wait" : "pointer", font: "inherit",
          }}
        >
          {me.school.logoUrl && (
            <img
              src={me.school.logoUrl}
              alt=""
              style={{ width: 18, height: 18, objectFit: "contain", borderRadius: 4 }}
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
            />
          )}
          <span style={{ fontWeight: 700, fontSize: 13 }}>{me.school.name}</span>
          <span style={{ fontSize: 10, color: "var(--steel)" }}>▾</span>
        </button>
      ) : many ? (
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
              {/*
                §30.5 — the window rides in the option text. Switching timetable
                now changes which dates you are looking at, and on a school that
                dates its timetables the name alone stops being enough to tell
                two of them apart.
              */}
              {configs.map((c) => {
                const when = windowLabel(c);
                return <option key={c.id} value={c.id}>{when ? `${c.name} · ${when}` : c.name}</option>;
              })}
            </select>
            {current && windowLabel(current) && (
              <span style={{ fontSize: 9.5, color: "var(--ink-faint)", marginTop: 2, fontFamily: "var(--font-mono)" }}>
                {windowLabel(current)}
              </span>
            )}
          </div>
        )}
        {me.permissions.includes(PERMISSIONS.NOTIFICATIONS_VIEW) && <Bell />}
        {/*
          §31.14 — the assistant's launcher, on every page.

          It floated at the bottom-right, where on the Master Grid it covered
          the strip's issue count; §31.11 docked it in that screen's own bar,
          which fixed the collision and left the button somewhere different on
          one page out of thirty. A control people reach for by memory has to
          be in the same place every time, so it lives here — beside the bell
          and the timetable picker, which is where the app's own controls are.

          `AiDock` portals into this slot and falls back to the floating corner
          button if it is ever absent, which is what keeps a role without
          `ai.chat` — and any page rendered outside this shell — working.
        */}
        <span id="ai-launcher-slot" style={{ display: "flex", alignItems: "center" }} />
        <span className="badge badge-ok">● Live</span>
      </div>
    </div>
  );
}

/**
 * §8.1d — the label that slides out of a collapsed icon.
 *
 * One element for the whole nav, positioned with `position: fixed` and a top
 * measured from the hovered row. A label nested inside its own row would be the
 * obvious build and does not work: `.sidebar-nav` scrolls, so it clips, and CSS
 * has no way to be scrollable on one axis and visible on the other.
 *
 * It stays mounted and fades rather than being conditionally rendered, because
 * an element removed on mouse-leave has nothing left to animate — "and then go
 * inside" needs the thing to still be there on the way back in. So the label
 * text survives the close and is only replaced when another row is entered.
 */
function NavFlyout({ hover }: { hover: { label: string; top: number; on: boolean } }) {
  return (
    <div
      className={`nav-fly${hover.on ? " on" : ""}`}
      style={{ top: hover.top }}
      aria-hidden
    >
      {hover.label}
    </div>
  );
}

export function Shell({ me }: { me: MeResponse }) {
  const { pathname } = useLocation();
  const [collapsed, toggleCollapsed] = useNavCollapsed();
  // `on` drives the animation; `label` and `top` are deliberately kept after it
  // goes false so the flyout has something to slide back in with.
  const [hover, setHover] = useState({ label: "", top: 0, on: false });
  const enter = (e: React.MouseEvent | React.FocusEvent, label: string) => {
    if (!collapsed) return;
    // The row's middle. The flyout centres itself on it with a translate, so
    // this does not have to know how tall a label is.
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setHover({ label, top: r.top + r.height / 2, on: true });
  };
  const leave = () => setHover((h) => ({ ...h, on: false }));

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
          <div className="brand-text" style={{ minWidth: 0 }}>
            <div className="brand-name">Timetable AI</div>
            <div className="brand-sub" title={me.school.name}>
              {me.school.shortName || me.school.name}
            </div>
          </div>
        </div>
        {/* Sits at the top of the nav rather than floating over the content:
            it belongs to the nav, and a control that moves with what it
            controls needs no explaining. */}
        <button
          className="nav-collapse-btn"
          onClick={toggleCollapsed}
          title={collapsed ? "Expand the menu" : "Collapse the menu to icons"}
          aria-label={collapsed ? "Expand the menu" : "Collapse the menu to icons"}
          aria-expanded={!collapsed}
        >
          <span className="nav-collapse-chevron" aria-hidden>«</span>
          <span className="nav-label">Collapse</span>
        </button>
        <NavScroll>
          {groups.map((g) => (
            <div key={g.label}>
              {/* Collapsed, the group name has nowhere to go — a rule stands in
                  for it, so the groups still read as groups rather than as one
                  undifferentiated column of twenty icons. */}
              <div className="nav-group-label">{g.label}</div>
              {g.items.map((i) => (
                <NavLink
                  key={i.to}
                  to={i.to}
                  className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}
                  /*
                    `aria-label` but NOT `title`.

                    The name has to keep reaching a screen reader when the
                    visible label is folded away — that is `aria-label`'s job.
                    `title` was doing the same job a second time, and now that
                    the flyout paints above the page rather than under it, the
                    two arrive together: the label slides out of the rail and a
                    grey browser tooltip drops on top of it a moment later,
                    saying the same word.
                  */
                  aria-label={collapsed ? i.label : undefined}
                  /*
                    §31.10 — a screen holding unsaved work gets to ask first.
                    Here rather than in a router blocker: `main.tsx` mounts a
                    plain `<BrowserRouter>`, and `useBlocker` needs a data
                    router — converting the app's routing to guard one screen
                    is a change across every route for a small feature.
                    `mayLeave()` is true whenever nothing is guarding, so every
                    other nav click is exactly as it was.
                  */
                  onClick={(e) => { if (!mayLeave()) e.preventDefault(); }}
                  onMouseEnter={(e) => enter(e, i.label)}
                  onMouseLeave={leave}
                  onFocus={(e) => enter(e, i.label)}
                  onBlur={leave}
                >
                  <Icon name={i.icon} />
                  <span className="nav-label">{i.label}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </NavScroll>
        {collapsed && <NavFlyout hover={hover} />}
        <div className="sidebar-foot">
          <div className="who" title={collapsed ? `${me.name} · ${me.role}` : undefined}>
            <div className="avatar">
              {me.name.split(" ").map((p) => p[0]).slice(0, 2).join("")}
            </div>
            <div className="nav-label" style={{ minWidth: 0 }}>
              <div className="who-name">{me.name}</div>
              <div className="who-role">{me.role}</div>
            </div>
          </div>
          <button
            className="logout-btn"
            title={collapsed ? "Sign out" : undefined}
            aria-label="Sign out"
            onClick={() => {
              clearToken();
              window.location.href = "/";
            }}
          >
            <span className="logout-icon" aria-hidden>⏻</span>
            <span className="nav-label">Sign out (back to ERP)</span>
          </button>
        </div>
      </nav>
      <div className="main">
        <Topbar me={me} />
        {/*
          §8.4 — the pages that want the pane's edges get them.

          Everything else keeps a small inset so a card does not touch the
          chrome; the guided setup and the Allocation grid are frames of their
          own, with their own border and their own scrolling, and an inset
          around them is a margin inside a margin. Listed here rather than
          decided by each page, because it is a fact about the LAYOUT — a page
          cannot remove padding its parent applied.
        */}
        <div className={FULL_BLEED.has(pathname) ? "content full-bleed" : "content"}>
          <Outlet />
        </div>
      </div>
    </div>
  );
}
