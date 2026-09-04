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
 * That buys correctness and costs one thing, which this hook then handles: a
 * fixed panel does not travel with its row, so any scroll closes it.
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
  const close = useCallback(() => setAt(null), []);

  const toggle = useCallback((e: React.MouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setAt((was) => {
      if (was) return null;
      // Flip above when there is no room below — a row near the bottom of a
      // long list would otherwise open a panel hanging off the screen.
      const up = r.bottom + panelHeight > window.innerHeight && r.top > panelHeight;
      return { left: r.left, top: up ? r.top - 4 : r.bottom + 4, up };
    });
  }, [panelHeight]);

  useEffect(() => {
    if (!at) return;
    const away = (e: MouseEvent) => {
      if (panel.current && !panel.current.contains(e.target as Node)) setAt(null);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setAt(null); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    // Capture: a table's own scroller does not bubble its scroll event.
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [at, close]);

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
