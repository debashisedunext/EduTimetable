/**
 * §30.7 — do two live timetables put one person, or one room, in two places at
 * the same moment?
 *
 * ## Why this cannot be done by period number
 *
 * Occupancy everywhere else in this system is keyed by **period number** —
 * that is what `uq_teacher_slot` and `uq_room_slot` compare, and within one
 * timetable it is exactly right. Across two it is not, because two wings keep
 * different hours: Junior's P3 starts 09:14 and Senior's P2 starts 09:14.
 * Comparing period numbers would refuse a pair that does not overlap and allow
 * a pair that does — confidently wrong in both directions.
 *
 * §28.5 already records the answer ("the real design is tick-based occupancy")
 * and records it as the reason per-class period lengths are refused. This is
 * that arithmetic, for the one question that can be answered without it: not
 * *preventing* a clash while placing, but *reporting* one that already exists.
 *
 * ## Why it is a warning and never a blocker
 *
 * Two timetables are only in conflict if the school actually runs them at the
 * same time. §30.5 already makes the case that matters impossible — a class
 * cannot be in two live timetables at once — so what is left here is two
 * timetables over *different* classes that share a teacher or a room. That may
 * be a mistake, or it may be a wing that runs in the morning and one that runs
 * in the afternoon with windows nobody has narrowed. Only the school knows,
 * which is exactly the shape of a warning.
 */

/** One engagement, flattened to wall-clock minutes. */
export interface Occupancy {
  /** What is occupied — a teacher id or a room id, already namespaced by kind. */
  key: string;
  /** ISO day, 1 = Monday. */
  day: number;
  /** Minutes from midnight. */
  startMin: number;
  endMin: number;
  /** For the message: "Class 5-A Maths, P3 09:14–09:54". */
  label: string;
}

export interface Clash {
  key: string;
  day: number;
  a: Occupancy;
  b: Occupancy;
}

/** "09:14" → 554. Returns null for anything that is not a time, so a malformed
 *  period row is skipped rather than treated as midnight. */
export function minutesOf(hhmm: string | null | undefined): number | null {
  if (!hhmm) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Every pair of occupancies, one from each side, that share a key, a day and a
 * minute.
 *
 * Touching is not overlapping: a period ending at 09:14 and one starting at
 * 09:14 do not collide, or every back-to-back pair in the school would be
 * reported. Strict inequality on both ends is what says so.
 *
 * O(n log n) by key and day rather than the obvious n²: on the reference school
 * each side is ~2,400 engagements, and the quadratic version is six million
 * comparisons on a screen with a 300 ms budget (§14).
 */
export function findClashes(left: Occupancy[], right: Occupancy[]): Clash[] {
  const index = new Map<string, Occupancy[]>();
  for (const o of right) {
    const k = `${o.key}|${o.day}`;
    const at = index.get(k);
    if (at) at.push(o);
    else index.set(k, [o]);
  }
  const out: Clash[] = [];
  for (const a of left) {
    const candidates = index.get(`${a.key}|${a.day}`);
    if (!candidates) continue;
    for (const b of candidates) {
      if (a.startMin < b.endMin && b.startMin < a.endMin) out.push({ key: a.key, day: a.day, a, b });
    }
  }
  return out;
}

/**
 * Collapse clashes to one entry per occupied thing.
 *
 * A teacher taught by two wings all week produces forty pairs; reporting forty
 * issues would bury the one sentence a school needs. Grouped, counted, and with
 * the first few named — the shape §28.1's Check 12 settled on for the same
 * reason.
 */
export function groupClashes(clashes: Clash[]): Array<{ key: string; count: number; samples: Clash[] }> {
  const by = new Map<string, Clash[]>();
  for (const c of clashes) {
    const at = by.get(c.key);
    if (at) at.push(c);
    else by.set(c.key, [c]);
  }
  return [...by.entries()]
    .map(([key, list]) => ({
      key,
      count: list.length,
      samples: list
        .slice()
        .sort((x, y) => x.day - y.day || x.a.startMin - y.a.startMin)
        .slice(0, 3),
    }))
    .sort((x, y) => y.count - x.count);
}
