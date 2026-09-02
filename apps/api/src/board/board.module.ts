import { Module } from "@nestjs/common";
import { DraftsModule } from "../drafts/drafts.module";
import { BoardController } from "./board.controller";
import { BoardService } from "./board.service";
import { PublishService } from "./publish.service";

@Module({
  imports: [DraftsModule],
  controllers: [BoardController],
  providers: [BoardService, PublishService],
})
export class BoardModule {}
