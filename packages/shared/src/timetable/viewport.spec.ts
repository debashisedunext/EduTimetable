import { describe, expect, it } from "vitest";
import { DEFAULT_OVERSCAN, rowWindow, scrollTopFor } from "./viewport";

/**
 * The reference school's Teachers tab, as it actually is: 122 teachers, 56
 * columns (5 days x 11 periods plus the row header), rows 23px tall, in a 74vh
 * pane on a 1080px screen, with the two sticky header rows taking 48 of it.
 */
const REFERENCE = {
  total: 122,
  columns: 56,
  rowHeight: 23,
  viewportHeight: 700,
  headerHeight: 48,
};

describe("§31.8 windowing the grid body", () => {
  it("draws a fraction of the reference school, and the fraction is the point", () => {
    const w = rowWindow({ ...REFERENCE, scrollTop: 0 });
    const drawn = w.end - w.start;
    const cells = drawn * REFERENCE.columns;
    const before = REFERENCE.total * REFERENCE.columns;

    // The measurement this stage exists for, stated as a number rather than as
    // a hope. 6,832 cells is what the screen built before; this is what it
    // builds now, and the assertion is a ceiling so the saving cannot quietly
    // erode.
    expect(before).toBe(6832);
    expect(cells).toBeLessThan(before / 2);
    expect(cells).toBeLessThanOrEqual(2100);
    // ...and it must still fill the screen. A window that drew four rows would
    // pass every assertion above and be useless.
    expect(drawn * REFERENCE.rowHeight).toBeGreaterThan(REFERENCE.viewportHeight - REFERENCE.headerHeight);
  });

  it("reserves exactly the height of the rows it did not draw", () => {
    // The scrollbar is the whole contract: if the spacers and the drawn rows do
    // not add up to the list's real height, the scrollbar lies and the bottom
    // of the list becomes unreachable.
    for (const scrollTop of [0, 100, 517, 1200, 2600, 99999]) {
      const w = rowWindow({ ...REFERENCE, scrollTop });
      const drawn = (w.end - w.start) * REFERENCE.rowHeight;
      expect(w.padTop + drawn + w.padBottom).toBe(REFERENCE.total * REFERENCE.rowHeight);
      expect(w.padTop).toBeGreaterThanOrEqual(0);
      expect(w.padBottom).toBeGreaterThanOrEqual(0);
    }
  });

  it("keeps the row under the pointer drawn, wherever the scroll is", () => {
    // A property over the whole scroll range: whatever is visible must have
    // been rendered. This is the assertion that catches an off-by-one in the
    // header offset, which shows up as blank rows at one edge only.
    const maxScroll = REFERENCE.total * REFERENCE.rowHeight;
    for (let scrollTop = 0; scrollTop <= maxScroll; scrollTop += 17) {
      const w = rowWindow({ ...REFERENCE, scrollTop });
      const firstVisible = Math.floor(Math.max(0, scrollTop - REFERENCE.headerHeight) / REFERENCE.rowHeight);
      const lastVisible = Math.min(
        REFERENCE.total - 1,
        Math.floor((scrollTop + REFERENCE.viewportHeight - REFERENCE.headerHeight) / REFERENCE.rowHeight),
      );
      if (firstVisible > REFERENCE.total - 1) continue;
      expect(w.start).toBeLessThanOrEqual(firstVisible);
      expect(w.end).toBeGreaterThan(lastVisible);
    }
  });

  it("renders a short list whole, exactly as before windowing existed", () => {
    // One code path, always exercised. A threshold would leave the windowed
    // branch untested on every school small enough to develop against.
    const w = rowWindow({ total: 8, rowHeight: 23, scrollTop: 0, viewportHeight: 700, headerHeight: 48 });
    expect(w).toEqual({ start: 0, end: 8, padTop: 0, padBottom: 0 });
  });

  it("draws everything when the row height has not been measured yet", () => {
    // Before the first paint there is no measured height. Drawing the whole
    // list is what the screen did before this file existed, so the first frame
    // is correct and the second is merely cheaper.
    for (const rowHeight of [0, -1, NaN, Infinity]) {
      const w = rowWindow({ total: 122, rowHeight, scrollTop: 0, viewportHeight: 700 });
      expect(w).toEqual({ start: 0, end: 122, padTop: 0, padBottom: 0 });
    }
    expect(rowWindow({ total: 0, rowHeight: 23, scrollTop: 0, viewportHeight: 700 }))
      .toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 });
  });

  it("draws everything when the VIEWPORT has not been measured either", () => {
    /*
      The regression this exists for. A viewport of zero is arithmetically
      valid — it yields about seven rows — and seven rows of fifty-six looks
      like a grid rather than like a bug: it scrolls, it has headers, and the
      missing forty-nine are simply not there. It is what a caller whose resize
      observer never attached actually produced, with nothing reporting it.

      Unknown is not zero, and the safe answer to unknown is all of it.
    */
    const w = rowWindow({ total: 56, rowHeight: 23, scrollTop: 0, viewportHeight: 0, headerHeight: 48 });
    expect(w).toEqual({ start: 0, end: 56, padTop: 0, padBottom: 0 });
    expect(rowWindow({ total: 56, rowHeight: 23, scrollTop: 0, viewportHeight: -1 }).end).toBe(56);
  });

  it("accounts for the sticky header, which covers the top of its own scroll box", () => {
    // Without the offset the window is computed for a viewport two rows taller
    // than anyone can see, and the last rows of every screenful arrive blank.
    const withHeader = rowWindow({ ...REFERENCE, scrollTop: 0, overscan: 0 });
    const without = rowWindow({ ...REFERENCE, headerHeight: 0, scrollTop: 0, overscan: 0 });
    expect(withHeader.end).toBeLessThan(without.end);
  });

  it("overscans on both sides, so a flick of the wheel lands on drawn rows", () => {
    const mid = rowWindow({ ...REFERENCE, scrollTop: 1000 });
    const none = rowWindow({ ...REFERENCE, scrollTop: 1000, overscan: 0 });
    expect(none.start - mid.start).toBe(DEFAULT_OVERSCAN);
    expect(mid.end - none.end).toBe(DEFAULT_OVERSCAN);
  });
});

