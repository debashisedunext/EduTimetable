/**
 * §8.1d — scrolling the nav without a scrollbar down the middle of it.
 *
 * The rail is 64px wide when collapsed and the icons are centred in it, so a
 * 6px scrollbar is not a thin edge detail — it is a pale blue bar running the
 * full height of a navy panel, a few pixels from the icons, and it reads as
 * part of the design rather than as a browser affordance.
 *
 * So the scrollbar is hidden and the same information is carried by a small
 * chevron at each end: a chevron means "there is more this way", and it is a
 * control as well as a sign. Two rules keep it from becoming furniture:
 *
 *  - **Both chevrons appear only when the list actually overflows.** On a tall
 *    screen the whole nav fits and neither is drawn. A permanently dimmed pair
 *    would be two rows of dead space in the one column the collapse exists to
 *    make room in.
 *  - **When it does overflow, both slots stay mounted** and the one at the end
 *    you have reached dims. Mounting and unmounting them as you scroll would
 *    shift every icon by 18px at the moment you were aiming at one.
 *
 * They are `aria-hidden` and out of the tab order deliberately. Scrolling this
 * list from the keyboard already works — tabbing through the nav scrolls the
 * focused item into view — so these are a pointer affordance, and adding them
 * to the tab order would put two extra stops in front of every nav item on
 * every page to duplicate something that already happens.
 */
import { useEffect, useRef, useState } from "react";

interface Reach {
  /** Is there anything to scroll at all? */
  overflows: boolean;
  atTop: boolean;
  atBottom: boolean;
}

export function NavScroll({ children }: { children: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [reach, setReach] = useState<Reach>({ overflows: false, atTop: true, atBottom: true });

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const read = () => {
      // A pixel of slack: fractional scroll positions are normal after a smooth
      // scroll, and an exact comparison leaves the chevron lit at the very end.
      const room = el.scrollHeight - el.clientHeight;
      setReach({
        overflows: room > 1,
        atTop: el.scrollTop <= 1,
        atBottom: el.scrollTop >= room - 1,
      });
    };
    read();
    el.addEventListener("scroll", read, { passive: true });
    /*
      Both boxes are observed, because either can change without the other.

      The viewport changes when the window resizes; the CONTENT changes when the
      nav collapses — every label folds away, the rows get shorter, and a list
      that overflowed a moment ago now fits. Watching only the scroller would
      leave the chevrons showing on a nav that no longer needs them.
    */
    const ro = new ResizeObserver(read);
    ro.observe(el);
    if (inner.current) ro.observe(inner.current);
    return () => {
      el.removeEventListener("scroll", read);
      ro.disconnect();
    };
  }, []);

  const step = (dir: -1 | 1) => {
    const el = box.current;
    if (!el) return;
    // Most of a screenful, so a press is worth making, minus enough overlap
    // that the row you were reading is still on screen afterwards.
    el.scrollBy({ top: dir * Math.max(96, el.clientHeight * 0.6), behavior: "smooth" });
  };

  return (
    <div className="sidebar-scroll">
      {reach.overflows && (
        <button
          className={`nav-arrow${reach.atTop ? " spent" : ""}`}
          onClick={() => step(-1)}
          disabled={reach.atTop}
          tabIndex={-1}
          aria-hidden
        >
          <Chevron up />
        </button>
      )}
      <div className="sidebar-nav" ref={box}>
        <div ref={inner}>{children}</div>
      </div>
      {reach.overflows && (
        <button
          className={`nav-arrow${reach.atBottom ? " spent" : ""}`}
          onClick={() => step(1)}
          disabled={reach.atBottom}
          tabIndex={-1}
          aria-hidden
        >
          <Chevron />
        </button>
      )}
    </div>
  );
}

/**
 * Drawn, not typed. The obvious `⌃`/`⌄` are typographic marks rather than
 * arrows: they sit off the optical centre, differ in size between fonts, and on
 * several systems fall back to a face that has nothing to do with the nav. A
 * two-line stroke matches `icons.tsx` exactly — same width, same cap — so the
 * chevrons read as the same family as the icons they sit above and below.
 */
function Chevron({ up = false }: { up?: boolean }) {
  return (
    <svg
      width={13} height={13} viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth={2.4}
      strokeLinecap="round" strokeLinejoin="round"
      aria-hidden focusable="false"
    >
      <path d={up ? "M5 15l7-7 7 7" : "M5 9l7 7 7-7"} />
    </svg>
  );
}
