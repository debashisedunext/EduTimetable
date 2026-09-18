/**
 * §15.3 Phase 25.2 — deciding whether to show anything at all.
 *
 * Mounted once inside the authenticated shell. It asks the server what state
 * this school and this user are in, and renders the welcome screen, the wizard,
 * or nothing.
 *
 * The rule it exists to enforce: **auto-open for a school with no timetable, or
 * an unfinished setup — once per sitting.** The server decides whether there is
 * anything to offer (`shouldPrompt`), because "new" is a question about data and
 * the client has none of it; the client decides it has now been asked.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { markOffered, wasOffered } from "./offered";
import { WelcomeModal, type OnboardingState } from "./WelcomeModal";
import { useNavigate } from "react-router-dom";
import { WINGS_STEP, type SchoolIdentity } from "./OnboardingWizard";
import { OnboardingChat } from "./OnboardingChat";

/**
 * Open the welcome screen from anywhere.
 *
 * A window event rather than a prop: the permanent entry point lives on the
 * Timetables screen, which is several layers below the shell this component is
 * mounted in, and threading a callback through Shell and the router for one
 * button would put onboarding state into components that have nothing to do
 * with it.
 */
export const OPEN_ONBOARDING = "edutt:open-onboarding";

/**
 * Open the three doors — for somebody choosing how to start.
 */
export const openOnboarding = () => window.dispatchEvent(new Event(OPEN_ONBOARDING));

/**
 * Go straight back into an unfinished setup, at the step it was left on.
 *
 * Deliberately NOT the welcome screen. Somebody pressing "Carry on" has already
 * chosen a door and walked through it; showing them the three doors again is
 * asking a question they answered twenty minutes ago. Which door reopens comes
 * from the draft's own `mode`, so a conversation resumes as a conversation.
 */
export const resumeOnboarding = () => window.dispatchEvent(new Event(RESUME_ONBOARDING));
export const RESUME_ONBOARDING = "edutt:resume-onboarding";

export function Onboarding({
  userName,
  canManage,
}: {
  userName: string;
  canManage: boolean;
}) {
  const nav = useNavigate();
  const [state, setState] = useState<OnboardingState | null>(null);
  const [school, setSchool] = useState<SchoolIdentity | null>(null);
  const [view, setView] = useState<"none" | "welcome" | "wizard" | "chat">("none");
  /**
   * Which step the wizard should open at when the conversation hands over.
   *
   * `null` means "wherever the saved draft says", which is the wizard's own
   * behaviour and right for every other way in. The chat sets it because a
   * handover has a specific destination: the first thing it did not ask about.
   */
  const [openAt, setOpenAt] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    if (!canManage) return;
    try {
      const [s, sc] = await Promise.all([
        api<OnboardingState>("/me/onboarding"),
        api<SchoolIdentity>("/school"),
      ]);
      setState(s);
      setSchool(sc);
      return s;
    } catch {
      // Never block the app on this. A school that cannot answer the question
      // simply does not get offered the wizard.
      return null;
    }
  }, [canManage]);

  /**
   * On load: open by itself when the server says so — once per sitting.
   *
   * `shouldPrompt` is a fact about the school and the draft, and it stays true
   * until a timetable exists or the setup is finished. Read literally that means
   * a modal across the screen on every single page load: you close it, navigate,
   * and it is back. A prompt that cannot be got past stops being an offer.
   *
   * So the server decides WHETHER there is something to offer, and the browser
   * decides it has now been offered — for this sitting only (§24.1a). Signing in
   * again re-offers it, which is the point: a school with no timetable is a
   * school that has not started, and it should be met at the door every time
   * until it has. The permanent entry point on the Timetables screen is how
   * anybody asks for it back sooner.
   */
  useEffect(() => {
    refresh().then((s) => {
      if (!s?.shouldPrompt || wasOffered()) return;
      markOffered();
      setView("welcome");
    });
  }, [refresh]);

  // On demand: the permanent entry point, which ignores `shouldPrompt` — the
  // whole point of a button is that you asked for it.
  useEffect(() => {
    /*
      §39.1 — a finished school goes straight to Wings, not to the doors.

      "Set up a timetable" on a school whose every timetable is complete used to
      open a dialog offering to *continue* work that is done, with three ways to
      start a setup that has already happened. The only thing left to do there
      is add a wing, which is step 3 — so that is where it goes.

      `unfinished.length > 0` rather than `isNew`: a school half-way through its
      first timetable still wants the doors, and `isNew` goes false the moment
      step 5 creates the config.
    */
    const open = () => {
      refresh().then((s) => {
        if (s && !s.isNew && (s.unfinished?.length ?? 0) === 0) {
          setOpenAt(WINGS_STEP);
          setView("wizard");
          return;
        }
        setView("welcome");
      });
    };
    // "Carry on" skips the doors and reopens the one already in use. The wizard
    // and the chat both resume from the saved draft on their own, so there is
    // no step to pass — only which of the two to show.
    const resume = () => {
      refresh().then((s) => setView(s?.resumeMode === "ai" ? "chat" : "wizard"));
    };
    window.addEventListener(OPEN_ONBOARDING, open);
    window.addEventListener(RESUME_ONBOARDING, resume);
    return () => {
      window.removeEventListener(OPEN_ONBOARDING, open);
      window.removeEventListener(RESUME_ONBOARDING, resume);
    };
  }, [refresh]);

  /*
    §8.3 — the wizard is a PAGE now, so "open it" means navigate.

    Kept here rather than pushed out to every caller: the welcome screen, the
    "carry on" button and the §24.6 chat hand-over all mean the same thing, and
    each would otherwise have to know the route and its query string. Only the
    answer changed — a URL instead of a piece of local state — so the address
    bar says where you are, Back works, and the setup can be linked to.

    In an effect rather than during render: this component decides to navigate
    as a RESULT of a state change, and setting state while rendering to return a
    redirect is the shape that makes a render loop somebody has to debug later.
  */
  useEffect(() => {
    if (view !== "wizard") return;
    const at = openAt;
    setView("none");
    setOpenAt(null);
    nav(at !== null ? `/guided-setup?at=${at}` : "/guided-setup");
  }, [view, openAt, nav]);

  if (!canManage || view === "none" || view === "wizard" || !state || !school) return null;


  if (view === "chat") {
    return (
      <OnboardingChat
        onSwitchToWizard={(step) => { setOpenAt(step); setView("wizard"); }}
        onClose={() => { setView("none"); refresh(); }}
      />
    );
  }

  return (
    <WelcomeModal
      state={state}
      userName={userName}
      schoolName={school.name}
      onClose={() => setView("none")}
      onStartGuided={() => setView("wizard")}
      onStartChat={() => setView("chat")}
    />
  );
}
