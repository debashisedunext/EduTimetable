import { Module } from "@nestjs/common";
import { AcademicYearsController } from "./academic-years.controller";
import { SchoolController } from "./school.controller";
import { ClassesController, ClassSectionsController } from "./classes.controller";
import { RoomsController } from "./rooms.controller";
import { SubjectsController } from "./subjects.controller";
import { AvailabilityController } from "./availability.controller";
import { TeachersController } from "./teachers.controller";
import { CurriculumController } from "./curriculum.controller";
import { MappingsController, MergedGroupsController } from "./mappings.controller";
import { ElectiveBlocksController } from "./electives.controller";
import { ExtraClassesController } from "./extra-classes.controller";
import { TimetableConfigsController } from "./timetable-configs.controller";
import { AiModule } from "../ai/ai.module";
import { ImportModule } from "../import/import.module";
import { ReadinessService } from "../readiness/readiness.service";
import { CloneService } from "./clone.service";
import { InstructionService } from "./instruction.service";

/**
 * The Config Service (§2): every master-data mutation invalidates the readiness
 * cache and pushes `readiness:invalidated` — the live "tell me what to fix"
 * loop of task 1.12.
 */
@Module({
  // §26.5: a teacher's plain-English instruction is translated by the §13.2
  // provider contract — the same neutral one the chat and the interviewer use,
  // never a vendor's shape.
  /*
    §35 — `ImportModule` for the board catalogue's Apply.

    Applying a catalogue subject writes through `commitSheets`, the §16
    committer, rather than through a write path of its own — so the Subjects
    controller needs that service, and it is exported for exactly this reason
    (the §13.5 AI data-entry path is the other caller). No cycle: `ImportModule`
    imports nothing from masters.
  */
  imports: [AiModule, ImportModule],
  controllers: [
    SchoolController,
    AcademicYearsController,
    ClassesController,
    ClassSectionsController,
    RoomsController,
    SubjectsController,
    AvailabilityController,
    TeachersController,
    CurriculumController,
    MappingsController,
    MergedGroupsController,
    ElectiveBlocksController,
    ExtraClassesController,
    TimetableConfigsController,
  ],
  providers: [ReadinessService, CloneService, InstructionService],
  exports: [ReadinessService],
})
export class MastersModule {}
