import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { io } from "socket.io-client";
import { api, getToken } from "../api";
import { asMessage, Card, ErrorNote } from "../components";

interface Notif {
  id: number;
  type: string;
  title: string;
  body: string;
  link: string | null;
  isRead: boolean;
  createdAt: string;
}

const ICONS: Record<string, string> = {
  published: "📣",
  solver_completed: "⚡",
  absence: "🤒",
  substitute_assigned: "🔁",
  substitute_gap: "⚠️",
};

const when = (iso: string) => {
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" }) + ", " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
};

/** §9 Notification Center — timeline with read/unread and deep links. */
export function Notifications() {
  const [rows, setRows] = useState<Notif[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api<Notif[]>("/notifications").then(setRows).catch((e) => setError(asMessage(e)));

  useEffect(() => {
    load();
    const socket = io({ auth: { token: getToken() } });
    socket.on("notification:new", load);
    return () => { socket.disconnect(); };
  }, []);

  const markAll = async () => {
    await api("/notifications/read-all", { method: "POST" });
    load();
  };
  const open = async (n: Notif) => {
    if (!n.isRead) {
      await api(`/notifications/${n.id}/read`, { method: "POST" }).catch(() => {});
      load();
    }
  };

  return (
    <Card
      title="Notification Center"
      sub="Every §9 trigger lands here in real time — publishes, solver runs, absences, substitute assignments."
      actions={<button className="btn btn-secondary" onClick={markAll} disabled={!rows?.some((r) => !r.isRead)}>Mark all read</button>}
    >
      <ErrorNote message={error} />
      {rows === null ? (
        <p className="screen-sub">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="screen-sub">Nothing yet — you'll see publishes, solver results, and substitution alerts here.</p>
      ) : (
        <div>
          {rows.map((n) => (
            <div key={n.id} onClick={() => open(n)} style={{
              display: "flex", gap: 12, padding: "13px 10px", borderBottom: "1px solid var(--line)",
              background: n.isRead ? "transparent" : "var(--steel-pale)", borderRadius: 8, marginBottom: 2, cursor: "pointer",
            }}>
              <div style={{ fontSize: 20 }}>{ICONS[n.type] ?? "🔔"}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: n.isRead ? 600 : 800, fontSize: 13.5 }}>
                  {n.title}
                  {!n.isRead && <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: "var(--brand)", marginLeft: 8 }} />}
                </div>
                <div style={{ fontSize: 12.5, color: "var(--ink-soft)", marginTop: 2 }}>{n.body}</div>
                <div style={{ fontSize: 10.5, color: "var(--ink-faint)", marginTop: 3 }}>
                  {when(n.createdAt)}
                  {n.link && <>{" · "}<Link to={n.link} style={{ color: "var(--brand)", fontWeight: 700 }}>Open →</Link></>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
