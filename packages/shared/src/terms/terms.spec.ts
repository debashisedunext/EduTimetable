import { describe, expect, it } from "vitest";
import { formatSpan, nextDay, splitSession, termForDate, validateTerms } from "./terms";

/**
 * §25 Phase 26 — the arithmetic behind term-wise timetables.
 *
 * These rules decide which dates a term covers, and a term is what a slot is
 * filed under. Getting them wrong files a lesson in the wrong half of the year,
 * which nobody notices until October.
 */

const SESSION = { startDate: "2026-04-01", endDate: "2027-03-31" };

describe("§25 splitting a session into terms", () => {
  it("gives two six-month terms for the ordinary Indian session — the case in the requirement", () => {
    expect(splitSession(SESSION.startDate, SESSION.endDate, 2)).toEqual([
      { name: "Term 1", startDate: "2026-04-01", endDate: "2026-09-30" },
      { name: "Term 2", startDate: "2026-10-01", endDate: "2027-03-31" },
    ]);
  });

  it("gives three four-month terms, and four three-month ones", () => {
    const three = splitSession(SESSION.startDate, SESSION.endDate, 3);
    expect(three.map((t) => `${t.startDate}..${t.endDate}`)).toEqual([
      "2026-04-01..2026-07-31", "2026-08-01..2026-11-30", "2026-12-01..2027-03-31",
    ]);
    expect(splitSession(SESSION.startDate, SESSION.endDate, 4)).toHaveLength(4);
  });

  it("is contiguous and covers the session exactly — no gap, no overhang", () => {
    for (const n of [2, 3, 4, 6]) {
      const terms = splitSession(SESSION.startDate, SESSION.endDate, n);
      expect(terms[0].startDate, `${n} terms`).toBe(SESSION.startDate);
      expect(terms[terms.length - 1].endDate, `${n} terms`).toBe(SESSION.endDate);
      for (let i = 1; i < terms.length; i++) {
        expect(terms[i].startDate, `${n} terms, gap before ${i}`).toBe(nextDay(terms[i - 1].endDate));
      }
      expect(validateTerms(terms, SESSION), `${n} terms`).toEqual([]);
    }
  });

  it("ends a term on the last day of its month, leap February included", () => {
    // Asked for the last day of the month rather than computed from a length
    // table, so 2028 needs no special case — and cannot acquire a wrong one.
    const terms = splitSession("2027-12-01", "2028-05-31", 2);
    expect(terms[0].endDate).toBe("2028-02-29");
    expect(terms[1].startDate).toBe("2028-03-01");
  });

  /**
   * A session that does not start on the 1st has no obvious "six months each",
   * so months are not used at all — it splits by days. The narrowing is the
   * point: a rule that guessed a month boundary here would put one somewhere
   * nobody chose, and only for some schools.
   */
  it("splits by days when the session does not start on the 1st, and still covers it exactly", () => {
    const terms = splitSession("2026-04-15", "2027-04-14", 2);
    expect(terms).toHaveLength(2);
    expect(terms[0].startDate).toBe("2026-04-15");
    expect(terms[1].endDate).toBe("2027-04-14");
    expect(terms[1].startDate).toBe(nextDay(terms[0].endDate));
    expect(validateTerms(terms, { startDate: "2026-04-15", endDate: "2027-04-14" })).toEqual([]);
  });

  it("splits by days when the session does not end on a month end", () => {
    const terms = splitSession("2026-04-01", "2027-03-20", 2);
    expect(terms[1].endDate).toBe("2027-03-20");
    expect(terms[1].startDate).toBe(nextDay(terms[0].endDate));
  });

  it("splits by DAYS when the months do not divide, and still ends on the session's last day", () => {
    // 5 terms over 12 months: 12 % 5 ≠ 0, so months cannot be shared out evenly.
    const terms = splitSession(SESSION.startDate, SESSION.endDate, 5);
    expect(terms).toHaveLength(5);
    expect(terms[4].endDate).toBe("2027-03-31");
    expect(validateTerms(terms, SESSION)).toEqual([]);
  });

  it("keeps names a school has already typed, so a re-split does not rename Autumn Term", () => {
    const named = splitSession(SESSION.startDate, SESSION.endDate, 3, ["Autumn Term", "Spring Term"]);
    expect(named.map((t) => t.name)).toEqual(["Autumn Term", "Spring Term", "Term 3"]);
  });

  it("refuses nonsense rather than inventing dates", () => {
    expect(splitSession("2027-03-31", "2026-04-01", 2)).toEqual([]);
    expect(splitSession("not a date", "2027-03-31", 2)).toEqual([]);
  });
});

