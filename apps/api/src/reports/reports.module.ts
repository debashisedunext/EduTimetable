import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { MyViewsController, ReportsController } from "./reports.controller";
import { ReportsService } from "./reports.service";

@Module({
  imports: [AuthModule],
  controllers: [ReportsController, MyViewsController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
