import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
import { BullModule } from "@nestjs/bullmq";
import { PrismaModule } from "./prisma/prisma.module";
import { RedisModule } from "./redis/redis.module";
import { AuthModule } from "./auth/auth.module";
import { JwtAuthGuard } from "./auth/jwt-auth.guard";
import { PermissionsGuard } from "./auth/permissions.guard";
import { HealthController } from "./health/health.controller";
import { MeController } from "./me/me.controller";
import { DemoModule } from "./demo/demo.module";
import { EventsModule } from "./events/events.module";
import { MastersModule } from "./masters/masters.module";
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
    PrismaModule,
    RedisModule,
    AuthModule,
    DemoModule,
    EventsModule,
    MastersModule,
  ],
  controllers: [HealthController, MeController, RolesAdminController, SampleDataController],
  providers: [
    ReadinessService,
    // Order matters: authentication first, then permission checks.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
