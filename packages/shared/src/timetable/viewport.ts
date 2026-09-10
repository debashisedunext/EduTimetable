/**
 * §31.8 — which rows of a long grid are worth drawing.
 *
 * The Master Grid's Teachers tab on the reference school is **122 rows x 56
 * columns = 6,832 cells**, every one of them a `<td>`. The Allocation Matrix
 * gets away with ~2,750 today; this does not, and CLAUDE.md has listed grid
 * virtualisation as outstanding debt since §14 was written.
 *
 * ## Why this is thirty lines and not `react-window`
 *
 * CLAUDE.md names `react-window` / AG Grid as the sanctioned answer, and for a
 * generic grid it is. This grid is not generic in the one way that matters:
 * `react-window` renders absolutely-positioned `<div>`s, and everything that
 * makes §31 correct is table machinery —
 *
 *  - a `<colgroup>` of **percentages**, which is what makes "no horizontal
 *    scroll" a property of the layout rather than a hope about the viewport
 *    (§31.1);
 *  - two `position: sticky` header rows, the first of them using `colSpan` to
 *    group a day's periods;
 *  - a `position: sticky` first column.
 *
 * Rebuilding those three as positioned divs to gain a dependency would trade a
 * working layout for a library that cannot render a `<tr>`. Windowing a table
 * body with two spacer rows keeps all of it, and the arithmetic is small enough
 * to test exhaustively — which is what this file is.
 *
 * ## The one thing that has to be right
 *
 * The spacers stand in for the rows that are not drawn, so **the height they
 * reserve must be the height those rows would have had**. That is two
 * independently-computed heights having to agree, which §10.6 records as the
 * shape to avoid: a CSS row height and a JavaScript constant drift the moment
 * anybody adjusts padding, and the symptom is a scrollbar that lies.
 *
 * So the caller does not pass a constant — it passes a height **measured from a
 * rendered row**. There is then only one height, and this module is pure
 * arithmetic over it.
 */

export interface RowWindowInput {
  /** How many rows the filtered list holds. */
  total: number;
  /** Measured from a rendered row, never assumed — see the note above. */
  rowHeight: number;
  /** The scroll container's current `scrollTop`. */
  scrollTop: number;
  /** The scroll container's visible height. */
  viewportHeight: number;
  /**
   * Rows drawn beyond each edge. Six is about a quarter of a screenful at this
   * row height: enough that a flick of the wheel lands on drawn rows, few
   * enough that the saving is still most of the grid.
   */
  overscan?: number;
  /**
   * The height of the sticky header, which sits *inside* the scroll container
   * and therefore covers the first rows. Without it the window is computed for
   * a viewport two rows taller than the one anybody can see, and the bottom
   * two rows of every screenful arrive blank.
   */
  headerHeight?: number;
}

export interface RowWindow {
  /** First row index to render. */
  start: number;
  /** One past the last row index to render. */
  end: number;
  /** Height of the spacer row above, in px. */
  padTop: number;
  /** Height of the spacer row below, in px. */
  padBottom: number;
}

export const DEFAULT_OVERSCAN = 6;

/**
 * The slice to draw, and the two spacers that hold the scrollbar honest.
 *
 * Degenerate by design: a list shorter than the viewport returns the whole of
 * itself with both spacers at zero, so a ten-teacher school renders exactly
 * what it rendered before windowing existed. That is deliberate — one code
 * path, always exercised, rather than a threshold that leaves the windowed
 * branch untested on every school small enough to develop against.
 */
export function rowWindow({
  total,
  rowHeight,
  scrollTop,
  viewportHeight,
  overscan = DEFAULT_OVERSCAN,
  headerHeight = 0,
}: RowWindowInput): RowWindow {
  /*
    Not measured yet → draw everything. FAIL SAFE, and it is worth being
    explicit about why `viewportHeight` is in this guard and not only
    `rowHeight`.

    A viewport of zero is arithmetically valid: it yields `ceil(0 / rowHeight)
    + 1` rows plus the overscan, which is about seven. Seven rows of fifty-six
    is not obviously a bug from the outside — it looks like a grid, it scrolls,
    and the missing forty-nine are simply absent. That is exactly what happened
    when the caller's observer failed to attach, and nothing anywhere reported
    it.

    So a height nobody has measured is treated as unknown rather than as zero,
    and an unknown height renders the whole list: the worst outcome becomes a
    slower first paint instead of a screen that quietly lies about the school.
  */
  if (!Number.isFinite(rowHeight) || rowHeight <= 0 || viewportHeight <= 0 || total <= 0) {
    return { start: 0, end: Math.max(0, total), padTop: 0, padBottom: 0 };
  }
  const visible = Math.max(0, viewportHeight - headerHeight);
  const first = Math.floor(Math.max(0, scrollTop - headerHeight) / rowHeight);
  const count = Math.ceil(visible / rowHeight) + 1;
  const start = Math.max(0, first - overscan);
  const end = Math.min(total, first + count + overscan);
  return {
    start,
    end,
    padTop: start * rowHeight,
    // From `end`, not from `total - count`: `end` is already clamped, and
    // deriving the bottom spacer from anything else is how the two stop adding
    // up to the list's real height.
    padBottom: (total - end) * rowHeight,
  };
}

/**
 * Where to scroll so row `index` is visible — or null when it already is.
 *
 * Needed because §31.6's arrow keys move the selection through the *data*, and
 * with windowing the row they move to may not be in the DOM at all. Without
 * this, ArrowDown past the bottom of the screen selects a row nobody can see
 * and the grid appears frozen while the strip changes underneath it.
 *
 * Returning null rather than the current `scrollTop` matters: assigning
 * `scrollTop` on every keystroke cancels the browser's own smooth scrolling and
 * fights any scroll already in flight.
 */
export function scrollTopFor(
  index: number,
  { rowHeight, scrollTop, viewportHeight, headerHeight = 0 }: Omit<RowWindowInput, "total" | "overscan">,
): number | null {
  if (!Number.isFinite(rowHeight) || rowHeight <= 0 || index < 0) return null;
  // A header taller than its own scroll box leaves no visible band at all, so
  // there is nowhere to bring the row TO. Scrolling anyway would move the grid
  // to a position no better than the one it was in.
  if (viewportHeight - headerHeight <= 0) return null;
  const top = index * rowHeight;
  const bottom = top + rowHeight;
  // The header floats over the top of the scroll box, so a row is only really
  // visible once it clears it.
  const seenFrom = scrollTop;
  const seenTo = scrollTop + viewportHeight - headerHeight;
  if (top >= seenFrom && bottom <= seenTo) return null;
  // Above the fold: bring it to the top. Below: bring it to the bottom, which
  // keeps the direction of travel — jumping the row to the top when arrowing
  // downwards moves everything the reader was comparing it with.
  return top < seenFrom ? top : Math.max(0, bottom - viewportHeight + headerHeight);
}
