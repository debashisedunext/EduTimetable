/**
 * Golden fixture builder for the Feasibility Engine test suite (task 1.14).
 * `cleanSchool()` is a small school that passes every check with score 100;
 * tests mutate one aspect at a time to prove each check fires precisely.
 */
import type { FeasibilitySnapshot, SnapshotTeacher } from "./types";

export function teacher(id: number, name: string, over: Partial<SnapshotTeacher> = {}): SnapshotTeacher {
  return {
    id,
    name,
    maxPeriodsPerDay: 6,
    maxPeriodsPerWeek: 30,
    classTeacherPeriodRule: "none",
    periodPattern: "every_period",
    alternateDaySet: null,
    unavailableFullDays: [],
    unavailablePeriodCount: 0,
    ...over,
  };
}

/**
 * 2 sections (5-A, 5-B) · 5 days × 6 periods = 30 slots/section.
 * 5 subjects × 6 periods/week (max 2/day) = exactly 30 required.
 * 5 teachers, one subject each, both sections → 12 periods/week each.
 */
export function cleanSchool(): FeasibilitySnapshot {
  const subjects = ["English", "Maths", "Science", "Hindi", "Art"];
  return {
    config: {
      id: 1,
      name: "Middle Wing",
      workingDays: [1, 2, 3, 4, 5],
      periodsPerDay: 6,
      daySegments: [3, 3],
    },
    classSections: [
      { id: 11, label: "5-A", classId: 5, classTeacherId: 101 },
      { id: 12, label: "5-B", classId: 5, classTeacherId: 102 },
    ],
    subjectRequirements: subjects.map((s, i) => ({
      id: 200 + i,
      classId: 5,
      subjectId: 300 + i,
      subjectName: s,
      periodsPerWeek: 6,
      maxPeriodsPerDay: 2,
      samePeriodAcrossWeek: false,
      consecutiveBlockSize: 1,
      consecutiveBlocksPerWeek: null,
    })),
    teachers: subjects.map((s, i) => teacher(101 + i, `T.${s}`)),
    mappings: subjects.flatMap((s, i) => [
      {
        id: 400 + i * 2,
        teacherId: 101 + i,
        teacherName: `T.${s}`,
        subjectId: 300 + i,
        subjectName: s,
        classSectionId: 11,
        classSectionLabel: "5-A",
        periodsPerWeek: 6,
      },
      {
        id: 401 + i * 2,
        teacherId: 101 + i,
        teacherName: `T.${s}`,
        subjectId: 300 + i,
        subjectName: s,
        classSectionId: 12,
        classSectionLabel: "5-B",
        periodsPerWeek: 6,
      },
    ]),
    mergedGroups: [],
    crossConfigTeacherLoad: {},
    labRoomCount: 1,
    labSubjectIds: [],
  };
}
