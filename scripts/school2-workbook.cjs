/**
 * Turns `school2-model.cjs` into the §16 import workbook.
 *
 * Sheet names, column headers and order all come from the shared contract, so
 * this cannot drift from what the importer expects: if a column is renamed
 * there, the file this writes changes with it.
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const ExcelJS = req("exceljs");
const { SHEETS } = require("/app/packages/shared/dist/cjs/index.js");

const M = require("./school2-model.cjs");

/** Cap for packing — 86% of the 30-period week, under the 90% tightness line. */
const LOAD_CAP = 26;

/**
 * Assign every teaching job to a person.
 *
 * Jobs are placed heaviest-first onto the least-loaded teacher who can still
 * take them. Heaviest-first matters: an 8-period job offered last has nowhere
 * to go once everyone sits at 20, and the run would end with an unassignable
 * remainder rather than an even spread.
 */
function assign() {
  const { perBandSubject } = M.staffing();
  const teachers = [];
  const byBandSubject = new Map(); // `${band}|${subject}` -> teacher[]
  let n = 0;

  for (const [key, count] of [...perBandSubject.entries()].sort()) {
    const [band, subject] = key.split("|");
    const list = [];
    for (let i = 0; i < count; i++) {
      const t = {
        employeeCode: `EDX-${String(1000 + n).padStart(4, "0")}`,
        name: M.nameFor(n),
        band,
        subject,
        load: 0,
        jobs: [],
      };
      n++;
      teachers.push(t);
      list.push(t);
    }
    byBandSubject.set(key, list);
  }

  const take = (band, subject, periods) => {
    const pool = byBandSubject.get(`${band}|${subject}`) ?? [];
    const fits = pool.filter((t) => t.load + periods <= LOAD_CAP).sort((a, b) => a.load - b.load);
    const chosen = fits[0] ?? [...pool].sort((a, b) => a.load - b.load)[0];
    if (!chosen) throw new Error(`No ${subject} teacher available in the ${band} band`);
    chosen.load += periods;
    return chosen;
  };

  // ---- ordinary and merged subject teaching ----
  const mappings = []; // { employeeCode, subjectName, classSections[], periodsPerWeek, room, merged }
  const jobs = [];
  for (const cls of M.CLASSES) {
    const cur = M.curriculumOf(cls);
    for (const [subject, periods] of Object.entries(cur.subjects)) {
      if (M.isMerged(cls, subject)) {
        jobs.push({ cls, subject, periods, merged: true, sections: [...M.SECTIONS] });
      } else {
        for (const s of M.SECTIONS) jobs.push({ cls, subject, periods, merged: false, sections: [s] });
      }
    }
  }
  jobs.sort((a, b) => b.periods - a.periods);
  for (const j of jobs) {
    const t = take(j.cls.band, j.subject, j.periods);
    t.jobs.push(j);
  }

  // ---- third-language blocks: one teacher per option per class ----
  const blocks = [];
  for (const cls of M.CLASSES) {
    const cur = M.curriculumOf(cls);
    if (cur.thirdLanguage === 0) continue;
    const options = M.LANGUAGES.map((lang, i) => {
      const t = take(cls.band, lang, cur.thirdLanguage);
      return { language: lang, teacher: t, roomIndex: i };
    });
    blocks.push({ cls, periodsPerWeek: cur.thirdLanguage, options });
  }

  // ---- collapse each teacher's jobs into as few mapping rows as possible ----
  for (const t of teachers) {
    const grouped = new Map(); // `${subject}|${periods}|${merged}|${clsName}` -> sections[]
    for (const j of t.jobs) {
      // Merged rows stay per class: one group is one lesson for one class.
      const k = j.merged
        ? `${j.subject}|${j.periods}|merged|${j.cls.name}`
        : `${j.subject}|${j.periods}|single|`;
      const list = grouped.get(k) ?? [];
      list.push(...j.sections.map((s) => `${j.cls.name}-${s}`));
      grouped.set(k, list);
    }
    for (const [k, sections] of grouped) {
      const [subject, periods, kind, clsName] = k.split("|");
      mappings.push({
        employeeCode: t.employeeCode,
        subjectName: subject,
        classSections: sections,
        periodsPerWeek: Number(periods),
        // Four sections in one lesson need somewhere that holds them; ordinary
        // lessons stay in their own classroom and need no room constraint.
        room: kind === "merged" ? (clsName === "Class 11" ? "Senior Hall 1" : "Senior Hall 2") : null,
        merged: kind === "merged",
      });
    }
  }

  return { teachers, mappings, blocks };
}

/** Every class-section in teaching order, with the home room it is given. */
function sections() {
  const out = [];
  let roomNo = 0;
  for (const cls of M.CLASSES) {
    for (const s of M.SECTIONS) {
      roomNo++;
      out.push({ cls, section: s, label: `${cls.name}-${s}`, homeRoom: `Room ${roomNo}` });
    }
  }
  return out;
}

