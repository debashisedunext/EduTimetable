import { Module } from "@nestjs/common";
import { AcademicYearsController } from "./academic-years.controller";
import { SchoolController } from "./school.controller";
import { ClassesController, ClassSectionsController } from "./classes.controller";
import { RoomsController } from "./rooms.controller";
import { SubjectsController } from "./subjects.controller";
import { TeachersController } from "./teachers.controller";
import { CurriculumController } from "./curriculum.controller";
import { MappingsController, MergedGroupsController } from "./mappings.controller";
import { TimetableConfigsController } from "./timetable-configs.controller";
import { ReadinessService } from "../readiness/readiness.service";

/**
 * The Config Service (§2): every master-data mutation invalidates the readiness
 * cache and pushes `readiness:invalidated` — the live "tell me what to fix"
 * loop of task 1.12.
 */
@Module({
  controllers: [
    SchoolController,
    AcademicYearsController,
    ClassesController,
    ClassSectionsController,
    RoomsController,
    SubjectsController,
    TeachersController,
    CurriculumController,
    MappingsController,
    MergedGroupsController,
    TimetableConfigsController,
  ],
  providers: [ReadinessService],
  exports: [ReadinessService],
})
export class MastersModule {}
