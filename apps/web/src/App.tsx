import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { PERMISSIONS, type MeResponse } from "@edutimetable/shared";
import { api, getToken, setToken } from "./api";
import { ConfigContext, type TimetableConfigSummary } from "./hooks";
import { Shell } from "./Shell";
import { Dashboard } from "./pages/Dashboard";
import { DevLogin } from "./pages/DevLogin";
import { Timetables } from "./pages/Timetables";
import { Setup } from "./pages/Setup";
import { Readiness } from "./pages/Readiness";
import { Roles } from "./pages/Roles";
import { Generate } from "./pages/Generate";
import { Matrix } from "./pages/Matrix";
import { Board } from "./pages/Board";
import { Publish } from "./pages/Publish";
import { Substitutes } from "./pages/Substitutes";
import { Reports } from "./pages/Reports";
import { Notifications } from "./pages/Notifications";
import { MyClasses, MyTimetable } from "./pages/MyViews";
import { AskAi } from "./pages/AskAi";
import { AiSettings } from "./pages/AiSettings";

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
      {!authed || !me ? (
        <Route path="*" element={<DevLogin />} />
      ) : (
        <Route
          element={
            <ConfigContext.Provider value={ctx}>
              <Shell me={me} />
            </ConfigContext.Provider>
          }
        >
          <Route path="/" element={
            me.permissions.includes(PERMISSIONS.MASTERS_MANAGE) ? <Timetables />
            : me.permissions.includes(PERMISSIONS.TIMETABLE_VIEW_OWN) ? <MyTimetable />
            : <Dashboard me={me} />
          } />
          <Route path="/setup" element={<Setup />} />
          <Route path="/readiness" element={<Readiness />} />
          <Route path="/generate" element={<Generate />} />
          <Route path="/matrix" element={<Matrix />} />
          <Route path="/board" element={<Board />} />
          <Route path="/publish" element={<Publish />} />
          <Route path="/substitutes" element={<Substitutes />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/notifications" element={<Notifications />} />
          <Route path="/my-timetable" element={<MyTimetable />} />
          <Route path="/my-classes" element={<MyClasses />} />
          <Route path="/ask-ai" element={<AskAi />} />
          <Route path="/ai-settings" element={<AiSettings />} />
          <Route path="/roles" element={<Roles />} />
          <Route path="/system" element={<Dashboard me={me} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      )}
    </Routes>
  );
}
