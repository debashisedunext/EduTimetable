/**
 * §8.1d — the collapsed nav, and the one place its width is known.
 *
 * Collapsing has to change **`--sidebar-w` on the document root**, not a width
 * on the sidebar element, because that token is what the §24.5d guided-setup
 * dialog insets itself by. Set it locally and the nav would shrink while the
 * dialog kept a 236px gap down its left edge — a strip of dead page that would
 * be very hard to trace back to a nav toggle.
 *
 * Remembered per browser: which way somebody likes their nav is a preference,
 * not a fact about the school, so it belongs in `localStorage` and never on the
 * server. Read once before the first paint (`useState` initialiser) so the nav
 * does not flash open and then snap shut on every page load.
 */
import { useCallback, useEffect, useState } from "react";

const KEY = "edutt.navCollapsed";
/** Wide enough for a 17px icon with a comfortable target around it. */
const COLLAPSED_W = "64px";

const read = (): boolean => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
};

/** Stamp the root, which is what both the nav and the §24.5d dialog read. */
function apply(collapsed: boolean): void {
  const root = document.documentElement;
  root.classList.toggle("nav-collapsed", collapsed);
  if (collapsed) root.style.setProperty("--sidebar-w", COLLAPSED_W);
  else root.style.removeProperty("--sidebar-w");
}

export function useNavCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(read);

  useEffect(() => { apply(collapsed); }, [collapsed]);
  // The class outlives this component's mount — the sign-out path replaces the
  // whole page — so clear it on the way out rather than leaving a login screen
  // reserving 64px for a nav that is not there.
  useEffect(() => () => apply(false), []);

  const toggle = useCallback(() => {
    setCollapsed((was) => {
      const next = !was;
      try { localStorage.setItem(KEY, next ? "1" : "0"); } catch { /* private window */ }
      return next;
    });
  }, []);

  return [collapsed, toggle];
}