describe("§25 validating a set of terms", () => {
  it("accepts the ordinary two-term year", () => {
    expect(validateTerms(splitSession(SESSION.startDate, SESSION.endDate, 2), SESSION)).toEqual([]);
  });

  it("names BOTH rows when two terms overlap, and the date to fix it to", () => {
    const issues = validateTerms([
      { name: "Term 1", startDate: "2026-04-01", endDate: "2026-10-15" },
      { name: "Term 2", startDate: "2026-10-01", endDate: "2027-03-31" },
    ], SESSION);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("Term 2");
    expect(issues[0].message).toContain("Term 1");
    // The fix is a date, not advice: a day cannot belong to two terms.
    expect(issues[0].fix).toContain("2026-10-16");
  });

  it("allows a GAP between terms — the holidays are not in a term", () => {
    expect(validateTerms([
      { name: "Term 1", startDate: "2026-04-01", endDate: "2026-09-30" },
      { name: "Term 2", startDate: "2026-11-01", endDate: "2027-03-31" },
    ], SESSION)).toEqual([]);
  });

  it("refuses a term outside the session it belongs to", () => {
    const issues = validateTerms([
      { name: "Term 1", startDate: "2026-04-01", endDate: "2026-09-30" },
      { name: "Term 2", startDate: "2026-10-01", endDate: "2027-06-30" },
    ], SESSION);
    expect(issues.some((i) => i.message.includes("outside the session"))).toBe(true);
  });

  it("refuses a term that ends before it starts, a nameless term, and two of the same name", () => {
    const backwards = validateTerms([
      { name: "Term 1", startDate: "2026-09-30", endDate: "2026-04-01" },
      { name: "Term 2", startDate: "2026-10-01", endDate: "2027-03-31" },
    ], SESSION);
    expect(backwards.some((i) => i.message.includes("ends before it starts"))).toBe(true);

    const nameless = validateTerms([
      { name: "  ", startDate: "2026-04-01", endDate: "2026-09-30" },
      { name: "Term 2", startDate: "2026-10-01", endDate: "2027-03-31" },
    ], SESSION);
    expect(nameless.some((i) => i.message.includes("no name"))).toBe(true);

    const twins = validateTerms([
      { name: "Term 1", startDate: "2026-04-01", endDate: "2026-09-30" },
      { name: "term 1", startDate: "2026-10-01", endDate: "2027-03-31" },
    ], SESSION);
    expect(twins.some((i) => i.message.includes("both called"))).toBe(true);
  });

  it("says a single term is not a term-wise year", () => {
    const issues = validateTerms([{ name: "Term 1", ...SESSION }], SESSION);
    expect(issues[0].message).toContain("at least two");
  });

  it("has nothing to say about a year-wise session", () => {
    expect(validateTerms([], SESSION)).toEqual([]);
  });
});

describe("§25 which term a date is in", () => {
  const terms = splitSession(SESSION.startDate, SESSION.endDate, 2);

  it("picks the term containing the date, including both its edges", () => {
    expect(termForDate(terms, "2026-11-12")?.name).toBe("Term 2");
    expect(termForDate(terms, "2026-04-01")?.name).toBe("Term 1");
    expect(termForDate(terms, "2026-09-30")?.name).toBe("Term 1");
    expect(termForDate(terms, "2026-10-01")?.name).toBe("Term 2");
  });

  it("answers null for a date in a gap or outside the session — the holidays are a real answer", () => {
    const withGap = [
      { name: "Term 1", startDate: "2026-04-01", endDate: "2026-09-30" },
      { name: "Term 2", startDate: "2026-11-01", endDate: "2027-03-31" },
    ];
    expect(termForDate(withGap, "2026-10-15")).toBeNull();
    expect(termForDate(terms, "2030-01-01")).toBeNull();
    expect(termForDate(terms, "rubbish")).toBeNull();
  });

  it("labels a term by its dates, which every term-wise screen shows", () => {
    expect(formatSpan(terms[1])).toBe("1 Oct 2026 – 31 Mar 2027");
  });
});
