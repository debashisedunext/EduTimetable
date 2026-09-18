/**
 * §8.8 — one definition of "this is a phone".
 *
 * ## Why a hook and not a CSS class
 *
 * Most of the mobile work is CSS, and it should be: a breakpoint that lives in
 * the stylesheet costs nothing at runtime and cannot get out of step with a
 * paint. But three things genuinely change *what is rendered* rather than how
 * it looks, and CSS cannot do any of them:
 *
 *  - the 236px navy rail is not narrowed on a phone, it is **replaced** by a
 *    bottom bar and a sheet;
 *  - `--sidebar-w` is an inline custom property on `<html>` (§8.1d), so a
 *    stylesheet `:root` rule cannot reach it — the guided-setup dialog insets
 *    itself by that token and would keep a 64px strip of dead page;
 *  - §8.7's page-action slot is not rendered at all on a phone, so `PageActions`
 *    has to look for it again when the breakpoint changes.
 *
 * ## One number, named once
 *
 * 820px, and both the stylesheet and this file say it. A second copy that
 * disagreed would produce the worst possible state: the rail hidden by CSS and
 * the bottom bar not rendered, or both at once. Anything that adds a mobile
 * rule must use this breakpoint.
 *
 * Read in `useLayoutEffect`, not `useEffect`: the first render has to be right.
 * §8.1d's rule about the collapsed nav is the same one — a passive effect shows
 * every phone user a desktop layout for one painted frame.
 */
import { useLayoutEffect, useState } from "react";

/** The one breakpoint. Mirrored in `styles.css`; never duplicated in a component. */
export const MOBILE_MAX = 820;
export const MOBILE_QUERY = `(max-width: ${MOBILE_MAX}px)`;

export function useIsMobile(): boolean {
  /*
    Seeded from `matchMedia` rather than from `false`.

    `useState(false)` plus an effect is the usual shape and is wrong here: on a
    phone it renders the desktop tree first and swaps, which on this app means
    the navy rail appearing and vanishing on every page load. The initialiser
    runs before the first paint, so there is nothing to swap.

    Guarded for a non-browser render — there is no SSR here today, and a
    `window` reference that assumes so is exactly how that stops being true
    quietly.
  */
  const [is, setIs] = useState(
    () => typeof window !== "undefined" && window.matchMedia(MOBILE_QUERY).matches,
  );

  useLayoutEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const on = () => setIs(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  return is;
}
