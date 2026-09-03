/**
 * §15.3 Phase 25.2 — deciding whether to show anything at all.
 *
 * Mounted once inside the authenticated shell. It asks the server what state
 * this school and this user are in, and renders the welcome screen, the wizard,
 * or nothing.
 *
 * The rule it exists to enforce: **auto-open only for a genuinely empty school
 * that this person has not waved away.** The server decides (`shouldPrompt`),
 * because "new" is a question about data and the client has none of it — and
 * because a second definition here would drift from the first.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { WelcomeModal, type OnboardingState } from "./WelcomeModal";
import { OnboardingWizard, type SchoolIdentity } from "./OnboardingWizard";
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

/** "This tab has already been offered the welcome screen." */
const OFFERED_KEY = "edutt.onboardingOffered";
export const openOnboarding = () => window.dispatchEvent(new Event(OPEN_ONBOARDING));

export function Onboarding({
  userName,
  canManage,
}: {
  userName: string;
  canManage: boolean;
}) {
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
   * On load: open by itself only when the server says so — and only ONCE.
   *
   * `shouldPrompt` is a fact about the school and the draft, and it stays true
   * until the setup is finished or thrown away. Read literally that means a
   * modal across the screen on every single page load, which is what an
   * unfinished setup actually produced: you close it, navigate, and it is back.
   * A prompt that cannot be got past stops being an offer.
   *
   * So the server still decides WHETHER there is something to offer, and the
   * browser decides it has now been offered. Per tab rather than remembered
   * server-side, because "I have seen this" is a fact about this sitting, not
   * about the person — tomorrow it should say so again. The permanent entry
   * point on the Timetables screen is how anybody asks for it back.
   */
  useEffect(() => {
    refresh().then((s) => {
      if (!s?.shouldPrompt) return;
      try {
        if (sessionStorage.getItem(OFFERED_KEY)) return;
        sessionStorage.setItem(OFFERED_KEY, "1");
      } catch {
        // A browser refusing storage should still see the welcome screen; it
        // is the nagging that is the problem, not the offer.
      }
      setView("welcome");
    });
  }, [refresh]);

  // On demand: the permanent entry point, which ignores `shouldPrompt` — the
  // whole point of a button is that you asked for it.
  useEffect(() => {
    const open = () => { refresh().then(() => setView("welcome")); };
    window.addEventListener(OPEN_ONBOARDING, open);
    return () => window.removeEventListener(OPEN_ONBOARDING, open);
  }, [refresh]);

  if (!canManage || view === "none" || !state || !school) return null;

  if (view === "wizard") {
    return (
      <OnboardingWizard
        school={school}
        startAt={openAt}
        onClose={() => { setView("none"); setOpenAt(null); refresh(); }}
      />
    );
  }

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
