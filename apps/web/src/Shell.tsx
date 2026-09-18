import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { io } from "socket.io-client";
import { PERMISSIONS, windowLabel, type MeResponse, type Permission } from "@edutimetable/shared";
import { api, clearToken, getToken, switchSchool } from "./api";
import { SchoolLogo } from "./brand";
import { useConfigCtx } from "./hooks";
import { Icon, type IconName } from "./icons";
import { useNavCollapsed } from "./nav-collapse";
import { MobileNav } from "./MobileNav";
import { useIsMobile } from "./mobile";
import { PAGE_ACTIONS_SLOT } from "./page-actions";
import { mayLeave } from "./unsaved-guard";
import { NavScroll } from "./nav-scroll";

interface NavEntry {
  /** §8.1d — what the screen IS, and the only thing identifying it when the nav
   *  is collapsed. Required, so a new entry cannot be added without one. */
  icon: IconName;
  label: string;
  /**
   * §8.6 — the same screen's name where 64 pixels is all there is.
   *
   * Beside `label` rather than in the toolbar, so a screen is never named twice
   * in two files: "Timetable Week" and "Week" are one decision about one row.
   * Absent means the label already fits, which is most of them.
   */
  short?: string;
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
  /** readonly so `NAV` can be `as const` — see `NavPath` below. */
  items: readonly NavEntry[];
}

/** Nav mirrors the mockup's groups; entries render only when the role holds the
 *  permission — cosmetic convenience, the server guard is the authority (§15.3).
 *
 *  `as const satisfies` rather than a plain annotation: it keeps every `to` as a
 *  literal type, which is what lets §8.6's `TOP_BAR` be checked against this
 *  list at compile time instead of agreeing with it by hand. */
const NAV = [
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
      { icon: "wand", label: "Timetable Week", short: "Week", to: "/setup", requires: PERMISSIONS.MASTERS_MANAGE },
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
      { icon: "swap", label: "Substitute Center", short: "Substitutes", to: "/substitutes", requires: PERMISSIONS.SUBSTITUTE_MANAGE },
      /*
        §29.2 — beside Substitute Center on purpose: both are "somebody is not
        taking their classes". A substitution is one day and an overlay; this
        is permanent and rewrites who owns the class.

        §8.6 — and it has its own icon now. Both screens used `swap`, which
        reads fine beside a label and is the same button twice the moment the
        toolbar drops to icons alone.
      */
      { icon: "handover", label: "Staffing Changes", short: "Staffing", to: "/staffing", requires: PERMISSIONS.TIMETABLE_PUBLISH },
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
      { icon: "grid", label: "Timetable Wall", short: "Wall", to: "/wall", requires: PERMISSIONS.REPORTS_VIEW },
      /*
        §37 — beside Reports, because it is a report: it reads the curriculum
        and the staff list and writes nothing. `reports.view` for the same
        reason — a principal who may read the teacher-load report may read the
        case for a hire.
      */
      { icon: "headcount", label: "Teacher Requirement", short: "Staffing need", to: "/teacher-requirement", requires: PERMISSIONS.REPORTS_VIEW },
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
] as const satisfies readonly NavGroup[];

/** Every route the nav knows, as a type. The point of `as const` above. */
type NavPath = (typeof NAV)[number]["items"][number]["to"];

/**
 * §8.6 — which screens get a button at the top of every page.
 *
 * This is a SELECTION out of `NAV`, not a second list: no labels, no icons, no
 * order and no groups live here, only membership. The order and the grouping
 * come from `NAV` itself, which is what makes the two renderings incapable of
 * disagreeing — a screen renamed or regrouped in the rail is renamed and
 * regrouped up here in the same edit, and a path that `NAV` does not have is a
 * type error rather than a button that silently never appears.
 *
 * A screen added to `NAV` and not to this list needs no decision at all: it
 * falls into More, which carries the whole of the rest of the rail.
 *
 * The twelve are the working day — build it, check it, generate it, publish it,
 * read it. Import, Sync, Electives and Availability are deliberately NOT here:
 * they are set up once, and a bar that holds everything holds nothing.
 */
