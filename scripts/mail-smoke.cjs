/**
 * §15.3 — outgoing mail, against a REAL SMTP server.
 *
 *   docker compose exec api node /app/scripts/mail-smoke.cjs
 *
 * Every other suite reads its links out of the Redis capture, which is exactly
 * why this one exists: the capture runs for every transport, so a suite that
 * only reads it passes just as happily when nothing is being delivered. For a
 * long time nothing was — `log` was the only implementation, and the four flows
 * that depend on a link in an inbox (verify, reset, invite, bulk invite) had
 * never once put one there.
 *
 * So this asserts against the INBOX: the dev stack speaks SMTP to Mailpit, and
 * this reads Mailpit's own API to see what actually arrived.
 *
 *   1. VERIFY   — registration sends a confirmation, and its link works
 *   2. RESET    — a forgotten password sends a link, and its link works
 *   3. INVITE   — a teacher invitation arrives, and its link RESOLVES
 *   4. SILENCE  — an unknown address is sent nothing, and still answers the same
 *   5. SHAPE    — the message has a text part, an HTML part, and one From
 *
 * Skipped with a clear message when the transport is `log`, because there is
 * then no inbox to read and pretending otherwise would be a green tick for a
 * deployment that cannot send anything.
 *
 * Everything it creates uses @zzmail.test / "ZZMAIL " and is removed at the end.
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");
const { PrismaClient: ControlClient } = req("/app/apps/api/prisma/generated/control-client");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const MAIL = process.env.MAILPIT_URL || "http://mailpit:8025";
const DOMAIN = "zzmail.test";
const PW = "correct horse battery staple";

let failed = 0;
const check = (ok, label, extra = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failed = 1;
};

async function call(method, path, token, body) {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

/** Mail is sent after the response returns, so give the transport a moment. */
async function waitForMail(to, timeoutMs = 6000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const box = await (await fetch(`${MAIL}/api/v1/messages?limit=200`)).json();
    const hit = (box.messages ?? []).find((m) => (m.To ?? []).some((a) => a.Address === to));
    if (hit) return (await (await fetch(`${MAIL}/api/v1/message/${hit.ID}`)).json());
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

const linkIn = (msg) => ((msg?.Text ?? "").match(/https?:\/\/\S+/) || [])[0] ?? null;

(async () => {
  const prisma = new PrismaClient();
  const control = new ControlClient({ datasources: { db: { url: process.env.CONTROL_DATABASE_URL } } });

  const purge = async () => {
    const mine = await prisma.school.findMany({
      where: { name: { startsWith: "ZZMAIL " } }, select: { id: true, code: true },
    });
    const ids = mine.map((s) => s.id);
    for (const m of [
      "onboardingSession", "aiChatLog", "auditLog", "user", "rolePermission", "erpRoleMapping", "role",
    ]) {
      if (ids.length) await prisma[m].deleteMany({ where: { schoolId: { in: ids } } }).catch(() => undefined);
    }
    if (ids.length) await prisma.school.deleteMany({ where: { id: { in: ids } } });
    await control.tenant.deleteMany({ where: { schoolCode: { in: mine.map((s) => s.code) } } });
    await control.account.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
  };

  // Nothing to read from, so say so rather than passing.
  let reachable = false;
  try { reachable = (await fetch(`${MAIL}/api/v1/info`)).ok; } catch { reachable = false; }
  if (!reachable) {
    console.log(`\nNo mail server at ${MAIL}. This suite asserts against a real inbox, so it`);
    console.log("cannot run with MAIL_TRANSPORT=log. Start the stack (`docker compose up -d mailpit`).");
    process.exit(0);
  }

  await purge();
  await fetch(`${MAIL}/api/v1/messages`, { method: "DELETE" });
  const stamp = Date.now();

  // ───────────────────────────────────────────────────────── 1. VERIFY
  console.log("\nRegistering sends a confirmation that actually arrives:");
  const owner = `owner-${stamp}@${DOMAIN}`;
  const reg = await call("POST", "/auth/register", null, { email: owner, password: PW, name: "ZZMAIL Owner" });
  check(reg.status < 300, "registered", `${reg.status}`);

  const verifyMail = await waitForMail(owner);
  check(Boolean(verifyMail), "a message reached the inbox");
  check(verifyMail?.Subject === "Confirm your email address", "with the right subject", verifyMail?.Subject);
  check((verifyMail?.From?.Address ?? "").includes("@"), "and one sensible From address",
    verifyMail?.From?.Address);
  const verifyLink = linkIn(verifyMail);
  check(Boolean(verifyLink) && verifyLink.includes("/verify?token="), "carrying a verification link",
    verifyLink?.slice(0, 62));

  // The link is the whole message; a link that does not work is a message that
  // did not arrive, however prettily it was formatted.
  const verified = await call("POST", "/auth/verify", null, { token: verifyLink.split("token=")[1] });
  check(verified.status < 300, "and the link WORKS", `${verified.status}`);

  // ────────────────────────────────────────────────────────── 5. SHAPE
  check((verifyMail?.Text ?? "").length > 50, "the message has a readable text part");
  check(/<a href=/.test(verifyMail?.HTML ?? ""), "and an HTML part with a clickable link");
  check(!/<img/i.test(verifyMail?.HTML ?? ""),
    "and no images — a school's mail should survive the strictest filter its IT department has");

  // ────────────────────────────────────────────────────────── 2. RESET
  console.log("\nA forgotten password sends a link that works:");
  await call("POST", "/auth/forgot", null, { email: owner });
  const resetMail = await waitForMail(owner);
  const resetLink = linkIn(resetMail);
  check(Boolean(resetLink) && resetLink.includes("/reset?token="), "a reset link arrived",
    resetLink?.slice(0, 58));
  const reset = await call("POST", "/auth/reset", null, {
    token: resetLink.split("token=")[1], password: "a different perfectly fine passphrase",
  });
  check(reset.status < 300, "and it works", `${reset.status}`);

  // ───────────────────────────────────────────────────────── 3. INVITE
  console.log("\nA teacher invitation arrives, and its link RESOLVES:");
  const login = await call("POST", "/auth/login", null, {
    email: owner, password: "a different perfectly fine passphrase",
  });
  const made = await call("POST", "/schools", login.json.accountToken, { name: "ZZMAIL School" });
  const S = made.json.sessionToken;
  const roles = (await call("GET", "/admin/overview", S)).json?.roles ?? [];
  const teacherRole = roles.find((r) => r.name === "Teacher");

  const teacherEmail = `teacher-${stamp}@${DOMAIN}`;
  const invited = await call("POST", "/users/invite", S, {
    email: teacherEmail, name: "ZZMAIL Teacher", roleId: teacherRole.id,
  });
  check(invited.status < 300, "invitation sent", `${invited.status}`);

  const inviteMail = await waitForMail(teacherEmail);
  check(Boolean(inviteMail), "and it reached the teacher's inbox");
  const inviteLink = linkIn(inviteMail);
  /**
   * The regression this check exists for. The link was built as
   * `/invite?token=…` while the route is `/invite/:token`, so every invitation
   * ever sent pointed at a page that does not exist — and no suite noticed,
   * because they all read the token out of the capture rather than following
   * the link a teacher would actually click.
   */
  check(Boolean(inviteLink) && /\/invite\/[^?]+$/.test(inviteLink),
    "as a PATH the router matches, not a query string it ignores", inviteLink?.slice(0, 58));
  const token = inviteLink.split("/invite/")[1];
  const preview = await call("GET", `/auth/invite/${token}`);
  check(preview.json?.valid === true && preview.json?.email === teacherEmail,
    "and following it finds the real invitation", `${preview.json?.email}`);

  // ──────────────────────────────────────────────────────── 4. SILENCE
  console.log("\nAn address nobody registered is sent nothing:");
  const before = (await (await fetch(`${MAIL}/api/v1/messages?limit=200`)).json()).messages_count;
  const stranger = `nobody-${stamp}@${DOMAIN}`;
  const forgot = await call("POST", "/auth/forgot", null, { email: stranger });
  await new Promise((r) => setTimeout(r, 1200));
  const after = (await (await fetch(`${MAIL}/api/v1/messages?limit=200`)).json()).messages_count;
  check(after === before, "no message was sent", `${before} → ${after}`);
  check(forgot.status < 300 && /check your inbox/i.test(forgot.json?.message ?? ""),
    "but the answer is the SAME one a real address gets — otherwise this endpoint is a customer list",
    (forgot.json?.message ?? "").slice(0, 46));

  // ───────────────────────────────────────────────────────────── cleanup
  console.log("\nCleanup:");
  await purge();
  await fetch(`${MAIL}/api/v1/messages`, { method: "DELETE" });
  check((await prisma.school.count({ where: { name: { startsWith: "ZZMAIL " } } })) === 0, "test school removed");

  await prisma.$disconnect();
  await control.$disconnect();
  console.log(failed ? "\nSOME MAIL CHECKS FAILED" : "\nALL MAIL CHECKS PASSED");
  process.exit(failed);
})().catch((e) => { console.error(e); process.exit(1); });
