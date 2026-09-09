import { Controller, NotFoundException, Post, Req } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { ReadinessService } from "../readiness/readiness.service";
import { ResourceGroupService } from "../groups/resource-group.service";
import type { AuthedRequest } from "../masters/crud.util";

/**
 * Dev-only: seeds a small demo school so the wizard/readiness screens have
 * real data to show. Deliberately includes two defects (an unmapped subject
 * and an overloaded teacher) so the Readiness Dashboard demonstrates the §4
 * blocker → fix loop. Idempotent-ish: bails if the demo config already exists.
 */
@Controller("dev")
export class SampleDataController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly readiness: ReadinessService,
    private readonly groups: ResourceGroupService,
  ) {}

  @Post("sample-data")
  async seed(@Req() req: AuthedRequest) {
    if (this.config.get("NODE_ENV") === "production") throw new NotFoundException();
    const schoolId = req.user.schoolId;

    const existing = await this.prisma.timetableConfig.findFirst({
      where: { schoolId, name: "Middle Wing" },
    });
    if (existing) return { ok: true, note: "sample data already present", configId: existing.id };

    const year = await this.prisma.academicYear.upsert({
      where: { schoolId_name: { schoolId, name: "2026-27" } },
      create: { schoolId, name: "2026-27", startDate: new Date("2026-04-01"), endDate: new Date("2027-03-31") },
      update: {},
    });

    const subjectDefs = [
      { name: "English", isLab: false },
      { name: "Mathematics", isLab: false },
      { name: "Science", isLab: true },
      { name: "Hindi", isLab: false },
      { name: "Social Studies", isLab: false },
      { name: "Art", isLab: false },
    ];
    const subjects: Record<string, number> = {};
    for (const s of subjectDefs) {
      const row = await this.prisma.subject.upsert({
        where: { schoolId_name: { schoolId, name: s.name } },
        create: { schoolId, name: s.name, isLab: s.isLab },
        update: {},
      });
      subjects[s.name] = row.id;
    }

    for (const name of ["Room 501", "Room 502", "Room 601", "Room 602", "Science Lab 1"]) {
      await this.prisma.room.upsert({
        where: { schoolId_name: { schoolId, name } },
        create: { schoolId, name, roomType: name.includes("Lab") ? "lab" : "classroom", isShared: name.includes("Lab") },
        update: {},
      });
    }

    const teacherDefs: Array<[string, string, Partial<{ rule: string; pattern: string }>]> = [
      ["EDX-1042", "Rekha Sharma", { rule: "always_first_period" }],
      ["EDX-1058", "Ajay Verma", {}],
      ["EDX-1071", "Priya Nair", { pattern: "alternate_period" }],
      ["EDX-1083", "Mehreen Khan", {}],
      ["EDX-1094", "Sunil Menon", {}],
      ["EDX-1107", "Tanvi Das", {}],
    ];
    const teachers: Record<string, number> = {};
    for (const [code, name, opts] of teacherDefs) {
      const row = await this.prisma.teacher.upsert({
        where: { schoolId_employeeCode: { schoolId, employeeCode: code } },
        create: {
          schoolId,
          employeeCode: code,
          name,
          classTeacherPeriodRule: (opts.rule as any) ?? "none",
          periodPattern: (opts.pattern as any) ?? "every_period",
        },
        update: {},
      });
      teachers[name] = row.id;
    }

    const groupId = await this.groups.defaultFor(year.id);
    const cfg = await this.prisma.timetableConfig.create({
      data: {
        schoolId,
        academicYearId: year.id,
        resourceGroupId: groupId,
        name: "Middle Wing",
        description: "Classes 5-6 · standard day",
        workingDays: [1, 2, 3, 4, 5],
        periodsPerDay: 6,
        periodDurationMins: 40,
        startTime: "08:00",
      },
    });
    // structure: 6 periods, break after P3
    const periodRows = [
      { sortOrder: 0, periodNumber: 1, startTime: "08:00", endTime: "08:40", isBreak: false, breakName: null },
      { sortOrder: 1, periodNumber: 2, startTime: "08:40", endTime: "09:20", isBreak: false, breakName: null },
      { sortOrder: 2, periodNumber: 3, startTime: "09:20", endTime: "10:00", isBreak: false, breakName: null },
      { sortOrder: 3, periodNumber: null, startTime: "10:00", endTime: "10:20", isBreak: true, breakName: "Break" },
      { sortOrder: 4, periodNumber: 4, startTime: "10:20", endTime: "11:00", isBreak: false, breakName: null },
      { sortOrder: 5, periodNumber: 5, startTime: "11:00", endTime: "11:40", isBreak: false, breakName: null },
      { sortOrder: 6, periodNumber: 6, startTime: "11:40", endTime: "12:20", isBreak: false, breakName: null },
    ];
    await this.prisma.period.createMany({
      data: periodRows.map((r) => ({ ...r, timetableConfigId: cfg.id, schoolId })),
    });
    await this.prisma.timetableConfig.update({ where: { id: cfg.id }, data: { endTime: "12:20" } });

    const sectionIds: Record<string, number> = {};
    for (const [className, seq] of [["Class 5", 5], ["Class 6", 6]] as Array<[string, number]>) {
      const klass = await this.prisma.schoolClass.upsert({
        where: { schoolId_name: { schoolId, name: className } },
        create: { schoolId, name: className, sequence: seq },
        update: {},
      });
      // curriculum: 6 subjects — 30 slots exactly (5×6)
      const plan: Array<[string, number, number]> = [
        ["English", 6, 2],
        ["Mathematics", 6, 2],
        ["Science", 5, 2],
        ["Hindi", 5, 2],
        ["Social Studies", 5, 2],
        ["Art", 3, 2],
      ];
      for (const [subj, pw, maxDay] of plan) {
        await this.prisma.classSubject.upsert({
          where: {
            classId_subjectId_academicYearId: {
              classId: klass.id,
              subjectId: subjects[subj],
              academicYearId: year.id,
            },
          },
          create: {
            schoolId,
            classId: klass.id,
            academicYearId: year.id,
            subjectId: subjects[subj],
            periodsPerWeek: pw,
            maxPeriodsPerDay: maxDay,
          },
          update: {},
        });
      }
      for (const sec of ["A", "B"]) {
        const section = await this.prisma.section.upsert({
          where: { classId_name: { classId: klass.id, name: sec } },
          create: { schoolId, classId: klass.id, name: sec },
          update: {},
        });
        const cs = await this.prisma.classSection.upsert({
          where: {
            classId_sectionId_academicYearId_resourceGroupId: {
              classId: klass.id,
              sectionId: section.id,
              academicYearId: year.id,
              resourceGroupId: groupId,
            },
          },
          create: {
            schoolId,
            classId: klass.id,
            sectionId: section.id,
            academicYearId: year.id,
            resourceGroupId: groupId,
            timetableConfigId: cfg.id,
            strength: 32,
          },
          update: { timetableConfigId: cfg.id },
        });
        sectionIds[`${className}-${sec}`] = cs.id;
      }
    }

    // class teachers: Sharma → 5-A (P1 rule active); 6-B left unassigned (demo warning)
    await this.prisma.classSection.update({
      where: { id: sectionIds["Class 5-A"] },
      data: { classTeacherId: teachers["Rekha Sharma"] },
    });
    await this.prisma.classSection.update({
      where: { id: sectionIds["Class 5-B"] },
      data: { classTeacherId: teachers["Ajay Verma"] },
    });
    await this.prisma.classSection.update({
      where: { id: sectionIds["Class 6-A"] },
      data: { classTeacherId: teachers["Mehreen Khan"] },
    });

    // subject mappings — full coverage EXCEPT: Art in 6-B unmapped (demo blocker),
    // and Sharma deliberately overloaded (English everywhere = 24 + Hindi 5-A/B = 10 → 34 > 30)
    const map = async (teacher: string, subj: string, section: string, pw: number) => {
      await this.prisma.teacherSubjectClassSection.upsert({
        where: {
          subjectId_classSectionId: { subjectId: subjects[subj], classSectionId: sectionIds[section] },
        },
        create: {
          schoolId,
          teacherId: teachers[teacher],
          subjectId: subjects[subj],
          classSectionId: sectionIds[section],
          periodsPerWeek: pw,
        },
        update: {},
      });
    };
    for (const s of ["Class 5-A", "Class 5-B", "Class 6-A", "Class 6-B"]) {
      await map("Rekha Sharma", "English", s, 6);
      await map("Ajay Verma", "Mathematics", s, 6);
      await map("Priya Nair", "Science", s, 5);
      await map("Mehreen Khan", "Social Studies", s, 5);
    }
    await map("Rekha Sharma", "Hindi", "Class 5-A", 5); // overload driver
    await map("Rekha Sharma", "Hindi", "Class 5-B", 5);
    await map("Sunil Menon", "Hindi", "Class 6-A", 5);
    await map("Sunil Menon", "Hindi", "Class 6-B", 5);
    await map("Tanvi Das", "Art", "Class 5-A", 3);
    await map("Tanvi Das", "Art", "Class 5-B", 3);
    await map("Tanvi Das", "Art", "Class 6-A", 3);
    // Art in Class 6-B intentionally left unmapped → UNDER_MAPPED blocker

    await this.readiness.invalidate(schoolId);
    return { ok: true, configId: cfg.id };
  }
}
