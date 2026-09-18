/**
 * §8.8 — the navigation on a phone.
 *
 * ## Why not the rail, and why not the toolbar
 *
 * The 236px navy rail is a third of a phone's width before any content, and its
 * collapsed form depends on a hover flyout to name anything — there is no hover
 * on a touch screen, so the icons would be unlabelled and unexplainable. §8.6's
 * toolbar is a horizontal strip of twelve, which at 400px shows three and asks
 * somebody to swipe a navigation bar to find the rest.
 *
 * So on a phone: **five destinations along the bottom, and everything else one
 * press away in a sheet.** The bottom edge is where a thumb rests; the five are
 * the ones a person opens daily.
 *
 * The sheet is opened by the TOP BAR's hamburger, not by a sixth slot down
 * here: that is also where the school and timetable pickers went, and two
 * controls opening one sheet is a question answered in two places.
 *
 * ## It is still one nav definition
 *
 * This renders from the same permission-filtered `groups` the rail and the
 * toolbar render from, and the five are the **first five of `TOP_BAR` this role
 * actually holds** — derived, never a third hand-written list. A screen removed
 * from `NAV` disappears from all three; a role without `timetable.publish`
 * never sees Publish in any of them (§8.6's rule, which this must not be the
 * exception to).
 *
 * ## The sheet is the whole rail, not a menu of leftovers
 *
 * It carries every group under its own heading, plus the two things the rail
 * kept at its foot and nothing else on a phone would have: who is signed in,
 * and the way out.
 */
import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { Icon, type IconName } from "./icons";
import { mayLeave } from "./unsaved-guard";

export interface MobileNavEntry {
  icon: IconName;
  label: string;
  short?: string;
  to: string;
}
export interface MobileNavGroup {
  label: string;
  items: readonly MobileNavEntry[];
}

export function MobileNav({
  groups, bar, here, open, setOpen, pickers, who, role, onSignOut,
}: {
  /** Every group this role may see — the same list the rail renders. */
  groups: MobileNavGroup[];
  /** The five along the bottom, chosen by the caller out of `groups`. */
  bar: MobileNavEntry[];
  /** The route that counts as current, §8.6's `STANDS_FOR` already applied. */
  here: string;
  open: boolean;
  setOpen: (v: boolean) => void;
  /**
   * §8.8 — the school and timetable pickers, at the top of the sheet.
   *
   * Passed in rather than built here: `SchoolPicker` knows about ERP grants,
   * local accounts and trusts, and the timetable picker knows about §30.5 date
   * windows. A second copy of either on a phone would be a second set of rules
   * about who may switch what.
   */
  pickers?: React.ReactNode;
  who: string;
  role: string;
  onSignOut: () => void;
}) {
  const { pathname } = useLocation();
  // Arriving somewhere closes the sheet. A full-screen menu still covering the
  // screen it just navigated to is the page nobody can see.
  useEffect(() => { setOpen(false); }, [pathname, setOpen]);

  /*
    The body does not scroll behind an open sheet.

    On a phone this is not a nicety: the sheet is `position: fixed`, so without
    it a scroll gesture over the menu moves the page underneath and the reader
    arrives back at a different screen position than they left.
  */
  useEffect(() => {
    if (!open) return;
    const had = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = had; };
  }, [open]);

  return (
    <>
      <nav className="mnav" aria-label="Main">
        {bar.map((i) => (
          <Link
            key={i.to}
            to={i.to}
            className={`mnav-item${i.to === here ? " active" : ""}`}
            aria-current={i.to === here ? "page" : undefined}
            // §31.10 — the same guard every other door carries.
            onClick={(e) => { if (!mayLeave()) e.preventDefault(); }}
          >
            <Icon name={i.icon} size={21} />
            <span>{i.short ?? i.label}</span>
          </Link>
        ))}
        {/*
          §8.8 — no Menu button here.

          The sheet is opened by the top bar's hamburger, which is where the
          school and timetable pickers went. Two controls opening the same
          sheet is one question answered in two places, so the slot it used to
          take went back to being a destination — five along the bottom rather
          than four and a door.
        */}
      </nav>

      {open && (
        <div className="msheet" role="dialog" aria-modal="true" aria-label="All screens">
          <div className="msheet-head">
            <div>
              <div className="msheet-who">{who}</div>
              <div className="msheet-role">{role}</div>
            </div>
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
          <div className="msheet-body">
            {/* What you are looking at, before where you can go: switching
                school or timetable changes what every one of those screens is
                about. */}
            {pickers && <div className="msheet-pickers">{pickers}</div>}
            {groups.map((g) => (
              <div key={g.label}>
                <div className="msheet-group">{g.label}</div>
                {g.items.map((i) => (
                  <Link
                    key={i.to}
                    to={i.to}
                    className={`msheet-item${i.to === here ? " active" : ""}`}
                    aria-current={i.to === here ? "page" : undefined}
                    onClick={(e) => { if (!mayLeave()) e.preventDefault(); }}
                  >
                    <Icon name={i.icon} size={17} />
                    <span>{i.label}</span>
                  </Link>
                ))}
              </div>
            ))}
            <button type="button" className="msheet-out" onClick={onSignOut}>
              ⏻ Sign out
            </button>
          </div>
        </div>
      )}
    </>
  );
}
