import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Req } from "@nestjs/common";
import { defaultsFor, PERMISSIONS } from "@edutimetable/shared";
import { RequirePermission } from "../auth/decorators";
import { PrismaService } from "../prisma/prisma.service";
import { ReadinessService } from "../readiness/readiness.service";
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
  ) {}

  @Get()
  list(@Req() req: AuthedRequest) {
    return this.prisma.subject.findMany({
      where: { schoolId: req.user.schoolId },
      orderBy: { name: "asc" },
    });
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
            requiresDoublePeriod: Boolean(body.requiresDoublePeriod),
            ...placement(body, String(body.name)),
          },
        }),
      `Subject '${body.name}'`,
    );
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
