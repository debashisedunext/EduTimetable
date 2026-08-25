/**
 * Opens the tenant context around the entire request — before the guards, so
 * that JwtAuthGuard can attach the school to the same store the route handler
 * will later query in. Applied to every route in AppModule.
 */
import { Injectable, NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { TenantContextService } from "./tenant-context.service";

@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  constructor(private readonly tenant: TenantContextService) {}

  use(req: Request, _res: Response, next: NextFunction) {
    this.tenant.open(`http ${req.method} ${req.path}`, () => next());
  }
}
