/**
 * §35 — the CBSE subject catalogue, as data.
 *
 * ## Where these rows come from
 *
 * The **structure** — which subjects a class runs — is the CBSE class-wise
 * subject scheme for 2026-27, aligned with the National Curriculum Framework
 * for School Education. The **45 language names** are the language list CBSE
 * publishes on `cbseacademic.nic.in/curriculum_2027.html`, read once and
 * written down here.
 *
 * It is seeded rather than fetched, deliberately. A government HTML page is not
 * an API: it carries the year in its own URL, it is a directory of PDFs rather
 * than a table, and a parser pointed at it is a button that breaks silently the
 * first time the site is redesigned. Written down, this is reviewable in a
 * diff, works with no egress, and is updated by editing one table — which is
 * how a school's own corrections survive too.
 *
 * ## `fromSeq` / `toSeq`
 *
 * Inclusive `CLASS_LADDER` positions, the same vocabulary `classes.sequence`
 * uses (§31.12): Pre-Nursery is 1, **Class 1 is 5**, Class 12 is 16. That range
 * is the point of the whole table — applying it writes `subject_classes`
 * (§27.16), and §27.16 is what then refuses Biology to Class 5 for ever after.
 *
 * ## Two places this deliberately departs from the document
 *
 * **Physical Education is ONE subject, not four.** The scheme names it by stage
 * — "Physical Education & Play" (1–2), "& Health" (3–5), "& Well-being" (6–8),
 * "Health & Physical Education" (9–10). Taken literally that is four rows in a
 * school's Subjects master, four colours on the grid, and four things to staff
 * and timetable separately, for one lesson that has been PE all along. Same for
 * Art Education. A school that wants the stage names can rename the row.
 *
 * **"Language 1 / 2 / 3" are not subjects.** The scheme describes slots; a
 * school cannot timetable "Language 1". So the languages below are OFFERED —
 * `isLanguage`, never pre-ticked — and the school picks the two or three it
 * actually runs out of the forty-five CBSE lists.
 */
import { CLASS_LADDER } from "@edutimetable/shared";

/** `CLASS_LADDER` is 0-indexed; `sequence` is 1-based. Class 1 → 5. */
const seq = (className: string): number => {
  const i = (CLASS_LADDER as readonly string[]).indexOf(className);
  if (i < 0) throw new Error(`Not on the class ladder: ${className}`);
  return i + 1;
};

export const CBSE_BOARD = "CBSE";
export const CBSE_VERSION = "2026-27";

export interface CatalogRow {
  name: string;
  code?: string;
  category?: "scholastic" | "co_scholastic";
  isLab?: boolean;
  /** Inclusive class names, resolved to ladder positions on the way in. */
  from: string;
  to: string;
  isLanguage?: boolean;
  group: string;
}

/**
 * The 45 languages CBSE lists, in its own order.
 *
 * Offered, never recommended: a school runs two or three, and pre-ticking the
 * list would create forty-five subjects nobody teaches. Spanning the whole
 * ladder because a school choosing Bengali generally teaches it throughout.
 */
export const CBSE_LANGUAGES = [
  "Arabic", "Assamese", "Bahasa Melayu", "Bengali", "Bhoti", "Bhutia", "Bodo",
  "Dogri", "English", "French", "German", "Gujarati", "Gurung", "Hindi",
  "Japanese", "Kannada", "Kashmiri", "Kokborok", "Konkani", "Lepcha", "Limboo",
  "Malayalam", "Manipuri", "Marathi", "Maithili", "Mizo", "Nepali", "Odia",
  "Persian", "Punjabi", "Rai", "Russian", "Sanskrit", "Santhali", "Sindhi",
  "Spanish", "Sherpa", "Tamang", "Tamil", "Tangkhul", "Telugu AP",
  "Telugu Telangana", "Tibetan", "Thai", "Urdu",
];

