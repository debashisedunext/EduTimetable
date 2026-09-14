import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Query, Req } from "@nestjs/common";
import { CLASS_LADDER, defaultsFor, PERMISSIONS } from "@edutimetable/shared";
import { RequirePermission } from "../auth/decorators";
import { PrismaService } from "../prisma/prisma.service";
import { ReadinessService } from "../readiness/readiness.service";
import { PrismaBaseService } from "../prisma/prisma-base.service";
import { ImportService } from "../import/import.service";
import { CBSE_BOARD, isRecommended } from "./cbse-catalog";
import { del, requireFields, toInt, uniq, type AuthedRequest } from "./crud.util";

const CATEGORIES = ["scholastic", "co_scholastic"] as const;
const LUNCH_RULES = ["any", "before", "after"] as const;

/**
 * §26.2 — the four placement fields off a request body.
 *
 * On CREATE, a field the caller did not send is filled from the subject's name
 * by `defaultsFor` — the one classifier the guided setup, the importer and the
 * ERP sync also use, so a subject arrives classified however it was created.
 * On UPDATE nothing is inferred: a field that was not sent is not a change, and
 * re-deriving it would silently overwrite a choice somebody made on purpose.
 */
function placement(body: any, name: string | null) {
  const d = name === null ? null : defaultsFor(name);
  const out: Record<string, unknown> = {};

  if (body.category !== undefined) {
    if (!CATEGORIES.includes(body.category)) {
      throw new BadRequestException(`category must be one of ${CATEGORIES.join(", ")}`);
    }
    out.category = body.category;
  } else if (d) out.category = d.category;

  if (body.priority !== undefined) {
    const n = Number(body.priority);
    // Bounded here as well as in the column, so the message names the field
    // rather than surfacing a MySQL range error on a TINYINT.
    if (!Number.isInteger(n) || n < 1 || n > 5) {
      throw new BadRequestException("priority must be a whole number from 1 to 5");
    }
    out.priority = n;
  } else if (d) out.priority = d.priority;

  if (body.lunchRule !== undefined) {
    if (!LUNCH_RULES.includes(body.lunchRule)) {
      throw new BadRequestException(`lunchRule must be one of ${LUNCH_RULES.join(", ")}`);
    }
    out.lunchRule = body.lunchRule;
  } else if (d) out.lunchRule = d.lunchRule;

  if (body.gapAfterLunch !== undefined) out.gapAfterLunch = Boolean(body.gapAfterLunch);
  else if (d) out.gapAfterLunch = d.gapAfterLunch;

  return out;
}

