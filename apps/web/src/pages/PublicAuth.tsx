/**
 * §15.3 Phase 25.0 — the public screens: home, create account, sign in, verify,
 * reset.
 *
 * These live OUTSIDE the authenticated shell. No sidebar, no config selector,
 * no `me` — a person on these pages may have no account at all, let alone a
 * school, so anything that assumes one would crash rather than render.
 *
 * Two things are deliberate throughout:
 *
 *  - **The server's words are shown, never rewritten.** Register, forgot and
 *    login all answer the same whoever you are, and that is the entire point;
 *    a client that helpfully turned a 401 into "no account with that email"
 *    would undo it in one line.
 *  - **ERP customers are told not to be here**, in the nav, the hero, the entry
 *    cards and under both forms. Without it they sign up with a personal
 *    address, hand-build a duplicate school, and cannot understand why their
 *    ERP data is missing.
 *
 * The home page is a scaffold: real structure and palette, with the marketing
 * design still to come.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
// The app's own session store — never a hand-written key, or signing in here
// would write somewhere `getToken()` does not read.
import { setToken } from "../api";
import { useIsMobile } from "../mobile";
import { AuthShowcase } from "./auth-showcase";

/** Same prefix `api.ts` uses — the Vite proxy and the production nginx both map it. */
const API = "/api";

async function post<T>(path: string, body: unknown, token?: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.message ?? "Something went wrong. Try again.");
  return json as T;
}

/** Where an account token lives until the account picks a school (25.1). */
export const ACCOUNT_TOKEN_KEY = "edutt.accountToken";

// ───────────────────────────────────────────────────────────── chrome

function PublicShell({ children, wide, showcase }: {
  children: ReactNode;
  wide?: boolean;
  /**
   * §39 — split the page, with the product on the left.
   *
   * Only the two front doors pass this (Sign in, Create account). Forgot
   * password, Verify and Accept invite stay a centred card on purpose: somebody
   * who arrived there is already mid-task and being sold to is noise.
   */
  showcase?: boolean;
}) {
  /*
    §8.8's ONE breakpoint, imported rather than a second number.

    A phone gets no showcase at all — and this is a render decision rather than
    a CSS one for the reason §8.8 gives for `useIsMobile` existing: hiding the
    panel with `display: none` would leave the carousel's timer ticking and its
    six animated SVG artefacts mounted, on the device least able to spare it.
  */
  const mobile = useIsMobile();
  const split = showcase === true && !mobile;

  const bar = (
    <nav style={{
      display: "flex", alignItems: "center", gap: 20, padding: "14px 24px",
      borderBottom: "1px solid var(--line)", background: "var(--paper)", flexWrap: "wrap",
    }}>
      <Link to="/" style={{
        fontFamily: "Fraunces, Georgia, serif", fontWeight: 700, fontSize: 17,
        color: "var(--brand-deep)", textDecoration: "none", letterSpacing: "-0.01em",
      }}>
        Edu<span style={{ color: "var(--brand)" }}>Timetable</span>
      </Link>
      <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
        <Link to="/login" className="btn" style={{ textDecoration: "none", padding: "6px 12px", fontSize: 12.5 }}>
          Sign in
        </Link>
        <Link to="/signup" className="btn btn-primary" style={{ textDecoration: "none", padding: "6px 12px", fontSize: 12.5 }}>
          Create account
        </Link>
      </div>
    </nav>
  );

  if (split) {
    return (
      <div style={{
        minHeight: "100dvh",
        display: "grid",
        /*
          `minmax(0, …)` on BOTH tracks — §5.7's lesson, and it bites here for
          the same reason: a grid child's default `min-width: auto` refuses to
          shrink below its content, so the showcase's 46ch paragraph would push
          its column past the track and scroll the whole page sideways.

          The form takes a PERCENTAGE with a floor, not a fixed width. A fixed
          468px meant the showcase swallowed everything past it — 1,530px of it
          on a 2,000px screen — and a large flat navy area reads as something
          that failed to load, where the same emptiness in white reads as
          breathing room. Splitting it closer to even puts the slack on the side
          that can carry it, and the floor keeps the form usable as the window
          narrows towards §8.8's breakpoint.
        */
        gridTemplateColumns: "minmax(0, 1fr) minmax(400px, 46%)",
        background: "var(--offwhite)",
      }}>
        <AuthShowcase />
        <div style={{
          display: "flex", flexDirection: "column", minWidth: 0,
          borderLeft: "1px solid var(--line)", background: "var(--paper)",
        }}>
          {/* The nav keeps its place above the form, not above the whole page:
              spanning it would put a white band over the showcase's top edge. */}
          <div style={{ background: "var(--paper)" }}>{bar}</div>
          {/*
            `margin: auto` on the child, NOT `align-items: center` on the parent.

            They centre identically until the content is taller than the column —
            and then `align-items: center` centres the overflow too, putting the
            top of the card above the scroll origin where it cannot be reached.
            The dev build hits this immediately: the five demo personas make this
            column taller than most laptops. An auto margin on a flex item
            centres the same way and collapses to zero when there is no room.
          */}
          <div style={{
            flex: 1, display: "flex", justifyContent: "center",
            padding: "28px 34px", overflowY: "auto",
          }}>
            <div style={{ width: "100%", maxWidth: 400, margin: "auto" }}>{children}</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--offwhite)", display: "flex", flexDirection: "column" }}>
      {bar}
      <div style={{ flex: 1, display: "flex", justifyContent: "center", padding: wide ? 0 : "36px 20px" }}>
        <div style={{ width: "100%", maxWidth: wide ? "none" : 440 }}>{children}</div>
      </div>
    </div>
  );
}

