/**
 * School 2 — the school itself, as data.
 *
 * Everything here is derived, not typed out: the curricula fix the demand, the
 * demand fixes the teacher count, and the teacher count fixes the mappings. So
 * a change to one period in one curriculum re-balances the staff list on the
 * next run, and the arithmetic that the Feasibility Engine will check is the
 * same arithmetic that produced the file.
 *
 * Three numbers drive the whole thing and are worth stating plainly:
 *
 *   - **40 slots a week per section** (5 days x 8 periods). Every curriculum
 *     below sums to exactly 40, because a section with spare slots is a
 *     `SLOT_UNDERFLOW` warning and 56 of them would bury the Readiness
 *     Dashboard in noise it cannot act on.
 *   - **~2,110 teacher-periods a week** once the 11/12 science merges are
 *     discounted. At a 30-period cap that is a floor of ~70 teachers working
 *     flat out; the generator targets 22 so nobody trips `TEACHER_TIGHT` at
 *     90% and the solver keeps room to manoeuvre.
 *   - **5 periods a week of third language** for classes 5-12, taught as a
 *     §4.9 split elective: one slot held open across all four sections while
 *     French, Sanskrit and German run in parallel.
 */

const SECTIONS = ["A", "B", "C", "D"];
const YEAR = "2026-27";
const CONFIG = "Main Timetable 2026-27";

/** 5 days x 8 periods. Every curriculum below must sum to exactly this. */
const WEEK = 40;
/** Target load per teacher: 73% of the 30-period cap, comfortably under the
 *  90% at which the Feasibility Engine starts warning about tightness. */
const TARGET_LOAD = 22;
/** The floor the brief asked for, even where demand does not justify it. */
const MIN_TEACHERS_PER_SUBJECT = 3;

/** Classes in teaching order, with the band that staffs them. */
/** The classes each teaching band covers — now recorded as §18 scope, not
 *  merely respected by this generator. */
const BAND_CLASSES = {
  primary: ["Pre-Nursery", "Nursery", "Class 1", "Class 2", "Class 3"],
  middle: ["Class 4", "Class 5", "Class 6", "Class 7", "Class 8"],
  senior: ["Class 9", "Class 10", "Class 11", "Class 12"],
};

const CLASSES = [
// `sequence` is the CLASS_LADDER position, not a running count — the gaps at 3
// and 4 are LKG and UKG, which this school does not run, and they are correct.
// `bandOf` and `subjectSuitsClass` compare this number against absolute ladder
// positions, so numbering 1..14 here made Class 9 read as "upper" rather than
// "senior"; and adding an LKG later handed it sequence 3, which Class 1 already
// held, which is what put the Master Grid's rows out of order.
  { name: "Pre-Nursery", sequence: 1, band: "primary", curriculum: "early" },
  { name: "Nursery", sequence: 2, band: "primary", curriculum: "early" },
  { name: "Class 1", sequence: 5, band: "primary", curriculum: "junior" },
  { name: "Class 2", sequence: 6, band: "primary", curriculum: "junior" },
  { name: "Class 3", sequence: 7, band: "primary", curriculum: "junior" },
  { name: "Class 4", sequence: 8, band: "middle", curriculum: "junior" },
  { name: "Class 5", sequence: 9, band: "middle", curriculum: "senior-primary" },
  { name: "Class 6", sequence: 10, band: "middle", curriculum: "senior-primary" },
  { name: "Class 7", sequence: 11, band: "middle", curriculum: "senior-primary" },
  { name: "Class 8", sequence: 12, band: "middle", curriculum: "senior-primary" },
  { name: "Class 9", sequence: 13, band: "senior", curriculum: "secondary" },
  { name: "Class 10", sequence: 14, band: "senior", curriculum: "secondary" },
  { name: "Class 11", sequence: 15, band: "senior", curriculum: "higher" },
  { name: "Class 12", sequence: 16, band: "senior", curriculum: "higher" },
];

/**
 * Curricula. Each sums to 40 **including** the third-language block, which is
 * NOT listed here: a section spends 5 periods on "a language", not 5 on each of
 * three, and listing French/Sanskrit/German as subjects would both double the
 * charge and demand per-section mappings the block already covers
 * (`ELECTIVE_SUBJECT_DOUBLE_COUNTED`).
 */
const CURRICULA = {
  // No third language, no science/social split — and, since one config means
  // one day shape (invariant 6), the four-year-olds get 40 periods like
  // everyone else. Filled with what four-year-olds actually do.
  early: {
    thirdLanguage: 0,
    subjects: {
      English: 8, Hindi: 6, Mathematics: 6,
      "Art & Craft": 5, "Music & Rhymes": 5, "Physical Education": 5, "Story Time": 5,
    },
  },
  junior: {
    thirdLanguage: 0,
    subjects: { English: 8, Hindi: 7, Mathematics: 8, Science: 7, "Social Science": 6, Computer: 4 },
  },
  "senior-primary": {
    thirdLanguage: 5,
    subjects: { English: 6, Hindi: 6, Mathematics: 7, Science: 7, "Social Science": 6, Computer: 3 },
  },
  // Science and Social Science split into their parts from class 9.
  secondary: {
    thirdLanguage: 5,
    subjects: {
      English: 5, Hindi: 4, Mathematics: 6,
      Physics: 4, Chemistry: 4, Biology: 4,
      History: 2, Civics: 2, Geography: 2, Economics: 1, Computer: 1,
    },
  },
  higher: {
    thirdLanguage: 5,
    subjects: {
      English: 5, Hindi: 4, Mathematics: 5,
      Physics: 5, Chemistry: 5, Biology: 5,
      Economics: 3, Computer: 3,
    },
  },
};

