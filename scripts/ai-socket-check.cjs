/**
 * Task 7.7 — the chat socket is guarded server-side (§13.3).
 * A hand-crafted client cannot reach the AI namespace without `ai.chat`, and a
 * forged token cannot reach it at all. Also exercises the ask path end to end.
 *
 *   docker compose exec web node /app/scripts/ai-socket-check.cjs
 *
 * socket.io-client lives in the web workspace, so resolve it from there
 * rather than from this file's location.
 */
const { createRequire } = require("node:module");
const { io } = createRequire("/app/apps/web/package.json")("socket.io-client");

const API = process.env.API_INTERNAL || "http://api:3000";

async function sessionFor(payload) {
  const r = await fetch(`${API}/api/dev/erp-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const { token } = await r.json();
  const cb = await fetch(`${API}/api/sso/callback?token=${token}`, { redirect: "manual" });
  return (cb.headers.get("location") || "").split("#token=")[1];
}

/** Resolves { connected, error } once the socket settles. */
function probe(token, holdMs = 1500) {
  return new Promise((resolve) => {
    const socket = io(`${API}/ai`, {
      auth: { token },
      transports: ["websocket"],
      reconnection: false,
      timeout: 5000,
    });
    let settled = false;
    let error = null;
    const finish = (connected) => {
      if (settled) return;
      settled = true;
      const c = connected && socket.connected;
      socket.close();
      resolve({ connected: c, error });
    };
    socket.on("ai:error", (d) => { error = d.message; });
    socket.on("connect_error", (e) => { error = error || e.message; finish(false); });
    socket.on("disconnect", () => finish(false));
    socket.on("connect", () => setTimeout(() => finish(true), holdMs));
    setTimeout(() => finish(socket.connected), 9000);
  });
}

/** Ask a question and collect the streamed events. */
function ask(token, question) {
  return new Promise((resolve) => {
    const socket = io(`${API}/ai`, { auth: { token }, transports: ["websocket"], reconnection: false });
    const out = { deltas: 0, text: "", tools: [], error: null, done: false };
    const finish = () => { socket.close(); resolve(out); };
    socket.on("connect", () => socket.emit("ai:ask", { question }));
    socket.on("ai:delta", (d) => { out.deltas++; out.text += d.text; });
    socket.on("ai:tool", (t) => out.tools.push(t.name));
    socket.on("ai:done", () => { out.done = true; finish(); });
    socket.on("ai:error", (d) => { out.error = d.message; finish(); });
    setTimeout(finish, 90_000);
  });
}

(async () => {
  let failed = 0;
  const expect = (ok, label, detail = "") => {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failed = 1;
  };

  const teacher = await sessionFor({ erpUserId: "ERP-3", erpRole: "TEACHER", name: "R. Sharma", email: "rs@school.test", teacherId: 1 });
  const admin = await sessionFor({ erpUserId: "ERP-1", erpRole: "ADMIN", name: "Admin A", email: "a@school.test" });

  console.log("Socket-layer enforcement (§13.3):");
  const t = await probe(teacher);
  expect(!t.connected, "teacher without ai.chat is refused at handshake", t.error || "");
  const g = await probe("not-a-jwt");
  expect(!g.connected, "forged token is refused");
  const a = await probe(admin);
  expect(a.connected, "admin with ai.chat connects");

  console.log("Ask path:");
  const res = await ask(admin, "How many periods does Rekha Sharma teach this week?");
  if (res.error && /No AI provider key/i.test(res.error)) {
    expect(true, "no key configured → clear, actionable error (not a crash)", res.error.slice(0, 60) + "…");
  } else if (res.done) {
    expect(res.text.length > 0, "streamed an answer", `${res.deltas} deltas, tools: ${res.tools.join(", ") || "none"}`);
    expect(res.tools.length > 0, "answer was grounded in tool calls", res.tools.join(", "));
  } else {
    expect(false, "ask path produced neither an answer nor a clean error", res.error || "silent");
  }

  console.log(failed ? "SOME AI SOCKET CHECKS FAILED" : "ALL AI SOCKET CHECKS PASSED");
  process.exit(failed);
})();
