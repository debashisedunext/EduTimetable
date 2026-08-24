/**
 * §16 — the master-data workbook contract. ONE declarative definition drives
 * everything: the template generator, the parser, the validator, the annotated
 * error file, and the docs. Adding a column here is the only edit needed.
 *
 * Pure data — no Excel, no Prisma. Sheets are ordered by dependency, which is
 * also the order the committer writes them in.
 */

export type CellType = "string" | "int" | "bool" | "date" | "enum" | "list";

export interface ColumnDef {
  /** header text as it appears in row 1 — matching is by NAME, not position */
  header: string;
  /** key on the parsed row object */
  key: string;
  type: CellType;
  required?: boolean;
  /** VarChar limit from the schema — the main garbage guard */
  maxLength?: number;
  min?: number;
  max?: number;
  /** allowed values for type "enum" (matched case-insensitively) */
  values?: readonly string[];
  /** human-friendly aliases accepted for enum values, e.g. "Lab" -> "lab" */
  aliases?: Record<string, string>;
  /** for type "list": the separator between items */
  separator?: string;
  /** the sheet whose natural key this column references */
  refSheet?: string;
  /** column width + the note shown in the template */
  width?: number;
  help: string;
  /** example values used for the sample rows in the template */
  sample?: (string | number | boolean)[];
}

export interface SheetDef {
  name: string;
  /** what this sheet creates, in plain English (used in the UI and template) */
  title: string;
  help: string;
  columns: ColumnDef[];
  /** column keys forming the natural key used for duplicate detection */
  naturalKey: string[];
  /** how the natural key reads in an error message, e.g. "Class + Subject" */
  keyLabel: string;
}

export const YES_NO = ["Yes", "No"] as const;
export const DAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export const DAY_VALUES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export const ROOM_TYPES = ["classroom", "lab", "sports", "music", "art", "auditorium", "other"] as const;
export const CT_RULES = ["none", "always_first_period", "random"] as const;
export const PATTERNS = ["every_period", "alternate_period", "alternate_day"] as const;

/** Rows whose first cell starts with this are template samples — never imported. */
export const SAMPLE_MARKER = "e.g.";

