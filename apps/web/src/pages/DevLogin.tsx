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
 * What the real ERP would put on the token (§17.4). The ERP owns school
 * identity — nothing here is hardcoded in the application; this screen stands
 * in for the ERP, so these are the claims it would send.
 *
 * Editable on purpose: type your own school's code and name to watch them land,
 * and the trust preset shows what a multi-school administrator's token looks
 * like. `code` is the stable key — reusing an existing one renames that school
 * rather than creating another.
 */
const SINGLE_SCHOOL = { code: "SCHOOL-1", name: "School 1" };

const TRUST_PRESET = {
  trust: { code: "TRUST-1", name: "Example Education Trust" },
  schools: [
    { code: "SCHOOL-1", name: "School 1" },
    { code: "SCHOOL-2", name: "Second Branch" },
    { code: "SCHOOL-3", name: "Third Branch" },
  ],
};

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
  const [schoolCode, setSchoolCode] = useState(SINGLE_SCHOOL.code);
  const [schoolName, setSchoolName] = useState(SINGLE_SCHOOL.name);
  const [asTrust, setAsTrust] = useState(false);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/dev/erp-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...PERSONAS[persona],
          school: { code: schoolCode.trim(), name: schoolName.trim() },
          ...(asTrust
            ? {
                trust: TRUST_PRESET.trust,
                // the active school first, then the rest of the trust's
                schools: [
                  { code: schoolCode.trim(), name: schoolName.trim() },
                  ...TRUST_PRESET.schools.filter((s) => s.code !== schoolCode.trim()),
                ],
              }
            : {}),
        }),
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
        <div className="field">
          <label>School the ERP reports (code · name)</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={schoolCode}
              onChange={(e) => setSchoolCode(e.target.value)}
              placeholder="SCHOOL-1"
              style={{ width: 120 }}
            />
            <input
              value={schoolName}
              onChange={(e) => setSchoolName(e.target.value)}
              placeholder="St. Xavier's High School"
              style={{ flex: 1 }}
            />
          </div>
          <p style={{ fontSize: 11, color: "var(--ink-faint)", margin: "6px 0 0" }}>
            The app never hardcodes a school name — it takes this from the SSO token and
            refreshes it on every login. Reusing a code renames that school.
          </p>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, margin: "0 0 14px" }}>
          <input type="checkbox" checked={asTrust} onChange={(e) => setAsTrust(e.target.checked)} />
          Sign in as a trust administrator (3 schools, switchable in-app)
        </label>
        <button className="btn btn-primary" style={{ width: "100%", justifyContent: "center" }} onClick={go} disabled={busy || !schoolCode.trim() || !schoolName.trim()}>
          {busy ? "Signing in…" : "Open Timetable via SSO"}
        </button>
        {error && <p style={{ color: "var(--signal)", fontSize: 12, marginTop: 10 }}>{error}</p>}
      </div>
    </div>
  );
}
