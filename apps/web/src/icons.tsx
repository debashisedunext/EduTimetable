/**
 * The nav's icons (§8.1d).
 *
 * Inline SVG rather than emoji, for three reasons that all matter once the
 * sidebar can collapse to icons alone:
 *
 *  | "calendar" | "wand" | "book" | "import" | "sync" | "split" | "clock" | "checklist" | "bolt"- **They inherit `currentColor`**, so an icon goes white on the active row
 *    and pale blue everywhere else, exactly as its label does. Twenty
 *    multicoloured emoji in a navy panel would be the loudest thing on the
 *    screen, and the nav is the one part of the app that should never compete
 *    with the timetable.
 *  - **They render the same everywhere.** An emoji is whatever the operating
 *    system decides — a different drawing on Windows, on a Mac and on a phone,
 *    and occasionally a blank rectangle. When the icon is the ONLY thing
 *    identifying a screen, that is not a cosmetic risk.
 *  - **No dependency.** An icon library for twenty glyphs is a package to keep
 *    current, and these are twenty short paths.
 *
 * Drawn on a 24×24 grid, stroked not filled, so they sit at the same visual
 * weight as the Inter labels beside them.
 */

/** Every screen in the nav has one, and the name says what the screen IS. */
export type IconName =
  | "calendar" | "wand" | "book" | "import" | "sync" | "split" | "clock" | "checklist" | "bolt"
  | "grid" | "master" | "board" | "publish" | "swap" | "plus"
  | "user" | "users"
  | "chart" | "bell"
  | "chat" | "sliders"
  | "building" | "shield" | "userPlus"
  | "pulse" | "server";

/** The path data. One entry per icon, and nothing else in the module knows the shapes. */
const PATHS: Record<IconName, React.ReactNode> = {
  // Build
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></>,
  wand: <><path d="M4 20 14 10" /><path d="M17 3v4M15 5h4M18 12.5v3M16.5 14h3" /></>,
  // §8.2 — the masters, which are a set of things rather than a sequence.
  book: <><path d="M4 4h11a3 3 0 0 1 3 3v13H7a3 3 0 0 1-3-3z" /><path d="M18 20a2 2 0 0 0 2-2V6" /><path d="M8 8h6M8 12h6" /></>,
  import: <><path d="M12 3v11M8 10l4 4 4-4" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></>,
  sync: <><path d="M20 11a8 8 0 0 0-13.7-5.7L3 8" /><path d="M4 13a8 8 0 0 0 13.7 5.7L21 16" /><path d="M3 4v4h4M21 20v-4h-4" /></>,
  split: <><path d="M3 12h5l3-5h5M11 17h5" /><path d="M8 12l3 5" /><path d="M17 4l3 3-3 3M17 14l3 3-3 3" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5.5l3.5 2" /></>,
  checklist: <><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 3h6v3H9z" /><path d="M9 13l2 2 4-4" /></>,
  bolt: <><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" /></>,
  // Manage
  grid: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M3 15h18M9 3v18M15 3v18" /></>,
  board: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M15 4v16" /></>,
  // §31 — the vertical tab rail down the left, and a dense grid beside it.
  master: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M8 3v18" /><path d="M8 9h13M8 15h13M14 3v18" /><path d="M5.2 7h1.6M5.2 11h1.6M5.2 15h1.6" /></>,
  publish: <><path d="M12 20V5M6 11l6-6 6 6" /><path d="M4 3h16" /></>,
  swap: <><path d="M16 3h5v5" /><path d="M21 3l-7 7" /><path d="M8 21H3v-5" /><path d="M3 21l7-7" /></>,
  plus: <><circle cx="12" cy="12" r="9" /><path d="M12 8v8M8 12h8" /></>,
  // Mine
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
  users: <><circle cx="9" cy="8" r="3.5" /><path d="M2 21a7 7 0 0 1 14 0" /><path d="M16 4.8a3.5 3.5 0 0 1 0 6.4" /><path d="M18.5 21a7 7 0 0 0-3.2-5.5" /></>,
  // Reference
  chart: <><path d="M5 20v-7M11 20V5M17 20v-4" /><path d="M3 21h18" /></>,
  bell: <><path d="M18 15V10a6 6 0 1 0-12 0v5l-2 3h16l-2-3z" /><path d="M10 21h4" /></>,
  // Intelligence
  chat: <><path d="M20 5H4v11h5l4 4v-4h7V5z" /><path d="M8 10.5h.01M12 10.5h.01M16 10.5h.01" /></>,
  sliders: <><path d="M4 8h9M19 8h1M4 16h5M15 16h5" /><circle cx="16" cy="8" r="2.5" /><circle cx="12" cy="16" r="2.5" /></>,
  // Administration
  building: <><path d="M4 21V8l8-5 8 5v13" /><path d="M9.5 21v-6h5v6" /><path d="M3 21h18" /></>,
  shield: <><path d="M12 3l8 3v6c0 4.8-3.4 8-8 9-4.6-1-8-4.2-8-9V6l8-3z" /><path d="M9 12l2 2 4-4" /></>,
  userPlus: <><circle cx="9" cy="8" r="3.5" /><path d="M2 21a7 7 0 0 1 14 0" /><path d="M18 8v6M15 11h6" /></>,
  // System
  pulse: <><path d="M3 12h4l3 8 4-16 3 8h4" /></>,
  server: <><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01" /></>,
};

export function Icon({ name, size = 17 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth={1.7}
      strokeLinecap="round" strokeLinejoin="round"
      // Decorative: every icon sits beside a label, or on an element that
      // carries the name as its accessible name when the nav is collapsed.
      aria-hidden focusable="false"
      style={{ flexShrink: 0 }}
    >
      {PATHS[name]}
    </svg>
  );
}
