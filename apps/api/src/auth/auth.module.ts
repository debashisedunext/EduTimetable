import { Global, Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { AuthService } from "./auth.service";
import { SsoController } from "./sso.controller";
import { DevErpController } from "./dev-erp.controller";
import { ErpKeysService } from "./erp-keys.service";
import { PermissionsService } from "./permissions.service";
import { ScopeService } from "./scope.service";

@Global()
@Module({
  imports: [
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET ?? "dev_only_change_me",
    }),
  ],
  controllers: [SsoController, DevErpController],
  providers: [AuthService, ErpKeysService, PermissionsService, ScopeService],
  exports: [AuthService, PermissionsService, ScopeService],
})
export class AuthModule {}
