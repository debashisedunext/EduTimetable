/**
 * §30.5 — `ValidityService`, wherever a timetable is published or re-dated.
 *
 * `@Global` for the reason `FreezeModule` and `ResourceGroupModule` are: the
 * failure mode is a write path that never asks. Two call sites today (publish,
 * and the config update that can re-date a published one), and the third is the
 * one this is for.
 */
import { Global, Module } from "@nestjs/common";
import { ValidityService } from "./validity.service";

@Global()
@Module({
  providers: [ValidityService],
  exports: [ValidityService],
})
export class ValidityModule {}
