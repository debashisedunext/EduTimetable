import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { AcceptInvite, Forgot, Home, ResetPassword, MySchools, SignIn, SignUp, Verify } from "./pages/PublicAuth";
import { PERMISSIONS, type MeResponse } from "@edutimetable/shared";
import { api, getToken, setToken } from "./api";
import { ConfigContext, type TimetableConfigSummary } from "./hooks";
import { ColorProvider } from "./colors";
import { Shell } from "./Shell";
import { Dashboard } from "./pages/Dashboard";
import { DevLogin } from "./pages/DevLogin";
import { Timetables } from "./pages/Timetables";
import { Setup } from "./pages/Setup";
import { Readiness } from "./pages/Readiness";
import { Roles } from "./pages/Roles";
import { Users } from "./pages/Users";
import { Generate } from "./pages/Generate";
import { Matrix } from "./pages/Matrix";
import { Board } from "./pages/Board";
import { Publish } from "./pages/Publish";
import { Substitutes } from "./pages/Substitutes";
import { ExtraClasses } from "./pages/ExtraClasses";
import { Reports } from "./pages/Reports";
import { Notifications } from "./pages/Notifications";
import { MyClasses, MyTimetable } from "./pages/MyViews";
import { AskAi } from "./pages/AskAi";
import { AiSettings } from "./pages/AiSettings";
import { ImportMasters } from "./pages/ImportMasters";
import { SyncErp } from "./pages/SyncErp";
import { Electives } from "./pages/Electives";
import { Availability } from "./pages/Availability";
import { AiDock } from "./ai/AiDock";
import { Onboarding } from "./onboarding/Onboarding";
import { SchoolProfile } from "./pages/SchoolProfile";
import { Platform } from "./pages/Platform";

