/**
 * §23.6 — turning an ERP's JSON into the rows the sync understands.
 *
 * A REST source hands back the ERP's own shape: `{ data: [ { staff_code, …,
 * employment: { active: 1 } } ], meta: { last_page: 4 } }`. The reconcile
 * engine wants `{ employeeCode, name, isActive }`. This module is the
 * translation, declared as paths rather than written as code, so adapting to a
 * new ERP is configuration and not a deployment.
 *
 * Pure and dependency-free — no fetch, no Nest — so every path rule is
 * unit-testable without an ERP to call.
 */

/**
 * Read a dotted path out of a JSON value. `data.0.name` and `data[0].name`
 * both work, because an ERP's docs will show one and a person will type the
 * other.
 *
 * Returns `undefined` for a path that does not resolve — never throws, and
 * never invents. The difference matters: a field that is missing must be left
 * alone by the sync (`changedFields` skips `undefined`), whereas a field that
 * is present and null is a real value.
 */
export function pick(source: unknown, path: string): unknown {
  if (path === "" || path === ".") return source;
  let cur: unknown = source;
  for (const raw of path.replace(/\[(\d+)\]/g, ".$1").split(".")) {
    if (raw === "") continue;
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const i = Number(raw);
      if (!Number.isInteger(i)) return undefined;
      cur = cur[i];
      continue;
    }
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[raw];
  }
  return cur;
}

/**
 * Where the array of records lives in a response.
 *
 * `""` means the response IS the array, which is what a plain
 * `GET /teachers` returns and what a lot of small APIs do. Anything else is a
 * path: `data`, `result.items`, `payload.rows`.
 */
export function pickList(source: unknown, listPath: string): unknown[] {
  const v = listPath ? pick(source, listPath) : source;
  if (Array.isArray(v)) return v;
  // Not an array is a configuration error, not an empty result — reporting it
  // as "0 rows" would send somebody looking for missing data in the ERP.
  throw new Error(
    `expected a list at "${listPath || "the response root"}" but found ${
      v === undefined ? "nothing" : Array.isArray(v) ? "an array" : typeof v
    }`,
  );
}

/**
 * One ERP record, mapped to our field keys.
 *
 * A field whose path does not resolve is **omitted**, not set to null: the
 * reconcile engine treats an absent field as "this source does not carry it,
 * leave ours alone", which is the difference between a partial API and data
 * loss.
 */
export function mapRecord(record: unknown, fields: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [ours, theirs] of Object.entries(fields)) {
    const v = pick(record, theirs);
    if (v === undefined) continue;
    out[ours] = typeof v === "string" ? v.trim() : v;
  }
  return out;
}

/** Which of our fields a mapping failed to produce, for the probe to report. */
export function missingFields(record: unknown, fields: Record<string, string>): string[] {
  return Object.entries(fields)
    .filter(([, theirs]) => pick(record, theirs) === undefined)
    .map(([ours, theirs]) => `${ours} (no "${theirs}" in the response)`);
}

/**
 * Fill `{placeholders}` in a URL or query string.
 *
 * Values are URL-encoded, because a school code may contain a slash and an ERP
 * is entitled to reject the request rather than guess. An unknown placeholder
 * is an error rather than a literal `{schoolId}` reaching the ERP as a string
 * — that would 404 or, worse, silently return every school's staff.
 */
export function fillTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    if (!(name in vars)) {
      throw new Error(`unknown placeholder {${name}} — available: ${Object.keys(vars).join(", ") || "none"}`);
    }
    return encodeURIComponent(String(vars[name]));
  });
}
