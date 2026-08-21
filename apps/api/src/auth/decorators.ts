import { SetMetadata } from "@nestjs/common";
import type { Permission } from "@edutimetable/shared";

export const IS_PUBLIC_KEY = "isPublic";
/** Skip authentication entirely (health check, SSO callback, dev token stub). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const PERMISSIONS_KEY = "requiredPermissions";
/** Server-side permission gate — UI hiding is cosmetic, this is the authority (§15). */
export const RequirePermission = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
