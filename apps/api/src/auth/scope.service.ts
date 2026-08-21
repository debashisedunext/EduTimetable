import { Injectable } from "@nestjs/common";
import { PERMISSIONS, type Permission, type ViewScope } from "@edutimetable/shared";

/**
 * Resolves the row-level visibility scope for a user (§15.3). Every timetable
 * and report query in later phases must be filtered through this — it is the
 * single scoping module shared by REST, Socket.IO, reports, and the AI tools.
 */
@Injectable()
export class ScopeService {
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
   * Sections the teacher teaches in (teacher_subject_class_section) or is
   * class teacher of (class_sections.class_teacher_id). Those tables land in
   * Phase 1 — until then no sections are resolvable.
   */
  protected async lookupLinkedClassSections(_teacherId: number): Promise<number[]> {
    return [];
  }
}
