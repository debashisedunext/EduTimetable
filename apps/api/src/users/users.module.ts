import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";

/** §24.8 Phase 25.6 — users and teacher logins for a self-serve school. */
@Module({
  // AccountService lives in AuthModule: the account half of an invitation is
  // control-plane work, and there is exactly one place that does it.
  imports: [AuthModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
