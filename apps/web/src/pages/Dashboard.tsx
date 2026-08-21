import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type { MeResponse } from "@edutimetable/shared";
import { api, getToken } from "../api";

interface Health {
  status: string;
  db: boolean;
  redis: boolean;
}

export function Dashboard({ me }: { me: MeResponse }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [jobDone, setJobDone] = useState(false);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    api<Health>("/health").then(setHealth).catch(() => setHealth(null));
    const socket = io({ auth: { token: getToken() } });
    socket.on("demo:progress", ({ progress }: { progress: number }) => {
      setJobDone(false);
      setProgress(progress);
    });
    socket.on("demo:completed", () => setJobDone(true));
    socketRef.current = socket;
    return () => {
      socket.disconnect();
    };
  }, []);

  const runJob = async () => {
    setProgress(0);
    setJobDone(false);
    await api("/demo-jobs", { method: "POST" });
  };

  return (
    <div style={{ display: "grid", gap: 18, maxWidth: 720 }}>
      <div className="card">
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: 17, marginBottom: 4 }}>
          Signed in via Edunext SSO
        </h2>
        <p className="screen-sub">Session, role, and permissions resolved server-side (§15).</p>
        <div className="kv"><b>User</b> {me.name} · {me.email}</div>
        <div className="kv"><b>Role</b> {me.role}</div>
        <div className="kv"><b>Teacher link</b> {me.teacherId ?? "— not a teacher —"}</div>
        <div className="kv">
          <b>Permissions</b>
          <span style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
            {me.permissions.map((p) => (
              <span key={p} className="chip mono">{p}</span>
            ))}
          </span>
        </div>
      </div>

      <div className="card">
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: 17, marginBottom: 4 }}>
          Stack health
        </h2>
        <p className="screen-sub">API → MySQL and Redis, all inside the Docker network.</p>
        {health ? (
          <div style={{ display: "flex", gap: 8 }}>
            <span className={`badge ${health.db ? "badge-ok" : "badge-error"}`}>MySQL {health.db ? "✓" : "✗"}</span>
            <span className={`badge ${health.redis ? "badge-ok" : "badge-error"}`}>Redis {health.redis ? "✓" : "✗"}</span>
          </div>
        ) : (
          <span className="badge badge-error">API unreachable</span>
        )}
      </div>

      <div className="card">
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: 17, marginBottom: 4 }}>
          Background job pipeline
        </h2>
        <p className="screen-sub">
          API enqueues → worker container processes → progress streams back over Socket.IO. The
          Phase 2 solver uses this exact pipeline.
        </p>
        <button className="btn btn-primary" onClick={runJob}>Run demo job</button>
        {progress !== null && (
          <>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${progress}%` }} />
            </div>
            <span className="mono" style={{ fontSize: 12, color: "var(--ink-soft)" }}>
              {jobDone ? "Completed ✓" : `${progress}%`}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