@Controller("subjects")
@RequirePermission(PERMISSIONS.MASTERS_MANAGE)
export class SubjectsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly readiness: ReadinessService,
    /**
     * §35 — the board catalogue has no `school_id`, so it is read through the
     * UNSCOPED client. That is the sanctioned way out of §17's ambient scoping
     * (CLAUDE.md names it for genuinely cross-school work), and this is the
     * safest possible use of it: reference data, read-only, written only by
     * the seed.
     */
    private readonly base: PrismaBaseService,
    /** §35 — applying the catalogue writes through the §16 committer, never directly. */
    private readonly importer: ImportService,
  ) {}

  /**
   * §35 — what the board recommends, and for which classes.
   *
   * Class NAMES rather than ladder positions: the screen shows "Class 11 –
   * Class 12" and the committer writes those names into the Subjects sheet's
   * `Classes` column, so a position never leaves this method.
   *
   * `alreadyHave` is the school's own subject names, so the grid can say which
   * rows would create something and which are already there — the §3.10b rule
   * that a screen must not describe a school it is not looking at.
   */
  @Get("catalog")
  async catalog(@Req() req: AuthedRequest, @Query("board") board?: string) {
    const rows = await this.base.boardSubjectCatalog.findMany({
      where: { board: (board || CBSE_BOARD).toUpperCase() },
      orderBy: { sortOrder: "asc" },
    });
    const mine = await this.prisma.subject.findMany({
      where: { schoolId: req.user.schoolId }, select: { name: true },
    });
    const ladder = CLASS_LADDER as readonly string[];
    return {
      board: rows[0]?.board ?? CBSE_BOARD,
      version: rows[0]?.version ?? null,
      alreadyHave: mine.map((m) => m.name),
      subjects: rows.map((r) => ({
        name: r.name,
        code: r.code,
        category: r.category,
        isLab: r.isLab,
        isLanguage: r.isLanguage,
        group: r.groupLabel,
        /**
         * Whether this row opens ticked. A property of its GROUP, decided in
         * `cbse-catalog.ts` beside the labels it names — the screen must not
         * carry a second copy of which groups are streams.
         */
        recommended: isRecommended(r.groupLabel),
        /** Inclusive, by name — what the `Classes` column will carry. */
        classes: ladder.slice(r.fromSeq - 1, r.toSeq),
        fromClass: ladder[r.fromSeq - 1],
        toClass: ladder[r.toSeq - 1],
      })),
    };
  }

  /**
   * Create the chosen catalogue subjects, with the classes they apply to.
   *
   * **Through the §16 committer, and nothing else.** The Subjects sheet already
   * carries `Subject Name`, `Code`, `Category`, `Is Lab` and — the one that
   * matters here — `Classes`, which writes `subject_classes` (§27.16). So this
   * needs no write path of its own, gets the importer's validation for free,
   * and is idempotent: pressing Create twice adds nothing, because the importer
   * skips by natural key.
   *
   * **The classes come from the CATALOGUE, never from the request.** §21's rule:
   * a preview is not the list of writes. A caller that asked for Biology in
   * Class 5 would otherwise get it, and §27.16 would then be enforcing a
   * statement nobody made.
   *
   * A class the school does not have is dropped rather than created — this is
   * the Subjects screen, and inventing Class 11 because a catalogue row
   * mentions it would be a second door onto the Classes master.
   */
  @Post("catalog/apply")
  async applyCatalog(@Req() req: AuthedRequest, @Body() body: { names?: unknown; board?: unknown }) {
    const wanted = Array.isArray(body?.names) ? body.names.map((n) => String(n)) : [];
    if (wanted.length === 0) throw new BadRequestException("Choose at least one subject.");

    const rows = await this.base.boardSubjectCatalog.findMany({
      where: {
        board: String(body?.board || CBSE_BOARD).toUpperCase(),
        name: { in: wanted },
      },
      orderBy: { sortOrder: "asc" },
    });
    if (rows.length === 0) throw new BadRequestException("None of those subjects are in the catalogue.");

    const ladder = CLASS_LADDER as readonly string[];
    const have = new Set(
      (await this.prisma.schoolClass.findMany({
        where: { schoolId: req.user.schoolId }, select: { name: true },
      })).map((c) => c.name),
    );

    const sheetRows = rows.map((r) => {
      const classes = ladder.slice(r.fromSeq - 1, r.toSeq).filter((c) => have.has(c));
      return {
        "Subject Name": r.name,
        Code: r.code ?? "",
        Category: r.category === "co_scholastic" ? "Co-scholastic" : "Scholastic",
        "Is Lab": r.isLab ? "Yes" : "No",
        /*
          §27.16 — empty means "not stated", which reads as EVERY class. So a
          catalogue subject whose classes this school does not have yet is
          skipped entirely below rather than created with a blank list: a
          Biology that says nothing is a Biology offered to Class 1.
        */
        Classes: classes.join(", "),
      };
    }).filter((r) => r.Classes !== "");

    if (sheetRows.length === 0) {
      throw new BadRequestException(
        "None of those subjects apply to the classes this school has yet — add the classes first.",
      );
    }

    const result = await this.importer.commitSheets(req.user.schoolId, [{
      name: "Subjects",
      headers: Object.keys(sheetRows[0]),
      rows: sheetRows.map((cells, i) => ({ row: i + 2, cells })),
    }]);
    await this.readiness.invalidate(req.user.schoolId);
    return {
      ...result,
      /** Named, so a subject silently skipped for want of a class is visible. */
      skipped: rows.length - sheetRows.length,
    };
  }

  @Get()
  async list(@Req() req: AuthedRequest) {
    const rows = await this.prisma.subject.findMany({
      where: { schoolId: req.user.schoolId },
      orderBy: { name: "asc" },
      // §19.1 — the rooms this subject is taught in, served with the subject
      // because the Subjects screen is where they are now edited. Same
      // `room_subjects` rows the Rooms screen writes: one table, two doors.
      include: {
        rooms: { select: { roomId: true } },
        // §27.16 — the classes this subject is taught to, ordered by the
        // ladder rather than by name: "Class 10" sorts between "Class 1" and
        // "Class 2", which is the classic way to make a class list unreadable.
        classes: { select: { classId: true }, orderBy: { class: { sequence: "asc" } } },
      },
    });
    return rows.map(({ rooms, classes, ...s }) => ({
      ...s,
      roomIds: rooms.map((r) => r.roomId),
      classIds: classes.map((c) => c.classId),
    }));
  }

  /**
   * §27.16 — replace which classes this subject is taught to.
   *
   * Same three rules as `setRooms` above, for the same reasons: a full
   * replacement (the screen shows the whole list it is editing, so what comes
   * back IS the answer), only when `classIds` was actually sent (absent is "not
   * mentioned" and changes nothing), and scoped before the write so a stranger's
   * class id cannot be stamped with this school's.
   *
   * An empty array IS a meaningful send here — it means "back to every class",
   * which is what "not stated" reads as (invariant 7). That is why it clears
   * rather than being treated as absent.
   */
  private async setClasses(schoolId: number, subjectId: number, classIds: unknown) {
    if (classIds === undefined) return;
    const ids = Array.isArray(classIds) ? classIds.map((c) => toInt(c, "classIds[]")) : [];
    if (ids.length > 0) {
      const mine = await this.prisma.schoolClass.findMany({ where: { id: { in: ids } }, select: { id: true } });
      const known = new Set(mine.map((c) => c.id));
      const stranger = ids.find((id) => !known.has(id));
      if (stranger !== undefined) throw new BadRequestException(`No class with id ${stranger}`);
    }
    await this.prisma.$transaction([
      this.prisma.subjectClass.deleteMany({ where: { subjectId } }),
      ...(ids.length > 0
        ? [this.prisma.subjectClass.createMany({
            data: ids.map((classId) => ({ classId, subjectId, schoolId })),
          })]
        : []),
    ]);
  }

  /**
   * §19.1 — replace which rooms serve this subject.
   *
   * A full replacement rather than an add, and only when `roomIds` was actually
   * sent: the screen shows the complete list it is editing, so what comes back
   * IS the answer. Absent means "not mentioned" and changes nothing — the same
   * rule the §26.2 placement fields follow on update.
   *
   * These are the rows the Rooms screen writes too (a lab naming its subjects),
   * which is deliberate: "which rooms serve Biology" has one answer, reachable
   * from either end. A second column on `subjects` would have been a second
   * answer, free to disagree.
   */
  private async setRooms(schoolId: number, subjectId: number, roomIds: unknown) {
    if (roomIds === undefined) return;
    const ids = Array.isArray(roomIds) ? roomIds.map((r) => toInt(r, "roomIds[]")) : [];
    if (ids.length > 0) {
      // Scoped: `createMany` would otherwise happily stamp this school's id
      // onto a link to somebody else's room.
      const mine = await this.prisma.room.findMany({ where: { id: { in: ids } }, select: { id: true } });
      const known = new Set(mine.map((r) => r.id));
      const stranger = ids.find((id) => !known.has(id));
      if (stranger !== undefined) throw new BadRequestException(`No room with id ${stranger}`);
    }
    await this.prisma.$transaction([
      this.prisma.roomSubject.deleteMany({ where: { subjectId } }),
      ...(ids.length > 0
        ? [this.prisma.roomSubject.createMany({
            data: ids.map((roomId) => ({ roomId, subjectId, schoolId })),
          })]
        : []),
    ]);
  }

  @Post()
  async create(@Req() req: AuthedRequest, @Body() body: any) {
    requireFields(body, ["name"]);
    const created = await uniq(
      () =>
        this.prisma.subject.create({
          data: {
            schoolId: req.user.schoolId,
            name: String(body.name),
            code: body.code ? String(body.code) : null,
            isLab: Boolean(body.isLab),
            // §19.1 — WHETHER this subject has a room of its own. WHERE is
            // `room_subjects`, written by `setRooms` below.
            taughtInOwnRoom: Boolean(body.taughtInOwnRoom),
            requiresDoublePeriod: Boolean(body.requiresDoublePeriod),
            ...placement(body, String(body.name)),
          },
        }),
      `Subject '${body.name}'`,
    );
    await this.setRooms(req.user.schoolId, created.id, body.roomIds);
    await this.setClasses(req.user.schoolId, created.id, body.classIds);
    await this.readiness.invalidate(req.user.schoolId);
    return created;
  }

  @Put(":id")
  async update(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: any) {
    const updated = await uniq(
      () =>
        this.prisma.subject.update({
          where: { id: toInt(id, "id") },
          data: {
            ...(body.name !== undefined ? { name: String(body.name) } : {}),
            ...(body.code !== undefined ? { code: body.code ? String(body.code) : null } : {}),
            ...(body.isLab !== undefined ? { isLab: Boolean(body.isLab) } : {}),
            ...(body.taughtInOwnRoom !== undefined
              ? { taughtInOwnRoom: Boolean(body.taughtInOwnRoom) }
              : {}),
            ...(body.requiresDoublePeriod !== undefined
              ? { requiresDoublePeriod: Boolean(body.requiresDoublePeriod) }
              : {}),
            // `null` name: on an update nothing is inferred from the name, so
            // only fields the caller actually sent are written.
            ...placement(body, null),
          },
        }),
      "Subject",
    );
    await this.setRooms(req.user.schoolId, updated.id, body.roomIds);
    await this.setClasses(req.user.schoolId, updated.id, body.classIds);
    await this.readiness.invalidate(req.user.schoolId);
    return updated;
  }

  @Delete(":id")
  async remove(@Req() req: AuthedRequest, @Param("id") id: string) {
    await del(() => this.prisma.subject.delete({ where: { id: toInt(id, "id") } }), "Subject");
    await this.readiness.invalidate(req.user.schoolId);
    return { ok: true };
  }
}
