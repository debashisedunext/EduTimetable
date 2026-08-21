import { useState } from "react";

const PERSONAS = {
  admin: { erpUserId: "ERP-1", erpRole: "ADMIN", name: "R. Ahuja", email: "admin@school.test" },
  principal: {
    erpUserId: "ERP-2",
    erpRole: "PRINCIPAL",
    name: "S. Iyer",
    email: "principal@school.test",
  },
  teacher: {
    erpUserId: "ERP-3",
    erpRole: "TEACHER",
    name: "R. Sharma",
    email: "rsharma@school.test",
    teacherId: 1,
  },
  frontoffice: {
    erpUserId: "ERP-4",
    erpRole: "FRONT_OFFICE",
    name: "K. Mehta",
    email: "frontoffice@school.test",
  },
} as const;

/**
 * Dev stand-in for the Edunext ERP menu (§15.1): asks the api's dev stub to
 * sign an ERP token, then walks through the REAL /sso/callback flow. In
 * production the ERP itself performs this hand-off and this page never renders
 * (the stub endpoint 404s).
 */
export function DevLogin() {
  const [persona, setPersona] = useState<keyof typeof PERSONAS>("admin");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/dev/erp-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(PERSONAS[persona]),
      });
      if (!res.ok) throw new Error(`Dev ERP stub unavailable (${res.status})`);
      const { token } = await res.json();
      window.location.href = `/api/sso/callback?token=${encodeURIComponent(token)}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1>Timetable AI</h1>
        <p className="login-sub">
          Users sign in through the <b>Edunext ERP → Timetable menu</b> (SSO). This dev screen
          simulates that hand-off through the real <span className="mono">/sso/callback</span> flow.
        </p>
        <div className="field">
          <label>Simulate ERP login as</label>
          <select value={persona} onChange={(e) => setPersona(e.target.value as keyof typeof PERSONAS)}>
            <option value="admin">R. Ahuja — ERP role ADMIN → Super Admin</option>
            <option value="principal">S. Iyer — ERP role PRINCIPAL → Principal</option>
            <option value="teacher">R. Sharma — ERP role TEACHER → Teacher</option>
            <option value="frontoffice">K. Mehta — ERP role FRONT_OFFICE → Front Office</option>
          </select>
        </div>
        <button className="btn btn-primary" style={{ width: "100%", justifyContent: "center" }} onClick={go} disabled={busy}>
          {busy ? "Signing in…" : "Open Timetable via SSO"}
        </button>
        {error && <p style={{ color: "var(--signal)", fontSize: 12, marginTop: 10 }}>{error}</p>}
      </div>
    </div>
  );
}
