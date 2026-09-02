/**
 * §23.6 — the dev stand-in ERP, as a REST API.
 *
 *   docker compose exec api node /app/scripts/fake-erp-api.cjs      # port 4010
 *
 * There is no real ERP in the dev stack, so without this the Sync screen has
 * nothing to talk to and every card reports a connection error that looks like
 * a bug in the app.
 *
 * It serves the same fixture database `seed-erp-fixture.cjs` builds. That is
 * deliberate: the fixture is the fake ERP's OWN storage, read by this server
 * and by nothing else — the timetable app reaches it only over HTTP, exactly as
 * it would reach a real ERP.
 *
 * Three things here are shaped to be awkward on purpose, because an ERP will be:
 *   - it is **secured** (§23.8): every read needs a live OAuth2 access token
 *     from `/oauth/token`, and an expired or revoked one is a 401;
 *   - `/sections` returns NESTED objects (`class.name`, `session.name`), the way
 *     a REST API returns what SQL would have joined;
 *   - `/staff` PAGES, with the page count in a `meta` envelope.
 * A mapping that only works against flat, unpaged, unauthenticated JSON is not
 * an integration.
 *
 * `scripts/erp-api.dev.json` is the mapping that reads it, and doubles as a
 * worked example of the real thing.
 */
const http = require("node:http");
const crypto = require("node:crypto");
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");

// §23.8 — a SECURED stand-in. It speaks OAuth2 client credentials, because
// that is what the real ERP speaks, and a test double that is easier to talk to
// than the real thing tests the wrong code path.
const CLIENT_ID = process.env.ERP_API_CLIENT_ID || "edutimetable";
const CLIENT_SECRET = process.env.ERP_API_CLIENT_SECRET || "dev-erp-secret";
/** Short by default so the refresh path is exercised in ordinary dev use. */
const TOKEN_TTL_S = Number(process.env.FAKE_ERP_TOKEN_TTL || 900);

