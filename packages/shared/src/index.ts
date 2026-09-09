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
/**
 * A school as the ERP describes it (§15.1, extended in Phase 9.5).
 *
 * `code` is the contract: it is the ERP's stable identifier for the school and
 * the only one meaningful across databases — numeric ids repeat between them.
 * Everything else is descriptive and refreshed on every login, so a school
 * renamed in the ERP is renamed here without anyone re-typing it.
 */
export interface ErpSchoolClaim {
  code: string;
  name: string;
  shortName?: string | null;
  logoUrl?: string | null;
  timezone?: string | null;
  address?: string | null;
}

/** The management body a group of schools belongs to (§17: scenario 2). */
export interface ErpTrustClaim {
  code: string;
  name: string;
}

export interface ErpSsoTokenPayload {
  erpUserId: string;
  name: string;
  email: string;
  erpRole: string;
  /**
   * The school this session opens in. Preferred over `schoolId`: the ERP knows
   * its schools by code, and a numeric id cannot survive a move to a separate
   * database.
   */
  school?: ErpSchoolClaim;
  /**
   * Legacy numeric id, still honoured when `school` is absent so a deployment
   * whose ERP has not been updated keeps working. Never used to *name* a
   * school — only to find one that already exists.
   */
  schoolId?: number;
  /** The trust this school belongs to, when it belongs to one. */
  trust?: ErpTrustClaim;
  /**
   * Every school this user may work in. A trust administrator gets several; a
   * single-school user gets one or none (in which case `school` is the only
   * one). This is what the in-app school switcher offers, and the server will
   * not switch to anything outside it.
   */
  schools?: ErpSchoolClaim[];
  teacherId?: number | null;
  /** single-use nonce — replay-checked against Redis */
  jti: string;
  exp: number;
}

/** The Timetable app's own session token claims. */
/**
 * §15.3 Phase 25.0 — the credential of somebody who has signed in but is not
 * yet *inside* a school.
 *
 * A self-serve admin who has just registered owns no school, so there is no
 * `schoolId`, no `roleId` and no tenant to bind — and `SessionTokenPayload`
 * requires all three. Rather than loosen that type (which every guard, scope
 * filter and audit path reads), a pre-school account gets its own, deliberately
 * tiny token that can reach exactly the account-level endpoints: list my
 * schools, create one, sign out.
 *
 * `typ` is the discriminator, and it is load-bearing: `JwtAuthGuard` must
 * REFUSE a token carrying it, or an account token would be read as a session
 * with `schoolId: undefined` and attach an undefined school to the request.
 * Entering a school exchanges this for a real `SessionTokenPayload`.
 */
export interface AccountTokenPayload {
  typ: "account";
  /** accounts.id, in the control plane — NOT users.id */
  sub: number;
  email: string;
  /** `owner` may create schools; `member` was invited into one and may not. */
  kind: "owner" | "member";
}

export interface SessionTokenPayload {
  sub: number; // users.id
  schoolId: number;
  roleId: number;
  /**
   * Identity carried forward from the ERP token so a school switch can
   * re-provision this user in the target school without a fresh SSO round trip
   * (§17.4). Not secret — this token is signed by us.
   */
  erpUserId?: string;
  erpRole?: string;
  /** The control-plane tenant of the active school (§17.5). */
  tenantId?: number | null;
  /**
   * Tenants this session may switch to. Tenant ids rather than school ids,
   * because school ids repeat across databases (§17.5). The switch endpoint
   * refuses anything not in this list, so a user cannot reach a school the ERP
   * did not grant them.
   */
  grants?: number[];
  /**
   * The same grant, as local school ids. Used by deployments with no registry —
   * where there are no tenant ids and every school shares one database — and by
   * sessions issued before 9.4.
   */
  schoolIds?: number[];
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
export * from "./board/engine";
export * from "./substitute/engine";
export * from "./optimize/objective";
export * from "./optimize/model";
export * from "./electives/pins";
export * from "./import/contract";
export * from "./terms/terms";
export * from "./onboarding/wizard";
export * from "./timetable/window";
export * from "./timetable/clash";
export * from "./timetable/initials";
export * from "./timetable/pivot";
export * from "./timetable/coverage";
export * from "./onboarding/suggest";
export * from "./onboarding/load";
export * from "./ai/data-entry";
export * from "./import/types";
export * from "./import/validate";
export * from "./colors/palette";
export * from "./sync/contract";
export * from "./sync/reconcile";
export * from "./sync/json-map";
export * from "./restaff/engine";

/** The school a session belongs to (§17, Phase 9.2). */
export interface SessionSchool {
  id: number;
  /**
   * The control-plane tenant (§17.3). This — not `id` — is what identifies a
   * school across databases: a dedicated tenant's local school id is usually 1,
   * and so is everyone else's. null when the deployment has no registry.
   */
  tenantId: number | null;
  /** stable code the ERP knows this school by — the identifier that survives
   *  across databases, unlike the numeric id */
  code: string;
  name: string;
  shortName: string | null;
  logoUrl: string | null;
  timezone: string;
}

export interface MeResponse {
  id: number;
  name: string;
  email: string;
  role: string;
  permissions: Permission[];
  teacherId: number | null;
  /** Which school this session is scoped to. Every row the user can see
   *  belongs to it, and the top bar names it (§17). */
  school: SessionSchool;
  /**
   * Every school this user may switch to, the active one included. One entry
   * means no switcher — the common single-school case (§17.4).
   */
  schools: SessionSchool[];
  /** The trust these schools belong to, when they belong to one. */
  trust: { code: string; name: string } | null;
  /**
   * Whether this account administers the platform itself (§17.6) — a level
   * above every school, granted outside any of them. Cosmetic here: the server
   * re-checks it on every platform request.
   */
  platformAdmin: boolean;
  /**
   * Whether this person signs in with a password rather than through the ERP.
   *
   * Decides one thing on screen: whether the school name in the top bar leads
   * to *My Schools*, where a school can be added. An ERP user has no account
   * and no business creating schools here — theirs come from the ERP (§15.1) —
   * so for them the name stays a switcher over what the token granted.
   */
  isLocalAccount: boolean;
}
