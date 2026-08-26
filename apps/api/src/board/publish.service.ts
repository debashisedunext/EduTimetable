/**
 * Task 3.7 — the draft→published lifecycle (§3 note). Publish is ONE
 * transaction: delete the superseded published set, flip every draft row's
 * status, and append the publication log row that gives the screen its
 * version number. Draft and published live in one table, so the §3 unique
 * keys guard both sides throughout.
 */
import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import type Redis from "ioredis";
import { PrismaService } from "../prisma/prisma.service";
import { REDIS } from "../redis/redis.module";
import { CacheKeysService } from "../redis/cache-keys.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EventsGateway } from "../events/events.gateway";
import { NotificationsService } from "../notifications/notifications.service";
import { buildFeasibilitySnapshot } from "../solver/input";

const DAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

interface SectionDiff {
  classSectionId: number;
  label: string;
  added: number;
  removed: number;
  changed: number;
  unallocated: number;
  details: string[];
}

@Injectable()
export class PublishService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsGateway,
    private readonly notifications: NotificationsService,
    private readonly keys: CacheKeysService,
    private readonly tenant: TenantContextService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  private async computeDiff(configId: number) {
    const [slots, snapshot, lastPub] = await Promise.all([
      this.prisma.timetableSlot.findMany({ where: { timetableConfigId: configId } }),
      buildFeasibilitySnapshot(this.prisma, configId).catch((e) => {
        throw new BadRequestException((e as Error).message);
      }),
      this.prisma.timetablePublication.findFirst({
        where: { timetableConfigId: configId },
        orderBy: { version: "desc" },
      }),
    ]);
    // The diff is per class-section, so it works on cells. An elective option
    // row is not a cell — it has no section (§4.9) — and a block that moves
    // already shows up here through the member rows of every section that
    // attends it, which is what a reader wants to see anyway.
    const cells = slots.filter((s): s is (typeof slots)[number] & { classSectionId: number } =>
      s.classSectionId !== null,
    );
    const draft = cells.filter((s) => s.status === "draft");
    const published = cells.filter((s) => s.status === "published");

    const subjectNames = new Map<number, string>();
    for (const r of snapshot.subjectRequirements) subjectNames.set(r.subjectId, r.subjectName);
    for (const m of snapshot.mappings) subjectNames.set(m.subjectId, m.subjectName);
    for (const g of snapshot.mergedGroups) subjectNames.set(g.subjectId, g.subjectName);
    const subjName = (id: number | null) =>
      id === null ? "—" : (subjectNames.get(id) ?? `subject #${id}`);

    // demand per section: per-section mappings + merged-group membership
    const demand = new Map<number, number>();
    for (const m of snapshot.mappings) {
      demand.set(m.classSectionId, (demand.get(m.classSectionId) ?? 0) + m.periodsPerWeek);
    }
    for (const g of snapshot.mergedGroups) {
      for (const cs of g.memberClassSectionIds) {
        demand.set(cs, (demand.get(cs) ?? 0) + g.periodsPerWeek);
      }
    }

    const cellOf = (s: (typeof slots)[number]) => `${s.classSectionId}@${s.dayOfWeek}:${s.periodNumber}`;
    const draftBy = new Map(draft.map((s) => [cellOf(s), s]));
    const pubBy = new Map(published.map((s) => [cellOf(s), s]));

    const perSection = new Map<number, SectionDiff>();
    const section = (id: number): SectionDiff => {
      let d = perSection.get(id);
      if (!d) {
        const cs = snapshot.classSections.find((c) => c.id === id);
        d = { classSectionId: id, label: cs?.label ?? `#${id}`, added: 0, removed: 0, changed: 0, unallocated: 0, details: [] };
        perSection.set(id, d);
      }
      return d;
    };
    const at = (s: { dayOfWeek: number; periodNumber: number }) =>
      `${DAY_NAMES[s.dayOfWeek]} P${s.periodNumber}`;
    const note = (d: SectionDiff, line: string) => {
      if (d.details.length < 8) d.details.push(line);
    };

    for (const [cell, d] of draftBy) {
      const p = pubBy.get(cell);
      if (!p) {
        const sd = section(d.classSectionId);
        sd.added++;
        note(sd, `${at(d)}: + ${subjName(d.subjectId)}`);
      } else if (p.subjectId !== d.subjectId || p.teacherId !== d.teacherId) {
        const sd = section(d.classSectionId);
        sd.changed++;
        note(sd, `${at(d)}: ${subjName(p.subjectId)} → ${subjName(d.subjectId)}`);
      }
    }
    for (const [cell, p] of pubBy) {
      if (!draftBy.has(cell)) {
        const sd = section(p.classSectionId);
        sd.removed++;
        note(sd, `${at(p)}: − ${subjName(p.subjectId)}`);
      }
    }

    const placedPer = new Map<number, number>();
    for (const s of draft) placedPer.set(s.classSectionId, (placedPer.get(s.classSectionId) ?? 0) + 1);
    let unallocatedTotal = 0;
    for (const cs of snapshot.classSections) {
      const gap = Math.max(0, (demand.get(cs.id) ?? 0) - (placedPer.get(cs.id) ?? 0));
      if (gap > 0) {
        const sd = section(cs.id);
        sd.unallocated = gap;
        note(sd, `${gap} period(s) still unallocated — place them on the Draft Board first`);
        unallocatedTotal += gap;
      }
    }

    const changedSections = [...perSection.values()].sort((a, b) => a.label.localeCompare(b.label));
    const changedTotal = changedSections.reduce((n, s) => n + s.added + s.removed + s.changed, 0);
    return {
      draftCount: draft.length,
      publishedCount: published.length,
      demandTotal: [...demand.values()].reduce((a, b) => a + b, 0),
      unallocatedTotal,
      changedTotal,
      unchangedSections: snapshot.classSections.length - changedSections.length,
      sections: changedSections,
      currentVersion: lastPub?.version ?? null,
      currentPublishedAt: lastPub?.publishedAt ?? null,
      nextVersion: (lastPub?.version ?? 0) + 1,
      snapshot,
    };
  }

  async preview(configId: number) {
    const diff = await this.computeDiff(configId);
    return { ...diff, snapshot: undefined };
  }

  async publish(configId: number, userId: number | null) {
    const diff = await this.computeDiff(configId);
    if (diff.draftCount === 0) {
      throw new BadRequestException("Nothing to publish — the draft is empty. Generate or build a draft first.");
    }
    const [, , pub] = await this.prisma.$transaction([
      this.prisma.timetableSlot.deleteMany({
        where: { timetableConfigId: configId, status: "published" },
      }),
      // flip the whole draft in place (§3): one table, one status column
      this.prisma.timetableSlot.updateMany({
        where: { timetableConfigId: configId, status: "draft" },
        data: { status: "published" },
      }),
      this.prisma.timetablePublication.create({
        data: {
          schoolId: this.tenant.requireSchoolId(),
          timetableConfigId: configId,
          version: diff.nextVersion,
          slotCount: diff.draftCount,
          changedCount: diff.changedTotal,
          unallocatedCount: diff.unallocatedTotal,
          publishedById: userId,
        },
      }),
    ]);
    await this.redis.del(
      this.keys.slots(configId, "draft"),
      this.keys.slots(configId, "published"),
      this.keys.slots(configId, "ctx"),
    );
    this.events.emitToCurrentSchool("slots:changed", { configId });
    this.events.emitToCurrentSchool("timetable:published", { configId, version: pub.version });
    // §9 trigger "Timetable published" — every teacher whose slots are in this
    // config + the timetable admins get the in-app notification
    const cfg = await this.prisma.timetableConfig.findUnique({ where: { id: configId } });
    const teacherIds = [
      ...new Set(
        diff.snapshot.mappings.map((m) => m.teacherId).concat(diff.snapshot.mergedGroups.map((g) => g.teacherId)),
      ),
    ];
    const note = {
      type: "published",
      title: `Timetable published — v${pub.version}`,
      body: `${cfg?.name ?? "The timetable"} v${pub.version} is now live (${diff.draftCount} slots). View yours.`,
      link: "/my-timetable",
    };
    await this.notifications.notifyTeachers(teacherIds, note);
    if (cfg) await this.notifications.notifyAdmins(cfg.schoolId, { ...note, link: "/matrix" });
    return { ok: true, version: pub.version, slotCount: diff.draftCount };
  }

  /** Start the next editing cycle: copy the live timetable back into a draft. */
  async draftFromPublished(configId: number) {
    const [draftCount, published] = await Promise.all([
      this.prisma.timetableSlot.count({ where: { timetableConfigId: configId, status: "draft" } }),
      this.prisma.timetableSlot.findMany({ where: { timetableConfigId: configId, status: "published" } }),
    ]);
    if (draftCount > 0) throw new BadRequestException("A draft already exists — edit or publish it first.");
    if (published.length === 0) throw new BadRequestException("Nothing published yet to draft from.");
    await this.prisma.timetableSlot.createMany({
      data: published.map((s) => ({
        schoolId: s.schoolId,
        timetableConfigId: s.timetableConfigId,
        status: "draft" as const,
        classSectionId: s.classSectionId,
        dayOfWeek: s.dayOfWeek,
        periodNumber: s.periodNumber,
        subjectId: s.subjectId,
        teacherId: s.teacherId,
        roomId: s.roomId,
        mergedGroupId: s.mergedGroupId,
        teacherOccupancyKey: s.teacherOccupancyKey,
        isLocked: s.isLocked,
        source: s.source,
      })),
    });
    await this.redis.del(this.keys.slots(configId, "draft"), this.keys.slots(configId, "ctx"));
    this.events.emitToCurrentSchool("slots:changed", { configId });
    return { ok: true, rows: published.length };
  }
}
