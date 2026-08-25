import { useState } from "react";
import { api } from "../api";
import { asMessage, Card, ErrorNote } from "../components";
import { useApi } from "../hooks";

interface TenantRow {
  id: number;
  schoolCode: string;
  displayName: string;
  mode: "shared" | "dedicated";
  status: "active" | "suspended" | "provisioning";
  localSchoolId: number;
  schemaVersion: string | null;
  schemaCurrent: boolean | null;
  trust: { id: number; code: string; name: string } | null;
  erpInstance: { id: number; name: string };
  hasStoredUrl: boolean;
}

interface Overview {
  registry: boolean;
  expectedSchema: string | null;
  schools: { total: number; active: number; suspended: number; shared: number; dedicated: number; behind: number };
  connections: {
    open: number; maxClients: number; poolLimit: number; maxConnections: number;
    sharedSchema: { ok: boolean; applied: string | null; missing: number } | null;
  };
}

interface TestResult {
  ok: boolean;
  ms?: number;
  mode?: string;
  schema?: { ok: boolean; applied: string | null; expected: string | null; missing: string[] };
  schoolsInDatabase?: number;
  error?: string;
}

const chip = (text: string, tone: "ok" | "warn" | "bad" | "muted") => {
  const tones = {
    ok: { bg: "var(--steel-pale)", fg: "var(--accent)", bd: "var(--steel-light)" },
    warn: { bg: "var(--amber-bg)", fg: "var(--amber)", bd: "var(--amber)" },
    bad: { bg: "var(--signal-bg)", fg: "var(--signal)", bd: "var(--signal)" },
    muted: { bg: "var(--offwhite)", fg: "var(--ink-faint)", bd: "var(--line)" },
  }[tone];
  return (
    <span style={{
      fontSize: 10.5, fontWeight: 700, padding: "2px 7px", borderRadius: 20,
      background: tones.bg, color: tones.fg, border: `1px solid ${tones.bd}`, whiteSpace: "nowrap",
    }}>
      {text}
    </span>
  );
};

const Stat = ({ label, value, tone }: { label: string; value: string | number; tone?: "warn" | "bad" }) => (
  <div style={{ flex: 1, minWidth: 108 }}>
    <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--ink-faint)", fontWeight: 700 }}>
      {label}
    </div>
    <div style={{
      fontFamily: "var(--font-display)", fontSize: 24, fontWeight: 600, lineHeight: 1.2,
      color: tone === "bad" ? "var(--signal)" : tone === "warn" ? "var(--amber)" : "var(--brand-deep)",
    }}>
      {value}
    </div>
  </div>
);

/**
 * The Platform Console (§17.6) — the view from above every school.
 *
 * Deliberately narrow, and the screen says why rather than leaving an operator
 * hunting for the missing buttons: it cannot create a school (that provisions a
 * database, which carries credentials and is a command) and it cannot delete
 * one (suspension is the reversible equivalent, and is what is actually
 * wanted). It never shows a connection URL — only whether one is stored and
 * whether it works.
 */
