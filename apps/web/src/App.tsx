import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import type { MeResponse } from "@edutimetable/shared";
import { api, getToken, setToken } from "./api";
import { Shell } from "./Shell";
import { Dashboard } from "./pages/Dashboard";
import { DevLogin } from "./pages/DevLogin";

/** Captures the session token from the SSO redirect fragment (§15.1). */
function SsoCapture() {
  const navigate = useNavigate();
  const { hash } = useLocation();
  useEffect(() => {
    const token = new URLSearchParams(hash.replace(/^#/, "")).get("token");
    if (token) setToken(token);
    navigate("/", { replace: true });
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
  const authed = Boolean(getToken());

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

  if (loading) return null;

  return (
    <Routes>
      <Route path="/sso" element={<SsoCapture />} />
      <Route path="/sso-error" element={<SsoError />} />
      {!authed || !me ? (
        <Route path="*" element={<DevLogin />} />
      ) : (
        <Route element={<Shell me={me} />}>
          <Route path="/" element={<Dashboard me={me} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      )}
    </Routes>
  );
}
