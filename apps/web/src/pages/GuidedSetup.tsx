/**
 * §8.3 — the guided setup, as a page.
 *
 * It was a dialog over whatever you were looking at, and by §24.5d it had grown
 * to exactly the size and position of the pane beside the nav: a "modal" filling
 * the whole content area and dimming a strip of navigation nobody was reading.
 * At that point the overlay costs things and buys none — focus is trapped, the
 * URL does not say where you are, Back does not close it, and a school works
 * inside it for an hour rather than answering a question and dismissing it.
 *
 * So it is routed. `/guided-setup` opens at the saved step; `/allocation` opens
 * the same wizard at step 9, which is what makes that nav entry a screen rather
 * than an announcement. The dialog form is kept for the welcome flow, which
 * genuinely is a hand-over from something else.
 */
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { Card } from "../components";
import { OnboardingWizard, type SchoolIdentity } from "../onboarding/OnboardingWizard";

export function GuidedSetup({ startAt = null }: { startAt?: number | null }) {
  const nav = useNavigate();
  /*
    `?at=` is how the welcome flow and the §24.6 chat hand-over say WHERE to
    open, now that opening is navigation rather than local state. A prop wins
    over it, because `/allocation` is a fixed destination rather than a resumed
    position.
  */
  const [params] = useSearchParams();
  const atQ = params.get("at");
  const openAt = startAt ?? (atQ !== null && /^\d+$/.test(atQ) ? Number(atQ) : null);
  /*
    §3.10a — and WHICH wing step 4 opens on, for somebody arriving from "New
    Timetable". Alongside `at` rather than inside it because they answer
    different questions, and only step 4 has a use for the second.
  */
  const openWing = params.get("wing");

  const [school, setSchool] = useState<SchoolIdentity | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    api<SchoolIdentity>("/school")
      .then((s) => { if (live) setSchool(s); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);

  if (failed) {
    return (
      <Card title="Guided setup">
        <p className="screen-sub">
          This school could not be loaded. Reload the page, or pick a school in the top bar.
        </p>
      </Card>
    );
  }
  if (!school) return <p className="screen-sub">Loading…</p>;

  return (
    <OnboardingWizard
      school={school}
      startAt={openAt}
      startWing={openWing}
      inline
      /*
        Finishing goes to the Timetables screen — the thing the setup was for.
        Closing without finishing goes back, because as a page it was navigated
        to and Back is what a person expects; it also keeps the history honest
        for somebody who arrived here from Readiness or the Board.
      */
      onClose={(reason) => { if (reason === "saved") nav("/"); else nav(-1); }}
    />
  );
}