function Card({ title, lede, children }: { title: string; lede?: string; children: ReactNode }) {
  return (
    <div style={{
      background: "var(--paper)", border: "1px solid var(--line)", borderRadius: 13,
      padding: "26px 28px", boxShadow: "0 1px 2px rgba(11,31,68,.05),0 8px 24px rgba(11,31,68,.07)",
    }}>
      <h2 style={{ fontFamily: "Fraunces, Georgia, serif", fontSize: 20, margin: "0 0 4px" }}>{title}</h2>
      {lede && <p style={{ fontSize: 13, color: "var(--ink-soft)", margin: "0 0 16px" }}>{lede}</p>}
      {children}
    </div>
  );
}

function Field({ label, hint, ...rest }: { label: string; hint?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div style={{ marginBottom: 13 }}>
      <label style={{
        display: "block", font: "600 11px/1.4 Inter", textTransform: "uppercase",
        letterSpacing: "0.06em", color: "var(--steel)", marginBottom: 5,
      }}>{label}</label>
      <input {...rest} style={{
        width: "100%", padding: "8px 11px", border: "1px solid var(--line)",
        borderRadius: 8, fontSize: 13.5, background: "var(--paper)", color: "var(--ink)",
      }} />
      {hint && <div style={{ fontSize: 11.5, color: "var(--ink-faint)", marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

function Note({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "error" | "ok" }) {
  const c = tone === "error"
    ? { bg: "var(--signal-bg)", line: "var(--signal)" }
    : tone === "ok"
      ? { bg: "var(--accent-bg)", line: "var(--accent)" }
      : { bg: "var(--steel-pale)", line: "var(--brand)" };
  return (
    <div style={{
      borderLeft: `3px solid ${c.line}`, background: c.bg, padding: "11px 13px",
      borderRadius: "0 8px 8px 0", fontSize: 12.5, color: "var(--ink-soft)", marginBottom: 14,
    }}>{children}</div>
  );
}

/** The sentence that keeps ERP customers out of the wrong funnel. */
function ErpNotice() {
  return (
    <Note>
      <strong>Already using Edunext ERP?</strong> Don't create an account — open Timetable from your
      ERP menu instead. Your school and staff are already there.
    </Note>
  );
}

// ───────────────────────────────────────────────────────────── home

export function Home() {
  const [local, setLocal] = useState<boolean | null>(null);
  useEffect(() => {
    fetch(`${API}/auth/methods`)
      .then((r) => r.json())
      .then((m) => setLocal(Boolean(m?.local)))
      .catch(() => setLocal(false));
  }, []);

  return (
    <PublicShell wide>
      <div style={{ width: "100%" }}>
        <div style={{
          background: "linear-gradient(160deg,var(--brand-deep) 0%,#123163 60%,#1A3F7C 100%)",
          color: "#fff", padding: "62px 24px 56px", textAlign: "center",
        }}>
          <h1 style={{
            fontFamily: "Fraunces, Georgia, serif", fontWeight: 600, color: "#fff",
            fontSize: "clamp(25px,4vw,40px)", lineHeight: 1.14, maxWidth: "20ch",
            margin: "0 auto 14px", textWrap: "balance",
          }}>
            A conflict-free school timetable, proved before it is built
          </h1>
          <p style={{ color: "#C2D3EC", fontSize: 15.5, maxWidth: "56ch", margin: "0 auto 26px" }}>
            Tell us your classes, teachers and subjects. We check that a complete timetable can
            exist — and name the exact row to fix if it can't — before the solver places a single
            period.
          </p>
          <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
            {local !== false && (
              <Link to="/signup" className="btn btn-lg" style={{
                textDecoration: "none", background: "#fff", borderColor: "#fff",
                color: "var(--brand-deep)", padding: "12px 22px", fontSize: 14, fontWeight: 600,
                borderRadius: 8, border: "1px solid #fff",
              }}>Create a free account →</Link>
            )}
            <Link to="/login" className="btn btn-lg" style={{
              textDecoration: "none", background: "none", borderColor: "rgba(255,255,255,.4)",
              color: "#fff", padding: "12px 22px", fontSize: 14, fontWeight: 600,
              borderRadius: 8, border: "1px solid rgba(255,255,255,.4)",
            }}>Sign in</Link>
          </div>
          <p style={{ color: "#8FA9CC", fontSize: 12, margin: "18px 0 0" }}>
            {local === false
              ? "This installation is entered through your ERP."
              : "No card required · Set up your first timetable in about 20 minutes"}
          </p>
        </div>

        <div style={{
          display: "grid", gap: 1, gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))",
          background: "var(--line)",
        }}>
          {[
            ["100%", "Conflict-free by construction — never a best effort"],
            ["2", "Phases: feasibility proved first, then the solver runs"],
            ["<1s", "Every screen and report, at realistic school size"],
            ["3", "Ways to enter your data — by hand, guided, or by talking"],
          ].map(([n, t]) => (
            <div key={t} style={{ background: "var(--paper)", padding: "20px 22px" }}>
              <b style={{
                fontFamily: "Fraunces, Georgia, serif", fontSize: 24, color: "var(--brand)",
                display: "block", fontVariantNumeric: "tabular-nums",
              }}>{n}</b>
              <span style={{ fontSize: 12.5, color: "var(--ink-soft)" }}>{t}</span>
            </div>
          ))}
        </div>

        <div style={{ padding: "34px 24px", maxWidth: 1000, margin: "0 auto" }}>
          <div style={{
            font: "600 11px/1 Inter", textTransform: "uppercase", letterSpacing: "0.11em",
            color: "var(--steel)", marginBottom: 12,
          }}>Two ways in</div>
          <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fit,minmax(250px,1fr))" }}>
            <div style={{
              border: "1.5px solid var(--brand)", background: "var(--steel-pale)",
              borderRadius: 11, padding: 18,
            }}>
              <h3 style={{ fontFamily: "Fraunces, Georgia, serif", fontSize: 16, margin: 0 }}>New here</h3>
              <p style={{ fontSize: 12.8, color: "var(--ink-soft)", margin: "6px 0 10px", lineHeight: 1.5 }}>
                Create an account with your work email. You can add as many schools as you look
                after, and switch between them from one sign-in.
              </p>
              <Link to="/signup" className="btn btn-primary" style={{
                textDecoration: "none", padding: "5px 10px", fontSize: 11.5,
              }}>Create account</Link>
            </div>
            <div style={{ border: "1.5px solid var(--line)", background: "var(--paper)", borderRadius: 11, padding: 18 }}>
              <h3 style={{ fontFamily: "Fraunces, Georgia, serif", fontSize: 16, margin: 0 }}>
                Already an Edunext ERP customer
              </h3>
              <p style={{ fontSize: 12.8, color: "var(--ink-soft)", margin: "6px 0 10px", lineHeight: 1.5 }}>
                Don't create anything. Open Timetable from your ERP menu and you arrive signed in,
                with your school's details already filled in.
              </p>
            </div>
            <div style={{ border: "1.5px solid var(--line)", background: "var(--paper)", borderRadius: 11, padding: 18 }}>
              <h3 style={{ fontFamily: "Fraunces, Georgia, serif", fontSize: 16, margin: 0 }}>Coming back</h3>
              <p style={{ fontSize: 12.8, color: "var(--ink-soft)", margin: "6px 0 10px", lineHeight: 1.5 }}>
                Sign in with the email and password you registered.
              </p>
              <Link to="/login" className="btn" style={{
                textDecoration: "none", padding: "5px 10px", fontSize: 11.5,
              }}>Sign in</Link>
            </div>
          </div>
        </div>
      </div>
    </PublicShell>
  );
}

// ───────────────────────────────────────────────────────── create account

export function SignUp() {
  const [form, setForm] = useState({
    name: "", email: "", password: "", organisation: "", country: "India", jobRole: "", phone: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const nav = useNavigate();
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  /**
   * Register, then sign straight in — no round trip to the inbox first.
   *
   * The second call is what keeps registration from becoming an address oracle.
   * `POST /auth/register` still answers **identically** whether or not the
   * address already exists; returning a token for a new one and a message for
   * an existing one would say which, in a single response, to anybody who asked.
   * So the client simply signs in with the credentials it has in hand: if the
   * address was new, that works; if it belonged to somebody else, login refuses
   * it in the same words it refuses any wrong password, which is a check it
   * already performs and reveals nothing new.
   *
   * If that second call fails for any reason, fall back to what this screen did
   * before — the verification mail is already sent, and the link still works.
   */
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await post<{ message: string }>("/auth/register", form);
      try {
        const session = await post<{ accountToken: string }>("/auth/login", {
          email: form.email, password: form.password,
        });
        localStorage.setItem(ACCOUNT_TOKEN_KEY, session.accountToken);
        nav("/schools");
        return;
      } catch {
        setSent(r.message);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <PublicShell>
        <Card title="Check your email">
          <Note tone="ok">{sent}</Note>
          <p style={{ fontSize: 12.5, color: "var(--ink-faint)", margin: 0 }}>
            The link works once and expires in 24 hours.
          </p>
        </Card>
      </PublicShell>
    );
  }

  return (
    <PublicShell showcase>
      <Card title="Create your account"
        lede="This is you, not your school — you'll add schools in a moment, and you can add more than one.">
        <form onSubmit={submit}>
          <Field label="Your name" value={form.name} onChange={set("name")} autoComplete="name" required />
          <Field label="Work email" type="email" value={form.email} onChange={set("email")}
            autoComplete="email" required hint="This becomes your sign-in. We'll send a confirmation link here too." />
          <Field label="Password" type="password" value={form.password} onChange={set("password")}
            autoComplete="new-password" required
            hint="At least 12 characters. Three or four ordinary words are both stronger and easier than P@ssw0rd!" />
          <Field label="Organisation / trust" value={form.organisation} onChange={set("organisation")}
            hint="Optional" />
          <Field label="Phone" value={form.phone} onChange={set("phone")} hint="Optional — for support only" />

          {error && <Note tone="error">{error}</Note>}
          <button className="btn btn-primary" disabled={busy}
            style={{ width: "100%", padding: 11, marginTop: 4 }}>
            {busy ? "Creating…" : "Create account and start"}
          </button>
        </form>
        <div style={{ margin: "18px 0", textAlign: "center", fontSize: 11.5, color: "var(--ink-faint)" }}>or</div>
        <ErpNotice />
        <p style={{ fontSize: 12.5, textAlign: "center", margin: 0 }}>
          Already registered? <Link to="/login">Sign in</Link>
        </p>
      </Card>
    </PublicShell>
  );
}

// ─────────────────────────────────────────────────────────────── sign in

export function SignIn() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nav = useNavigate();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await post<{ accountToken: string }>("/auth/login", { email, password });
      localStorage.setItem(ACCOUNT_TOKEN_KEY, r.accountToken);
      // 25.1 puts My Schools here. Until then the account exists and is signed
      // in, with nowhere yet to go — said plainly rather than silently.
      nav("/schools");
    } catch (err) {
      // Shown exactly as the server wrote it. It is deliberately the same
      // sentence for a wrong password and an unknown address, and "helpfully"
      // distinguishing them here would hand over the customer list.
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <PublicShell showcase>
      <Card title="Sign in" lede="Welcome back.">
        <form onSubmit={submit}>
          <Field label="Email" type="email" value={email} autoComplete="email" required
            onChange={(e) => setEmail(e.target.value)} />
          <Field label="Password" type="password" value={password} autoComplete="current-password" required
            onChange={(e) => setPassword(e.target.value)} />
          {error && <Note tone="error">{error}</Note>}
          <div style={{ textAlign: "right", marginBottom: 12 }}>
            <Link to="/forgot" style={{ fontSize: 12.3 }}>Forgot password?</Link>
          </div>
          <button className="btn btn-primary" disabled={busy} style={{ width: "100%", padding: 11 }}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <div style={{ margin: "18px 0", textAlign: "center", fontSize: 11.5, color: "var(--ink-faint)" }}>or</div>
        <ErpNotice />
        <p style={{ fontSize: 12.5, textAlign: "center", margin: 0 }}>
          New here? <Link to="/signup">Create an account</Link>
        </p>
      </Card>
      <DemoPersonas />
    </PublicShell>
  );
}

/**
 * The four demo roles, on the screen where somebody is trying to get in.
 *
 * These are ERP sign-ins, not passwords: each one asks the dev stub to sign a
 * token and then walks the REAL `/sso/callback`, so what you are looking at is
 * the production hand-off with a stand-in ERP — not a back door that skips it.
 *
 * It renders only where the stub is actually live, and it asks the SERVER that
 * question (`/auth/methods` reports the same condition `POST /dev/erp-token`
 * gates itself on). Guessing from the hostname would eventually put four
 * buttons that all 404 in front of a real customer.
 */
const DEMO_ROLES = [
  { key: "admin", who: "R. Ahuja", role: "Super Admin", does: "everything — masters, generate, publish, roles, AI" },
  { key: "timetable", who: "V. Kulkarni", role: "Timetable Admin", does: "builds and publishes; cannot touch roles or AI keys" },
  { key: "principal", who: "S. Iyer", role: "Principal", does: "sees every timetable and report; changes nothing" },
  { key: "teacher", who: "R. Sharma", role: "Teacher", does: "their own grid and their classes only" },
  { key: "frontoffice", who: "K. Mehta", role: "Front Office", does: "substitutions, and every timetable to pick from" },
] as const;

const DEMO_TOKENS: Record<string, Record<string, unknown>> = {
  admin: { erpUserId: "ERP-1", erpRole: "ADMIN", name: "R. Ahuja", email: "admin@school.test" },
  timetable: { erpUserId: "ERP-5", erpRole: "TIMETABLE_ADMIN", name: "V. Kulkarni", email: "ttadmin@school.test" },
  principal: { erpUserId: "ERP-2", erpRole: "PRINCIPAL", name: "S. Iyer", email: "principal@school.test" },
  teacher: { erpUserId: "ERP-3", erpRole: "TEACHER", name: "R. Sharma", email: "rsharma@school.test" },
  frontoffice: { erpUserId: "ERP-4", erpRole: "FRONT_OFFICE", name: "K. Mehta", email: "frontoffice@school.test" },
};

/** Which school these open, and who the Teacher persona is — see /dev/demo-target. */
interface DemoTarget {
  school: { code: string; name: string } | null;
  teacher: { id: number; name: string; periods: number } | null;
  published: number;
  /** The ERP roles this school maps — a persona outside them has no way in. */
  erpRoles?: string[];
}

function DemoPersonas() {
  const [available, setAvailable] = useState(false);
  const [target, setTarget] = useState<DemoTarget | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API}/auth/methods`)
      .then((r) => r.json())
      .then((m) => setAvailable(Boolean(m?.dev)))
      .catch(() => setAvailable(false));
    /**
     * Which school to open, asked of the server (§8.1e).
     *
     * These buttons used to name `SCHOOL-1`, which the master seed leaves with
     * two classes and no timetable — four ways into an empty app. The server
     * picks the school with the most published lessons instead, so re-seeding
     * moves the demo without anybody editing this file.
     */
    fetch(`${API}/dev/demo-target`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setTarget)
      .catch(() => setTarget(null));
  }, []);

  if (!available) return null;

  const go = async (key: string) => {
    setBusy(key); setError(null);
    try {
      const r = await post<{ token: string }>("/dev/erp-token", {
        ...DEMO_TOKENS[key],
        // The real teacher behind the Teacher persona, so My Timetable and My
        // Classes have something in them. Falls back to no link rather than to
        // a guessed id: an unlinked login shows an honest "no teacher record",
        // where a wrong id shows somebody else's week.
        ...(key === "teacher" && target?.teacher ? { teacherId: target.teacher.id } : {}),
        school: target?.school ?? { code: "SCHOOL-1", name: "School 1" },
      });
      // Through the real callback, exactly as the ERP menu would.
      window.location.href = `${API}/sso/callback?token=${encodeURIComponent(r.token)}`;
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  return (
    <div style={{
      marginTop: 16, background: "var(--paper)", border: "1px dashed var(--line)",
      borderRadius: 13, padding: "18px 20px",
    }}>
      <div style={{
        font: "600 10.5px/1 Inter", textTransform: "uppercase", letterSpacing: "0.09em",
        color: "var(--steel)", marginBottom: 4,
      }}>Demo sign-in · this environment only</div>
      <p style={{ fontSize: 12.3, color: "var(--ink-soft)", margin: "0 0 12px" }}>
        {target?.school
          ? <>Five roles in <strong>{target.school.name}</strong>{target.published > 0 && <> — {target.published.toLocaleString()} published lessons</>}, to see what each one is allowed to do. </>
          : <>Five roles in the sample school, to see what each one is allowed to do. </>}
        These go through the real ERP hand-off with a stand-in ERP — not a shortcut around it.
      </p>
      {target && target.published === 0 && (
        <Note tone="error">
          No school has a published timetable yet, so these will open an empty app. Generate and
          publish one first, or run <code>scripts/seed-school2.cjs</code>.
        </Note>
      )}
      <div style={{ display: "grid", gap: 7 }}>
        {/* Only the roles this school maps: an unmapped persona dies at the
            callback, and a door with no room behind it is worse than no door. */}
        {DEMO_ROLES.filter((r) =>
          !target?.erpRoles || target.erpRoles.includes(String(DEMO_TOKENS[r.key].erpRole)),
        ).map((r) => (
          <button key={r.key} onClick={() => go(r.key)} disabled={busy !== null}
            style={{
              textAlign: "left", font: "inherit", cursor: busy ? "wait" : "pointer",
              border: "1px solid var(--line)", borderRadius: 9, padding: "9px 12px",
              background: busy === r.key ? "var(--steel-pale)" : "var(--paper)",
            }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>
              {r.role}{" "}
              <span style={{ color: "var(--ink-faint)", fontWeight: 400 }}>
                · {r.key === "teacher" && target?.teacher ? target.teacher.name : r.who}
              </span>
            </div>
            <div style={{ fontSize: 11.8, color: "var(--ink-soft)", marginTop: 1 }}>
              {r.does}
              {r.key === "teacher" && target?.teacher && ` · ${target.teacher.periods} periods a week`}
            </div>
          </button>
        ))}
      </div>
      {error && <Note tone="error">{error}</Note>}
      <p style={{ fontSize: 11.3, color: "var(--ink-faint)", margin: "10px 0 0" }}>
        Signing in as a role you have already used returns you to the same person — the ERP id is the
        identity, so nothing is duplicated.
      </p>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────── forgot

export function Forgot() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await post<{ message: string }>("/auth/forgot", { email });
      setSent(r.message);
    } catch {
      // Even a failure here must not distinguish a known from an unknown
      // address, so the same reassurance is shown either way.
      setSent("If that address can be used, an email is on its way.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <PublicShell>
      <Card title="Reset your password"
        lede={sent ? undefined : "Enter your email and we'll send you a link."}>
        {sent ? <Note tone="ok">{sent}</Note> : (
          <form onSubmit={submit}>
            <Field label="Email" type="email" value={email} autoComplete="email" required
              onChange={(e) => setEmail(e.target.value)} />
            <button className="btn btn-primary" disabled={busy} style={{ width: "100%", padding: 11 }}>
              {busy ? "Sending…" : "Send the link"}
            </button>
          </form>
        )}
        <p style={{ fontSize: 12.5, textAlign: "center", margin: "16px 0 0" }}>
          <Link to="/login">Back to sign in</Link>
        </p>
      </Card>
    </PublicShell>
  );
}

// ──────────────────────────────────────────────────────── verify / reset

export function Verify() {
  const [params] = useSearchParams();
  const token = params.get("token");
  const [state, setState] = useState<"working" | "ok" | "bad">("working");
  const [message, setMessage] = useState("");
  const nav = useNavigate();

  useEffect(() => {
    if (!token) { setState("bad"); setMessage("That link is incomplete."); return; }
    // POSTed rather than opened as a GET: a mail scanner that fetches links
    // would otherwise spend the token before the person ever clicks it.
    post<{ accountToken: string }>("/auth/verify", { token })
      .then((r) => {
        localStorage.setItem(ACCOUNT_TOKEN_KEY, r.accountToken);
        setState("ok");
        setTimeout(() => nav("/schools"), 1200);
      })
      .catch((e) => { setState("bad"); setMessage((e as Error).message); });
  }, [token, nav]);

  return (
    <PublicShell>
      <Card title={state === "ok" ? "You're all set" : "Confirming your email"}>
        {state === "working" && <p style={{ fontSize: 13, color: "var(--ink-soft)" }}>One moment…</p>}
        {state === "ok" && <Note tone="ok">Your email is confirmed and you're signed in. Taking you in…</Note>}
        {state === "bad" && (
          <>
            <Note tone="error">{message}</Note>
            <p style={{ fontSize: 12.5, margin: 0 }}><Link to="/login">Go to sign in</Link></p>
          </>
        )}
      </Card>
    </PublicShell>
  );
}

export function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) { setError("Those two do not match."); return; }
    setBusy(true); setError(null);
    try {
      await post("/auth/reset", { token, password });
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <PublicShell>
      <Card title="Choose a new password">
        {done ? (
          <>
            <Note tone="ok">Your password has been changed.</Note>
            <p style={{ fontSize: 12.5, margin: 0 }}><Link to="/login">Sign in with it</Link></p>
          </>
        ) : (
          <form onSubmit={submit}>
            <Field label="New password" type="password" value={password} autoComplete="new-password"
              required onChange={(e) => setPassword(e.target.value)} hint="At least 12 characters." />
            <Field label="Confirm" type="password" value={confirm} autoComplete="new-password"
              required onChange={(e) => setConfirm(e.target.value)} />
            {error && <Note tone="error">{error}</Note>}
            <button className="btn btn-primary" disabled={busy} style={{ width: "100%", padding: 11 }}>
              {busy ? "Saving…" : "Change my password"}
            </button>
          </form>
        )}
      </Card>
    </PublicShell>
  );
}

/**
 * §24.8 Phase 25.6e — accepting an invitation.
 *
 * Two shapes behind one link, decided by the server: somebody new chooses a
 * password, and somebody who already has an identity here is simply joining a
 * second school and is asked for nothing. Asking the second group for a new
 * password would be asking them to change the one they use everywhere else.
 *
 * The identity is **shown and not editable**. The invitation was issued to an
 * address; letting the recipient edit the name or email would make it a way to
 * create an arbitrary account with somebody else's link.
 */
export function AcceptInvite() {
  const { token = "" } = useParams();
  const [details, setDetails] = useState<
    { valid: boolean; email?: string; name?: string; needsPassword?: boolean; message?: string } | null
  >(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nav = useNavigate();

  useEffect(() => {
    // A GET that only LOOKS. Accepting is a POST, so a mail scanner following
    // the link cannot spend the invitation on the recipient's behalf.
    fetch(`/api/auth/invite/${encodeURIComponent(token)}`)
      .then((r) => r.json())
      .then(setDetails)
      .catch(() => setDetails({ valid: false, message: "That link could not be checked. Try again." }));
  }, [token]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (details?.needsPassword && password !== confirm) { setError("Those two do not match."); return; }
    setBusy(true); setError(null);
    try {
      const r = await post<{ accountToken: string }>("/auth/invite/accept", {
        token, ...(details?.needsPassword ? { password } : {}),
      });
      localStorage.setItem(ACCOUNT_TOKEN_KEY, r.accountToken);
      // Straight to the school list, which is one card for most invitees — and
      // is the screen that actually checks they still have a login there.
      nav("/schools");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!details) {
    return (
      <PublicShell>
        <Card title="Checking your invitation"><p style={{ fontSize: 13, color: "var(--ink-soft)" }}>One moment…</p></Card>
      </PublicShell>
    );
  }

  if (!details.valid) {
    return (
      <PublicShell>
        <Card title="This invitation cannot be used">
          <Note tone="error">{details.message ?? "That invitation has expired or has already been used."}</Note>
          <p style={{ fontSize: 12.5, margin: 0 }}>
            Ask whoever invited you to send it again, or <Link to="/login">sign in</Link> if you
            already have a password.
          </p>
        </Card>
      </PublicShell>
    );
  }

  return (
    <PublicShell>
      <Card
        title={details.needsPassword ? "Set up your login" : "Join this school"}
        lede={details.needsPassword
          ? "Choose a password and you're in. You'll use your email address to sign in."
          : "You already have an account here — accepting adds this school to it."}
      >
        <form onSubmit={submit}>
          {/* Shown, never editable: the invitation was issued to this address. */}
          <Field label="Name" value={details.name ?? ""} readOnly />
          <Field label="Email" value={details.email ?? ""} readOnly />
          {details.needsPassword && (
            <>
              <Field label="Choose a password" type="password" value={password} autoComplete="new-password"
                required onChange={(e) => setPassword(e.target.value)} hint="At least 12 characters." />
              <Field label="Confirm" type="password" value={confirm} autoComplete="new-password"
                required onChange={(e) => setConfirm(e.target.value)} />
            </>
          )}
          {error && <Note tone="error">{error}</Note>}
          <button className="btn btn-primary" disabled={busy} style={{ width: "100%", padding: 11 }}>
            {busy ? "One moment…" : details.needsPassword ? "Create my login" : "Accept the invitation"}
          </button>
        </form>
      </Card>
    </PublicShell>
  );
}

/**
 * §15.3 Phase 25.1 — My Schools.
 *
 * The one screen an account sees before it is inside anything. Two behaviours
 * in one component, chosen by the server's `canCreate`: a **creator** for a
 * self-serve owner, a **switcher** for anyone else. The server refuses
 * independently — hiding the tile is cosmetic (§15) — so this is presentation,
 * not enforcement.
 *
 * Entering a school swaps the account token for the ordinary session token and
 * reloads into the app, which is where every existing screen takes over.
 */
export function MySchools() {
  const nav = useNavigate();
  const [data, setData] = useState<{
    account: { name: string; email: string; kind: string; emailVerified?: boolean };
    schools: Array<{
      id: number; code: string; name: string; shortName: string | null;
      counts: { configs: number; classes: number; sections: number };
      publishedAt: string | null; state: "published" | "in-progress" | "empty";
    }>;
    canCreate: boolean; remaining: number; cap: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);

  const token = localStorage.getItem(ACCOUNT_TOKEN_KEY);

  const load = () => {
    if (!token) { nav("/login"); return; }
    fetch(`${API}/schools`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        if (r.status === 401) { localStorage.removeItem(ACCOUNT_TOKEN_KEY); nav("/login"); return null; }
        return r.json();
      })
      .then((d) => d && setData(d))
      .catch(() => setError("Could not load your schools."));
  };
  useEffect(load, [token]);

  /** Swap the account token for a school session and hand over to the app. */
  const enter = async (id: number) => {
    setBusy(true);
    try {
      const r = await post<{ sessionToken: string }>(`/schools/${id}/enter`, {}, token!);
      setToken(r.sessionToken);
      window.location.href = "/";
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await post<{ sessionToken: string; schoolId: number }>("/schools", { name }, token!);
      // Straight in — the only reason to create a school is to set it up.
      setToken(r.sessionToken);
      window.location.href = "/";
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  if (!data) {
    return <PublicShell><Card title="Your schools">{error ?? "Loading…"}</Card></PublicShell>;
  }

  /**
   * Asked for, not enforced here.
   *
   * Verification no longer stands between somebody and their first school, so
   * the reminder has to be visible or it would simply be forgotten — and the
   * second school genuinely does need it. It says what it is FOR, because
   * "verify your email" with no consequence attached is the kind of banner
   * people learn to scroll past.
   */
  const unverified = data.account.emailVerified === false;

  const badge = (s: { state: string; publishedAt: string | null }) =>
    s.state === "published" ? { text: "Published", color: "var(--accent)" }
      : s.state === "in-progress" ? { text: "Setup in progress", color: "var(--amber)" }
      : { text: "Nothing set up yet", color: "var(--ink-faint)" };

  return (
    <PublicShell wide>
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "36px 20px" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap", marginBottom: 4 }}>
          <h1 style={{ fontFamily: "Fraunces, Georgia, serif", fontSize: 24, margin: 0 }}>Your schools</h1>
          <span style={{ fontSize: 12.5, color: "var(--ink-faint)" }}>
            {data.schools.length} of {data.cap}
          </span>
          <span style={{ flex: 1 }} />
          <button className="btn" style={{ padding: "6px 12px", fontSize: 12.5 }}
            onClick={() => { localStorage.removeItem(ACCOUNT_TOKEN_KEY); nav("/login"); }}>
            Sign out
          </button>
        </div>
        <p style={{ fontSize: 13.5, color: "var(--ink-soft)", marginBottom: 18 }}>
          Signed in as {data.account.name} · {data.account.email}. Each school keeps its own classes,
          teachers and timetables — nothing is shared between them.
        </p>

        {unverified && (
          <div style={{
            borderLeft: "3px solid var(--amber)", background: "var(--amber-bg)",
            padding: "12px 14px", borderRadius: "0 9px 9px 0", fontSize: 12.8,
            color: "var(--ink-soft)", marginBottom: 18,
          }}>
            <strong>Confirm your email address.</strong> We sent a link to {data.account.email}. You
            can set up your first school without it — but a second school, and anything sent to your
            staff, needs a confirmed address.
          </div>
        )}

        {error && <Note tone="error">{error}</Note>}

        <div style={{ display: "grid", gap: 13, gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))" }}>
          {data.schools.map((s) => {
            const b = badge(s);
            return (
              <div key={s.id} style={{
                border: "1px solid var(--line)", borderRadius: 11, padding: "16px 17px",
                background: "var(--paper)", display: "flex", flexDirection: "column", gap: 7,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                  <span style={{
                    width: 34, height: 34, borderRadius: 8, display: "grid", placeItems: "center",
                    font: "700 13px Inter", color: "#fff", background: "var(--brand)", flex: "0 0 auto",
                  }}>{(s.shortName ?? s.name).slice(0, 2).toUpperCase()}</span>
                  <div style={{ minWidth: 0 }}>
                    <h3 style={{ fontFamily: "Fraunces, Georgia, serif", fontSize: 15.5, margin: 0 }}>{s.name}</h3>
                    <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-faint)" }}>{s.code}</span>
                  </div>
                </div>
                <div style={{ fontSize: 11.5, color: b.color, fontWeight: 600 }}>{b.text}</div>
                <div style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>
                  {s.counts.classes} classes · {s.counts.sections} sections
                </div>
                <button className="btn btn-primary" disabled={busy}
                  style={{ marginTop: 4, padding: "6px 12px", fontSize: 12.5 }}
                  onClick={() => enter(s.id)}>
                  {s.state === "empty" ? "Start setup →" : "Open"}
                </button>
              </div>
            );
          })}

          {/* Offered only to an owner. The server refuses a member regardless. */}
          {data.canCreate && (adding ? (
            <form onSubmit={create} style={{
              border: "1.5px solid var(--brand)", borderRadius: 11, padding: "16px 17px",
              background: "var(--paper)",
            }}>
              <Field label="School name" value={name} autoFocus required
                onChange={(e) => setName(e.target.value)} hint="You can change this later." />
              <button className="btn btn-primary" disabled={busy || !name.trim()}
                style={{ width: "100%", padding: 9 }}>
                {busy ? "Creating…" : "Create & set up"}
              </button>
            </form>
          ) : (
            <button onClick={() => setAdding(true)} style={{
              border: "1.5px dashed var(--line)", borderRadius: 11, padding: 16, minHeight: 130,
              background: "var(--paper)", color: "var(--ink-faint)", cursor: "pointer",
              display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
              gap: 5, font: "inherit",
            }}>
              <span style={{ fontSize: 26 }}>+</span>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Add a school</span>
              <span style={{ fontSize: 11.5 }}>{data.remaining} remaining</span>
            </button>
          ))}
        </div>

        {!data.canCreate && (
          <Note>
            Your account was invited into a school, so it cannot create new ones. Ask the
            administrator who invited you.
          </Note>
        )}
      </div>
    </PublicShell>
  );
}