export const SHEETS: SheetDef[] = [
  {
    name: "Academic Years",
    title: "Academic years",
    help: "Every class-section belongs to one academic year. Add the year you are building the timetable for.",
    keyLabel: "Name",
    naturalKey: ["name"],
    columns: [
      { header: "Name", key: "name", type: "string", required: true, maxLength: 20, width: 18, help: "e.g. 2026-27", sample: ["e.g. 2026-27"] },
      { header: "Start Date", key: "startDate", type: "date", required: true, width: 14, help: "First day of the year (YYYY-MM-DD or an Excel date)", sample: ["2026-04-01"] },
      { header: "End Date", key: "endDate", type: "date", required: true, width: 14, help: "Last day of the year", sample: ["2027-03-31"] },
      { header: "Active", key: "isActive", type: "enum", values: YES_NO, width: 10, help: "Is this the current year? Defaults to Yes", sample: ["Yes"] },
    ],
  },
  {
    name: "Classes",
    title: "Classes (grades)",
    help: "The grades your school runs. Sections are added on the next sheet.",
    keyLabel: "Class Name",
    naturalKey: ["name"],
    columns: [
      { header: "Class Name", key: "name", type: "string", required: true, maxLength: 20, width: 18, help: "e.g. Class 5", sample: ["e.g. Class 5"] },
      { header: "Sequence", key: "sequence", type: "int", min: 0, max: 999, width: 12, help: "Display order (1, 2, 3…). Leave blank to append", sample: [1] },
    ],
  },
  {
    name: "Class Sections",
    title: "Class-sections",
    help: "The actual scheduling units — one row per section. This creates the section and links it to an academic year.",
    keyLabel: "Class + Section + Year",
    naturalKey: ["className", "sectionName", "academicYear"],
    columns: [
      { header: "Class Name", key: "className", type: "string", required: true, maxLength: 20, refSheet: "Classes", width: 18, help: "Must exist on the Classes sheet or already in the system", sample: ["e.g. Class 5"] },
      { header: "Section Name", key: "sectionName", type: "string", required: true, maxLength: 10, width: 14, help: "e.g. A", sample: ["A"] },
      { header: "Academic Year", key: "academicYear", type: "string", required: true, maxLength: 20, refSheet: "Academic Years", width: 16, help: "Must exist on the Academic Years sheet or already in the system", sample: ["2026-27"] },
      { header: "Strength", key: "strength", type: "int", min: 1, max: 200, width: 11, help: "Number of students (optional)", sample: [32] },
      { header: "Home Room", key: "homeRoom", type: "string", maxLength: 50, refSheet: "Rooms", width: 16, help: "Their usual room (optional) — must exist on the Rooms sheet", sample: ["Room 12"] },
      { header: "Timetable", key: "timetable", type: "string", maxLength: 50, width: 16, help: "Optional: name of an EXISTING timetable to add this section to", sample: [""] },
    ],
  },
  {
    name: "Rooms",
    title: "Rooms",
    help: "Classrooms, labs and special rooms. Labs get their own contention check when solving.",
    keyLabel: "Room Name",
    naturalKey: ["name"],
    columns: [
      { header: "Room Name", key: "name", type: "string", required: true, maxLength: 50, width: 20, help: "e.g. Room 12 or Science Lab 1", sample: ["e.g. Room 12"] },
      { header: "Type", key: "roomType", type: "enum", values: ROOM_TYPES, aliases: { classroom: "classroom", "class room": "classroom", laboratory: "lab", lab: "lab" }, width: 14, help: "One of: " + ROOM_TYPES.join(", "), sample: ["classroom"] },
      { header: "Capacity", key: "capacity", type: "int", min: 1, max: 500, width: 11, help: "Seats (optional)", sample: [40] },
      { header: "Shared", key: "isShared", type: "enum", values: YES_NO, width: 10, help: "Shared between classes? Labs default to Yes", sample: ["No"] },
    ],
  },
  {
    name: "Subjects",
    title: "Subjects",
    help: "Every subject taught. Flag lab subjects so the solver places them in a lab.",
    keyLabel: "Subject Name",
    naturalKey: ["name"],
    columns: [
      { header: "Subject Name", key: "name", type: "string", required: true, maxLength: 50, width: 20, help: "e.g. Mathematics", sample: ["e.g. Mathematics"] },
      { header: "Code", key: "code", type: "string", maxLength: 10, width: 10, help: "Short code (optional)", sample: ["MATH"] },
      { header: "Is Lab", key: "isLab", type: "enum", values: YES_NO, width: 10, help: "Needs a lab room?", sample: ["No"] },
      { header: "Requires Double Period", key: "requiresDoublePeriod", type: "enum", values: YES_NO, width: 20, help: "Usually taught as a double period?", sample: ["No"] },
    ],
  },
  {
    name: "Teachers",
    title: "Teachers",
    help: "Staff and their placement rules. These rules are HARD constraints — the solver can never break them.",
    keyLabel: "Employee Code",
    naturalKey: ["employeeCode"],
    columns: [
      { header: "Employee Code", key: "employeeCode", type: "string", required: true, maxLength: 20, width: 16, help: "Unique per school, e.g. EDX-1042", sample: ["e.g. EDX-1042"] },
      { header: "Name", key: "name", type: "string", required: true, maxLength: 100, width: 22, help: "Full name", sample: ["Rekha Sharma"] },
      { header: "Max Periods/Day", key: "maxPeriodsPerDay", type: "int", min: 1, max: 12, width: 15, help: "Defaults to 6", sample: [6] },
      { header: "Max Periods/Week", key: "maxPeriodsPerWeek", type: "int", min: 1, max: 60, width: 16, help: "Defaults to 30", sample: [30] },
      { header: "Class-Teacher Rule", key: "classTeacherPeriodRule", type: "enum", values: CT_RULES, aliases: { "always first period": "always_first_period" }, width: 20, help: "always_first_period = takes P1 of their own class every day, and never P1 elsewhere", sample: ["none"] },
      { header: "Period Pattern", key: "periodPattern", type: "enum", values: PATTERNS, aliases: { "alternate period": "alternate_period", "alternate day": "alternate_day", "every period": "every_period" }, width: 18, help: "alternate_period = never two periods in a row", sample: ["every_period"] },
      { header: "Alternate Days", key: "alternateDaySet", type: "list", separator: ",", width: 18, help: "Only for alternate_day, e.g. Mon,Wed,Fri", sample: [""] },
      { header: "Active", key: "isActive", type: "enum", values: YES_NO, width: 10, help: "Defaults to Yes", sample: ["Yes"] },
    ],
  },
  {
    name: "Teacher Unavailability",
    title: "Teacher unavailability",
    help: "When a teacher cannot be scheduled. Leave Period blank to block the whole day.",
    keyLabel: "Teacher + Day + Period",
    naturalKey: ["employeeCode", "day", "period"],
    columns: [
      { header: "Employee Code", key: "employeeCode", type: "string", required: true, maxLength: 20, refSheet: "Teachers", width: 16, help: "Must exist on the Teachers sheet or already in the system", sample: ["e.g. EDX-1042"] },
      { header: "Day", key: "day", type: "enum", required: true, values: DAY_VALUES, width: 10, help: "Mon…Sun", sample: ["Fri"] },
      { header: "Period", key: "period", type: "int", min: 1, max: 12, width: 10, help: "Blank = unavailable all day", sample: [""] },
      { header: "Reason", key: "reason", type: "string", maxLength: 100, width: 24, help: "Optional note", sample: ["Weekly staff meeting"] },
    ],
  },
  {
    name: "Curriculum",
    title: "Curriculum (class ↔ subject)",
    help: "How many periods of each subject a class takes per week. This is what the solver has to place.",
    keyLabel: "Class + Subject",
    naturalKey: ["className", "subjectName"],
    columns: [
      { header: "Class Name", key: "className", type: "string", required: true, maxLength: 20, refSheet: "Classes", width: 18, help: "Must exist on the Classes sheet or already in the system", sample: ["e.g. Class 5"] },
      { header: "Subject Name", key: "subjectName", type: "string", required: true, maxLength: 50, refSheet: "Subjects", width: 20, help: "Must exist on the Subjects sheet or already in the system", sample: ["Mathematics"] },
      { header: "Periods/Week", key: "periodsPerWeek", type: "int", required: true, min: 1, max: 20, width: 14, help: "Cannot exceed the timetable's weekly capacity", sample: [6] },
      { header: "Max Periods/Day", key: "maxPeriodsPerDay", type: "int", min: 1, max: 12, width: 16, help: "Defaults to 1", sample: [1] },
      { header: "Same Period Across Week", key: "samePeriodAcrossWeek", type: "enum", values: YES_NO, width: 22, help: "Must land in the same period every day it occurs", sample: ["No"] },
      { header: "Block Size", key: "consecutiveBlockSize", type: "int", min: 1, max: 4, width: 12, help: "2 = double period. Defaults to 1", sample: [1] },
      { header: "Blocks/Week", key: "consecutiveBlocksPerWeek", type: "int", min: 1, max: 10, width: 13, help: "How many blocks of that size per week", sample: [""] },
    ],
  },
  {
    name: "Class Teachers",
    title: "Class-teacher assignments",
    help: "Who owns each class-section. This is what activates a teacher's 'always first period' rule.",
    keyLabel: "Class-Section",
    naturalKey: ["classSection"],
    columns: [
      { header: "Class-Section", key: "classSection", type: "string", required: true, maxLength: 40, refSheet: "Class Sections", width: 18, help: "e.g. Class 5-A", sample: ["e.g. Class 5-A"] },
      { header: "Teacher Employee Code", key: "employeeCode", type: "string", required: true, maxLength: 20, refSheet: "Teachers", width: 22, help: "Must be an active teacher", sample: ["EDX-1042"] },
    ],
  },
  {
    name: "Subject Mapping",
    title: "Subject mapping (who teaches what, where)",
    help: "The core mapping the solver builds from. List several class-sections in one row to map them all at once.",
    keyLabel: "Subject + Class-Section",
    naturalKey: ["subjectName", "classSections"],
    columns: [
      { header: "Teacher Employee Code", key: "employeeCode", type: "string", required: true, maxLength: 20, refSheet: "Teachers", width: 22, help: "Must exist on the Teachers sheet or already in the system", sample: ["e.g. EDX-1042"] },
      { header: "Subject", key: "subjectName", type: "string", required: true, maxLength: 50, refSheet: "Subjects", width: 20, help: "Must exist on the Subjects sheet or already in the system", sample: ["Mathematics"] },
      { header: "Class-Sections", key: "classSections", type: "list", required: true, separator: ",", refSheet: "Class Sections", width: 28, help: "One or more, comma separated: Class 5-A, Class 5-B", sample: ["Class 5-A, Class 5-B"] },
      { header: "Periods/Week", key: "periodsPerWeek", type: "int", required: true, min: 1, max: 20, width: 14, help: "Per class-section. Should match the Curriculum sheet", sample: [6] },
      { header: "Room", key: "room", type: "string", maxLength: 50, refSheet: "Rooms", width: 18, help: "Fixed room for these periods (optional)", sample: [""] },
      { header: "Merged", key: "merged", type: "enum", values: YES_NO, width: 10, help: "Yes = one lesson taught to all the listed sections together (needs 2+)", sample: ["No"] },
    ],
  },
];

export const SHEET_BY_NAME = new Map(SHEETS.map((s) => [s.name.toLowerCase(), s]));

export const dayNumber = (name: string): number | null => {
  const i = DAY_VALUES.findIndex((d) => d.toLowerCase() === name.trim().toLowerCase());
  return i === -1 ? null : i + 1;
};
