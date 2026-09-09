/**
 * §25 Phase 26 — the terms of a session, and the one place a term is resolved.
 *
 * Exported rather than kept private for the same reason `DraftsService` is: the
 * board, the slots endpoint, publish, the reports and the substitute engine all
 * have to answer "which term does this request mean?", and they must all answer
 * it the same way. One resolver, many call sites.
 *
 * The resolution rule, in order:
 *
 *   1. an id the caller asked for — **verified to belong to this config's own
 *      session**, because a term id is not a capability;
 *   2. otherwise the term containing the date in question, defaulting to today.
 *      This is what makes the term selector a default rather than a chore: a
 *      teacher opening their timetable in November is shown November's;
 *   3. otherwise the session's first term, for a date in the summer holidays,
 *      which belong to no term at all;
 *   4. otherwise `null` — a year-wise session, which is every session that
 *      exists until somebody asks for terms, and which behaves exactly as it
 *      did before this phase.
 */
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { termForDate, validateTerms } from "@edutimetable/shared";
import { PrismaService } from "../prisma/prisma.service";

/** A term as every screen and endpoint passes it around. */
export interface TermRow {
  id: number;
  name: string;
  sortOrder: number;
  /** `YYYY-MM-DD` — dates crossing the wire are calendar facts, never instants. */
  startDate: string;
  endDate: string;
}

/** `Date` → `YYYY-MM-DD`, in UTC, because that is how `@db.Date` stores it. */
const iso = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * `YYYY-MM-DD` → midnight UTC.
 *
 * `new Date("2026-10-01")` already parses as UTC, but only for exactly this
 * format — the moment somebody passes "01/10/2026" it becomes local time and a
 * term starts a day early in half the world. Parsed by hand so the format is
 * enforced rather than assumed.
 */
function dateOnly(value: string, field: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BadRequestException(`${field} must be a date in YYYY-MM-DD form, not "${value}"`);
  }
  const [y, m, d] = value.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

