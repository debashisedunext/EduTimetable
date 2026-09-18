/**
 * §8.1d — the collapsed nav, and the one place its width is known.
 *
 * Collapsing has to change **`--sidebar-w` on the document root**, not a width
 * on the sidebar element, because that token is what the §24.5d guided-setup
 * dialog insets itself by. Set it locally and the nav would shrink while the
 * dialog kept a 236px gap down its left edge — a strip of dead page that would
 * be very hard to trace back to a nav toggle.
 *
 * **It starts collapsed, every time.** The nav was built for that state: each
 * item is an icon with the name sliding out on hover, so nothing is hidden,
 * only folded. Every screen behind it — the 50×40 allocation matrix, the drag
 * board, the guided setup dialog that insets itself by this very token — wants
 * the 172px back more than a permanent list of twenty-four labels is worth.
 *
 * Expanding is therefore a deliberate act and lasts as long as the visit, not
 * for ever: the preference is not remembered across a reload. That is what was
 * asked for, and it is a real trade-off — somebody who genuinely prefers the
 * labels re-opens it each time. Making it sticky again is one line: read
 * `localStorage` in the `useState` initialiser and write it in `toggle`.
 */
import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { useIsMobile } from "./mobile";

/** Wide enough for a 17px icon with a comfortable target around it. */
const COLLAPSED_W = "64px";

/** Stamp the root, which is what both the nav and the §24.5d dialog read. */
function apply(collapsed: boolean, mobile: boolean): void {
  const root = document.documentElement;
  root.classList.toggle("nav-collapsed", collapsed && !mobile);
  /*
    §8.8 — on a phone the rail is not narrowed, it is not there at all, and the
    token has to say so.

    It is an INLINE property on `<html>`, so a stylesheet `:root` rule inside a
    media query cannot reach it — the §24.5d guided-setup dialog insets itself
    by this token and would keep a 64px strip of dead page down its left edge on
    every phone. Exactly the failure the note above describes, arriving through
    a different door.
  */
  if (mobile) root.style.setProperty("--sidebar-w", "0px");
  else if (collapsed) root.style.setProperty("--sidebar-w", COLLAPSED_W);
  else root.style.removeProperty("--sidebar-w");
}

export function useNavCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(true);
  const mobile = useIsMobile();

  /*
    `useLayoutEffect`, not `useEffect`, and that is the difference between a
    default and a flicker.

    `--sidebar-w` defaults to 236px in the stylesheet, so until the root is
    stamped the nav renders open. A passive effect runs AFTER the browser
    paints, which would show every user an expanded nav snapping shut on every
    single page load — the collapsed default made that everybody's first
    impression rather than a rare one. A layout effect runs before the paint.
  */
  useLayoutEffect(() => { apply(collapsed, mobile); }, [collapsed, mobile]);
  // The class outlives this component's mount — the sign-out path replaces the
  // whole page — so clear it on the way out rather than leaving a login screen
  // reserving 64px for a nav that is not there.
  useEffect(() => () => apply(false, false), []);

  const toggle = useCallback(() => setCollapsed((was) => !was), []);

  return [collapsed, toggle];
}
