import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { APP_GUARD, DiscoveryModule } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
import { BullModule } from "@nestjs/bullmq";
import { PrismaModule } from "./prisma/prisma.module";
import { TenantModule } from "./tenant/tenant.module";
import { ControlModule } from "./control/control.module";
import { TenantContextMiddleware } from "./tenant/tenant-context.middleware";
import { RedisModule } from "./redis/redis.module";
import { AuthModule } from "./auth/auth.module";
import { JwtAuthGuard } from "./auth/jwt-auth.guard";
import { PermissionsGuard } from "./auth/permissions.guard";
import { PlatformGuard } from "./control/platform.guard";
import { HealthController } from "./health/health.controller";
import { MeController } from "./me/me.controller";
import { DemoModule } from "./demo/demo.module";
import { EventsModule } from "./events/events.module";
import { BullModule as BullQueueModule } from "@nestjs/bullmq";
import { MastersModule } from "./masters/masters.module";
import { BoardModule } from "./board/board.module";
import { SubstitutesModule } from "./substitutes/substitutes.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { ReportsModule } from "./reports/reports.module";
import { AiModule } from "./ai/ai.module";
import { ImportModule } from "./import/import.module";
import { SyncModule } from "./sync/sync.module";
import { SolverController } from "./solver/solver.controller";
import { RolesAdminController } from "./admin/roles-admin.controller";
import { SampleDataController } from "./dev/sample-data.controller";
import { RouteCensusController } from "./dev/route-census.controller";
import { ReadinessService } from "./readiness/readiness.service";
import { AutoFixController } from "./readiness/auto-fix.controller";
import { DraftsModule } from "./drafts/drafts.module";
import { AutoFixService } from "./readiness/auto-fix.service";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Supplies DiscoveryService/MetadataScanner to the dev route census (9.10).
    DiscoveryModule,
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST ?? "redis",
        port: Number(process.env.REDIS_PORT ?? 6379),
      },
    }),
    // TenantModule before PrismaModule: the scoped client is built from the
    // tenant context, so the context service must already exist (9.1 / §17).
    TenantModule,
    DraftsModule,
    // The tenant registry (§17.3). Optional at runtime — a deployment without
    // CONTROL_DATABASE_URL keeps working as a single school.
    ControlModule,
    PrismaModule,
    RedisModule,
    AuthModule,
    DemoModule,
    EventsModule,
    MastersModule,
    BoardModule,
    SubstitutesModule,
    NotificationsModule,
    ReportsModule,
    AiModule,
    ImportModule,
    SyncModule,
    BullQueueModule.registerQueue({ name: "solver" }),
  ],
  controllers: [
    HealthController,
    MeController,
    AutoFixController,
    RolesAdminController,
    SampleDataController,
    // Dev-only. Lets the 9.10 isolation suite enumerate what actually exists,
    // so a new endpoint cannot go un-swept unnoticed (§17.8).
    RouteCensusController,
    SolverController,
  ],
  providers: [
    ReadinessService,
    AutoFixService,
    // Order matters: authentication first, then permission checks.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    // ...and the platform level above every school (§17.6). Separate from
    // permissions on purpose: a school's admin must not be able to grant
    // themselves authority over the registry.
    { provide: APP_GUARD, useClass: PlatformGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Every route, including the public ones: the context must be open before
    // the guards run so JwtAuthGuard can attach the school to the same store
    // the route handler will query in.
    consumer.apply(TenantContextMiddleware).forRoutes("*");
  }
}
