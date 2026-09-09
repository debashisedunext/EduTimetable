/**
 * One sign-in per role, against the seeded school — for demonstrating the app.
 *
 *   docker compose exec api node /app/scripts/seed-demo-logins.cjs
 *
 * The point is to show what each role actually SEES. A demo given entirely as
 * Super Admin shows a product where everybody can do everything, which is the
 * opposite of what §15's whole permission story is for: a teacher's sign-in
 * that reaches only their own grid is a feature, and it can only be shown by
 * signing in as one.
 *
 * Three things it deliberately does NOT do:
 *
 *  - **It does not hash a password itself.** Every account is created through
 *    `POST /auth/register` and verified through the real token, so the demo
 *    exercises the same path a customer does. A script writing its own hash
 *    would be a second definition of what a valid credential is, and the day
 *    the hashing parameters change it would quietly mint accounts that cannot
 *    sign in.
 *  - **It does not invent data.** It attaches to the school the master seed
 *    already built (`SCHOOL-2`, Second Branch), and refuses if that school has
 *    no published timetable — a demo of an empty timetable is worse than no
 *    demo.
 *  - **It does not run in production.** `/dev/*` is gated there, so the
 *    register-and-verify path this depends on is not available.
 *
 * Re-running is safe: an account that already exists is left alone, and its
 * user row is re-pointed at the right role rather than duplicated.
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");
const { PrismaClient: ControlClient } = req("/app/apps/api/prisma/generated/control-client");
const Redis = req("ioredis");

const API = process.env.API_INTERNAL || "http://localhost:3000";
/** Shared with `GET /dev/demo-logins`, which shows these on the sign-in screen. */
const PASSWORD = process.env.DEMO_LOGIN_PASSWORD || "DemoTimetable2026";
const DOMAIN = "demo.edutimetable.test";
const SCHOOL_CODE = "SCHOOL-2";

/**
 * Who to create, and — more usefully — what each one is FOR.
 *
 * `teacherCode` links the sign-in to a real staff row, which is what makes My
 * Timetable and My Classes show something. Without it a Teacher login is a
 * teacher who teaches nothing, which demonstrates the opposite of the point.
 */
const PEOPLE = [
  {
    role: "Super Admin", key: "admin", name: "Asha Menon",
    shows: "Everything — masters, generation, publishing, roles and the AI settings.",
  },
  {
    role: "Timetable Admin", key: "timetable", name: "Ravi Kulkarni",
    shows: "Builds and publishes timetables, but cannot change roles or AI keys.",
  },
  {
    role: "Principal", key: "principal", name: "Dr. Sunita Rao",
    shows: "Reads every timetable and every report. No editing at all.",
  },
  {
    role: "Teacher", key: "teacher", name: "Chetan Singh",
    teacherCode: "EDX-1085",
    shows: "Only their own 28 periods and the two class-sections they own (§15.3).",
  },
  {
    role: "Front Office", key: "frontoffice", name: "Meera Nair",
    shows: "The Substitute Center — marks a teacher absent and assigns cover.",
  },
];

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

(async () => {
  const prisma = new PrismaClient();
  const control = new ControlClient({ datasources: { db: { url: process.env.CONTROL_DATABASE_URL } } });
  const redis = new Redis(process.env.REDIS_URL || "redis://redis:6379");

  const school = await prisma.school.findFirst({ where: { code: SCHOOL_CODE } });
  if (!school) {
    console.error(`No school with code ${SCHOOL_CODE}. Run scripts/seed-school2.cjs first.`);
    process.exit(1);
  }
  const published = await prisma.timetableSlot.count({ where: { schoolId: school.id, status: "published" } });
  if (published === 0) {
    console.error(
      `${school.name} has no published timetable, so there would be nothing to demonstrate.\n` +
      "Generate and publish it first (Generate → Publish, or the API).",
    );
    process.exit(1);
  }
  console.log(`\n${school.name} — ${published} published lessons. Creating one sign-in per role:\n`);

  // Registering five accounts in a row trips the sign-up throttle, which would
  // fail this with a 429 that has nothing to do with the demo.
  const keys = await redis.keys("throttle:*:ip:*");
  if (keys.length) await redis.del(...keys);

  const roles = new Map(
    (await prisma.role.findMany({ where: { schoolId: school.id } })).map((r) => [r.name, r.id]),
  );

  for (const p of PEOPLE) {
    const email = `${p.key}@${DOMAIN}`;
    const roleId = roles.get(p.role);
    if (!roleId) { console.log(`  SKIP  ${p.role} — no such role in this school`); continue; }

    let account = await control.account.findUnique({ where: { email } });
    if (!account) {
      await call("POST", "/auth/register", null, { email, password: PASSWORD, name: p.name });
      const tok = await call("GET", `/dev/mail/token?to=${encodeURIComponent(email)}&kind=verify`);
      if (!tok.json?.token) {
        console.log(`  FAIL  ${p.role} — no verification token (is /dev gated?)`);
        continue;
      }
      await call("POST", "/auth/verify", null, { token: tok.json.token });
      account = await control.account.findUnique({ where: { email } });
    }
    if (!account) { console.log(`  FAIL  ${p.role} — account was not created`); continue; }

    const teacher = p.teacherCode
      ? await prisma.teacher.findFirst({ where: { schoolId: school.id, employeeCode: p.teacherCode } })
      : null;
    if (p.teacherCode && !teacher) {
      console.log(`  WARN  ${p.role} — no teacher ${p.teacherCode}; the login will see an empty timetable`);
    }

    // One user row per account per school, re-pointed rather than duplicated:
    // §24.7's rule is one login per teacher, and a second row would be a second
    // login for the same person.
    const existing = await prisma.user.findFirst({ where: { schoolId: school.id, accountId: account.id } });
    const data = {
      schoolId: school.id,
      accountId: account.id,
      erpUserId: `local:demo-${p.key}`,
      name: p.name,
      email,
      roleId,
      teacherId: teacher?.id ?? null,
      isActive: true,
    };
    if (existing) await prisma.user.update({ where: { id: existing.id }, data });
    else await prisma.user.create({ data });

    console.log(`  ${p.role.padEnd(16)} ${email.padEnd(34)} ${teacher ? `→ ${teacher.name}` : ""}`);
  }

  console.log(`\n  Password for all of them: ${PASSWORD}`);
  console.log("  They appear on the sign-in screen automatically (dev only).\n");

  await prisma.$disconnect();
  await control.$disconnect();
  redis.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