const CORE: CatalogRow[] = [
  // ── every stage
  { name: "Mathematics", code: "MAT", from: "Class 1", to: "Class 12", group: "Core" },

  // ── primary and middle
  { name: "Environmental Studies", code: "EVS", from: "Class 3", to: "Class 5", group: "Core" },
  { name: "Science", code: "SCI", isLab: true, from: "Class 6", to: "Class 10", group: "Core" },
  { name: "Social Science", code: "SST", from: "Class 6", to: "Class 10", group: "Core" },

  // ── co-scholastic, consolidated (see the note at the top of this file)
  { name: "Art Education", code: "ART", category: "co_scholastic", from: "Class 1", to: "Class 10", group: "Co-scholastic" },
  { name: "Physical Education", code: "PE", category: "co_scholastic", from: "Class 1", to: "Class 10", group: "Co-scholastic" },
  { name: "Work Experience", code: "WE", category: "co_scholastic", from: "Class 3", to: "Class 8", group: "Co-scholastic" },

  // ── secondary skill subjects (optional at 9–10, elective at 11–12)
  { name: "Artificial Intelligence", code: "AI", isLab: true, from: "Class 9", to: "Class 12", group: "Skill" },
  { name: "Information Technology", code: "IT", isLab: true, from: "Class 9", to: "Class 10", group: "Skill" },
  { name: "Coding", code: "COD", isLab: true, from: "Class 9", to: "Class 10", group: "Skill" },
  { name: "Financial Literacy", code: "FIN", from: "Class 9", to: "Class 10", group: "Skill" },

  // ── senior secondary: science
  { name: "Physics", code: "PHY", isLab: true, from: "Class 11", to: "Class 12", group: "Science stream" },
  { name: "Chemistry", code: "CHE", isLab: true, from: "Class 11", to: "Class 12", group: "Science stream" },
  { name: "Biology", code: "BIO", isLab: true, from: "Class 11", to: "Class 12", group: "Science stream" },
  { name: "Biotechnology", code: "BT", isLab: true, from: "Class 11", to: "Class 12", group: "Science stream" },
  { name: "Applied Mathematics", code: "AMT", from: "Class 11", to: "Class 12", group: "Science stream" },

  // ── senior secondary: commerce
  { name: "Accountancy", code: "ACC", from: "Class 11", to: "Class 12", group: "Commerce stream" },
  { name: "Business Studies", code: "BST", from: "Class 11", to: "Class 12", group: "Commerce stream" },
  { name: "Economics", code: "ECO", from: "Class 11", to: "Class 12", group: "Commerce stream" },
  { name: "Entrepreneurship", code: "ENT", from: "Class 11", to: "Class 12", group: "Commerce stream" },

  // ── senior secondary: humanities
  { name: "History", code: "HIS", from: "Class 11", to: "Class 12", group: "Humanities stream" },
  { name: "Political Science", code: "POL", from: "Class 11", to: "Class 12", group: "Humanities stream" },
  { name: "Geography", code: "GEO", from: "Class 11", to: "Class 12", group: "Humanities stream" },
  { name: "Sociology", code: "SOC", from: "Class 11", to: "Class 12", group: "Humanities stream" },
  { name: "Psychology", code: "PSY", from: "Class 11", to: "Class 12", group: "Humanities stream" },
  { name: "Legal Studies", code: "LEG", from: "Class 11", to: "Class 12", group: "Humanities stream" },

  // ── senior secondary: tech and skill electives
  { name: "Computer Science", code: "CS", isLab: true, from: "Class 11", to: "Class 12", group: "Tech elective" },
  { name: "Informatics Practices", code: "IP", isLab: true, from: "Class 11", to: "Class 12", group: "Tech elective" },
  { name: "Web Applications", code: "WEB", isLab: true, from: "Class 11", to: "Class 12", group: "Tech elective" },
  { name: "Design Thinking", code: "DT", from: "Class 11", to: "Class 12", group: "Tech elective" },
  { name: "Data Science", code: "DS", isLab: true, from: "Class 11", to: "Class 12", group: "Tech elective" },
];

/**
 * Which groups open TICKED in the recommendation dialog.
 *
 * The class range already answers "does this subject apply to this class"; it
 * cannot answer "does this school run a Humanities stream", because that is a
 * choice rather than a fact about the scheme. A school offering Science and
 * Commerce only, given the whole senior list, gets Sociology, Psychology and
 * Legal Studies as real subjects — in the Allocation grid's columns, in the
 * colour palette, and in what Readiness counts — and has to find and delete
 * three rows it never asked for.
 *
 * So the streams are offered by the group rather than the row: one click ticks
 * a whole stream, which is the unit a school actually decides in. Languages are
 * the same argument at larger scale (forty-five of them, a school runs two).
 *
 * It lives here rather than in the screen because the group labels are defined
 * in this file, and a predicate over strings defined somewhere else is a rename
 * away from silently ticking nothing.
 */
export const OPT_IN_GROUPS: ReadonlySet<string> = new Set([
  "Science stream", "Commerce stream", "Humanities stream", "Tech elective", "Languages",
]);

/** True for the rows nearly every CBSE school runs, whatever streams it offers. */
export const isRecommended = (groupLabel: string): boolean => !OPT_IN_GROUPS.has(groupLabel);

/** Every row the seed writes, languages last and marked as offered. */
export function cbseCatalogRows() {
  const rows = [
    ...CORE,
    ...CBSE_LANGUAGES.map((name): CatalogRow => ({
      name,
      // No code: three-letter codes for forty-five languages collide (Bhoti /
      // Bhutia / Bodo), and a wrong code printed on a timetable is worse than
      // none. The school sets one on the row it actually keeps.
      from: "Class 1",
      to: "Class 12",
      isLanguage: true,
      group: "Languages",
    })),
  ];
  return rows.map((r, i) => ({
    board: CBSE_BOARD,
    version: CBSE_VERSION,
    name: r.name,
    code: r.code ?? null,
    category: r.category ?? "scholastic",
    isLab: r.isLab ?? false,
    fromSeq: seq(r.from),
    toSeq: seq(r.to),
    isLanguage: r.isLanguage ?? false,
    groupLabel: r.group,
    sortOrder: i,
  }));
}
