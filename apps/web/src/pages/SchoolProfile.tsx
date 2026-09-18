import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { SchoolLogo } from "../brand";
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
 * §17.4a — the school's logo: what it is, where it comes from, and what happens
 * without one, all in one control.
 *
 * ## Why an upload, when the hint used to say there are none
 *
 * It said *"the app does not host uploads"*, which left a school with no public
 * image host unable to set a logo at all — a URL field is only an entry point
 * if you already have somewhere to put the file. The browser downscales the
 * chosen image and stores it as a `data:` URI in the same column, so there is
 * still **no file storage, no image route and no unauthenticated asset path**;
 * `logo_url` went from VARCHAR(255) to TEXT and nothing else moved.
 *
 * ## The downscale is the whole safety argument
 *
 * A school picks a 4MB photograph, because that is the file they have. It goes
 * onto every screen of every session through `/me`, so it is drawn onto a
 * canvas at `MAX_PX` first and re-encoded. A 160px PNG is tens of kilobytes;
 * the server refuses anything past 60,000 characters rather than truncating it
 * into an image that is silently broken.
 *
 * ## The preview is the real component
 *
 * It renders `SchoolLogo` — the same thing the top bar renders — so "what will
 * this look like" is answered by showing it rather than by describing it. That
 * also means the default appears the moment the field is cleared, which is the
 * question somebody has when they are deciding whether to set one at all.
 */
const MAX_PX = 256;
const MAX_FILE = 8 * 1024 * 1024;

function LogoField({
  value, onChange, onError,
}: {
  value: string;
  onChange: (v: string) => void;
  onError: (m: string | null) => void;
}) {
  const file = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  /*
    Set only by the preview failing to load, and cleared by every path that
    changes the value — which is all of them, since this component owns the
    control. It is an event rather than a derived state on purpose: see the
    note on `SchoolLogo.onBroken`.
  */
  const [broken, setBroken] = useState(false);
  const put = (v: string) => { setBroken(false); onChange(v); };
  const usingDefault = value.trim().length === 0 || broken;

  const pick = async (f: File) => {
    onError(null);
    if (!f.type.startsWith("image/")) {
      onError(`${f.name} is not an image.`);
      return;
    }
    if (f.size > MAX_FILE) {
      onError(`${f.name} is ${(f.size / 1024 / 1024).toFixed(1)}MB. Pick something under 8MB.`);
      return;
    }
    setBusy(true);
    try {
      put(await downscale(f));
    } catch (e) {
      onError(asMessage(e));
    } finally {
      setBusy(false);
      // Cleared so choosing the SAME file again still fires a change event —
      // which is what somebody does after cropping it and saving over it.
      if (file.current) file.current.value = "";
    }
  };

  return (
    <Field
      label="School logo"
      hint="Shown at the top left of every screen and on reports. Upload an image or paste a link to one — without either, the default mark is used."
    >
      <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
        <SchoolLogo src={value} size={64} framed onBroken={() => setBroken(true)} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <button type="button" className="btn" disabled={busy} onClick={() => file.current?.click()}>
              {busy ? "Preparing…" : "Upload an image"}
            </button>
            {value.trim() && (
              <button type="button" className="btn" onClick={() => { put(""); onError(null); }}>
                Use the default
              </button>
            )}
            <input
              ref={file}
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void pick(f); }}
            />
          </div>
          <input
            value={value.startsWith("data:") ? "" : value}
            onChange={(e) => put(e.target.value)}
            placeholder={value.startsWith("data:") ? "— uploaded image —" : "…or paste https://…/logo.png"}
            disabled={value.startsWith("data:")}
            style={{ ...inputStyle, ...(value.startsWith("data:") ? { background: "var(--offwhite)", color: "var(--ink-faint)" } : {}) }}
          />
          <div style={{ fontSize: 11, lineHeight: 1.5, marginTop: 5, color: broken ? "var(--signal)" : "var(--ink-faint)" }}>
            {broken
              ? "That link could not be loaded from this browser, so the default is being shown instead."
              : usingDefault
                ? `No logo set — every screen uses the default mark. Uploads are resized to ${MAX_PX}px before they are stored.`
                : "This is what the top bar will show."}
          </div>
        </div>
      </div>
    </Field>
  );
}

/**
 * The chosen file, drawn down to `MAX_PX` and re-encoded.
 *
 * PNG, not JPEG: a logo is usually transparent, and JPEG would paint a black
 * rectangle behind it. The longest edge is what is capped, so the aspect ratio
 * of a wide wordmark survives — squashing it to a square would be a silent edit
 * to somebody's brand.
 */
async function downscale(f: File): Promise<string> {
  const url = URL.createObjectURL(f);
  try {
    const img = await new Promise<HTMLImageElement>((ok, fail) => {
      const el = new Image();
      el.onload = () => ok(el);
      el.onerror = () => fail(new Error(`${f.name} could not be read as an image.`));
      el.src = url;
    });
    const scale = Math.min(1, MAX_PX / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser could not resize the image.");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}

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
        <div className="grid2" style={{ gap: 12 }}>
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
        <div className="grid2" style={{ gap: 12 }}>
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

        <LogoField
          value={form.logoUrl ?? ""}
          onChange={(logoUrl) => set({ logoUrl })}
          onError={setError}
        />

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
