import { Injectable } from "@nestjs/common";
import { PERMISSIONS, type Permission, type ViewScope } from "@edutimetable/shared";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Resolves the row-level visibility scope for a user (§15.3). Every timetable
 * and report query is filtered through this — it is the single scoping module
 * shared by REST, Socket.IO, reports, and the AI tools.
 */
@Injectable()
export class ScopeService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(
    permissions: Permission[],
    teacherId: number | null,
  ): Promise<ViewScope> {
    if (permissions.includes(PERMISSIONS.TIMETABLE_VIEW_ALL)) {
      return { level: "all" };
    }
    if (permissions.includes(PERMISSIONS.TIMETABLE_VIEW_CLASS)) {
      // A class-scope user with no linked teacher record can't be resolved to
      // any sections — the Roles & Responsibility page warns about this (§15.4).
      if (teacherId === null) return { level: "none" };
      return {
        level: "class",
        teacherId,
        classSectionIds: await this.lookupLinkedClassSections(teacherId),
      };
    }
    if (permissions.includes(PERMISSIONS.TIMETABLE_VIEW_OWN)) {
      if (teacherId === null) return { level: "none" };
      return { level: "own", teacherId };
    }
    return { level: "none" };
  }

  /**
   * Sections the teacher is linked to: teaches (mappings), teaches via a
   * merged group, or is class teacher of.
   */
  protected async lookupLinkedClassSections(teacherId: number): Promise<number[]> {
    const [mappings, merged, classTeacherOf] = await Promise.all([
      this.prisma.teacherSubjectClassSection.findMany({
        where: { teacherId },
        select: { classSectionId: true },
      }),
      this.prisma.mergedTeachingGroup.findMany({
        where: { teacherId },
        select: { members: { select: { classSectionId: true } } },
      }),
      this.prisma.classSection.findMany({
        where: { classTeacherId: teacherId },
        select: { id: true },
      }),
    ]);
    return [
      ...new Set([
        ...mappings.map((m) => m.classSectionId),
        ...merged.flatMap((g) => g.members.map((m) => m.classSectionId)),
        ...classTeacherOf.map((c) => c.id),
      ]),
    ];
  }
}