function buildRows() {
  const { teachers, mappings, blocks } = assign();
  const secs = sections();
  const homeRoomsOf = (cls) => secs.filter((x) => x.cls.name === cls.name).map((x) => x.homeRoom);

  const subjectNames = new Set();
  for (const cls of M.CLASSES) {
    for (const s of Object.keys(M.curriculumOf(cls).subjects)) subjectNames.add(s);
    if (M.curriculumOf(cls).thirdLanguage > 0) for (const l of M.LANGUAGES) subjectNames.add(l);
  }

  // Computer is the only lab subject, and the sums say why: 144 lab periods a
  // week against 5 labs x 40 slots = 200 is 72%, under the 80% at which the
  // engine warns. Marking the three sciences as labs too would need 368
  // periods and twelve labs — and would count the 11/12 merges four times
  // over, once per section, which is a limitation of the check rather than a
  // real demand.
  const rooms = [
    // §19: each section's own room, named from this side of the relation so the
    // file reads the way a school thinks — "Room 12 is Class 1-A's".
    ...secs.map((s) => ({
      name: s.homeRoom, roomType: "classroom", capacity: 40, isShared: "No",
      homeFor: s.label, subjectNames: "",
    })),
    // The computer labs teach Computer and nothing else, so a Computer period
    // can only ever land in one of these five.
    ...[1, 2, 3, 4, 5].map((i) => ({
      name: `Computer Lab ${i}`, roomType: "lab", capacity: 40, isShared: "Yes",
      homeFor: "", subjectNames: "Computer",
    })),
    { name: "Senior Hall 1", roomType: "auditorium", capacity: 160, isShared: "Yes", homeFor: "", subjectNames: "" },
    { name: "Senior Hall 2", roomType: "auditorium", capacity: 160, isShared: "Yes", homeFor: "", subjectNames: "" },
  ];

  const curriculum = [];
  for (const cls of M.CLASSES) {
    for (const [subject, periods] of Object.entries(M.curriculumOf(cls).subjects)) {
      curriculum.push({
        className: cls.name,
        // Phase 19: the curriculum is per session, like the class-sections.
        academicYear: M.YEAR,
        subjectName: subject,
        periodsPerWeek: periods,
        // A subject of 6 periods over 5 days needs 2/day to be placeable at
        // all; giving everything substantial the same headroom keeps the
        // solver's domain wide without loosening anything that matters.
        maxPeriodsPerDay: periods >= 4 ? 2 : 1,
        samePeriodAcrossWeek: "No",
        consecutiveBlockSize: 1,
        consecutiveBlocksPerWeek: "",
      });
    }
  }

  // One class teacher per section, drawn from someone who actually teaches it.
  const classTeachers = secs.map((s) => {
    const owner = mappings.find((m) => !m.merged && m.classSections.includes(s.label));
    return { classSection: s.label, employeeCode: owner ? owner.employeeCode : teachers[0].employeeCode };
  });

  // The options meet in three of their own class's rooms — the students come
  // from those very sections, so the rooms are free by construction and no
  // extra language rooms are needed.
  const electives = blocks.flatMap((b) => {
    const homeRooms = homeRoomsOf(b.cls);
    return b.options.map((o) => ({
      blockName: `${b.cls.name} Third Language`,
      classSections: M.SECTIONS.map((s) => `${b.cls.name}-${s}`),
      periodsPerWeek: b.periodsPerWeek,
      maxPeriodsPerDay: 1,
      subjectName: o.language,
      employeeCode: o.teacher.employeeCode,
      room: homeRooms[o.roomIndex],
    }));
  });

  return {
    "Academic Years": [{ name: M.YEAR, startDate: "2026-04-01", endDate: "2027-03-31", isActive: "Yes" }],
    Classes: M.CLASSES.map((c) => ({ name: c.name, sequence: c.sequence })),
    "Class Sections": secs.map((s) => ({
      className: s.cls.name, sectionName: s.section, academicYear: M.YEAR,
      strength: 35, homeRoom: s.homeRoom, timetable: M.CONFIG,
    })),
    Rooms: rooms,
    Subjects: [...subjectNames].map((name) => ({
      name,
      code: M.SUBJECT_META[name]?.code ?? "",
      isLab: M.LAB_SUBJECTS.has(name) ? "Yes" : "No",
      requiresDoublePeriod: "No",
    })),
    Teachers: teachers.map((t) => ({
      employeeCode: t.employeeCode, name: t.name,
      maxPeriodsPerDay: 6,
      // §20: a teacher comes in for a proper day or not at all. 3 is the app
      // default; stated here so the workbook shows what the rule will be.
      minPeriodsPerDay: 3,
      maxPeriodsPerWeek: 30,
      classTeacherPeriodRule: "none", periodPattern: "every_period",
      alternateDaySet: "",
      // §18: the band this teacher was staffed into, now recorded as a rule
      // the app enforces rather than a convention of this script.
      classNames: M.BAND_CLASSES[t.band].join(", "),
      employmentType: "permanent",
      isActive: "Yes",
    })),
    "Teacher Unavailability": [],
    Curriculum: curriculum,
    "Class Teachers": classTeachers,
    "Subject Mapping": mappings.map((m) => ({
      employeeCode: m.employeeCode, subjectName: m.subjectName,
      classSections: m.classSections.join(", "), periodsPerWeek: m.periodsPerWeek,
      room: m.room ?? "", merged: m.merged ? "Yes" : "No",
    })),
    Electives: electives.map((e) => ({ ...e, classSections: e.classSections.join(", ") })),
    _stats: { teachers, mappings, blocks, sections: secs },
  };
}

/** Write the workbook, headers straight from the contract. */
async function writeWorkbook(path) {
  const rows = buildRows();
  const wb = new ExcelJS.Workbook();
  wb.creator = "EduTimetable generator";

  for (const sheet of SHEETS) {
    const data = rows[sheet.name];
    if (!data) continue;
    const ws = wb.addWorksheet(sheet.name);
    ws.addRow(sheet.columns.map((c) => c.header));
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: "frozen", ySplit: 1 }];
    sheet.columns.forEach((c, i) => { ws.getColumn(i + 1).width = c.width ?? 16; });
    for (const r of data) {
      ws.addRow(sheet.columns.map((c) => {
        const v = r[c.key];
        return v === null || v === undefined ? "" : v;
      }));
    }
  }
  await wb.xlsx.writeFile(path);
  return rows._stats;
}

module.exports = { buildRows, writeWorkbook, LOAD_CAP };