/** Captures the session token from the SSO redirect fragment (§15.1). */
function SsoCapture() {
  const navigate = useNavigate();
  const { hash } = useLocation();
  useEffect(() => {
    const token = new URLSearchParams(hash.replace(/^#/, "")).get("token");
    if (token) setToken(token);
    navigate("/", { replace: true });
    window.location.reload();
  }, [hash, navigate]);
  return null;
}

function SsoError() {
  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1>Sign-in failed</h1>
        <p className="login-sub">
          Your SSO link was invalid or expired. Please return to the Edunext ERP and open the
          Timetable module again — this application has no login of its own.
        </p>
      </div>
    </div>
  );
}

export default function App() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [configs, setConfigs] = useState<TimetableConfigSummary[]>([]);
  const [currentId, setCurrentId] = useState<number | null>(
    Number(localStorage.getItem("edutt.configId")) || null,
  );
  const authed = Boolean(getToken());

  const canSeeConfigs = me?.permissions.includes(PERMISSIONS.TIMETABLE_GENERATE);

  const refetchConfigs = useCallback(() => {
    if (!canSeeConfigs) return;
    api<TimetableConfigSummary[]>("/timetable-configs").then(setConfigs).catch(() => {});
  }, [canSeeConfigs]);

  useEffect(() => {
    if (!authed) {
      setLoading(false);
      return;
    }
    api<MeResponse>("/me")
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setLoading(false));
  }, [authed]);

  useEffect(refetchConfigs, [refetchConfigs]);

  const ctx = useMemo(() => {
    const current = configs.find((c) => c.id === currentId) ?? configs[0] ?? null;
    return {
      configs,
      current,
      setCurrentId: (id: number) => {
        localStorage.setItem("edutt.configId", String(id));
        setCurrentId(id);
      },
      refetch: refetchConfigs,
    };
  }, [configs, currentId, refetchConfigs]);

  if (loading) return null;

  return (
    <Routes>
      <Route path="/sso" element={<SsoCapture />} />
      <Route path="/sso-error" element={<SsoError />} />
      {/* §15.3 Phase 25.0 — the second way in. These sit OUTSIDE the
          authenticated shell on purpose: whoever is on them may have no
          account at all, so anything reading `me` would crash. They are
          declared before the authed branch so they resolve whether or not a
          session exists — a signed-in user opening /login should still see the
          form rather than being bounced by the catch-all. */}
      <Route path="/signup" element={<SignUp />} />
      <Route path="/login" element={<SignIn />} />
      <Route path="/forgot" element={<Forgot />} />
      <Route path="/verify" element={<Verify />} />
      <Route path="/reset" element={<ResetPassword />} />
      {/* §24.8 — the token is in the PATH, not a query string: an invitation
          link is pasted into chat as often as it is clicked in a mail client,
          and a path survives that intact. */}
      <Route path="/invite/:token" element={<AcceptInvite />} />
      {/* Declared OUTSIDE the authed branch, with the other account-level
          screens. It was inside it, so somebody already in a school who
          followed the top bar's school name fell through to the app shell's
          catch-all and landed back where they started — looking, from the
          outside, exactly like the button did nothing. My Schools is about the
          ACCOUNT, not about any school, so having a session must not hide it. */}
      <Route path="/schools" element={<MySchools />} />
      {!authed || !me ? (
        <>
          <Route path="/" element={<Home />} />
          {/* the dev SSO shortcut stays reachable, but is no longer what a
              stranger meets at the front door */}
          <Route path="*" element={<DevLogin />} />
        </>
      ) : (
        <Route
          element={
            <ConfigContext.Provider value={ctx}>
              {/* §10.5 — the school's subject/class colours, resolved once for
                  every screen so they cannot disagree. */}
              <ColorProvider>
                <Shell me={me} />
                {/* §13.5 — the assistant, reachable from every screen. It
                    renders nothing without ai.chat, and the drafting tools
                    appear only with masters.manage — enforced on the server,
                    not here. */}
                <AiDock permissions={me.permissions} />
                {/* §15.3 Phase 25.2 — the welcome screen and the guided setup.
                    Opens by itself for a school with no timetable — every
                    sign-in, once per sitting (§24.1a) — and only for somebody
                    who could act on it. The server decides whether there is
                    anything to offer; a second definition of "new" here would
                    drift from it. */}
                <Onboarding
                  userName={me.name}
                  canManage={me.permissions.includes(PERMISSIONS.MASTERS_MANAGE)}
                />
              </ColorProvider>
            </ConfigContext.Provider>
          }
        >
          <Route path="/" element={
            me.permissions.includes(PERMISSIONS.MASTERS_MANAGE) ? <Timetables me={me} />
            : me.permissions.includes(PERMISSIONS.TIMETABLE_VIEW_OWN) ? <MyTimetable />
            : <Dashboard me={me} />
          } />
          <Route path="/setup" element={<Setup />} />
          <Route path="/import" element={<ImportMasters />} />
          <Route path="/sync" element={<SyncErp />} />
          <Route path="/electives" element={<Electives />} />
          <Route path="/availability" element={<Availability />} />
          <Route path="/readiness" element={<Readiness />} />
          <Route path="/generate" element={<Generate />} />
          <Route path="/matrix" element={<Matrix />} />
          <Route path="/board" element={<Board />} />
          <Route path="/publish" element={<Publish />} />
          <Route path="/substitutes" element={<Substitutes />} />
          <Route path="/extra-classes" element={<ExtraClasses />} />
          <Route path="/reports" element={<Reports me={me} />} />
          <Route path="/notifications" element={<Notifications />} />
          <Route path="/my-timetable" element={<MyTimetable />} />
          <Route path="/my-classes" element={<MyClasses />} />
          <Route path="/ask-ai" element={<AskAi />} />
          <Route path="/ai-settings" element={<AiSettings />} />
          <Route path="/school" element={<SchoolProfile me={me} />} />
          <Route path="/platform" element={<Platform />} />
          <Route path="/roles" element={<Roles />} />
          <Route path="/users" element={<Users />} />
          <Route path="/system" element={<Dashboard me={me} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      )}
    </Routes>
  );
}
