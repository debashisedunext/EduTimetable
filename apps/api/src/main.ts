import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { AppModule } from "./app.module";
import { TenantAwareLogger, logLevels } from "./tenant/tenant-logger";

async function bootstrap() {
  // Every log line gains the school it belongs to, without any call site
  // knowing about it (§17.7). Set at creation so bootstrap is covered too.
  const app = await NestFactory.create(AppModule, {
    logger: new TenantAwareLogger("App", { logLevels: logLevels() }),
  });
  app.setGlobalPrefix("api");
  app.enableCors({ origin: process.env.WEB_APP_URL ?? true, credentials: true });
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, "0.0.0.0");
  new Logger("Bootstrap").log(`API listening on :${port}`);
}
bootstrap();