/** Classes 11 and 12 take the three sciences as one lesson across all four
 *  sections — one teacher, one room, four sections at once (§4.9 merged). */
const MERGED_IN_HIGHER = ["Physics", "Chemistry", "Biology"];

const LANGUAGES = ["French", "Sanskrit", "German"];

/** Only Computer is a lab subject: see the arithmetic in `rooms()` below. */
const LAB_SUBJECTS = new Set(["Computer"]);

const SUBJECT_META = {
  English: { code: "ENG" }, Hindi: { code: "HIN" }, Mathematics: { code: "MATH" },
  Science: { code: "SCI" }, "Social Science": { code: "SST" }, Computer: { code: "CS" },
  Physics: { code: "PHY" }, Chemistry: { code: "CHEM" }, Biology: { code: "BIO" },
  History: { code: "HIST" }, Civics: { code: "CIV" }, Geography: { code: "GEO" },
  Economics: { code: "ECO" }, "Art & Craft": { code: "ART" }, "Music & Rhymes": { code: "MUS" },
  "Physical Education": { code: "PE" }, "Story Time": { code: "STORY" },
  French: { code: "FRE" }, Sanskrit: { code: "SAN" }, German: { code: "GER" },
};

const FIRST_NAMES = [
  "Aarav", "Aditi", "Ananya", "Arjun", "Bhavna", "Chetan", "Deepa", "Devansh", "Divya", "Farhan",
  "Gauri", "Harsh", "Ishaan", "Jaya", "Kabir", "Kavya", "Lakshmi", "Manav", "Meera", "Naveen",
  "Neha", "Nikhil", "Pooja", "Pranav", "Priya", "Rahul", "Rakhi", "Rohan", "Sanjay", "Sarika",
  "Shalini", "Siddharth", "Sneha", "Tanvi", "Uday", "Vandana", "Varun", "Vikram", "Yash", "Zoya",
];
const LAST_NAMES = [
  "Agarwal", "Banerjee", "Chatterjee", "Desai", "Gupta", "Iyer", "Joshi", "Kapoor", "Khanna",
  "Kulkarni", "Malhotra", "Mehta", "Menon", "Nair", "Pillai", "Rao", "Reddy", "Saxena", "Sharma",
  "Singh", "Sinha", "Trivedi", "Varma", "Verma",
];

/** Deterministic names: the same run twice produces the same school. */
const nameFor = (n) => `${FIRST_NAMES[n % FIRST_NAMES.length]} ${LAST_NAMES[(n * 7) % LAST_NAMES.length]}`;

const curriculumOf = (cls) => CURRICULA[cls.curriculum];
const classSections = () => CLASSES.flatMap((c) => SECTIONS.map((s) => ({ cls: c, section: s, label: `${c.name}-${s}` })));

/**
 * Is this (class, subject) taught as one merged lesson across all four
 * sections? Only the three sciences, and only in 11 and 12.
 */
const isMerged = (cls, subject) => cls.curriculum === "higher" && MERGED_IN_HIGHER.includes(subject);

/**
 * Weekly teacher-periods per (band, subject).
 *
 * A merged lesson is taught **once** however many sections attend, which is
 * why classes 11 and 12 need three science teachers rather than twelve. An
 * elective option is likewise taught once per block.
 */
function demand() {
  const byBandSubject = new Map(); // `${band}|${subject}` -> periods
  const add = (band, subject, n) => {
    const k = `${band}|${subject}`;
    byBandSubject.set(k, (byBandSubject.get(k) ?? 0) + n);
  };

  for (const cls of CLASSES) {
    const cur = curriculumOf(cls);
    for (const [subject, periods] of Object.entries(cur.subjects)) {
      add(cls.band, subject, isMerged(cls, subject) ? periods : periods * SECTIONS.length);
    }
    if (cur.thirdLanguage > 0) {
      for (const lang of LANGUAGES) add(cls.band, lang, cur.thirdLanguage);
    }
  }
  return byBandSubject;
}

/**
 * How many teachers each (band, subject) needs.
 *
 * Sized to the work — a uniform "three per subject" would starve English and
 * Mathematics (368 and 376 periods) while over-staffing History (16) more than
 * twentyfold. The brief's floor of three is then applied per *subject*, across
 * whichever bands teach it.
 */
function staffing() {
  const d = demand();
  const perBandSubject = new Map();
  const totalBySubject = new Map();

  for (const [k, periods] of d) {
    const [, subject] = k.split("|");
    const n = Math.max(1, Math.ceil(periods / TARGET_LOAD));
    perBandSubject.set(k, n);
    totalBySubject.set(subject, (totalBySubject.get(subject) ?? 0) + n);
  }

  // Top up to the floor, adding where the demand is heaviest so the extra
  // hands land where they are most useful rather than arbitrarily.
  for (const [subject, total] of totalBySubject) {
    let short = MIN_TEACHERS_PER_SUBJECT - total;
    if (short <= 0) continue;
    const bands = [...d.entries()]
      .filter(([k]) => k.endsWith(`|${subject}`))
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => k);
    for (let i = 0; short > 0; i++, short--) {
      const k = bands[i % bands.length];
      perBandSubject.set(k, perBandSubject.get(k) + 1);
    }
  }
  return { perBandSubject, demand: d };
}

module.exports = {
  BAND_CLASSES,
  SECTIONS, YEAR, CONFIG, WEEK, TARGET_LOAD, CLASSES, CURRICULA, LANGUAGES,
  LAB_SUBJECTS, SUBJECT_META, MERGED_IN_HIGHER,
  nameFor, curriculumOf, classSections, isMerged, demand, staffing,
};
