import { Module } from "@nestjs/common";
import { BoardController } from "./board.controller";
import { BoardService } from "./board.service";
import { PublishService } from "./publish.service";

@Module({
  controllers: [BoardController],
  providers: [BoardService, PublishService],
})
export class BoardModule {}
