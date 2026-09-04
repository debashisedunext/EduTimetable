/**
 * §24.1a — "has this sitting already been shown the welcome screen?"
 *
 * The server decides whether there is anything to offer: a school with no
 * timetable, or an unfinished draft. Read literally that is true on every page
 * load, so something has to decide it has now been *asked*, and this is it.
 *
 * Two properties, both deliberate:
 *
 *  - **Per sitting, not per person.** `sessionStorage`, so closing the modal
 *    quiets it while you work and the next sign-in offers it again. A school
 *    with no timetable has not started using the product yet, and an offer that
 *    appears once and never returns leaves the app's one job behind a button
 *    nobody has a reason to look for. This is what "I'll do this later" means:
 *    later, not never.
 *  - **Cleared whenever a session into a school begins** — sign-in, SSO,
 *    entering a school, creating one, switching. That is what makes a fresh
 *    login a fresh offer even in a tab that has been open all day, and it is
 *    why `setToken` calls this rather than each of the five entry points
 *    remembering to.
 *
 * Its own module because `api.ts` needs it and it must not drag the onboarding
 * components in behind it — `Onboarding.tsx` already imports `api`.
 */
const OFFERED_KEY = "edutt.onboardingOffered";

/** True once this sitting has already been shown the welcome screen. */
export const wasOffered = (): boolean => {
  try {
    return sessionStorage.getItem(OFFERED_KEY) === "1";
  } catch {
    // A browser refusing storage should still see the welcome screen; it is the
    // nagging that is the problem, not the offer.
    return false;
  }
};

export const markOffered = (): void => {
  try {
    sessionStorage.setItem(OFFERED_KEY, "1");
  } catch { /* see above */ }
};

/** A new session into a school: this sitting has not been offered anything yet. */
export const clearOffered = (): void => {
  try {
    sessionStorage.removeItem(OFFERED_KEY);
  } catch { /* see above */ }
};
