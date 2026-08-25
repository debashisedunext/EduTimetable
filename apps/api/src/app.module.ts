import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
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
import { SolverController } from "./solver/solver.controller";
import { RolesAdminController } from "./admin/roles-admin.controller";
import { SampleDataController } from "./dev/sample-data.controller";
import { ReadinessService } from "./readiness/readiness.service";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST ?? "redis",
        port: Number(process.env.REDIS_PORT ?? 6379),
      },
    }),
    // TenantModule before PrismaModule: the scoped client is built from the
    // tenant context, so the context service must already exist (9.1 / §17).
    TenantModule,
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
    BullQueueModule.registerQueue({ name: "solver" }),
  ],
  controllers: [HealthController, MeController, RolesAdminController, SampleDataController, SolverController],
  providers: [
    ReadinessService,
    // Order matters: authentication first, then permission checks.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
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