const TOP_BAR: readonly NavPath[] = [
  "/", "/masters", "/master-grid", "/setup", "/readiness", "/generate",
  "/publish", "/substitutes", "/staffing",
  "/reports", "/wall",
  "/ask-ai",
];

/**
 * §8.6 — routes with no button of their own, and the button they light instead.
 *
 * `/matrix` and `/board` are real screens that Generate and Publish link to and
 * people have bookmarked (§31.13 kept the routes when it took them out of the
 * rail); they are Master Grid tabs, so they light Master Grid. Without this the
 * bar goes blank on a screen somebody reached from inside the app, which reads
 * as the navigation having lost its place.
 */
const STANDS_FOR: Record<string, NavPath> = {
  "/matrix": "/master-grid",
  "/board": "/master-grid",
  "/allocation": "/master-grid",
  "/guided-setup": "/",
};

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
  "/teacher-requirement": ["Reference", "Teacher Requirement"],
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
          {/* §17.4a — no logo here any more: it is top left, at a size worth
              looking at, and twice on one bar is once too many. */}
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
          {me.school.name}
        </span>
      )}
    </div>
  );
}

/**
 * §8.6 — the screens, as icons, at the top of every page.
 *
 * ## What it is allowed to decide
 *
 * Almost nothing. `groups` arrives ALREADY permission-filtered and in the
 * rail's own order, and this only chooses which of those entries get a button
 * and which fall into More. That is deliberate: a toolbar that carried its own
 * list of labels, icons, order and permissions would be a second nav, free to
 * drift from the first, and More would be a way round exactly what the rail
 * hides — the rule §31.10 kept for the Master Grid's tabs.
 *
 * A rule between two icons is therefore a real group boundary rather than
 * decoration: it is where one of `NAV`'s groups ends.
 *
 * ## The twelve never move
 *
 * There is no width-measured overflow here, and there must not be. The same
 * buttons in the same order at every window size; under 1100px the labels drop
 * and it becomes icons, under 820px it scrolls sideways. §31.14's argument for
 * docking the assistant's launcher in this bar is the same one: a control whose
 * position depends on the window is a control nobody can reach by memory.
 */
