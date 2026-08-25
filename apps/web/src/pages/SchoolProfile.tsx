import { useEffect, useState } from "react";
import { api } from "../api";
import { asMessage, Card, ErrorNote, Field } from "../components";
import { useApi } from "../hooks";
import { inputStyle } from "./Timetables";
import type { MeResponse } from "@edutimetable/shared";

interface School {
  id: number;
  code: string;
  name: string;
  shortName: string | null;
  logoUrl: string | null;
  address: string | null;
  timezone: string;
  trustCode: string | null;
  trustName: string | null;
}

const TIMEZONES = [
  "Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Asia/Kathmandu", "Asia/Dhaka",
  "Europe/London", "America/New_York", "Australia/Sydney", "UTC",
];

/**
 * Screen: School Profile (§17.4).
 *
 * The honest split this screen has to make clear: **the ERP owns the school's
 * identity**. Code and name arrive on the SSO token and are refreshed on every
 * sign-in, so editing them here is at best temporary. Everything else — short
 * name, logo, address, timezone — is only overwritten when the ERP actually
 * sends it, so it is genuinely local presentation and safe to set.
 *
 * Showing an editable name with no warning would be the worst of both worlds:
 * the admin renames the school, signs in again, and it silently reverts.
 */
export function SchoolProfile({ me }: { me: MeResponse }) {
  const { data, error: loadError, refetch } = useApi<School>("/school");
  const [form, setForm] = useState<Partial<School>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  if (loadError) return <ErrorNote message={loadError} />;
  if (!data) return <p style={{ color: "var(--ink-faint)", fontSize: 13 }}>Loading…</p>;

  const set = (patch: Partial<School>) => {
    setForm((f) => ({ ...f, ...patch }));
    setSaved(null);
  };
  const dirty = (["name", "shortName", "logoUrl", "address", "timezone"] as const).some(
    (k) => (form[k] ?? "") !== (data[k] ?? ""),
  );

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/school", {
        method: "PUT",
        body: JSON.stringify({
          name: form.name,
          shortName: form.shortName ?? "",
          logoUrl: form.logoUrl ?? "",
          address: form.address ?? "",
          timezone: form.timezone,
        }),
      });
      setSaved("Saved.");
      refetch();
      // The top bar and sidebar read the school from /me, which was fetched at
      // load — reload so the whole shell reflects the change rather than only
      // this form.
      setTimeout(() => window.location.reload(), 600);
    } catch (e) {
      setError(asMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ maxWidth: 760 }}>
      <ErrorNote message={error} />
      {saved && (
        <div style={{ background: "var(--steel-pale)", border: "1px solid var(--steel-light)", color: "var(--brand-deep)", borderRadius: 8, padding: "9px 12px", fontSize: 12.5, marginBottom: 12 }}>
          {saved}
        </div>
      )}

      {me.schools.length > 1 && (
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "11px 13px", marginBottom: 16, background: "var(--steel-pale)", border: "1px solid var(--steel-light)", borderRadius: 9 }}>
          <span style={{ fontSize: 15 }}>🏫</span>
          <div style={{ fontSize: 11.5, lineHeight: 1.55, color: "var(--ink-soft)" }}>
            You have access to {me.schools.length} schools{me.trust ? ` in ${me.trust.name}` : ""}. This
            page edits <strong>{data.name}</strong> only — switch schools in the top bar to edit another.
          </div>
        </div>
      )}

      <Card
        title="Identity"
        sub="Where this school's name comes from, and what the ERP will overwrite."
      >
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field
            label="School code"
            hint="The ERP's stable identifier for this school. It is what an incoming sign-in is matched against, so it is not editable here — changing it would lock this school's users out."
          >
            <input value={data.code} readOnly style={{ ...inputStyle, background: "var(--offwhite)", color: "var(--ink-soft)" }} className="mono" />
          </Field>
          <Field
            label="Name"
            hint="Sent by the ERP on every sign-in and refreshed from it. If your ERP reports a name, editing it here lasts only until the next sign-in — rename it in the ERP instead."
          >
            <input value={form.name ?? ""} onChange={(e) => set({ name: e.target.value })} style={inputStyle} maxLength={120} />
          </Field>
        </div>
        {data.trustName && (
          <Field label="Trust" hint="Also reported by the ERP. Schools in a trust can be switched between from the top bar.">
            <input value={`${data.trustName} (${data.trustCode})`} readOnly style={{ ...inputStyle, background: "var(--offwhite)", color: "var(--ink-soft)" }} />
          </Field>
        )}
      </Card>

      <Card
        title="Presentation"
        sub="Local settings. These are only overwritten if your ERP explicitly sends them, so what you set here sticks."
      >
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Short name" hint="Used where space is tight, e.g. report headers.">
            <input
              value={form.shortName ?? ""}
              onChange={(e) => set({ shortName: e.target.value })}
              placeholder={data.name.slice(0, 12)}
              style={inputStyle}
              maxLength={40}
            />
          </Field>
          <Field label="Timezone" hint="Used for dated views such as the Substitute Center.">
            <select value={form.timezone ?? "Asia/Kolkata"} onChange={(e) => set({ timezone: e.target.value })} style={inputStyle}>
              {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
              {form.timezone && !TIMEZONES.includes(form.timezone) && (
                <option value={form.timezone}>{form.timezone}</option>
              )}
            </select>
          </Field>
        </div>

        <Field label="Logo URL" hint="Shown in the sidebar and on reports. Must be a URL this browser can reach — the app does not host uploads.">
          <input
            value={form.logoUrl ?? ""}
            onChange={(e) => set({ logoUrl: e.target.value })}
            placeholder="https://…/logo.png"
            style={inputStyle}
            maxLength={255}
          />
        </Field>
        {form.logoUrl && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: -6, marginBottom: 12 }}>
            <img
              src={form.logoUrl}
              alt=""
              style={{ width: 34, height: 34, objectFit: "contain", borderRadius: 7, border: "1px solid var(--line)", background: "#fff" }}
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
            />
            <span style={{ fontSize: 11, color: "var(--ink-faint)" }}>
              Preview — if nothing appears, the URL is not reachable from this browser.
            </span>
          </div>
        )}

        <Field label="Address">
          <input value={form.address ?? ""} onChange={(e) => set({ address: e.target.value })} style={inputStyle} maxLength={255} />
        </Field>
      </Card>

      <button className="btn btn-primary" onClick={save} disabled={!dirty || busy || !(form.name ?? "").trim()}>
        {busy ? "Saving…" : dirty ? "Save changes" : "No changes"}
      </button>
    </div>
  );
}
