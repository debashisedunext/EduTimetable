/**
 * §8.7 — a screen's own actions, in the top bar beside the navigation.
 *
 * ## Why they belong up there
 *
 * The Timetables page carried its three primary buttons in a header row of
 * their own: a line of the page spent on three controls, with the prose on the
 * left and several hundred pixels of nothing between them on any wide screen.
 * Every other screen that grows a primary action would spend the same line
 * again.
 *
 * §8.6's toolbar row already ends in empty space before **More**, and the split
 * it draws is the useful one: the left of the bar is *where you can go*, the
 * right is *what you can do here*. A rule between them, as between every other
 * group.
 *
 * ## A portal rather than a prop
 *
 * The bar lives in `Shell`, several layers above the routed page, and threading
 * a `headerActions` callback down through the router for one row of buttons
 * would put every screen's actions into a component that renders none of them.
 * The same argument `AiDock` makes for `#ai-launcher-slot`.
 *
 * ## It falls back rather than vanishing
 *
 * A page rendered outside the shell has no slot. `AiDock` learned this the hard
 * way: a portal with no target renders nothing at all, and a primary action
 * that silently disappears on one route is worse than one in the wrong place.
 * With no slot the buttons render exactly where the component sits.
 *
 * The look-up is a `useLayoutEffect`, so it happens before paint — a passive
 * effect would draw the fallback for one frame and then move it, which is a row
 * of buttons jumping on every navigation (§8.1d's rule, again).
 */
import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useIsMobile } from "./mobile";

/** The id `Shell` renders. One string, named once. */
export const PAGE_ACTIONS_SLOT = "page-actions-slot";

export function PageActions({ children }: { children: React.ReactNode }) {
  /*
    Three states, not two. `undefined` means "not looked yet" and renders
    nothing for that one pre-paint pass; `null` means "looked, and there is no
    slot", which is what turns on the fallback. Collapsing them would make the
    fallback flash on every page that does have a slot.
  */
  const [slot, setSlot] = useState<HTMLElement | null | undefined>(undefined);
  /*
    §8.8 — looked up again when the breakpoint changes.

    On a phone the toolbar is not rendered, so neither is the slot, and these
    buttons fall back into the page where there is room for them. Without
    `mobile` in the deps the look-up would happen once: rotate a tablet and the
    portal would still be pointing at a node that has left the document, which
    renders nothing at all — the silent-disappearance failure the fallback
    exists to prevent, arriving by the other door.
  */
  const mobile = useIsMobile();
  useLayoutEffect(() => { setSlot(document.getElementById(PAGE_ACTIONS_SLOT)); }, [mobile]);

  if (slot === undefined) return null;
  if (slot === null) return <div className="actions">{children}</div>;
  return createPortal(children, slot);
}
