import { Global, Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { AuthService } from "./auth.service";
import { SsoController } from "./sso.controller";
import { DevErpController } from "./dev-erp.controller";
import { DevMailController } from "./dev-mail.controller";
import { SchoolSwitchController } from "./school-switch.controller";
import { LocalAuthController } from "./local-auth.controller";
import { ErpKeysService } from "./erp-keys.service";
import { PermissionsService } from "./permissions.service";
import { ScopeService } from "./scope.service";
import { AccountService } from "./account.service";
import { AccountAuthGuard } from "./account-auth.guard";
import { EmailService } from "./email.service";
import { LoginThrottleService } from "./login-throttle.service";
import { PasswordService } from "./password.service";

@Global()
@Module({
  imports: [
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET ?? "dev_only_change_me",
    }),
  ],
  controllers: [
    SsoController,
    DevErpController,
    DevMailController,
    SchoolSwitchController,
    // §15.3 Phase 25.0 — the second way in. SSO is untouched above it.
    LocalAuthController,
  ],
  providers: [
    AuthService,
    ErpKeysService,
    PermissionsService,
    ScopeService,
    AccountService,
    PasswordService,
    EmailService,
    LoginThrottleService,
    AccountAuthGuard,
  ],
  exports: [
    AuthService,
    PermissionsService,
    ScopeService,
    AccountService,
    PasswordService,
    AccountAuthGuard,
  ],
})
export class AuthModule {}
