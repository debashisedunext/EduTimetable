/**
 * A panel that opens next to the thing you clicked, and is not clipped by it.
 *
 * Both places this is used sit inside a scrolling container — the guided
 * setup's `Scroll` table (`overflow: auto`, max-height 340) and the Subjects
 * list — so an absolutely-positioned panel is cut off at the container's edge
 * and scrolls away with the rows. CSS offers no way out: an element cannot be
 * scrollable on one axis and visible on the other.
 *
 * So the panel is `position: fixed` and the button is measured when it opens.
 * That buys correctness and costs one thing: a fixed panel does not travel with
 * its row. The first version paid for that by closing on any scroll, which was
 * wrong in two ways once a panel had enough in it to be worth scrolling:
 *
 *  - **The panel's own scrollbar closed the panel.** The listener is in the
 *    capture phase (a table's own scroller does not bubble), so an inner scroll
 *    reached it too, and a fourteen-class list could not be scrolled at all.
 *  - **Closing was never the right answer anyway.** The panel is not stale when
 *    the page moves, only misplaced — so it is re-measured against its anchor
 *    and follows the row, and closes only when the anchor has actually left.
 *
 * Extracted the second time it was needed rather than the third. The §8.1d nav
 * flyout solves the same problem differently — one shared element positioned
 * per hover, rather than one panel per open — because it has to animate on the
 * way out, which a mounted-on-demand panel cannot do.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export interface AnchorAt {
  left: number;
  top: number;
  /** True when the panel opens upward, because there was no room below. */
  up: boolean;
}

export function useAnchored(panelHeight: number) {
  const [at, setAt] = useState<AnchorAt | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  /** The button the panel belongs to, so a moved page can be followed. */
  const anchor = useRef<HTMLElement | null>(null);
  const close = useCallback(() => { anchor.current = null; setAt(null); }, []);

  /** Where the panel sits, given where its button is right now. */
  const placeAt = useCallback((r: DOMRect): AnchorAt => {
    // Flip above when there is no room below — a row near the bottom of a
    // long list would otherwise open a panel hanging off the screen.
    const up = r.bottom + panelHeight > window.innerHeight && r.top > panelHeight;
    return { left: r.left, top: up ? r.top - 4 : r.bottom + 4, up };
  }, [panelHeight]);

  const toggle = useCallback((e: React.MouseEvent<HTMLElement>) => {
    const el = e.currentTarget;
    setAt((was) => {
      if (was) { anchor.current = null; return null; }
      anchor.current = el;
      return placeAt(el.getBoundingClientRect());
    });
  }, [placeAt]);

  /*
    Keyed on WHETHER a panel is open, never on where it is.

    `followed` calls `setAt` on every scroll frame; depending on `at` itself
    would tear down and re-add four listeners each time one arrived.
  */
  const isOpen = at !== null;
  useEffect(() => {
    if (!isOpen) return;
    const away = (e: MouseEvent) => {
      if (panel.current && !panel.current.contains(e.target as Node)) setAt(null);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setAt(null); };
    /**
     * Follow the anchor rather than give up on it.
     *
     * Two things have to be told apart, and the capture phase is what makes it
     * necessary: an ancestor scrolling (the page, the table's own scroller) has
     * moved the button, so the panel is re-measured; the PANEL scrolling has
     * moved nothing, so it must be ignored entirely — that was the bug, and it
     * made a long list impossible to scroll.
     */
    const followed = (e: Event) => {
      if (panel.current && e.target instanceof Node && panel.current.contains(e.target)) return;
      const el = anchor.current;
      if (!el || !el.isConnected) { close(); return; }
      const r = el.getBoundingClientRect();
      // Scrolled out of sight: there is nothing left to be anchored to, and a
      // panel floating beside a row nobody can see is worse than no panel.
      if (r.bottom < 0 || r.top > window.innerHeight) { close(); return; }
      // Only when it actually moved: a horizontal scroll elsewhere on the page
      // would otherwise re-render the panel for nothing.
      const next = placeAt(r);
      setAt((was) => (was && was.left === next.left && was.top === next.top && was.up === next.up ? was : next));
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    // Capture: a table's own scroller does not bubble its scroll event.
    window.addEventListener("scroll", followed, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
      window.removeEventListener("scroll", followed, true);
      window.removeEventListener("resize", close);
    };
  }, [isOpen, close, placeAt]);

  /** Spread onto the panel element. The caller owns width and contents. */
  const panelProps = at
    ? {
      ref: panel,
      style: {
        position: "fixed" as const,
        left: at.left,
        top: at.top,
        transform: at.up ? "translateY(-100%)" : undefined,
        zIndex: 210,
        maxHeight: panelHeight,
        background: "var(--paper)",
        border: "1px solid var(--line)",
        borderRadius: 10,
        boxShadow: "0 12px 30px rgba(11,31,68,.18)",
      },
    }
    : null;

  return { open: at !== null, toggle, close, panelProps };
}
