import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { json, urlencoded } from "express";
import { AppModule } from "./app.module";
import { TenantAwareLogger, logLevels } from "./tenant/tenant-logger";

/**
 * The largest request body this app accepts.
 *
 * Express defaults to 100kb, and a real school outgrows it. Second Branch —
 * 16 classes, 64 sections, 122 teachers, 20 subjects — has 957 subject
 * mappings, and that ONE key of a guided-setup draft is 98kb of JSON on its
 * own. The whole draft is 145kb, so the wizard's save failed with a raw
 * `request entity too large` on a school that had done nothing unusual.
 *
 * The client now sends only the keys a step actually touched, which fixes the
 * common case — but a single legitimately large key can still approach the
 * default on a bigger school, and a limit that a school can reach by growing
 * is not a limit, it is a time bomb. 2mb leaves room for roughly a
 * thousand-section school while still refusing anything that could only be an
 * attack or a mistake.
 *
 * The §16 Excel importer does NOT ride on this: it uploads a file through
 * multipart, which has its own limit.
 */
const BODY_LIMIT = process.env.BODY_LIMIT ?? "2mb";

async function bootstrap() {
  // Every log line gains the school it belongs to, without any call site
  // knowing about it (§17.7). Set at creation so bootstrap is covered too.
  const app = await NestFactory.create(AppModule, {
    logger: new TenantAwareLogger("App", { logLevels: logLevels() }),
    // Nest's own parser is registered at create() with the 100kb default and
    // runs first, so raising the limit means replacing it rather than adding
    // a second one behind it.
    bodyParser: false,
  });
  app.use(json({ limit: BODY_LIMIT }));
  app.use(urlencoded({ extended: true, limit: BODY_LIMIT }));
  app.setGlobalPrefix("api");
  app.enableCors({ origin: process.env.WEB_APP_URL ?? true, credentials: true });
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, "0.0.0.0");
  new Logger("Bootstrap").log(`API listening on :${port}`);
}
bootstrap();