describe("§31.8 bringing an arrowed-to row into view", () => {
  const at = (index: number, scrollTop: number) =>
    scrollTopFor(index, { rowHeight: 23, scrollTop, viewportHeight: 700, headerHeight: 48 });

  it("does nothing when the row is already visible", () => {
    // Returning the current scrollTop instead of null would cancel the
    // browser's own scrolling on every keystroke.
    expect(at(5, 0)).toBeNull();
    expect(at(20, 0)).toBeNull();
  });

  it("brings a row above the fold to the top", () => {
    expect(at(3, 500)).toBe(69);
  });

  it("brings a row below the fold to the BOTTOM, keeping the direction of travel", () => {
    // Jumping it to the top would move everything the reader was comparing it
    // with — the row they arrowed away from included.
    const want = at(40, 0);
    expect(want).toBe(40 * 23 + 23 - 700 + 48);
    // and the row really is inside the visible band afterwards
    expect(at(40, want!)).toBeNull();
  });

  it("never asks for a negative scroll", () => {
    expect(at(0, 400)).toBe(0);
  });

  it("gives up when the header is taller than its own scroll box", () => {
    // Degenerate, but the alternative is worse than doing nothing: with no
    // visible band there is nowhere to bring the row TO, and the arithmetic
    // happily produces a scroll position no better than the current one.
    expect(scrollTopFor(0, { rowHeight: 23, scrollTop: 0, viewportHeight: 100, headerHeight: 200 })).toBeNull();
  });

  it("refuses an unmeasured row height rather than jumping to zero", () => {
    expect(scrollTopFor(9, { rowHeight: 0, scrollTop: 500, viewportHeight: 700 })).toBeNull();
    expect(scrollTopFor(-1, { rowHeight: 23, scrollTop: 500, viewportHeight: 700 })).toBeNull();
  });
});
