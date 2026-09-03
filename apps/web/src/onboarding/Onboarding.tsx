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

  // On load: open by itself only when the server says so.
  useEffect(() => {
    refresh().then((s) => { if (s?.shouldPrompt) setView("welcome"); });
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
