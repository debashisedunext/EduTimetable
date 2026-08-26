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
    eligibleClassIds: [],
    employmentType: "permanent",
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
    // Every fixture teacher covers class 5 — the only class here — so the
    // golden school stays clean under §18's Check 8.
    teachers: subjects.map((s, i) => teacher(101 + i, `T.${s}`, { eligibleClassIds: [5] })),
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
    electiveBlocks: [],
    crossConfigTeacherLoad: {},
    labRoomCount: 1,
    labSubjectIds: [],
  };
}

/**
 * `cleanSchool()` with a §4.9 split elective bolted on: both sections drop one
 * subject to 4 periods, freeing 2 slots each, and a 2-period "Class 5 Third
 * Language" block fills them with three parallel lessons.
 *
 * The block's periods are deliberately NOT in `subjectRequirements` — a section
 * spends 2 periods on "a language", not 2 on each of three — which is exactly
 * what `runFeasibility` has to account for on its own.
 */
export function schoolWithElective(): FeasibilitySnapshot {
  const snap = cleanSchool();
  // free 2 periods per section by trimming Art from 6 to 4
  const art = snap.subjectRequirements.find((r) => r.subjectName === "Art")!;
  art.periodsPerWeek = 4;
  for (const m of snap.mappings) if (m.subjectName === "Art") m.periodsPerWeek = 4;

  snap.teachers.push(
    teacher(201, "Mme Dubois", { eligibleClassIds: [5] }),
    teacher(202, "Shri Joshi", { eligibleClassIds: [5] }),
    teacher(203, "Hr. Bauer", { eligibleClassIds: [5] }),
  );
  snap.electiveBlocks = [
    {
      id: 7,
      name: "Class 5 Third Language",
      periodsPerWeek: 2,
      maxPeriodsPerDay: 1,
      memberClassSectionIds: [11, 12],
      memberLabels: ["5-A", "5-B"],
      options: [
        { id: 21, subjectId: 501, subjectName: "French", teacherId: 201, teacherName: "Mme Dubois", roomId: 801, roomName: "Lang 1" },
        { id: 22, subjectId: 502, subjectName: "Sanskrit", teacherId: 202, teacherName: "Shri Joshi", roomId: 802, roomName: "Lang 2" },
        { id: 23, subjectId: 503, subjectName: "German", teacherId: 203, teacherName: "Hr. Bauer", roomId: 803, roomName: "Lang 3" },
      ],
    },
  ];
  return snap;
}
