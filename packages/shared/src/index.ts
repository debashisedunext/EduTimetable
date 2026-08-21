/**
 * Single source of truth for the app-wide permission registry (§15.2) and the
 * SSO/session contracts (§15.1). Imported by both the API (guards, seed) and
 * the web app (nav gating) — never duplicate these strings elsewhere.
 */

export const PERMISSIONS = {
  MASTERS_MANAGE: "masters.manage",
  TIMETABLE_GENERATE: "timetable.generate",
  TIMETABLE_EDIT: "timetable.edit",
  TIMETABLE_PUBLISH: "timetable.publish",
  TIMETABLE_VIEW_OWN: "timetable.view.own",
  TIMETABLE_VIEW_CLASS: "timetable.view.class",
  TIMETABLE_VIEW_ALL: "timetable.view.all",
  SUBSTITUTE_MANAGE: "substitute.manage",
  REPORTS_VIEW: "reports.view",
  REPORTS_EXPORT: "reports.export",
  NOTIFICATIONS_VIEW: "notifications.view",
  ROLES_MANAGE: "roles.manage",
  AI_CHAT: "ai.chat",
  AI_REPORTS: "ai.reports",
  AI_CONFIGURE: "ai.configure",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: Permission[] = Object.values(PERMISSIONS);

/** Default system roles and their permission sets (§15.2). Editable at runtime
 *  on the Roles & Responsibility page; these are only the seed defaults. */
export const DEFAULT_ROLES: Record<string, Permission[]> = {
  "Super Admin": ALL_PERMISSIONS,
  Principal: [
    PERMISSIONS.TIMETABLE_VIEW_ALL,
    PERMISSIONS.REPORTS_VIEW,
    PERMISSIONS.REPORTS_EXPORT,
    PERMISSIONS.NOTIFICATIONS_VIEW,
    PERMISSIONS.AI_CHAT,
    PERMISSIONS.AI_REPORTS,
  ],
  "Timetable Admin": ALL_PERMISSIONS.filter(
    (p) => p !== PERMISSIONS.ROLES_MANAGE && p !== PERMISSIONS.AI_CONFIGURE,
  ),
  Teacher: [
    PERMISSIONS.TIMETABLE_VIEW_OWN,
    PERMISSIONS.TIMETABLE_VIEW_CLASS,
    PERMISSIONS.REPORTS_VIEW,
    PERMISSIONS.NOTIFICATIONS_VIEW,
  ],
  "Front Office": [
    PERMISSIONS.SUBSTITUTE_MANAGE,
    PERMISSIONS.TIMETABLE_VIEW_ALL,
    PERMISSIONS.NOTIFICATIONS_VIEW,
  ],
};

/** Claims inside the short-lived RS256 token the ERP sends us (§15.1). */
export interface ErpSsoTokenPayload {
  erpUserId: string;
  name: string;
  email: string;
  erpRole: string;
  schoolId: number;
  teacherId?: number | null;
  /** single-use nonce — replay-checked against Redis */
  jti: string;
  exp: number;
}

/** The Timetable app's own session token claims. */
export interface SessionTokenPayload {
  sub: number; // users.id
  schoolId: number;
  roleId: number;
}

/** Row-level visibility scope, resolved server-side per request (§15.3). */
export type ViewScope =
  | { level: "all" }
  | { level: "class"; teacherId: number; classSectionIds: number[] }
  | { level: "own"; teacherId: number }
  | { level: "none" };

export * from "./feasibility/types";
export { runFeasibility, teacherWeeklyCapacity } from "./feasibility/engine";
export * from "./solver/types";
export { solveTimetable } from "./solver/engine";
export { SolverState } from "./solver/state";
export { buildVariables, buildTeacherCtx, segmentOfPeriod } from "./solver/variables";

export interface MeResponse {
  id: number;
  name: string;
  email: string;
  role: string;
  permissions: Permission[];
  teacherId: number | null;
}
