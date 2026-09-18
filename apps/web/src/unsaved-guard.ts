/**
 * §31.10 — "you have unsaved work" for an app that cannot use a router blocker.
 *
 * The Master Grid's Lesson Grid tab edits a draft that is only in the browser
 * until Save. Moving between the five tabs must be free — the edits live in the
 * screen, not in the tab — but *leaving the screen* has to say something first,
 * or work disappears with no way to tell it ever existed.
 *
 * ## Why this is not `useBlocker`
 *
 * React Router's `useBlocker` needs a data router (`createBrowserRouter`), and
 * `main.tsx` mounts a plain `<BrowserRouter>` around `<Routes>`. Converting the
 * app's routing to data routers to guard one screen is a large change with a
 * blast radius across every route, for a small feature — so the guard is a
 * module-level registration instead: one screen may say "ask me before you
 * navigate", the nav asks, and nothing else in the app knows.
 *
 * Deliberately ONE slot rather than a set. Two screens claiming the guard at
 * once means one of them failed to unregister, and a silently-stacked second
 * prompt is a worse bug than the loud overwrite this gives.
 */

type Ask = () => boolean;

let ask: Ask | null = null;

/**
 * Claim the guard. Returns the release function — call it on unmount, or the
 * prompt outlives the screen that owned it.
 *
 * @param fn returns true when it is safe to leave, and is expected to have
 *   asked the person itself when it is not.
 */
export function guardUnsaved(fn: Ask): () => void {
  ask = fn;
  return () => {
    // Only release if it is still ours: a screen unmounting *after* another
    // has claimed the guard would otherwise clear somebody else's.
    if (ask === fn) ask = null;
  };
}

/** May the app navigate away? True when nothing is guarding, or the guard agrees. */
export function mayLeave(): boolean {
  return ask === null || ask();
}