/** Start the stand-in. Resolves once it is listening. */
async function startFakeErpApi({ url, port = 4010, quiet = false } = {}) {
  const erpUrl = url || process.env.ERP_DATABASE_URL;
  if (!erpUrl) throw new Error("No fixture database URL — set ERP_DATABASE_URL (§23).");
  const db = new PrismaClient({ datasources: { db: { url: erpUrl } } });

  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

  const routes = {
    "/schools": async (q) =>
      wrap(await db.$queryRawUnsafe(`SELECT id, code, name FROM schools WHERE code = ?`, String(q.code ?? ""))),

    "/academic-sessions": async (q) =>
      wrap(await db.$queryRawUnsafe(
        `SELECT name, DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date,
                DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date, is_current
           FROM academic_sessions WHERE school_id = ? ORDER BY id`,
        num(q.school_id, 0))),

    "/classes": async (q) =>
      wrap(await db.$queryRawUnsafe(
        `SELECT name, display_order FROM classes WHERE school_id = ? ORDER BY display_order`,
        num(q.school_id, 0))),

    // Nested, like a real REST API: the client's mapping reads `class.name`.
    "/sections": async (q) => {
      const rows = await db.$queryRawUnsafe(
        `SELECT s.name, s.strength, c.name AS class_name, a.name AS session_name
           FROM sections s
           JOIN classes c ON c.id = s.class_id
           JOIN academic_sessions a ON a.id = s.session_id
          WHERE s.school_id = ? ORDER BY c.display_order, s.name`,
        num(q.school_id, 0));
      return wrap(rows.map((r) => ({
        name: r.name,
        strength: r.strength === null ? null : Number(r.strength),
        class: { name: r.class_name },
        session: { name: r.session_name },
      })));
    },

    "/subjects": async (q) =>
      wrap(await db.$queryRawUnsafe(
        `SELECT name, code FROM subjects WHERE school_id = ? ORDER BY id`, num(q.school_id, 0))),

    // Paged. `per_page` is honoured so a test can force several pages out of a
    // handful of rows — pagination that is never exercised is untested code.
    "/staff": async (q) => {
      const all = await db.$queryRawUnsafe(
        `SELECT employee_code, name, is_active FROM staff
          WHERE school_id = ? AND is_teaching = 1 ORDER BY employee_code`,
        num(q.school_id, 0));
      const size = num(q.per_page, 200);
      const page = num(q.page, 1);
      const lastPage = Math.max(1, Math.ceil(all.length / size));
      return {
        data: all.slice((page - 1) * size, page * size).map(clean),
        meta: { last_page: lastPage, total: all.length, per_page: size, current_page: page },
      };
    },
  };

  /** Issued access tokens → expiry (epoch ms). */
  const issued = new Map();
  const stats = { tokensIssued: 0, unauthorized: 0, lastActingUser: null, reads: 0 };

  const body = (rq) =>
    new Promise((resolve) => {
      let s = "";
      rq.on("data", (c) => { s += c; });
      rq.on("end", () => resolve(s));
    });

  const server = http.createServer(async (rq, rs) => {
    const send = (code, payload) => {
      rs.writeHead(code, { "Content-Type": "application/json" });
      rs.end(JSON.stringify(payload));
    };
    try {
      const u = new URL(rq.url, "http://erp.local");
      const path = u.pathname.replace(/^\/api\/v1/, "");

      // ---- the token endpoint (the only POST this API accepts) -------------
      if (path === "/oauth/token") {
        if (rq.method !== "POST") return send(405, { error: "invalid_request" });
        const form = new URLSearchParams(await body(rq));
        const basic = /^Basic /.test(rq.headers.authorization ?? "")
          ? Buffer.from(rq.headers.authorization.slice(6), "base64").toString().split(":")
          : null;
        const id = basic ? basic[0] : form.get("client_id");
        const secret = basic ? basic.slice(1).join(":") : form.get("client_secret");
        if (form.get("grant_type") !== "client_credentials") {
          return send(400, { error: "unsupported_grant_type" });
        }
        if (id !== CLIENT_ID || secret !== CLIENT_SECRET) {
          stats.unauthorized++;
          return send(401, { error: "invalid_client", error_description: "client authentication failed" });
        }
        const token = crypto.randomUUID();
        issued.set(token, Date.now() + TOKEN_TTL_S * 1000);
        stats.tokensIssued++;
        return send(200, { access_token: token, token_type: "Bearer", expires_in: TOKEN_TTL_S });
      }

      // ---- test hooks, for the smoke ---------------------------------------
      // This whole file is a test double; these make the auth path observable
      // rather than merely assumed to work.
      if (path === "/_test/stats") return send(200, { ...stats, activeTokens: issued.size });
      if (path === "/_test/revoke") { issued.clear(); return send(200, { revoked: true }); }

      // ---- everything else is a read, and needs a live token ---------------
      //
      // Read-only, and it says so: anything but GET is refused, so a mapping
      // that ever tried to write would fail here rather than succeed quietly.
      if (rq.method !== "GET") return send(405, { message: "This ERP API is read-only." });

      const bearer = (rq.headers.authorization ?? "").replace(/^Bearer /, "");
      const expiry = issued.get(bearer);
      if (!expiry || expiry < Date.now()) {
        issued.delete(bearer);
        stats.unauthorized++;
        return send(401, { message: "Unauthorized — token missing, expired or revoked" });
      }

      // §23.8 — who triggered this, when a person did. A real ERP would put
      // this in its audit log; recording it is how the smoke proves it arrives.
      stats.lastActingUser = rq.headers["x-erp-acting-user"] ?? null;
      stats.reads++;

      const route = routes[path];
      if (!route) return send(404, { message: `No such endpoint: ${path}` });

      send(200, await route(Object.fromEntries(u.searchParams)));
    } catch (e) {
      send(500, { message: e.message });
    }
  });

  await new Promise((resolve) => server.listen(port, resolve));
  if (!quiet) {
    console.log(
      `Stand-in ERP API listening on :${port} — OAuth2 client credentials ` +
        `(client "${CLIENT_ID}", tokens valid ${TOKEN_TTL_S}s)`,
    );
  }

  return {
    port,
    baseUrl: `http://localhost:${port}/api/v1`,
    async stop() {
      await new Promise((r) => server.close(r));
      await db.$disconnect();
    },
  };
}

/** BigInt and Buffer do not survive JSON.stringify; MySQL hands back both. */
function clean(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) out[k] = typeof v === "bigint" ? Number(v) : v;
  return out;
}
const wrap = (rows) => ({ data: rows.map(clean) });

module.exports = { startFakeErpApi };

if (require.main === module) {
  startFakeErpApi({ port: Number(process.env.FAKE_ERP_PORT || 4010) }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
