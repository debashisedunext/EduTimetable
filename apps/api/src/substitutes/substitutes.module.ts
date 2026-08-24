import { Module } from "@nestjs/common";
import { SubstitutesController } from "./substitutes.controller";
import { SubstitutesService } from "./substitutes.service";

@Module({
  controllers: [SubstitutesController],
  providers: [SubstitutesService],
})
export class SubstitutesModule {}