function Toolbar({ groups, mobile }: { groups: NavGroup[]; mobile: boolean }) {
  const { pathname } = useLocation();
  /** §8.6 — the button this route lights, which is not always its own. */
  const here: string = STANDS_FOR[pathname] ?? pathname;
  const onBar = (i: NavEntry) => (TOP_BAR as readonly string[]).includes(i.to);

  const bar = groups
    .map((g) => ({ label: g.label, items: g.items.filter(onBar) }))
    .filter((g) => g.items.length > 0);
  const rest = groups
    .map((g) => ({ label: g.label, items: g.items.filter((i) => !onBar(i)) }))
    .filter((g) => g.items.length > 0);

  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);

  /*
    A plain absolutely-positioned panel rather than `useAnchored`. That hook
    measures its button because its two call sites sit inside containers that
    scroll the button out from under the panel; this button is in the top bar,
    which is sticky, and it sits OUTSIDE the toolbar's own scroller (see the
    note on `.tb-scroll` below) — so nothing can move it, and measuring it
    would be machinery for its own sake.
  */
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  // Arriving somewhere closes it — a panel left open over the screen it just
  // navigated to is covering the answer it was asked for.
  useEffect(() => { setOpen(false); }, [pathname]);

  const activeInMore = rest.some((g) => g.items.some((i) => i.to === here));
  /*
    §8.8 — nothing on a phone. The bottom bar is the navigation there, and a
    second strip of twelve icons above the content would be the same list twice
    in a place with no room for it once.

    Returned AFTER the hooks above, not before: rules-of-hooks, and this file
    has been caught by it before.
  */
  if (mobile) return null;
  if (bar.length === 0 && rest.length === 0) return null;

  /*
    One tab stop, not thirteen. The toolbar pattern: whichever button is current
    takes the tab stop and the arrows move between them, so a keyboard reader
    reaches the page in one press rather than walking the whole bar first.
  */
  const flat = bar.flatMap((g) => g.items);
  const stop = flat.find((i) => i.to === here)?.to
    ?? (activeInMore ? " more" : flat[0]?.to ?? " more");
  const move = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    const btns = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-tb]")];
    const at = btns.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    e.preventDefault();
    btns[(at + step + btns.length) % btns.length].focus();
  };

  return (
    <div className="topbar-nav" role="toolbar" aria-label="Screens" onKeyDown={move}>
      {/*
        The buttons scroll; More does NOT live inside the scroller.

        Two reasons, and the first is a bug this was written with: an
        `overflow-x: auto` ancestor clips an absolutely-positioned panel, so the
        More panel would have been cut off at the toolbar's own height — the
        same trap `ui/anchored.tsx` exists to document. The second is plainer:
        the way out of a bar too narrow to show everything must not be the thing
        that scrolls off it.
      */}
      <div className="tb-scroll">
        {bar.map((g, gi) => (
          <div className="tb-group" key={g.label}>
            {/* The rule IS the group boundary — see the note above. */}
            {gi > 0 && <span className="tb-pipe" role="separator" aria-orientation="vertical" />}
            {g.items.map((i) => (
              <Link
                key={i.to}
                to={i.to}
                data-tb
                tabIndex={i.to === stop ? 0 : -1}
                className={`tb${i.to === here ? " active" : ""}`}
                aria-label={i.label}
                aria-current={i.to === here ? "page" : undefined}
                // §31.10 — the same guard the rail's links carry. A new door
                // that skipped it would be a way to lose unsaved work by
                // pressing the nearest thing to the top of the screen.
                onClick={(e) => { if (!mayLeave()) e.preventDefault(); }}
              >
                <Icon name={i.icon} size={22} />
                <span className="tb-label">{i.short ?? i.label}</span>
              </Link>
            ))}
          </div>
        ))}
        <span className="tb-end" />
      </div>
      {/*
        §8.7 — the screen's own actions, portalled in.

        Outside `.tb-scroll` for the reason More is: a primary action that
        scrolls off a narrow bar is a primary action nobody can reach. The rule
        before it is the same group boundary the nav uses — left of it is where
        you can go, right of it is what you can do here — and it is drawn by
        the slot itself only when the slot has something in it, so a screen
        with no actions gets no stray hairline.
      */}
      <span id={PAGE_ACTIONS_SLOT} className="tb-actions" />
      {rest.length > 0 && (
        <div className="tb-more" ref={wrap}>
          <span className="tb-pipe" role="separator" aria-orientation="vertical" />
          <button
            type="button"
            data-tb
            tabIndex={stop === " more" ? 0 : -1}
            className={`tb${open ? " open" : ""}`}
            aria-label="More screens"
            aria-expanded={open}
            aria-haspopup="true"
            onClick={() => setOpen((o) => !o)}
          >
            <Icon name="more" size={22} />
            <span className="tb-label">More</span>
            {/* Where you are, when where you are has no button of its own. */}
            {activeInMore && <span className="tb-flag" aria-hidden />}
          </button>
          {open && (
            <div className="tb-panel">
              {rest.map((g) => (
                <div key={g.label}>
                  <div className="tb-panel-label">{g.label}</div>
                  {g.items.map((i) => (
                    <Link
                      key={i.to}
                      to={i.to}
                      className={`tb-panel-item${i.to === here ? " active" : ""}`}
                      aria-current={i.to === here ? "page" : undefined}
                      onClick={(e) => { if (!mayLeave()) e.preventDefault(); }}
                    >
                      <Icon name={i.icon} size={15} />
                      <span>{i.label}</span>
                    </Link>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * §8.8 — what you are looking at, at the top of the phone menu.
 *
 * Both pickers, reusing the real ones: `SchoolPicker` knows about ERP grants,
 * local accounts and trusts, and the timetable list carries §30.5's date
 * windows in its option text. A phone-shaped copy of either would be a second
 * set of rules about who may switch what — which is how the app ended up with
 * three timetable selectors once already (§30.13).
 */
function MobilePickers({ me }: { me: MeResponse }) {
  const { configs, current, setCurrentId } = useConfigCtx();
  return (
    <>
      <div className="msheet-picker">
        <span className="msheet-picker-label">School</span>
        <SchoolPicker me={me} />
      </div>
      {configs.length > 0 && (
        <div className="msheet-picker">
          <span className="msheet-picker-label">Viewing timetable</span>
          <select
            value={current?.id ?? ""}
            onChange={(e) => setCurrentId(Number(e.target.value))}
            style={{
              width: "100%", fontWeight: 700, fontSize: 15, color: "var(--brand)",
              border: "1px solid var(--steel-pale)", background: "var(--steel-pale)",
              borderRadius: 9, padding: "11px 10px",
            }}
          >
            {configs.map((c) => {
              const when = windowLabel(c);
              return <option key={c.id} value={c.id}>{when ? `${c.name} · ${when}` : c.name}</option>;
            })}
          </select>
        </div>
      )}
    </>
  );
}

function Topbar({ me, groups, mobile, menuOpen, menuFlag, onMenu }: {
  me: MeResponse; groups: NavGroup[]; mobile: boolean;
  menuOpen: boolean;
  /** The active screen is not one of the five along the bottom. */
  menuFlag: boolean;
  onMenu: () => void;
}) {
  const { pathname } = useLocation();
  const { configs, current, setCurrentId } = useConfigCtx();
  /*
    §8.6 — the eyebrow-and-title block is gone: the toolbar's lit button says
    which screen this is, and saying it twice cost 42px of every page on an app
    whose two densest screens are short of exactly that.

    `TITLES` did not become dead with it. It names the browser tab, which is
    what somebody with six of these open is reading.
  */
  useEffect(() => {
    const [eyebrow, title] = TITLES[pathname] ?? ["", "Timetable AI"];
    document.title = eyebrow && title !== "Timetable AI" ? `${title} · Timetable AI` : title;
  }, [pathname]);
  return (
    <header className="topbar">
      {/*
        §17.4a — the school's logo, top left, above the toolbar.

        The school's mark rather than the product's: this is whose timetable
        this is. `SchoolLogo` owns the fallback, so a school with no logo — and
        a school whose logo URL cannot be reached — both get the default mark
        rather than a blank 26px hole.
      */}
      <div className="topbar-brand">
        <SchoolLogo src={me.school.logoUrl} size={mobile ? 30 : 26} alt={me.school.name} />
        {/* §8.8 — the mark alone on a phone. The bar has room for four things
            and three of them are controls; the product's name is not one of
            the four. */}
        {!mobile && <span className="topbar-brand-name">Timetable AI</span>}
      </div>
      <Toolbar groups={groups} mobile={mobile} />
      <div className="topbar-ctx">
        {!mobile && <SchoolPicker me={me} />}
        {!mobile && configs.length > 0 && (
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
        {/* "Live" is reassurance, and reassurance is the first thing to go when
            four controls are competing for 400px. */}
        {!mobile && <span className="badge badge-ok">● Live</span>}
        {/*
          §8.8 — the hamburger, and the ONLY opener of the sheet.

          The school and timetable pickers moved into it: both are dropdowns
          whose value is a long name, and two of those plus a bell plus the
          assistant do not fit a phone's top bar — so they became the first
          thing inside the menu instead, which is where somebody goes to change
          what they are looking at.

          Deliberately the only opener: the bottom bar carries five
          destinations now rather than four and a Menu, because two controls
          opening the same sheet is the same question answered in two places.
        */}
        {mobile && (
          <button
            type="button"
            className="topbar-burger"
            aria-label="Menu"
            aria-expanded={menuOpen}
            aria-haspopup="dialog"
            onClick={onMenu}
          >
            <span /><span /><span />
            {menuFlag && <em aria-hidden />}
          </button>
        )}
      </div>
    </header>
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
  const mobile = useIsMobile();
  const [menuOpen, setMenuOpen] = useState(false);
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
  /*
    Widened back to `NavEntry` here. `NAV` is `as const` so that §8.6's
    `TOP_BAR` can be checked against its paths, which also narrows every entry
    to its own literal shape — and an entry with no `requires` then has no such
    property to read rather than an optional one.
  */
  const groups: NavGroup[] = NAV.map((g) => ({
    label: g.label,
    items: (g.items as readonly NavEntry[]).filter(
      (i) =>
        (!i.requires || held.has(i.requires)) &&
        (!i.requiresTeacher || me.teacherId !== null) &&
        (!i.requiresPlatform || me.platformAdmin),
    ),
  })).filter((g) => g.items.length > 0);

  /*
    §8.8 — the five along the bottom of a phone.

    Derived, never a third hand-written list: the first five entries of §8.6's
    `TOP_BAR` that this role actually holds, read out of the same
    permission-filtered `groups` the rail and the toolbar render from. A screen
    removed from `NAV` leaves all three at once, and a role without a permission
    is missing the entry in all three — which is the whole point, because a
    bottom bar would otherwise be a way round what the rail hides.
  */
  const mobileBar = groups
    .flatMap((g) => g.items)
    .filter((i) => (TOP_BAR as readonly string[]).includes(i.to))
    .sort((a, b) => TOP_BAR.indexOf(a.to as NavPath) - TOP_BAR.indexOf(b.to as NavPath))
    .slice(0, 5);
  const signOut = () => { clearToken(); window.location.href = "/"; };
  /** The active screen is not one of the five, so the hamburger says so. */
  const hereNow: string = STANDS_FOR[pathname] ?? pathname;
  const menuFlag = !mobileBar.some((i) => i.to === hereNow);

  return (
    <div className="app">
      {/* §8.8 — the rail is not narrowed on a phone, it is replaced. Rendering
          it hidden would keep its 100vh sticky box, its scroll listeners and
          its hover flyout in a tree that can never show them. */}
      {!mobile && (
      <nav className="sidebar">
        <div className="brand">
          {/*
            §17.4a — the PRODUCT mark here, always, and the school's logo in the
            top bar instead.

            Two reasons it stopped being the school's. The rail is
            `--brand-deep` navy, so a dark logo on it is invisible — and the
            default mark is dark, which is right on the paper-white top bar and
            would be a black square on black here. And with a logo top left, a
            second copy of it 26 pixels away was the same fact said twice.
          */}
          <div className="brand-mark">
            <span /><span /><span /><span />
          </div>
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
            onClick={signOut}
          >
            <span className="logout-icon" aria-hidden>⏻</span>
            <span className="nav-label">Sign out (back to ERP)</span>
          </button>
        </div>
      </nav>
      )}
      <div className="main">
        {/* §8.6 — the toolbar renders from the SAME filtered groups the rail
            does, so neither can offer a screen the other hides. */}
        <Topbar
          me={me}
          groups={groups}
          mobile={mobile}
          menuOpen={menuOpen}
          menuFlag={menuFlag}
          onMenu={() => setMenuOpen((o) => !o)}
        />
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
      {/* §8.8 — four destinations at the thumb, and everything else in a sheet. */}
      {mobile && (
        <MobileNav
          groups={groups}
          bar={mobileBar}
          here={hereNow}
          pickers={<MobilePickers me={me} />}
          open={menuOpen}
          setOpen={setMenuOpen}
          who={me.name}
          role={me.role}
          onSignOut={signOut}
        />
      )}
    </div>
  );
}