export function Platform() {
  const { data: overview, refetch: refetchOverview } = useApi<Overview>("/platform/overview");
  const { data: tenants, refetch } = useApi<TenantRow[]>("/platform/tenants");
  const [error, setError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<number, TestResult | "running">>({});

  const test = async (id: number) => {
    setTests((t) => ({ ...t, [id]: "running" }));
    try {
      const result = await api<TestResult>(`/platform/tenants/${id}/test`, { method: "POST" });
      setTests((t) => ({ ...t, [id]: result }));
    } catch (e) {
      setTests((t) => ({ ...t, [id]: { ok: false, error: asMessage(e) } }));
    }
  };

  const setStatus = async (row: TenantRow, status: "active" | "suspended") => {
    const verb = status === "suspended" ? "Suspend" : "Reinstate";
    const warning =
      status === "suspended"
        ? `Suspend ${row.displayName}?\n\nIts users will not be able to sign in until it is reinstated. Anyone already signed in keeps their session until it expires.`
        : `Reinstate ${row.displayName}? Its users will be able to sign in again.`;
    if (!window.confirm(warning)) return;
    try {
      await api(`/platform/tenants/${row.id}/status`, { method: "POST", body: JSON.stringify({ status }) });
      refetch();
      refetchOverview();
    } catch (e) {
      setError(`${verb} failed: ${asMessage(e)}`);
    }
  };

  if (!overview) return <p style={{ color: "var(--ink-faint)", fontSize: 13 }}>Loading…</p>;

  const grouped = new Map<string, TenantRow[]>();
  for (const t of tenants ?? []) {
    const key = t.trust ? t.trust.name : "Independent schools";
    grouped.set(key, [...(grouped.get(key) ?? []), t]);
  }

  return (
    <div>
      <ErrorNote message={error} />

      {!overview.registry && (
        <Card>
          <p style={{ fontSize: 13, color: "var(--ink-soft)" }}>
            No tenant registry is configured (<span className="mono">CONTROL_DATABASE_URL</span> is unset), so
            this deployment serves a single school and has nothing to administer here.
          </p>
        </Card>
      )}

      <Card title="Deployment" sub={`Schema this build expects: ${overview.expectedSchema ?? "—"}`}>
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
          <Stat label="Schools" value={overview.schools.total} />
          <Stat label="Suspended" value={overview.schools.suspended} tone={overview.schools.suspended > 0 ? "warn" : undefined} />
          <Stat label="Own database" value={overview.schools.dedicated} />
          <Stat label="Behind" value={overview.schools.behind} tone={overview.schools.behind > 0 ? "bad" : undefined} />
          <Stat
            label="Connections"
            value={`${overview.connections.open}/${overview.connections.maxClients}`}
            tone={overview.connections.open >= overview.connections.maxClients ? "warn" : undefined}
          />
        </div>
        <p style={{ fontSize: 11.5, color: "var(--ink-faint)", marginTop: 12, lineHeight: 1.6 }}>
          Every open client holds a pool, so the ceiling is{" "}
          <strong>{overview.connections.maxClients} × {overview.connections.poolLimit} ={" "}
          {overview.connections.maxConnections}</strong> connections against MySQL's{" "}
          <span className="mono">max_connections</span> — raise{" "}
          <span className="mono">TENANT_MAX_CLIENTS</span> only alongside it. A school behind this build is
          refused rather than served; <span className="mono">pnpm migrate:all</span> brings every database up
          to date.
        </p>
      </Card>

      {[...grouped.entries()].map(([group, rows]) => (
        <Card key={group} title={group} sub={`${rows.length} school${rows.length === 1 ? "" : "s"}`}>
          <table className="data-table">
            <thead>
              <tr>
                <th>School</th><th>Code</th><th>Where its data lives</th><th>Schema</th><th>Status</th><th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                const result = tests[t.id];
                return (
                  <tr key={t.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{t.displayName}</div>
                      <div style={{ fontSize: 11, color: "var(--ink-faint)" }}>
                        tenant {t.id} · school_id {t.localSchoolId} · {t.erpInstance.name}
                      </div>
                    </td>
                    <td className="mono">{t.schoolCode}</td>
                    <td>
                      {t.mode === "dedicated"
                        ? chip(t.hasStoredUrl ? "own database" : "own database · NO URL", t.hasStoredUrl ? "ok" : "bad")
                        : chip("shared", "muted")}
                    </td>
                    <td>
                      {t.schemaVersion === null
                        ? chip("unknown", "muted")
                        : t.schemaCurrent
                          ? chip("current", "ok")
                          : chip("behind", "bad")}
                    </td>
                    <td>
                      {t.status === "active" ? chip("active", "ok") : chip(t.status, "warn")}
                    </td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button
                        className="btn"
                        style={{ border: "1px solid var(--line)", fontSize: 11, marginRight: 6 }}
                        onClick={() => test(t.id)}
                        disabled={result === "running"}
                      >
                        {result === "running" ? "Testing…" : "Test"}
                      </button>
                      <button
                        className="btn"
                        style={{ border: "1px solid var(--line)", fontSize: 11 }}
                        onClick={() => setStatus(t, t.status === "active" ? "suspended" : "active")}
                      >
                        {t.status === "active" ? "Suspend" : "Reinstate"}
                      </button>
                      {result && result !== "running" && (
                        <div style={{ fontSize: 11, marginTop: 5, textAlign: "right", color: result.ok ? "var(--ink-faint)" : "var(--signal)", maxWidth: 340, whiteSpace: "normal" }}>
                          {result.ok
                            ? `Reachable in ${result.ms}ms · schema ${result.schema?.ok ? "current" : `behind (${result.schema?.missing.length} missing)`} · ${result.schoolsInDatabase} school row(s)`
                            : result.error}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      ))}

      <Card title="What this console deliberately cannot do">
        <ul style={{ fontSize: 12.5, color: "var(--ink-soft)", lineHeight: 1.75, paddingLeft: 18, margin: 0 }}>
          <li>
            <strong>Create a school.</strong> That provisions a database, which carries credentials — an
            operator action, not a click:{" "}
            <span className="mono">pnpm --filter @edutimetable/api tenant:create --code … --name …</span>.
            A school the ERP mentions that nobody provisioned lands in the shared database.
          </li>
          <li>
            <strong>Delete one.</strong> A school holding data is not something to remove through a web form.
            Suspend is the reversible equivalent.
          </li>
          <li>
            <strong>Show a connection URL.</strong> Those are credentials, encrypted at rest. This page reports
            whether one is stored and whether it works, never what it is.
          </li>
          <li>
            <strong>Grant platform access.</strong>{" "}
            <span className="mono">pnpm --filter @edutimetable/api platform:admin -- --grant &lt;ERP-USER-ID&gt;</span>.
            Authority over the registry should take a deliberate act on the host, not a click by whoever
            currently holds it.
          </li>
        </ul>
      </Card>
    </div>
  );
}