@Injectable()
export class TermsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The session's terms, in order. Empty means the session runs as a whole year.
   *
   * The session is checked for existence FIRST, and that check is not
   * ceremony. Scoped by the tenant context, a query for another school's year
   * returns zero rows — and `[]` is indistinguishable from "this session runs
   * as a whole year", so a stranger would be told a fact about a school they
   * cannot see, in the same words its owner gets. Another school's id is a 404
   * (§17), never a successful empty answer.
   */
  async list(academicYearId: number): Promise<TermRow[]> {
    const year = await this.prisma.academicYear.findFirst({
      where: { id: academicYearId },
      select: { id: true },
    });
    if (!year) throw new NotFoundException("Academic year not found");
    const rows = await this.prisma.academicTerm.findMany({
      where: { academicYearId },
      orderBy: { sortOrder: "asc" },
    });
    return rows.map((t) => ({
      id: t.id,
      name: t.name,
      sortOrder: t.sortOrder,
      startDate: iso(t.startDate),
      endDate: iso(t.endDate),
    }));
  }

  /** The terms a timetable runs under — its session's, since terms are school-wide. */
  async forConfig(configId: number): Promise<TermRow[]> {
    const config = await this.prisma.timetableConfig.findFirst({
      where: { id: configId },
      select: { academicYearId: true },
    });
    if (!config) throw new NotFoundException("Timetable config not found");
    return this.list(config.academicYearId);
  }

  /**
   * Save the session's terms as a set — the whole list, every time.
   *
   * A set rather than a row at a time because the rules are about the *set*:
   * no two terms may overlap, and two terms are the minimum. Saving one row and
   * validating it alone would let a screen walk through an illegal intermediate
   * state and stop there.
   *
   * Rows carrying an `id` are updated in place. That matters more than it
   * looks: every slot, draft and publication points at a term id, so re-dating
   * Term 2 must move the term the timetable is already filed under, never
   * replace it with a new row and orphan a term's work.
   */
  async replace(
    academicYearId: number,
    input: Array<{ id?: number | null; name: string; startDate: string; endDate: string }>,
  ): Promise<TermRow[]> {
    const year = await this.prisma.academicYear.findFirst({ where: { id: academicYearId } });
    if (!year) throw new NotFoundException("Academic year not found");

    const wanted = input.map((t) => ({
      id: t.id ?? null,
      name: String(t.name ?? "").trim(),
      startDate: String(t.startDate ?? ""),
      endDate: String(t.endDate ?? ""),
    }));

    const issues = validateTerms(wanted, { startDate: iso(year.startDate), endDate: iso(year.endDate) });
    if (issues.length > 0) {
      // The first issue, with its fix — the Feasibility Engine's contract: name
      // the exact row and what to do, never "invalid input".
      throw new BadRequestException(`${issues[0].message} ${issues[0].fix}`);
    }

    const existing = await this.prisma.academicTerm.findMany({ where: { academicYearId } });
    const keep = new Set(wanted.map((t) => t.id).filter((id): id is number => id !== null));
    const going = existing.filter((t) => !keep.has(t.id));

    // A term with a timetable in it is not something a Save button may remove.
    // The FK is RESTRICT so the database would refuse anyway, but it would
    // refuse with a constraint name; this refuses with the term's own name and
    // says where the delete lives.
    for (const term of going) {
      const used = await this.usage(term.id);
      if (used > 0) {
        throw new BadRequestException(
          `"${term.name}" has ${used} timetable row${used === 1 ? "" : "s"} in it, so removing it here would throw that work away. ` +
            "Delete the term from the Academic Years screen, which shows what goes with it first.",
        );
      }
    }

    // An id the caller sent that belongs to another session is not an update
    // target — it is an attempt to re-date somebody else's term.
    const mine = new Set(existing.map((t) => t.id));
    for (const t of wanted) {
      if (t.id !== null && !mine.has(t.id)) {
        throw new NotFoundException(`Term ${t.id} does not belong to this session`);
      }
    }

    const schoolId = year.schoolId;
    await this.prisma.$transaction(async (tx) => {
      if (going.length > 0) {
        await tx.academicTerm.deleteMany({ where: { id: { in: going.map((t) => t.id) } } });
      }
      // Two passes over sort_order, because `uq_term_order` is a live
      // constraint and swapping two terms' positions in one pass collides with
      // it halfway through. The parking space is negative, which no real
      // sort_order ever is.
      for (const [i, t] of wanted.entries()) {
        if (t.id === null) continue;
        await tx.academicTerm.update({ where: { id: t.id }, data: { sortOrder: -(i + 1) } });
      }
      for (const [i, t] of wanted.entries()) {
        const data = {
          name: t.name,
          sortOrder: i + 1,
          startDate: dateOnly(t.startDate, `${t.name} start date`),
          endDate: dateOnly(t.endDate, `${t.name} end date`),
        };
        if (t.id === null) {
          await tx.academicTerm.create({ data: { schoolId, academicYearId, ...data } });
        } else {
          await tx.academicTerm.update({ where: { id: t.id }, data });
        }
      }
    });

    return this.list(academicYearId);
  }

  /**
   * Write a set of terms that arrived with no ids — the guided setup's case.
   *
   * The draft holds names and dates because at the session step the academic
   * year does not exist yet, so there are no ids to hold. Existing terms are
   * matched **by name**, which is what makes a re-commit a no-op: without it,
   * pressing Next twice would delete Term 1 and create a new Term 1 with a new
   * id, and any timetable already filed under the old one would be orphaned —
   * or, since `replace` refuses to remove a term with rows in it, would fail on
   * a step whose entire promise is that pressing it again does nothing.
   *
   * Names are unique per session (`uq_term_name`), so the match is exact.
   */
  async applyByName(
    academicYearId: number,
    wanted: Array<{ name: string; startDate: string; endDate: string }>,
  ): Promise<TermRow[]> {
    if (wanted.length === 0) return this.list(academicYearId);
    const existing = await this.list(academicYearId);
    const byName = new Map(existing.map((t) => [t.name.trim().toLowerCase(), t.id]));
    return this.replace(
      academicYearId,
      wanted.map((t) => ({ ...t, id: byName.get(String(t.name ?? "").trim().toLowerCase()) ?? null })),
    );
  }

  /** How much timetable is filed under a term — the number a removal has to report. */
  async usage(termId: number): Promise<number> {
    const [slots, drafts, publications, extras] = await Promise.all([
      this.prisma.timetableSlot.count({ where: { termId } }),
      this.prisma.timetableDraft.count({ where: { termId } }),
      this.prisma.timetablePublication.count({ where: { termId } }),
      this.prisma.extraClass.count({ where: { termId } }),
    ]);
    return slots + drafts + publications + extras;
  }

  /**
   * Which term a request means. `null` is a real answer: a year-wise session.
   *
   * `date` is the date the caller is looking at — an absence date, the day a
   * report is for — and defaults to today. It is the term selector's default
   * everywhere, so the answer to "which term?" is almost never typed.
   */
  async resolve(
    configId: number,
    requested?: number | null,
    date?: string | null,
  ): Promise<number | null> {
    const terms = await this.forConfig(configId);
    if (terms.length === 0) {
      // Asking for a term of a session that has none is a client that thinks
      // this school uses terms. Say so rather than silently ignoring it.
      if (requested != null) {
        throw new BadRequestException("This session runs as a whole year, so it has no terms");
      }
      return null;
    }
    if (requested != null) {
      const own = terms.find((t) => t.id === requested);
      if (!own) throw new NotFoundException(`Term ${requested} is not a term of this timetable's session`);
      return own.id;
    }
    const on = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date().toISOString().slice(0, 10);
    return (termForDate(terms, on) ?? terms[0]).id;
  }
}
