# AI-Powered School Timetable Generation System
## Complete Architecture, Algorithm, Data Model & UI Specification

---

## 1. Design Philosophy — Why "100% generation" is actually achievable

Most timetable tools fail at 100% auto-generation for one reason: they run the solver **before** checking whether a valid solution can even exist mathematically. Your requirement of "always 100%" is achievable only if we split the system into two hard phases:

**Phase A — Feasibility Engine (runs before any slot is placed).**
This is a pure arithmetic/graph check that proves whether the input data (as currently entered) *can* produce a complete, conflict-free timetable. If not, it tells the user exactly what to fix — a specific teacher, a specific class-section, a specific subject — before the algorithm even attempts generation. This is what makes the system feel "intelligent from the first click," and it's what guarantees the solver phase never fails silently.

**Phase B — Constraint Solver (runs only after Phase A passes).**
A CSP (Constraint Satisfaction Problem) solver with backtracking + heuristics + local-search repair, formulated so that a solution is mathematically guaranteed to exist because Phase A already proved it exists.

This two-phase split is the single most important architectural decision — everything below is built around it.

---

## 2. High-Level System Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                          CLIENT (React + TS)                          │
│  Setup Wizard | Allocation Matrix | Drag-Drop Board | Reports | Subst. │
└───────────────┬─────────────────────────────────────┬─────────────────┘
                │  REST/GraphQL                        │ WebSocket (live conflict
                ▼                                       │  checks, notifications)
┌──────────────────────────────────────────────────────┴────────────────┐
│                        APPLICATION LAYER (Node.js)                     │
│ ┌───────────────┐ ┌───────────────┐ ┌───────────────┐ ┌─────────────┐ │
│ │ Config Service │ │ Feasibility   │ │ Solver Engine │ │ Substitute  │ │
│ │ (masters, CRUD)│ │ Engine        │ │ (CSP + repair)│ │ Engine      │ │
│ └───────────────┘ └───────────────┘ └───────────────┘ └─────────────┘ │
│ ┌───────────────┐ ┌───────────────┐ ┌───────────────┐ ┌─────────────┐ │
│ │ Validation /   │ │ Draft/Publish │ │ Notification  │ │ Report      │ │
│ │ Conflict Rules │ │ Manager       │ │ Engine        │ │ Generator   │ │
│ └───────────────┘ └───────────────┘ └───────────────┘ └─────────────┘ │
└───────────────┬──────────────────────────────────────────────────────┘
                ▼
┌──────────────────────────────────────────────────────────────────────┐
│  DATA LAYER: MySQL/Postgres (relational core) + Redis (solver cache,  │
│  in-progress draft locks) + Job Queue (BullMQ) for async solver runs   │
└──────────────────────────────────────────────────────────────────────┘
```

**Why a separate Solver Engine as a service/worker, not inline in the API:** generation for 50 class-sections × 40 slots (2,000 slots) with full constraint checking is CPU-heavy. It must run as a background job (queued via BullMQ/Redis), streaming progress back over WebSocket so the UI can show "Generating... 1,340 / 2,000 slots placed" with live status — this is also your "tell the user what's happening at every moment" requirement.

**Tech stack recommendation** (matches your existing Edunext stack — React + Node.js + MySQL):
- Frontend: React + TypeScript, `@dnd-kit` (drag-and-drop, better than react-beautiful-dnd for grid-based boards), Zustand/Redux for the in-memory timetable grid state, TailwindCSS
- Backend: Node.js (NestJS recommended for the module boundaries you need), MySQL 8 (or Postgres if you want native `EXCLUDE` constraints for double-booking prevention), Redis + BullMQ for the solver job queue
- Solver: pure Node/TypeScript (no need for external OR-tools unless you want to — see §5.6 on when to graduate to Google OR-Tools CP-SAT)
- Realtime: Socket.IO for solver progress + live conflict alerts during manual drag-drop
- **Runtime environment: Docker only.** All development, testing, and deployment runs in containers — a Docker Compose stack (api, web, solver worker, MySQL 8, Redis) is the only supported way to run the system. Nothing (Node, MySQL, Redis) is ever installed on the host; every command (install, migrate, test, lint) executes inside its container. Dev and production use the same images (multi-stage Dockerfiles; dev adds bind mounts + hot reload), so environment parity is guaranteed from day one.

---

## 3. Data Model (Core Schema)

Below is the relational core. Every table that participates in conflict-checking has been designed so a **single unique index enforces uniqueness at the database level** — this is your strongest guarantee against double-booking, stronger than any application code.

```sql
-- ===================== MASTERS =====================

CREATE TABLE academic_years (
  id INT PRIMARY KEY AUTO_INCREMENT,
  school_id INT NOT NULL,
  name VARCHAR(20),              -- '2026-27'
  start_date DATE, end_date DATE,
  is_active BOOLEAN DEFAULT TRUE
);

CREATE TABLE classes (
  id INT PRIMARY KEY AUTO_INCREMENT,
  school_id INT NOT NULL,
  name VARCHAR(20),              -- 'Class 5'
  sequence INT                   -- for sort order I..XII
);

CREATE TABLE sections (
  id INT PRIMARY KEY AUTO_INCREMENT,
  class_id INT NOT NULL REFERENCES classes(id),
  name VARCHAR(10)                -- 'A','B'...
);

CREATE TABLE class_sections (       -- the 50 "class-section" units
  id INT PRIMARY KEY AUTO_INCREMENT,
  class_id INT NOT NULL REFERENCES classes(id),
  section_id INT NOT NULL REFERENCES sections(id),
  academic_year_id INT NOT NULL,
  home_room_id INT REFERENCES rooms(id),   -- default/home classroom
  strength INT,                             -- student count (for room-capacity checks)
  class_teacher_id INT NULL REFERENCES teachers(id),
  UNIQUE KEY uq_cs (class_id, section_id, academic_year_id)
);

CREATE TABLE rooms (
  id INT PRIMARY KEY AUTO_INCREMENT,
  school_id INT NOT NULL,
  name VARCHAR(50),               -- 'Room 204', 'Science Lab 1'
  capacity INT,
  room_type ENUM('classroom','lab','sports','music','art','auditorium','other'),
  is_shared BOOLEAN DEFAULT FALSE  -- shared special rooms (labs) need their own conflict check
);

CREATE TABLE subjects (
  id INT PRIMARY KEY AUTO_INCREMENT,
  school_id INT NOT NULL,
  name VARCHAR(50),
  code VARCHAR(10),
  is_lab BOOLEAN DEFAULT FALSE,        -- requires special room
  requires_double_period BOOLEAN DEFAULT FALSE
);

CREATE TABLE teachers (
  id INT PRIMARY KEY AUTO_INCREMENT,
  school_id INT NOT NULL,
  employee_code VARCHAR(20),
  name VARCHAR(100),
  max_periods_per_day INT DEFAULT 6,
  max_periods_per_week INT DEFAULT 30,
  wants_alternate_periods BOOLEAN DEFAULT FALSE,   -- gap-preference
  min_gap_between_periods INT DEFAULT 0,           -- if alternate-period mode
  is_active BOOLEAN DEFAULT TRUE
);

-- weekly-off / part-time availability per teacher (defaults to all-available)
CREATE TABLE teacher_unavailability (
  id INT PRIMARY KEY AUTO_INCREMENT,
  teacher_id INT NOT NULL REFERENCES teachers(id),
  day_of_week TINYINT,             -- 1=Mon..7=Sun
  period_id INT NULL REFERENCES periods(id),  -- NULL = whole day unavailable
  reason VARCHAR(100)
);

-- ===================== MAPPINGS =====================

-- which subject applies to which class, in which session (curriculum)
CREATE TABLE class_subjects (
  id INT PRIMARY KEY AUTO_INCREMENT,
  class_id INT NOT NULL REFERENCES classes(id),
  academic_year_id INT NOT NULL REFERENCES academic_years(id),  -- §3.11
  subject_id INT NOT NULL REFERENCES subjects(id),
  periods_per_week INT NOT NULL,        -- e.g. English = 6 periods/week
  max_periods_per_day INT DEFAULT 1,    -- prevents same subject twice same day unless intended
  same_period_across_week BOOLEAN DEFAULT FALSE,  -- "same subject same period every day" rule
  UNIQUE KEY uq_class_subject (class_id, subject_id, academic_year_id)
);

-- which teacher teaches which subject, in which class-section (the core mapping)
CREATE TABLE teacher_subject_class_section (
  id INT PRIMARY KEY AUTO_INCREMENT,
  teacher_id INT NOT NULL REFERENCES teachers(id),
  subject_id INT NOT NULL REFERENCES subjects(id),
  class_section_id INT NOT NULL REFERENCES class_sections(id),
  periods_per_week INT NOT NULL,        -- usually = class_subjects.periods_per_week, but
                                         -- allows split-teaching (2 teachers share a subject)
  preferred_room_id INT NULL REFERENCES rooms(id),
  UNIQUE KEY uq_tscs (subject_id, class_section_id)  -- one subject-teacher per class-section
                                                       -- (relax if co-teaching is allowed)
);

-- ===================== TIMETABLE CONFIGURATION =====================

CREATE TABLE timetable_config (
  id INT PRIMARY KEY AUTO_INCREMENT,
  school_id INT NOT NULL,
  academic_year_id INT NOT NULL,
  name VARCHAR(50),                       -- 'Primary Wing 2026-27'
  working_days JSON,                      -- ["MON","TUE","WED","THU","FRI"]
  periods_per_day INT,
  period_duration_mins INT,
  has_zero_period BOOLEAN DEFAULT FALSE,
  zero_period_duration_mins INT,
  allow_consecutive_periods BOOLEAN DEFAULT TRUE,  -- e.g. double lab periods
  class_teacher_gets_first_period BOOLEAN DEFAULT FALSE,
  status ENUM('draft','active','archived') DEFAULT 'draft'
);

CREATE TABLE periods (                    -- the physical period grid, one row per slot-in-day
  id INT PRIMARY KEY AUTO_INCREMENT,
  timetable_config_id INT NOT NULL,
  period_number INT,                      -- 0 (zero period), 1, 2, 3...
  start_time TIME,
  end_time TIME,
  is_break BOOLEAN DEFAULT FALSE,
  break_name VARCHAR(30)                  -- 'Short Break','Lunch'
);

CREATE TABLE holidays (
  id INT PRIMARY KEY AUTO_INCREMENT,
  academic_year_id INT NOT NULL,
  date DATE,
  name VARCHAR(100),
  applies_to ENUM('all','class_group') DEFAULT 'all'
);

-- ===================== THE TIMETABLE ITSELF =====================
-- This single table IS the 2,000-slot matrix in your example.
-- A slot = (class_section_id, day_of_week, period_id) — enforced unique.
-- A teacher can appear only once per (day_of_week, period_id) — enforced unique.
-- A room can appear only once per (day_of_week, period_id) unless is_shared=0 — enforced unique.

CREATE TABLE timetable_slots (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  timetable_config_id INT NOT NULL,
  status ENUM('draft','published') DEFAULT 'draft',
  class_section_id INT NOT NULL REFERENCES class_sections(id),
  day_of_week TINYINT NOT NULL,
  period_id INT NOT NULL REFERENCES periods(id),
  subject_id INT NULL REFERENCES subjects(id),   -- NULL = free/unallocated
  teacher_id INT NULL REFERENCES teachers(id),
  room_id INT NULL REFERENCES rooms(id),
  is_locked BOOLEAN DEFAULT FALSE,     -- user manually pinned this slot; solver must not touch it
  source ENUM('auto','manual','substitute') DEFAULT 'auto',

  UNIQUE KEY uq_class_slot   (timetable_config_id, status, class_section_id, day_of_week, period_id),
  UNIQUE KEY uq_teacher_slot (timetable_config_id, status, teacher_id, day_of_week, period_id),
  UNIQUE KEY uq_room_slot    (timetable_config_id, status, room_id, day_of_week, period_id)
);
-- NOTE: the two uniqueness constraints above are your absolute, database-enforced
-- guarantee that "no teacher can ever be in two places" and "no two subjects can
-- ever occupy the same class slot" — even if application logic has a bug, MySQL itself
-- will reject the insert.

CREATE TABLE substitution_log (
  id INT PRIMARY KEY AUTO_INCREMENT,
  timetable_slot_id BIGINT NOT NULL REFERENCES timetable_slots(id),
  original_teacher_id INT NOT NULL,
  substitute_teacher_id INT NOT NULL,
  date DATE NOT NULL,                  -- substitution is date-specific, not permanent
  reason VARCHAR(100),
  created_by INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE teacher_absences (
  id INT PRIMARY KEY AUTO_INCREMENT,
  teacher_id INT NOT NULL,
  date DATE NOT NULL,
  reason VARCHAR(100),
  status ENUM('reported','substitutes_assigned','resolved') DEFAULT 'reported'
);
```

**Why `status ENUM('draft','published')` lives inside `timetable_slots` rather than being two separate tables:** your requirement is "create draft first, then publish into main table." Keeping them in one table with a status flag (rather than copying rows between two tables) means the unique constraints, the solver, and the drag-drop UI all work against one schema. "Publish" becomes a single transaction: `UPDATE timetable_slots SET status='published' WHERE status='draft' AND timetable_config_id=X`, after archiving/superseding the previous published set.

### 3.10 Multi-Timetable Support (independent configs per wing)

A single school routinely needs several timetables running side by side — LKG–2 starting later on a shorter day, Class 3–5 on a standard day, Class 6–10 on the longest day with its own zero period. This isn't an edge case to bolt on later; `timetable_config` (§3) is already the unit that carries name, description, and its own working days/periods/breaks/zero-period/timings, so the model just needs two more things to make multiple *independent, concurrently-active* timetables first-class:

```sql
ALTER TABLE timetable_config ADD COLUMN description TEXT NULL;
ALTER TABLE timetable_config ADD COLUMN start_time TIME NOT NULL DEFAULT '08:00';
ALTER TABLE timetable_config ADD COLUMN end_time TIME NULL;   -- generated/cached, see below
-- periods.start_time / periods.end_time (already in §3) are computed from
-- timetable_config.start_time + Σ(period durations + break durations + zero-period
-- duration up to that point) — recalculated server-side whenever the structure changes,
-- and mirrored to timetable_config.end_time so list/summary screens don't need to
-- re-derive it from the full periods table every time.

ALTER TABLE class_sections ADD COLUMN timetable_config_id INT NOT NULL REFERENCES timetable_config(id);
-- the scoping rule: a class-section belongs to exactly ONE timetable_config.
-- This single FK is what makes "Classes covered by this timetable" a real,
-- enforced constraint rather than a UI convention — the setup wizard's class-picker
-- for a new/edited timetable simply queries which class_sections have this
-- timetable_config_id (or NULL, meaning unassigned) and disables any class-section
-- already claimed by a different timetable_config, showing that timetable's name.
```

**Break placement** (`periods.is_break` rows, §3) already supports "break after period N, for M minutes" per config — each break is just a row inserted into that `timetable_config`'s period sequence with `is_break = true`, positioned between the two periods it separates. Zero period is the same mechanism at the boundary: a `period_number = 0` row placed before (or, if configured, immediately after) `period_number = 1`, flagged separately from ordinary subject periods so it's excluded from subject-load totals (§4.1) but still occupies real wall-clock time for the computed end time.

**Cross-wing teachers:** a teacher who teaches in more than one timetable (e.g. a Class 2 art teacher who also covers Class 6 art) is mapped via `teacher_subject_class_section` rows that point at class-sections in *different* `timetable_config`s — this is allowed by design (the table has no config-scoping of its own). The Feasibility Engine's Check 2 (§4.2) sums that teacher's `periods_per_week` **across every timetable_config they appear in *within the same academic year***, not per-config in isolation, so a teacher can never be silently over-loaded just because the overload is split across two wings' configs. The Readiness Dashboard for either wing surfaces the same blocker, with a note naming the other timetable involved.

The academic-year qualifier is load-bearing (§3.11): a teacher's periods in *next* session's timetable do not consume *this* session's capacity. Without it a school that had rolled over into a new year counted every teacher twice, and Check 2 failed for the entire staff before anybody had touched the new timetable.

**Solver scope:** Phase B (§5) solves one `timetable_config` at a time — its variable set is exactly the class-sections scoped to that config — so Middle Wing can be regenerated, edited, and published independently of Senior Wing without touching its slots. `timetable_slots.timetable_config_id` (already the leading column in every unique key in §3) is what makes this safe: two configs' slots never collide in the uniqueness checks even if, coincidentally, they'd otherwise land on the same `(day, period)` — because their teachers, rooms, and class-sections are typically disjoint by wing, and where they aren't (the cross-wing teacher case above), the load-sum check in §4.2 is what catches it, not the slot-uniqueness constraint.

### 3.11 The Academic Year is Part of the Curriculum (Phase 19)

`class_subjects` is keyed **(class_id, subject_id, academic_year_id)**. It was originally keyed on class and subject alone, with no year dimension at all — so a single row served every session the school had ever run, and editing Class 5's periods/week for 2026-27 silently rewrote what 2025-26's readiness report said about the same class. No school hit it, because every school shipped so far runs one academic year.

Cloning a timetable into a new session (§3.12) makes two live years the ordinary case rather than a curiosity, so the year joins the key. Three consequences, each of which was a real defect before:

1. **The snapshot filters by year.** `buildFeasibilitySnapshot` selects only the config's own `academic_year_id`. This is what keeps the engines untouched: `solver/variables.ts` keys subject requirements by `classId:subjectId` in a plain `Map`, so two sessions' rows reaching the snapshot would collapse to whichever loaded last — timetabling the wrong syllabus with no error anywhere.
2. **Cross-config teacher load is same-year only** (§3.10 above).
3. **Weekly capacity is capped by the session's own week.** `capacityForClass` takes the year; a class has sections in every session it has ever run, so without it a 2026-27 curriculum entry was capped by whichever session happened to have the shortest day — including ones long finished — and the rejection named that session's timetable.

**The year is required on write, never inferred.** `POST /class-subjects` and the importer's Curriculum sheet both demand it rather than defaulting to the school's active year: a curriculum row filed against the wrong session is invisible until the timetable comes out wrong, and the importer loads hundreds of them at once. Reads are the opposite — `GET /class-subjects` takes the year as an *optional* filter, because reading every session is merely noisy. The Curriculum screen supplies it from the timetable already chosen in the top bar; there is deliberately no second selector, since two ways to say which session you mean is two ways to disagree.

`PUT /class-subjects/:id` cannot move a row between sessions — that is a re-key, not an edit.

Scoped by academic year rather than by timetable config on purpose: what Class 5 studies is a property of the session, not of whichever wing timetables it. A class whose sections are split across two configs in one year correctly shares one curriculum.

### 3.12 Cloning a Timetable into a New Session (Phase 19)

A school does not rebuild its timetable from nothing every April. Next session has the same classes, the same syllabus and very nearly the same staffing; what changes is a handful of rows. On the reference school, cloning carries **637 rows** — 11 periods, 56 class-sections with their home rooms and class teachers, 100 curriculum rows, **376 subject mappings**, 6 merged groups, and 8 elective blocks with 24 options — computed in 152 ms.

**`POST /timetable-configs/:id/clone/preview`** and **`POST /timetable-configs/:id/clone`**, both `masters.manage`.

**The rule: copy the inputs, never the outputs.** Config settings, periods, class-sections, curriculum, mappings, merged groups and elective blocks are copied. `timetable_slots`, `timetable_drafts` and `timetable_publications` are not — the admin adjusts and presses Generate, which is what they were going to do anyway. That also keeps the whole feature clear of the §22 `draft_scope` unique-key machinery, which is where the risk would otherwise be.

Also deliberately not copied, each for its own reason: **extra classes** (§18 — they run on dates, and next session's revision class is not this session's), **holidays** (a property of the year), **absences and substitutions** (dated events), **auto-fix runs** (an audit trail of what somebody did to *that* config).

**The whole algorithm is one map.** `class_sections` is keyed (class, section, academic_year), so cloning into a new session mints new section rows; build `oldSectionId → newSectionId` once and every dependent table is a straight re-point. Teachers, subjects and rooms are school-wide and carry over unchanged, which is what makes this tractable.

**A different session, always.** A class-section belongs to one session and one timetable (§3.10), so one session cannot hold two copies of it — a same-session clone is refused, pointing at named drafts (§22) as the tool for trying alternative *placements* within a session. Cloning varies the inputs; drafts vary the arrangement.

**The preview writes nothing** — not even the target academic year, which the commit path alone mints. The commit recomputes the plan from the database and acts only on its own findings; the request names the source and the target session, never the rows to write (the rule §21's auto-resolve follows).

**Staffing that cannot come across is dropped and reported by name.** A teacher who is inactive, or a `guest` holding regular curriculum (§18 forbids it), has their lessons left out. Dropped rather than copied on purpose: the curriculum row still records that Class 5-A needs six periods of English, so Readiness says "no teacher for English in 5-A" — the actionable sentence — whereas a copied dead mapping says nothing until Generate fails. A §18 **eligibility** breach is warned about but *not* dropped: unlike a departure, that is a declared scope the admin can simply widen, and dropping would lose a real teaching assignment.

The clone always arrives with `status = 'draft'`: it has not been generated, let alone checked, so it must not wear the source's `active` badge.

**Sessions must be visibly apart afterwards.** Cloning is what makes duplicate-looking rows normal, so the three list screens that would otherwise show two sessions at once take an optional `academicYearId`: `GET /class-subjects` (§3.11), `GET /mappings`, and `GET /elective-blocks`. Each screen supplies it from the timetable already chosen in the top bar. Without this the Teacher Mapping screen shows "Class 5-A · English · Mrs Rao" twice with nothing to tell the rows apart, and the Electives screen shows "Class 5 Third Language" twice — a feature that breaks the screens it feeds is not finished.

---

## 4. Phase A — The Feasibility Engine (the "always 100%" guarantee)

This runs the instant the user finishes data entry (and re-runs live as they edit masters), **before** offering the "Generate Timetable" button. It performs six checks, each mapped directly to a specific, actionable error message — this is your "tell the user what's wrong" requirement.

### 4.1 Check 1 — Slot Capacity per Class-Section
```
available_slots(class_section) = working_days × periods_per_day  (e.g. 5 × 8 = 40)
required_slots(class_section)  = Σ periods_per_week over all class_subjects mapped to that class

IF required_slots > available_slots:
   ERROR: "Class 5-A needs 44 periods/week but only 40 slots exist.
            Reduce subject periods or increase periods/day for this class,
            or move [Art: 2, Music: 2] to a different config group."
IF required_slots < available_slots:
   WARNING: "Class 5-A has 3 free slots/week — mark them as Library/Study
             period or add more subject periods."
```

### 4.2 Check 2 — Teacher Weekly Load Capacity
```
For each teacher T:
   demand(T) = Σ periods_per_week across every teacher_subject_class_section row for T
   capacity(T) = MIN(teacher.max_periods_per_week, working_days × periods_per_day)

IF demand(T) > capacity(T):
   ERROR: "Mrs. Sharma is assigned 34 periods/week across 6 sections but her
            max load is 30. Over by 4 periods — reassign [8-C English: 4 periods]
            to another teacher, or raise her max load."
```
This is the single most common real-world timetabling failure (a teacher over-assigned across sections), and it's O(1) to detect before generation — this is exactly the check that lets you promise "100%": if this check passes for every teacher and Check 1 passes for every class-section, a feasible full allocation is *mathematically guaranteed to exist* by Hall's Marriage Theorem for the underlying bipartite graph (teachers × slots), **provided also that Check 3 (daily distribution) and Check 5 (shared-room contention) pass** — see below, because raw weekly totals fitting doesn't guarantee a valid *daily* distribution exists.

### 4.3 Check 3 — Daily Distribution Feasibility
A subject needing 6 periods/week across a 5-day week must have `max_periods_per_day` set high enough to be placeable — e.g., 6 periods over 5 days needs at least one day with 2 periods. The engine auto-suggests the minimum viable spread:
```
min_days_needed = ceil(periods_per_week / max_periods_per_day)
IF min_days_needed > working_days:
   ERROR: "English needs 6 periods/week but max 1/day means it needs 6 days;
           you only have 5. Either allow 2 periods on one day, or reduce to 5/week."
```

### 4.4 Check 4 — Teacher Cross-Section Daily Overlap Pre-Check
For a teacher teaching in multiple class-sections, verify no single day requires more simultaneous placements than periods available that day (basic pigeonhole check), and flag teachers whose assigned sections' *combined* daily period requirement leaves the solver too little slack (a "tightness score" — teachers above 90% utilization on a given day are flagged as **at risk of unsolvable local conflicts** even though global weekly totals are fine).

### 4.5 Check 5 — Shared/Special Room Contention
```
For each period slot, count how many class-sections need a lab/special room simultaneously.
IF demand > number_of_such_rooms available at that time:
   WARNING: "3 sections need Science Lab in Period 4 on Monday but you have
             only 2 labs — the algorithm will need to spread these across
             different periods; confirm this is acceptable or add a lab."
```

### 4.6 Check 6 — Structural Constraint Conflicts
Detects contradictory rules before they silently fail the solver, e.g.:
- Class teacher must always take Period 1 of their own class, but the class teacher is *also* mapped to teach another section in the same Period 1 slot for every day → structural deadlock, flagged with the exact two rows in conflict.
- `same_period_across_week = true` for a subject that only has 3 periods/week in a 5-day week (which specific 3 days? the engine asks the user to pick, rather than guessing).

### 4.7 Teacher-Level Placement Configuration (hard constraints, never bypassed by the solver)

Your requirement is explicit: these are **per-teacher settings**, they are **optional** (default = no restriction), and once set, the **algorithm must never override them** — they are hard constraints, not preferences the solver can trade off. Extend `teachers` with:

> **Note on `class_teacher_period_rule` specifically:** this field only says *how* a teacher behaves once they *are* a class teacher — it does not by itself make them one anywhere. That's a separate, explicit step: assigning a teacher to `class_sections.class_teacher_id` (§3) for a given section, done on the **Class Teacher Assignments** screen (§8.1b). Domain pruning for `always_first_period` runs against whichever section(s) that teacher is actually assigned to, looked up from `class_sections.class_teacher_id`, not against any section they merely teach a subject in.

```sql
ALTER TABLE teachers ADD COLUMN class_teacher_period_rule
    ENUM('none','always_first_period','random') DEFAULT 'none';
    -- 'none'              → this teacher's class-teacher status has no bearing on period placement
    -- 'always_first_period' → HARD: Period 1 of their own class-section MUST be this teacher,
    --                          and this teacher MUST NOT be placed in Period 1 of any OTHER
    --                          class-section (so they're never double-booked at P1)
    -- 'random'            → their own class's P1 is unrestricted; solver places normally

ALTER TABLE teachers ADD COLUMN period_pattern
    ENUM('every_period','alternate_period','alternate_day') DEFAULT 'every_period';
    -- 'every_period'     → no gap restriction (default/current behavior)
    -- 'alternate_period' → HARD: within any single day, this teacher can never be placed in
    --                       two consecutive periods (period N and N+1 both occupied is illegal)
    -- 'alternate_day'    → HARD: this teacher can only be scheduled on alternate calendar days
    --                       (e.g. Mon/Wed/Fri only, or Tue/Thu only) — see below for how the
    --                       specific day-set is chosen
```

**`always_first_period` — exact enforcement logic:**
```
IF teacher.class_teacher_period_rule = 'always_first_period':
    - variable (own_class_section, subject=X, occurrence=1st-of-day-if-applicable) → domain restricted to period_id = 1, for at least one placement per day if the class-teacher's own subject runs daily, OR simply: reserve (own_class_section, day, period_1) for this teacher across all days regardless of subject (many schools use P1 for attendance/homeroom, not a subject) — this is a config toggle: "Reserve P1 as homeroom" vs "P1 must be a subject taught by the class teacher."
    - HARD EXCLUSION: remove (any_other_class_section, day, period_1) from this teacher's
      domain entirely, for every day — enforced as a pre-solve domain restriction, not a
      soft penalty, so the solver can never even consider that slot for this teacher.
```
This is implemented as a **domain-pruning step that runs before the solver starts** (not a constraint checked during search) — the fastest and most bulletproof way to guarantee "never bypassed": the illegal slots simply don't exist in that teacher's candidate domain.

**`alternate_period` — exact enforcement logic:**
```
Hard constraint added to the CSP: for teacher T, for every day D, for every period P:
    NOT (T occupies (D, P) AND T occupies (D, P+1))
```
Checked both during solver placement (constraint #6 in §5.1, now promoted from soft to **hard** when this flag is set) and during manual drag-and-drop (§7.1) — a drag that would create two consecutive periods for this teacher is rejected with: *"Mr. Iyer is configured for alternate periods only — Period 4 is adjacent to his Period 3 placement."*

**`alternate_day` — exact enforcement logic + the day-set question:**
Since "alternate day" needs a concrete day-set, add:
```sql
ALTER TABLE teachers ADD COLUMN alternate_day_set JSON NULL;
    -- e.g. ["MON","WED","FRI"] — admin picks explicitly at teacher setup time,
    -- OR set to NULL and the solver auto-picks the day-set that best fits
    -- their weekly load (demand ÷ available-days-per-week), surfaced to the
    -- admin for confirmation before generation ("Mrs. Rao's 9 periods/week
    -- fit best on Mon/Wed/Fri — confirm or override").
```
Domain-pruned the same way as `always_first_period`: every `(day NOT IN alternate_day_set, *)` slot is removed from this teacher's candidate domain before the solver runs.

**Feasibility Engine impact (§4.2 revisited):** Check 2 (weekly load capacity) must now compute capacity **per teacher, per their actual pattern**, not a flat `working_days × periods_per_day`:
```
IF period_pattern = 'alternate_period':
    capacity(T) = Σ over each day: floor((periods_that_day + 1) / 2)   -- max non-adjacent periods/day
IF period_pattern = 'alternate_day':
    capacity(T) = periods_per_day × count(alternate_day_set)           -- only those days count at all
IF class_teacher_period_rule = 'always_first_period':
    capacity(T) is unaffected in total, but Period-1 slots in every OTHER class-section
    are removed from every OTHER teacher's... no — removed only from T's own domain of
    "other sections"; this instead REDUCES the pool of teachers eligible for P1 elsewhere,
    which Check 4 (cross-section daily overlap) must re-verify: "3 class-sections need a
    P1 teacher today but their class-teachers are all locked to their own P1 — verify a
    non-class-teacher subject teacher is mapped for P1 in those sections."
```
This is exactly the kind of interaction that would silently break a naive solver — by pruning domains up front and re-running Check 2/Check 4 with pattern-aware math, the Readiness Score stays accurate and still catches it before generation, not after.

### 4.7a Teacher Availability (§4.7's hard rule, made sayable)

`teacher_unavailability` is one row per blocked cell — `(teacher_id, day_of_week, period_number)`, with **`period_number = NULL` meaning the whole day**. It has been enforced everywhere that matters since Phase 1:

| Where | How |
|---|---|
| Solver | `buildTeacherCtx` removes the cells from the teacher's domain **before search** — invariant 2, a hard constraint, never a penalty |
| Drag-drop board | a move into a blocked cell is refused, naming the teacher |
| Feasibility Check 2 | full off-days and blocked periods are subtracted from weekly capacity, so Readiness never counts hours the teacher does not work |
| Substitute engine | `t.unavailablePeriods.includes(slot.period)` drops them from the candidate list outright, before scoring |

What was missing was any way to **enter** it: the Excel importer's "Teacher Unavailability" sheet, or a raw `PUT /teachers/:id/unavailability`. So in practice it stayed empty, and a rule nobody can set is a rule that does not exist. The Teacher Availability screen (`/availability`, under Build) is that entry point — a teacher list beside a week grid of the current timetable's own days and periods, clicked cell by cell, or by day, or by period.

**The patterns are entry shortcuts, not a second model.** Everything an admin describes reduces to cells, so that is all that is ever stored:

| What they say | What is written |
|---|---|
| "not available Monday and Friday, periods 1–4" | 8 cells |
| "not available second half, daily" | the back half of each working day |
| "comes in after 10am" | every period whose `start_time` is before 10:00, every day |
| "leaves early" | every period whose `end_time` is after the time, every day |

The last two are computed from the config's real period times, which is why the grid shows them. One representation whichever way it was typed: the solver cannot tell a pattern from hand-clicked cells, and neither can the next person to edit it.

Two rules the screen holds to. A day with **every** teaching period blocked is saved as one whole-day row rather than N rows — that is what the NULL means, and it keeps meaning it if the timetable later gains a period. And availability belongs to the **teacher, not to a timetable**: the grid is drawn from the current config's day, but the rule applies wherever that teacher is timetabled, which the screen says plainly rather than letting somebody assume otherwise.

### 4.8 Class-Subject-Level Consecutive Period Configuration

Extend `class_subjects` (§3) — this is per class-section, per subject (Maths in 10-A might need double periods; Maths in 10-B might not):

```sql
ALTER TABLE class_subjects ADD COLUMN consecutive_block_size INT DEFAULT 1;
    -- 1 = no requirement (default). 2 = must be placed as 2 back-to-back periods
    -- on the same day (e.g. a lab or a double-Maths block).
ALTER TABLE class_subjects ADD COLUMN consecutive_blocks_per_week INT DEFAULT NULL;
    -- how many such double-blocks per week — e.g. periods_per_week=6, consecutive_block_size=2,
    -- consecutive_blocks_per_week=2 → 2 double-periods (4 periods) + 2 single periods,
    -- OR consecutive_blocks_per_week=3 → all 6 periods as 3 double-blocks, no singles.
    -- Validated at entry: consecutive_block_size × consecutive_blocks_per_week must not
    -- exceed periods_per_week; the remainder is auto-scheduled as singles.
```
**Solver treatment:** a consecutive block is modeled as **one macro-variable** spanning `consecutive_block_size` contiguous period-slots on one day, rather than as independent single-period variables — its domain is only the set of `(day, start_period)` pairs where `start_period ... start_period + block_size - 1` are all free, within the same day, and not crossing a break (breaks split the day into placement segments; a double period can never straddle a break unless explicitly configured to). This keeps the all-different constraints (§5.1) working unchanged — the macro-variable simply claims multiple slot-cells atomically, so if it can't fully fit, it fully fails and backtracks, rather than leaving one orphaned half-placed period (which is the classic bug in naive implementations).

**Feasibility Check 3 (§4.3) impact:** `min_days_needed` must be computed accounting for block packing, e.g., 6 periods as 3 double-blocks needs only 3 days-with-availability (not the naive per-period math), while also checking each of those days actually has 2 physically contiguous free periods available in the class-section's grid — flagged explicitly if a day's period grid is too fragmented (e.g., broken up by too many breaks) to fit any double-block at all.

### 4.9 Merged Teaching Groups (one teacher, one slot, multiple class-sections simultaneously)

Your Bio example — one teacher teaches 10-A and 10-B together in the same period — is structurally different from a normal placement: **one teacher occupies one physical slot, but that single slot satisfies the subject requirement for *multiple* class-sections at once.** This needs its own construct rather than forcing it through the normal per-class-section mapping:

```sql
CREATE TABLE merged_teaching_groups (
  id INT PRIMARY KEY AUTO_INCREMENT,
  subject_id INT NOT NULL REFERENCES subjects(id),
  teacher_id INT NOT NULL REFERENCES teachers(id),
  periods_per_week INT NOT NULL,
  room_id INT NULL,                      -- typically required: merged groups usually need one
                                          -- larger shared room (e.g. combined Bio lab)
  consecutive_block_size INT DEFAULT 1   -- merged groups can also be double-period, per §4.8
);

CREATE TABLE merged_teaching_group_members (
  merged_group_id INT NOT NULL REFERENCES merged_teaching_groups(id),
  class_section_id INT NOT NULL REFERENCES class_sections(id),
  PRIMARY KEY (merged_group_id, class_section_id)
);
```

**How this interacts with the "no double-booking" unique constraints (§3):** the whole point of a merged group is that the *teacher* legitimately occupies the *same* `(day, period)` for two rows at once — one row per member class-section — which would otherwise violate `uq_teacher_slot`. Fix: add a nullable `merged_group_id` to `timetable_slots`, and replace the teacher-uniqueness index with a **generated occupancy key** so a merged group counts as a single teacher-occupancy event no matter how many class-sections it spans:

```sql
ALTER TABLE timetable_slots ADD COLUMN merged_group_id INT NULL REFERENCES merged_teaching_groups(id);
ALTER TABLE timetable_slots ADD COLUMN teacher_occupancy_key VARCHAR(30)
  GENERATED ALWAYS AS (
    CASE WHEN merged_group_id IS NOT NULL
         THEN CONCAT('MG-', merged_group_id)
         ELSE CONCAT('T-', teacher_id) END
  ) STORED;

-- replace uq_teacher_slot with:
ALTER TABLE timetable_slots ADD UNIQUE KEY uq_teacher_slot2
  (timetable_config_id, status, teacher_occupancy_key, day_of_week, period_id);
```
**Implementation note (Phase 2):** a literal generated key on every member row would make the member rows themselves collide in `uq_teacher_slot`. The implemented refinement: only the **primary** member row of a merged placement carries `teacher_occupancy_key` (`T-{teacherId}`) and `room_id`; the other member rows are display echoes with those columns NULL (MySQL unique keys ignore NULLs). Teacher/room double-booking stays DB-enforced — any other placement of that teacher or room at the slot collides with the primary row — and the single slot-writer service is the only code that writes these columns.

`uq_class_slot` (§3) is untouched and still fires per class-section — 10-A and 10-B each still get their own row for that period (each shows "Bio · Mr. Menon" in their own grid), so both class-section reports render correctly; it's only the teacher's own occupancy that's collapsed into one event, correctly reflecting that they're not "double-booked," they're legitimately teaching one combined class.

**Solver treatment:** a merged group is placed as **one macro-variable** (like the consecutive-block case in §4.8, and combinable with it — a merged double-period is both at once): the solver finds a `(day, period[, +1 if double])` slot that is simultaneously free in *every* member class-section's grid, free for the teacher, and free in the shared room. Domain = intersection of all member class-sections' free slots ∩ teacher's free slots ∩ room's free slots. If that intersection becomes empty (e.g., 10-A already has every remaining slot full but 10-B doesn't), it's a **feasibility blocker surfaced immediately**, not a late-stage solver failure: *"Merged Bio group (10-A + 10-B) needs 4 more common free slots but 10-A only has 2 slots left in common with 10-B's availability — check 10-A's schedule density."*

**Split classes (the inverse case — e.g., language electives where one class-section's students split into parallel subject groups at the same time)** use a mirror construct:
```sql
CREATE TABLE elective_blocks (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(50),                      -- 'Class 10 Second Language'
  periods_per_week INT NOT NULL
);
CREATE TABLE elective_block_members (     -- which class-sections' students participate
  elective_block_id INT NOT NULL REFERENCES elective_blocks(id),
  class_section_id INT NOT NULL REFERENCES class_sections(id),
  PRIMARY KEY (elective_block_id, class_section_id)
);
CREATE TABLE elective_options (            -- the parallel subject/teacher/room choices
  id INT PRIMARY KEY AUTO_INCREMENT,
  elective_block_id INT NOT NULL REFERENCES elective_blocks(id),
  subject_id INT NOT NULL,
  teacher_id INT NOT NULL,
  room_id INT NOT NULL
);
```
All `elective_options` under one `elective_block_id` are placed as a **synchronized group** — they must land on the identical `(day, period)` for every occurrence (so a student can validly be "free" from their home class-section grid at that slot and routed to whichever option they're enrolled in). Same domain-intersection logic as merged groups, but here the intersection is across the *set of teachers/rooms* rather than class-sections, while all member class-sections' grids just need that one shared slot free once per occurrence (not per-option).

**Implementation note (Phase 10):** an occurrence is written as **one member row per attending section** — carrying the block but no subject, teacher or room, so each section's grid shows the shared cell and `uq_class_slot` still guards it — plus **one option row per parallel lesson**, carrying `class_section_id = NULL`. The NULL is deliberate and is the same device merged groups already use for `teacher_occupancy_key`: MySQL unique indexes ignore NULLs, so option rows drop out of `uq_class_slot` (they belong to a block, not a section — there is no enrolment model, so an option genuinely has no class-section) while `uq_teacher_slot` and `uq_room_slot` still refuse a double-booked language teacher or room. Invariant 1 keeps its teeth and it stays one table.

**Placement (Phase 15).** A block did not choose *when* it ran — the solver placed it wherever it fitted, so a school's third-language slot landed Mon P3, Tue P6, Wed P2. Real schools run the language period at a known time so a whole grade changes rooms in one movement. `elective_blocks` therefore gains two columns:

```sql
ALTER TABLE elective_blocks
  ADD COLUMN placement ENUM('solver', 'same_period', 'fixed') NOT NULL DEFAULT 'solver',
  ADD COLUMN fixed_slots JSON NULL;      -- [{"day":1,"period":4}, …], one per occurrence
```

- `solver` — the pre-Phase-15 behaviour, and the default, so no existing block changes.
- `same_period` — one period *number* across the block's days (P4 Mon–Fri). Implemented by giving the block's variables `samePeriodKey = B{id}`, which is the §4.6 same-period-across-week machinery already in `SolverState`: nothing new in the state machine.
- `fixed` — exact cells. Occurrence *i* is handed `fixed_slots[i]` intersected with what its option teachers can work.

All three are **domain pruning before search** (invariant 2), never a penalty score: the solver must not be able to consider a slot the school ruled out. `fixed_slots` is read only under `fixed`, so a stale pin cannot quietly narrow a block the school has since set free.

Pinning is the only setting on the Electives screen that takes cells *away* from the solver rather than expressing a preference, so **Check 7b** exists to name every way it can be wrong before Generate: `ELECTIVE_PIN_COUNT` (fewer or more slots than periods/week), `ELECTIVE_PIN_INVALID` (a cell outside the working days or the teaching periods), `ELECTIVE_PIN_DUPLICATE` (the same cell twice, or more on one day than the block's cap), `ELECTIVE_PIN_UNAVAILABLE` (an option teacher who does not work that day — every option runs at once, so one of them takes the whole block off that day), `ELECTIVE_PIN_CLASH` (two blocks pinned to one cell that share a section, a teacher or a room — sharing a cell alone is fine and normal), and `ELECTIVE_SAME_PERIOD_TIGHT` (one period number cannot come round more times than there are days).

Every one of those carries a §21 remedy, and every one of those remedies is the same shape: hand the block back to the solver. That is the invariant-19 rule applied here — a relax remedy changes the *rule*, never the teaching. Auto-resolve may turn a pin off, with the cost shown; it may never move a block to a day nobody chose, which is why `fixed_slots` is absent from the `WRITABLE` allow-list while `placement` is on it.

**Reading a block back (Phase 15).** A member row carries no subject, teacher or room by design, so any screen that renders a class's week from the section's own rows shows the elective as an empty cell. `ReportsService.classSectionTimetable` therefore joins the block's **option rows** for each member cell and returns them as `electiveOptions` beside a `blockName`, so one slot reads as *"Third Language — French / B. Rao (Lang 1); Sanskrit / S. Iyer (Lang 2); German / K. Mehta (Lang 3)"*. It reads the written option *rows* rather than the block's configured options, so a covered option shows its substitute. Because that one function also feeds My Classes, the CSV export and the §13.1 AI tools, all four were wrong together and are right together. The flat `subject` field carries the block name so an older consumer never sees a blank.

**The same mistake, one layer down.** `GET /timetable-configs/:id/slots` — the compact payload behind the Allocation Matrix and the Draft Board — dropped option rows server-side for the same reason: they are not cells in a section's grid. But that one payload feeds **two dimensions**, By Class-Section (cells) *and* By Teacher (lessons), so a teacher whose only work is an elective option appeared completely unscheduled on both screens. In the reference school that was nine language teachers and 130 lessons.

The rule this establishes: **invariant 9's distinction is a property of the consumer, not of the transport.** A payload serving both meanings must carry both, and each reader filters on `classSectionId === null` for the meaning it wants. Applying the filter once at the source looks like tidiness and is silently lossy for whichever consumer meant the other thing. **Dragging a block (Phase 16).** The sentence above described the limit, and Phase 16 removes it: a block IS a draggable card, and moving it moves every option and every member section at once — which is precisely why it took its own phase rather than being folded into a display fix.

The load-bearing point is that no new rules engine was written. `SolverState` already validates an elective macro-variable (`optionTeachersOf` / `optionRoomsOf` occupy every option's teacher and room at once) — that is how the solver places blocks. `BoardEngine.varOf` previously hard-coded `electiveBlockId: null, options: []` and treated blocks as opaque `reserved` cells; it now emits the real macro-variable, so drag legality is the same check the solver made, per the one-rules-engine rule. `reserved` is deleted.

Two consequences follow from a block being multi-section:

- **The group swap.** A card holding N sections can only *move* to a cell free in all N, which in a full school essentially never happens — the feature would read as broken. `checkSwapGroup` instead lifts the dragged card and every distinct entry standing at the target across its member sections, checks the card at the target and each displaced entry at the source, then restores the board exactly (it is a pure query). A displaced entry may span sections the dragged card does not — a merged group over 5-A and 6-A — so 6-A's source cell must be free too; lifting everything and asking `SolverState` makes that fall out instead of needing its own rule. The same machinery lifts the long-standing merged-group limitation: `legalDestinations` routes to the group swap whenever **either** side is multi-section, so merged groups became swappable in the same change.
- **A swap with another occurrence of the same block is refused.** Both cells hold the identical card afterwards, so it changes nothing; offering it as a green destination is a lie the user acts on. On the reference school it was *every* destination a block had — 4 of 4 — until it was excluded.

The block card carries **no 📌 and no ✕**, and neither is an oversight. `lockedSlots` is built filtered to rows with a section, a subject and a teacher, so a block's rows never reach the solver as locks — a pin would be silently ignored by the next Generate, violating invariant 13. §4.9 Phase 15's `placement: fixed` is the tool that actually holds a block's time, and being domain pruning it survives regeneration; the card points there. Removal is refused for a different reason: the unplaced tray is per-section *mapping* demand, and a block is not a mapping, so a removed block would have no way back.

Server-side, a block is addressed by `electiveBlockId` rather than a section — its option rows belong to no section, so a section-based lookup would move the members and leave the lessons behind — and staleness is checked against the **set of option ids**, because comparing subject and teacher would compare two NULLs and call any block equal to any other. `POST board/swap-group` is separate from `board/swap` because the client cannot name what gets displaced: one card can push a different lesson out of each member section, and the server resolves that from the engine's own answer, never from the request.

The solver treats a block as one macro-variable whose domain is the intersection of every member section's free slots **and every option teacher's** — so a single alternate-day language teacher narrows the whole block, which the Feasibility Engine warns about by name before search starts (`ELECTIVE_DAY_INTERSECTION`). Per-day caps count against the *block*, not each option: a student takes one language period a day, not one of French and one of German. CP-SAT (§5.6) deliberately skips a config that has blocks rather than optimising around them — a payload that cannot express several simultaneous teachers would propose placements that collide with the blocks and fail the replay gate, burning the budget to be rejected. Fast-mode output is already valid, so this is the same graceful degradation as the optimizer being down.

**UI note:** both merged and split groups get their own setup screen in the wizard (§8.1, new step "Merged & Split Teaching") and render visually distinct on the Allocation Matrix and Drag-Drop Board — a merged-group cell shows a small link icon and, on hover, lists every class-section it's tied to, and dragging one half of a merged/split group automatically moves all linked cells together (dragging only one would silently break the sync, so the UI treats the whole group as one draggable unit).

**UI representation:** a persistent **"Readiness Score"** panel (e.g. "87% Ready — 3 blockers, 5 warnings") sits above the Generate button at all times, with each blocker clickable → jumps straight to the offending master-data row with the fix pre-suggested. This is the live "tell me what to do next" intelligence you asked for, and it applies from the very first day of data entry, not just at generation time.

---

## 5. Phase B — The Solver Algorithm

### 5.1 Problem formulation (CSP)
- **Variables:** one variable per required `(class_section, subject, occurrence#)` — e.g. "5-A English occurrence 3 of 6" — **except** where §4.8/§4.9 apply, in which case a set of occurrences collapses into a single **macro-variable**:
  - A `consecutive_block_size > 1` subject occurrence → one macro-variable claiming `block_size` contiguous period-cells on one day.
  - A `merged_teaching_groups` occurrence → one macro-variable claiming one `(day, period)` (or a contiguous block, if also double-period) simultaneously across every member class-section's grid, keyed to one teacher-occupancy event (§4.9).
  - An `elective_blocks` occurrence → one synchronized macro-variable spanning all of its `elective_options`, all forced to the same `(day, period)`.
- **Domain of each variable:** every `(day, period)` slot not already ruled out by that class-section's unavailability, **pre-pruned** by any hard teacher-pattern restriction from §4.7 (e.g. an `alternate_day` teacher's domain excludes every day outside their `alternate_day_set` before search even starts; an `always_first_period` class-teacher's domain for *other* sections excludes Period 1 entirely).
- **Constraints:**
  1. All-different: no two variables (or macro-variable cells) for the same class-section share a `(day, period)`
  2. All-different: no two variables sharing the same `teacher_occupancy_key` (§4.9 — collapses merged-group placements into one event) share a `(day, period)`
  3. All-different: no two variables sharing the same `room_id` (when room is not the home classroom) share a `(day, period)`
  4. `max_periods_per_day` per subject per class-section
  5. `max_periods_per_day` per teacher (pattern-adjusted per §4.7 when `alternate_period`/`alternate_day` is set)
  6. **Teacher `alternate_period` pattern — HARD** (promoted from soft; §4.7): no two of that teacher's placements on the same day may be in adjacent periods
  7. **`always_first_period` class-teacher rule — HARD**, enforced via domain pruning (§4.7), not runtime checking
  8. `same_subject_same_period_across_week` — hard constraint linking all occurrences of that subject for that class-section to the same `period_id` (but different days)
  9. Consecutive/double-period block placement (§4.8) — enforced structurally by the macro-variable's domain, not as a post-hoc check
  10. Merged/split group synchronization (§4.9) — enforced structurally by the macro-variable spanning all linked class-sections/options at once

All constraints above are **hard** — per your instruction that configuration must never be bypassed, nothing in §4.7–§4.9 is modeled as a penalized soft preference; only genuinely optional preferences (e.g., a teacher's non-binding "prefers mornings" hint, if you add one later) belong in the soft-constraint / least-constraining-value layer.

### 5.2 Variable & Value Ordering Heuristics (this is what makes it fast and reliable at 2,000+ slots)
- **Most-Constrained-Variable-First (MRV):** place the class-section/subject/teacher combos with the *fewest legal remaining slots* first (e.g., a subject with `max_periods_per_day=1` and a teacher who's also class-teacher elsewhere and wants alternate periods — very constrained, must go early). This mirrors how an experienced human timetable-in-charge works: hardest constraints first.
- **Least-Constraining-Value:** among legal slots for the current variable, prefer the slot that eliminates the fewest options for *other* still-unplaced variables.
- **Degree heuristic tiebreak:** prefer variables involving teachers who teach in the most other class-sections (they create the most downstream conflicts if placed late).

### 5.3 Search with Forward Checking + Backjumping
```
function solve(assignment, domains):
    if assignment is complete: return assignment
    var = selectUnassignedVariable(domains)   // MRV + degree heuristic
    for value in orderDomainValues(var, domains):   // LCV heuristic
        if isConsistent(var, value, assignment):
            assign(var, value)
            removed = forwardCheck(var, value, domains)   // prune neighbor domains
            if no domain wiped out:
                result = solve(assignment, domains)
                if result != FAILURE: return result
            undoPrune(removed)
            unassign(var, value)
    return FAILURE   // triggers conflict-directed backjump to the deepest
                      // variable that actually caused this dead end,
                      // not just one step back (huge speedup over plain backtracking)
```
Because Phase A already proved a solution exists, `FAILURE` at the top level should never occur in production — if it ever does (e.g. due to an edge case Phase A didn't model), the engine falls back to §5.4.

### 5.4 Repair / Local-Search Fallback (safety net)
If backtracking ever times out (budget: e.g. 30 seconds for 2,000 slots) or a corner-case constraint interaction causes a dead end, the engine falls back to a **min-conflicts local search**: start from the best-effort partial assignment, then repeatedly pick a conflicted slot and reassign it to the value that minimizes total conflicts (simulated-annealing-style, with random restarts). This never fails to terminate — worst case it converges to a near-100% solution and reports the exact remaining unplaced periods for manual placement via drag-and-drop (which itself is conflict-validated, see §7).

### 5.5 Performance at your stated scale
50 class-sections × 40 slots = 2,000 variables. With MRV + forward checking, this class of CSP (school timetabling) is well-studied and solves in seconds to low-minutes on a single core for these sizes; running it as a queued background job with progress streaming (§2) removes any UX pressure to be instant.

### 5.6 When to graduate to Google OR-Tools CP-SAT
If the school later wants *soft* optimization goals beyond pure feasibility (e.g., "minimize teacher gaps across the whole school," "balance workload evenly," "minimize room changes for young children"), hand the same constraint model to **Google OR-Tools CP-SAT** (open-source, free, has official Node.js/Python bindings) — it's purpose-built for exactly this class of problem and will outperform a hand-rolled backtracker on optimization (not just feasibility) objectives. Recommendation: ship v1 with the custom CSP engine above (full control, no external dependency, meets the 100%-feasibility bar), and evaluate CP-SAT for a v2 "optimize for teacher happiness" mode.

> **Implementation note (Phase 6 — shipped).** Two deviations from the sketch above, both deliberate:
>
> 1. **Python microservice, not Node bindings.** OR-Tools ships official Python/C++/Java/.NET bindings; there is no maintained official Node.js binding, so the optimizer is a separate compose service (`optimizer`, `apps/optimizer/server.py`, stdlib HTTP + `ortools`) that the worker calls over the Docker network. It is optional at runtime — if it is down, generation falls back to the fast engine and still succeeds.
> 2. **The CSP engine stays the source of truth for hard constraints.** TypeScript keeps ownership of §4.7 domain pruning and room assignment and hands CP-SAT only the pruned domains plus caps; CP-SAT owns search and the objective. Whatever it returns is replayed cell-by-cell through the *same* `SolverState.check()` the fast engine uses (`verifyAssignment`), and is adopted only if it verifies **and** scores strictly better. An optimizer bug therefore cannot reach the database — the worst case is "no improvement".
>
> **The objective (three weighted terms, configurable per run on the Generate screen):** teacher gaps (free periods sandwiched between two teaching periods), peak daily load per teacher (flattens the week), and room changes (lab↔classroom switches between consecutive periods for a class-section — clustering lab periods keeps young children in one room). `packages/shared/src/optimize/objective.ts` is the single definition of "nice": CP-SAT minimizes exactly these terms and the same scorer grades both engines, so "optimized" is proven rather than asserted. Benchmark (6 sections × 40 slots, 180 variables): teacher gaps **171 → 0**, room changes 54 → 21, zero hard-constraint regressions.

### 5.7 Where "AI" (LLM) actually adds value vs. where it doesn't
Be deliberate about this — pure timetable placement is a combinatorial optimization problem, and an LLM is the *wrong* tool for guaranteeing zero conflicts (it can hallucinate a placement that looks right and isn't). Use the CSP solver above for all actual placement. Use an LLM layer for:
- **Natural-language explanation of conflicts:** turning the raw "ERROR: teacher_id 45 demand=34 > capacity=30" into the plain-English message shown in §4.2, and answering "why can't I place Maths here?" in chat form by feeding it the specific constraint-check result.
- **Natural-language data entry:** "Add English, 6 periods a week, taught by Mrs. Sharma in 5-A, 5-B, 5-C" → parsed into the mapping rows via an LLM extraction step, with a confirmation screen before saving.
- **Substitute-teacher ranking narrative** (see §6) — the matching itself is a bipartite-matching algorithm, but the LLM can write the one-line rationale next to each suggested substitute.

---

## 6. Substitute Teacher Engine

This is a bounded **bipartite matching / assignment problem**, solved per absent-teacher-per-day.

### 6.1 Algorithm
```
Input: absent_teacher, date
1. Find all slots for absent_teacher on date's day_of_week (from published timetable):
      slots = [ (class_section, period, subject) ... ]   // e.g. 4 slots in your example

2. For each slot, find candidate substitutes:
      candidates(slot) = teachers WHERE
          (teaches same subject_id  OR qualifies to teach that class's grade band)
          AND is_active = true
          AND NOT already occupied at (date.day_of_week, slot.period)   -- from their own
              published timetable AND any substitution already assigned today
          AND NOT in teacher_unavailability for that day/period
          AND current_daily_load(teacher, date) < max_periods_per_day   -- don't overload the substitute

3. Build bipartite graph: slots (4 nodes) <-> eligible substitute-teachers (N nodes),
   edge weight = preference score:
      +3  same subject specialist
      +2  already teaches this exact class-section (continuity for students)
      +1  free period immediately adjacent (less disruption to substitute's own day)
      -1  substitute already covering 2+ periods today (spread load fairly)

4. Run Hungarian Algorithm (or greedy-augmenting-path matching for small N, which is
   sufficient at this scale) to find the MAXIMUM-WEIGHT assignment that covers as many
   slots as possible.

5. Output: assigned substitute per slot (possibly different substitutes for different
   periods — exactly your example: Substitute 1 → periods 5 & 7, Substitute 2 → periods 1 & 3).
   Any slot with zero eligible candidates is flagged: "No substitute available for
   8-C Period 5 — options: merge with adjacent section, assign to free-period duty
   teacher, or cancel period."
```

### 6.2 UX flow
1. User marks Teacher absent for a date (or the system detects via leave-approval integration).
2. System instantly computes the matching above and shows a **review screen**: each of the 4 affected slots with its top-ranked substitute pre-selected + 1-2 alternates in a dropdown, and the LLM-written rationale ("Mr. Verma — also teaches English to 7-B, free this period, only 2 substitutions today").
3. One click **"Confirm All"** writes 4 rows into `substitution_log` and creates matching `timetable_slots` rows with `source='substitute'`, `status` scoped to that single date only (the base published timetable is untouched — substitutions are date-specific overlays, not permanent changes).

> **Implementation note (Phase 4):** the overlay lives in `substitution_log` alone — no `timetable_slots` rows are created for substitutions. `timetable_slots` has no date column, so a substitute row at the same `(config, published, section, day, period)` would collide with the §3 unique keys; instead every read that takes a `?date=` (matrix, boards, reports) joins that date's `substitution_log` rows over the published grid at query time. `uq_slot_substitution_date (timetable_slot_id, date)` guarantees one substitute per slot per day, and deleting an absence cascades its overlay rows away — the base grid is untouchable by construction, which is the §6.2 intent stated more strongly.
4. Affected class-sections and the substitute teachers get a notification (see §9).

---

## 7. Manual Drag-and-Drop Editing — Validation Model

This is the screen where the full matrix (all 2,000 slots) is manually adjustable after generation, per your spec.

### 7.1 Interaction model
- Grid: rows = periods (+ breaks/zero period rendered as non-draggable divider rows), columns = days, **one grid per class-section**, with a class-section switcher; a second view mode switches the same grid to **per-teacher** (rows=periods, columns=days, cells = which class-section that teacher is in).
- Every cell is a draggable card showing `Subject · Teacher (initials) · Room`.
- Drag a card onto another cell:
  - **Green outline + subtle snap** if the target is legal.
  - **Red outline + shake + audible beep + toast** if illegal, with the *specific reason*, e.g.: *"Can't move here — Mrs. Sharma already teaches 7-B Maths in this slot (Mon, Period 3)."* or *"Class 5-A already has Science in Period 5 today (max 1/day)."*
  - This validation runs **client-side first** (instant, using a synced copy of the current slot-matrix held in memory) for zero-latency feedback, then is **re-validated server-side** on drop-confirm (defense against stale state / concurrent edits by another admin).

### 7.2 "Suggest where I can move this" mode
When the user picks up a card (mousedown, before dropping), the system doesn't wait for a drop attempt — it immediately **highlights every legal destination cell** across the entire visible grid (soft green glow), computed by re-running the constraint check for that specific subject/teacher/class-section against every empty or swappable cell. This directly satisfies your "application should suggest where user can move the entry" requirement.

### 7.3 Swap vs. Move
- Dropping onto an **empty** slot = move.
- Dropping onto an **occupied** slot = proposes a **swap** (both cards trade places) if that keeps both sides legal; if not, it's rejected with the reason, same as above.

### 7.4 Locking
Manually placed/approved cells can be pinned (`is_locked = true`) so a future re-run of the auto-solver (e.g., after adding a new class-section mid-year) treats them as fixed and only fills the remaining gaps — critical so admins don't lose hand-tuned adjustments every time they regenerate.

---

## 8. Screens (Full List + Sample HTML for the 3 highest-complexity ones)

### 8.1 Full screen list
0. **Timetables** — the landing screen: every timetable_config the school runs (Primary Wing, Middle Wing, Senior Wing, …), each with its classes covered, periods/day, timing, and status. "+ New Timetable" starts a fresh wizard without disturbing the others; "Edit" re-opens an existing one directly at its config step.
1. **Setup Wizard** (multi-step, scoped to one timetable_config at a time): Academic Year → Classes/Sections → Rooms → Subjects → **Teachers** (list + add/edit — see 8.1a) → Timetable Configuration (name, description, classes covered, days, periods, start time, breaks, zero period, computed end time) → Curriculum mapping (class↔subject) → **Teacher Mapping** (Class-Teacher Assignments + Subject Mapping, both list + add/edit — see 8.1b). *Capacity-first ordering:* the config step fixes the week's period count (periods/day × working days), and every later periods/week field (curriculum rows, subject mappings, merged groups) is hard-validated server-side against that capacity at entry — a value above it is rejected with a message naming the config and its cap.
2. **Readiness / Feasibility Dashboard** — the live blocker/warning panel from §4
3. **Full Allocation Matrix** — the 2,000-slot grid view (§8.3 below)
4. **Generate Timetable** — trigger + live progress (WebSocket) + result summary
5. **Draft Timetable Board (Drag & Drop)** — per class-section / per teacher toggle (§8.4 below)
6. **Publish Confirmation** — diff view vs. currently-published version, with a warning list of anything still unallocated
7. **Substitute Teacher Center** — mark absence → review matched substitutes → confirm (§8.2)
8. **Reports** — Class-section weekly grid (printable), Teacher weekly grid (printable), Room utilization report, Free-period report
9. **Master Data screens** — Classes, Sections, Rooms, Subjects, Teachers, Curriculum Mapping, Teacher Mapping (standard CRUD grids, each with the same live-validation pattern)
10. **Notification Center** — timeline of alerts (over-load warnings, unresolved absences, publish events)

#### 8.1c Curriculum step = edit in the row

List-first/form-second (§8.1a) is right for a teacher: a dozen fields, edited rarely, one at a time. It is wrong for the curriculum, and the reason is arithmetic — a real school is 14 classes × ~8 subjects, so the table runs past a hundred rows and the form sat underneath all of them. Pressing Edit on row 90 scrolled the row you were editing off the screen, and put the fields you were editing it with somewhere else entirely.

So this one step edits **in the row**: the same seven columns become inputs, Save and Cancel replace the row's actions, Enter saves and Escape cancels. Nothing moves. Class and subject lock while editing, because together with the year they *are* the row's identity (`class_id, subject_id, academic_year_id`) — changing one is a different row, not an edit of this one.

Two supports matter as much as the inline form. **Filters come first** (class, subject, free-text), because the fastest edit is the one where you never scrolled to find the row; and the **capacity mirror travels with the field it constrains** — `35/40 of the Main Timetable week`, under the periods/week input, turning red and disabling Save when the class is over its week. It used to be a hint under a form on another part of the page.

This also gave `same_period_across_week` a control. The field was in the payload, in the table and in the edit state, but nothing on the screen could set it — so a same-period subject could not be declared from the screen that owns it.

#### 8.1a Teacher step = list first, form second

The Teachers step of the wizard is two views, not one form: it opens on a **Teacher Directory** — a table of every teacher already added (name, code, subjects, sections mapped, current weekly load vs. capacity, class-teacher rule, period pattern) — with **"+ Add New Teacher"** at the top and an **Edit** action per row. Only clicking Add or Edit drops into the single-teacher form from §4.7. This is the same list-then-form pattern the other master-data steps (Classes, Rooms, Subjects) already use, so a user re-entering the wizard to fix one teacher's load never has to page through a blank "add teacher" form to find who already exists.

```html
<div class="teacher-directory">
  <div class="toolbar"><h2>Teachers</h2><button class="btn-primary">+ Add New Teacher</button></div>
  <table>
    <thead><tr><th>Teacher</th><th>Subjects</th><th>Sections</th><th>Load</th><th>Class-Teacher Rule</th><th>Period Pattern</th><th></th></tr></thead>
    <tbody>
      <tr><td>R. Sharma</td><td>English</td><td>6</td><td class="over">34 / 30</td>
          <td><code>always_first_period</code></td><td><code>every_period</code></td>
          <td><button class="btn-sm">Edit</button></td></tr>
      <tr><td>P. Nair</td><td>Science, Biology</td><td>4</td><td>24 / 30</td>
          <td><code>none</code></td><td><code>alternate_period</code></td>
          <td><button class="btn-sm">Edit</button></td></tr>
    </tbody>
  </table>
</div>
```

#### 8.1b Teacher Mapping step = Class-Teacher Assignment + Subject Mapping (both list + add/edit)

This is the missing link the earlier draft of this spec left implicit: `teachers.class_teacher_period_rule` (§4.7) is configured **per teacher**, but a teacher isn't "the class teacher of 5-A" just because that field is set — nothing yet points from a specific `class_sections` row to a specific teacher. That pointer is `class_sections.class_teacher_id` (§3), and until now no screen ever wrote to it. The Teacher Mapping step is where it happens, split into two distinct tables on one screen:

- **Class Teacher Assignments** — one row per class-section, with a dropdown to pick its class teacher from the Teacher Directory (or leave unassigned). Selecting a teacher here is what activates their `class_teacher_period_rule` for *that specific section* — the row also echoes the teacher's configured rule (`always_first_period` / `random` / `none`) as a read-only chip, so the admin sees the consequence of the assignment immediately, and an "Unassigned" badge flags any class-section still missing a class teacher (feeding a new Feasibility warning: a class-section with no class teacher isn't a hard blocker, but is surfaced so it's never silently missed).
- **Subject Mapping** — the original teacher↔subject↔class-section grid (`teacher_subject_class_section`, §3), now with the same list-then-form pattern as Teachers: a table with an **Edit** action per row, and **"+ Add Mapping"** opening a form (teacher, subject, class-section, periods/week, room, and the merged-teaching checkbox from §4.9) rather than the row being the only way to see what already exists.

```html
<div class="class-teacher-assignments">
  <table>
    <thead><tr><th>Class-Section</th><th>Home Room</th><th>Class Teacher</th><th>Their Period-1 Rule</th><th>Status</th></tr></thead>
    <tbody>
      <tr><td>5-A</td><td>Room 12</td>
          <td><select><option>— Unassigned —</option><option selected>R. Sharma</option><option>A. Verma</option></select></td>
          <td><code>always_first_period</code></td><td class="ok">✓ Assigned</td></tr>
      <tr><td>5-C</td><td>Room 205</td>
          <td><select><option selected>— Unassigned —</option><option>R. Sharma</option></select></td>
          <td>—</td><td class="warn">⚠ Unassigned</td></tr>
    </tbody>
  </table>
</div>
```

### 8.2 Substitute Teacher Center (sample HTML)
```html
<div class="substitute-center">
  <div class="absence-banner">
    <span class="teacher-avatar">RS</span>
    <div>
      <h3>Mrs. Sharma — Absent Today (Mon, 17 Aug)</h3>
      <p>4 periods affected · 2 substitutes auto-matched · 1 needs review</p>
    </div>
    <button class="btn-primary">Confirm All Matches</button>
  </div>

  <table class="substitute-table">
    <thead>
      <tr><th>Period</th><th>Class-Section</th><th>Subject</th><th>Suggested Substitute</th><th>Why</th><th></th></tr>
    </thead>
    <tbody>
      <tr class="matched">
        <td>P1 · 8:00–8:40</td><td>5-A</td><td>English</td>
        <td><select><option selected>Mr. Verma (English)</option><option>Ms. Iyer (free)</option></select></td>
        <td class="rationale">Also teaches English · free this period · 1 substitution today</td>
        <td><span class="badge-ok">✓ Ready</span></td>
      </tr>
      <tr class="matched">
        <td>P3 · 9:20–10:00</td><td>7-B</td><td>English</td>
        <td><select><option selected>Mr. Verma (English)</option></select></td>
        <td class="rationale">Already teaches 7-B (continuity) · 2nd substitution today</td>
        <td><span class="badge-ok">✓ Ready</span></td>
      </tr>
      <tr class="matched">
        <td>P5 · 11:00–11:40</td><td>8-C</td><td>English</td>
        <td><select><option selected>Ms. Iyer (English)</option></select></td>
        <td class="rationale">Free this period · subject specialist</td>
        <td><span class="badge-ok">✓ Ready</span></td>
      </tr>
      <tr class="needs-review">
        <td>P7 · 12:40–1:20</td><td>9-D</td><td>English</td>
        <td><select><option disabled selected>No eligible substitute</option></select></td>
        <td class="rationale">All English teachers occupied — assign duty teacher or merge sections</td>
        <td><span class="badge-warn">⚠ Action needed</span></td>
      </tr>
    </tbody>
  </table>
</div>
```

### 8.3 Full Allocation Matrix (sample HTML — the "200-slot view")
```html
<div class="matrix-toolbar">
  <select id="dimension"><option>By Class-Section</option><option>By Teacher</option><option>By Room</option></select>
  <input placeholder="Search teacher/class/subject..." />
  <span class="fill-stat">1,987 / 2,000 slots filled (99.35%)</span>
  <span class="conflict-stat ok">0 conflicts</span>
</div>

<table class="allocation-matrix">
  <thead>
    <tr>
      <th class="sticky-col">Class-Section</th>
      <th colspan="8">Mon</th><th colspan="8">Tue</th><th colspan="8">Wed</th>
      <th colspan="8">Thu</th><th colspan="8">Fri</th>
    </tr>
    <tr>
      <th class="sticky-col"></th>
      <!-- repeated 5x for each day -->
      <th>P1</th><th>P2</th><th>P3</th><th class="brk">Brk</th><th>P4</th><th>P5</th><th>P6</th><th>P7</th>
      <!-- ... -->
    </tr>
  </thead>
  <tbody>
    <tr>
      <td class="sticky-col">5-A</td>
      <td class="slot filled">Eng<br><span>R.Sharma</span></td>
      <td class="slot filled">Math<br><span>A.Kapoor</span></td>
      <td class="slot filled">Sci<br><span>P.Nair</span></td>
      <td class="slot break">—</td>
      <td class="slot filled">Hindi<br><span>S.Rao</span></td>
      <td class="slot filled">SSt<br><span>M.Khan</span></td>
      <td class="slot empty">+ Add</td>
      <td class="slot filled">Art<br><span>T.Das</span></td>
    </tr>
    <tr>
      <td class="sticky-col">5-B</td>
      <!-- ... -->
    </tr>
    <!-- 48 more rows for the remaining class-sections -->
  </tbody>
</table>
```
Row/column freeze on scroll (sticky first column + sticky header) is essential at 50 rows × 40 columns — this is a virtualized grid (e.g. `react-window` / `AG Grid`) in the real implementation, not a plain HTML table, for performance.

### 8.4 Draft Drag-and-Drop Board (sample HTML)
```html
<div class="dnd-board">
  <div class="board-header">
    <h2>5-A · Draft Timetable</h2>
    <span class="status-pill draft">DRAFT — not published</span>
    <button class="btn-secondary">Auto-fill remaining gaps</button>
    <button class="btn-primary">Publish</button>
  </div>

  <div class="grid" style="grid-template-columns: 80px repeat(5, 1fr)">
    <div class="corner"></div>
    <div class="day-head">Mon</div><div class="day-head">Tue</div><div class="day-head">Wed</div>
    <div class="day-head">Thu</div><div class="day-head">Fri</div>

    <div class="period-label">P1<br><small>8:00</small></div>
    <div class="cell" draggable="true" data-legal-targets="true">
      <div class="card subject-english">English<br><span>R. Sharma · Rm 12</span></div>
    </div>
    <!-- ... 4 more days for P1, then repeat rows for P2..P8 -->

    <div class="period-label break-row">Break<br><small>10:00</small></div>
    <div class="cell break-cell" colspan="5">— 20 min —</div>

    <div class="period-label">P4<br><small>10:20</small></div>
    <div class="cell empty-cell" data-drop-target="true">
      <div class="drop-hint">Drop a period here</div>
    </div>
  </div>

  <!-- conflict toast, shown on illegal drop attempt -->
  <div class="toast toast-error" hidden>
    ⚠ Can't place here — Mrs. Sharma already teaches 7-B Maths at Mon, P3.
  </div>
</div>
```

---

## 9. Notifications & Alerts Engine

| Trigger | Recipient | Channel | Example |
|---|---|---|---|
| Feasibility blocker introduced (e.g., overload) | Timetable admin | In-app banner + notification center | "Teacher overload detected: Mrs. Sharma +4 periods" |
| Solver run completes | Admin who triggered it | In-app + push | "Timetable generated: 1,987/2,000 slots (99.35%). 13 slots need manual placement." |
| Timetable published | All teachers + class-section homerooms | Push/email + in-app | "New timetable effective Mon 17 Aug — view yours" |
| Teacher marked absent | Timetable admin | In-app urgent banner | "Mrs. Sharma absent today — 4 periods need substitutes" |
| Substitute assigned | Substitute teacher + affected class | Push/SMS/email | "You're covering 5-A English, P1 today (room 12)" |
| No eligible substitute found | Admin | In-app urgent | "9-D P7 English — no substitute available, action needed" |
| Manual edit conflicts with a locked/published slot | Editing admin (real-time) | In-app toast | as shown in §7 |
| Draft not published X days after generation | Admin | Reminder notification | "Draft timetable pending publish for 3 days" |

Implementation: a single `notifications` table (`id, user_id, type, title, body, link, is_read, created_at`) + Socket.IO push for real-time in-app delivery, with an existing email/push provider (you likely already have this in the Edunext Parent app stack) reused for cross-channel delivery.

---

## 10. Reports Module

All reports share one query shape — filter `timetable_slots WHERE status='published'` by dimension — and render to both screen and print/PDF:

- **Class-Section Weekly Timetable:** filter by `class_section_id` → grid of Day × Period showing Subject/Teacher/Room, with breaks and zero period rendered as shaded non-teaching rows.
- **Teacher Weekly Timetable:** filter by `teacher_id` → grid of Day × Period showing which Class-Section/Subject/Room, with free periods explicitly marked "Free" (useful for substitute-assignment lookups and workload audits).
- **Room Utilization Report:** filter by `room_id` → occupancy % across the week, flags underused/overused special rooms.
- **Teacher Load Summary:** one row per teacher — periods/week assigned vs. max capacity, number of distinct class-sections, gap count — this doubles as an ongoing feasibility-health report even after publishing.
- Filters throughout: Class, Section, Teacher, Day, Date-range (for substitution history), Subject.
- Export: PDF (print-styled, one page per class-section/teacher) and Excel.

---


### 10.4 Print / PDF (Phase 18)

"Print / PDF" was a bare `window.print()` with **no `@media print` stylesheet at all**, so the browser printed the whole application — navy sidebar, top bar, filter row and buttons — with the timetable squeezed into what was left. A printed timetable leaves the app: it goes on a staffroom wall and into a parent's hand, and it has to read as a document.

**The rule is inverted, not enumerated.** Rather than listing what to hide, the screen is wrapped in `.screen-only` and the sheets in `.print-root`; print hides the first and reveals the second. Enumerating what to hide means every screen element added later is one somebody forgot.

**A sheet says on its own face** what the chrome used to say around it: school logo (initials when the ERP has supplied no `logoUrl` — a broken image is worse than no image), school name, the timetable's name, class or teacher, class teacher or weekly load, days, periods/day, cells filled, and whether the sheet is the standing timetable or a dated view with substitutions overlaid. `@page` is A4 **landscape** — a five-to-seven-column week in portrait squeezes teacher names to three lines — and `print-color-adjust: exact` keeps the break shading, elective tint and substitute highlight, all of which carry meaning.

**Print all** renders one sheet per class-section (or per teacher) with `page-break-after: always`, from the same `GridPayload` the screen renders — so a printed week can never disagree with the one on screen, §4.9 electives included. Sheets are fetched four at a time: the reports are Redis-cached (§14), but firing sixty parallel requests at the API is how a report screen becomes an outage. They render into the page rather than a popup, because a popup inherits none of the app's stylesheet and is blocked about half the time; `window.print()` is called after two animation frames, or it prints the previous render — a blank page.

### 10.5 The Subject and Class Colour Code (Phase 20)

A timetable grid is a wall of small text. Colour is what lets somebody find every Maths period in a week at a glance instead of reading forty cells, and it is the first thing a printed timetable is judged on.

**One module chooses every colour** — `packages/shared/src/colors/palette.ts`. If the Board, the Matrix and the report grids each derived their own, Maths would be green on one screen and blue on the next, which is worse than no colour at all: a reader would have learned something untrue. Same discipline as the rules engine — one source, several call sites.

**The palette is 32 swatches: 16 hues × 2 tones**, ordered so consecutive slots differ in *hue* rather than in shade. Each swatch is a light fill plus text that is a **dark shade of that same hue** — never a neutral grey. Both properties are enforced by `palette.spec.ts`, which recomputes every WCAG contrast ratio and every hue gap from the hex values rather than trusting the comment: minimum **5.50:1** on the swatch's own background and **5.96:1** on white, both clear of AA's 4.5:1 with deliberate headroom so a later tweak cannot quietly drop a pair below the line.

**The assignment is set-aware, and has to be.** A name hashes (FNV-1a — byte-identical in every JS runtime, so a colour never depends on which machine drew it) to a preferred slot and takes it; a taken slot probes forward, with names processed in sorted order so the result depends on the *set* and never on the order it arrived in. A bare hash cannot do this: 20 subjects into 32 slots leaves about five sharing a colour with another, and that is the birthday problem, not a palette that is too small. On the reference school the set-aware version gives **20 of 20 subjects and 14 of 14 classes distinct colours**. Adding a subject that hashes to a free slot changes nothing; one that collides can push a single later name along its probe chain.

**Colour the thing the cell is about.** A class's grid headlines the subject, a teacher's headlines the class — so the fill follows the headline instead of becoming a second, competing signal. Classes are keyed on the **class**, not the class-section, so 5-A, 5-B and 5-C read as one family; three shades would spend three palette slots saying one thing.

**Existing meanings outrank colour, and none were painted over.** A **substituted** cell keeps its cyan and its ↺: on a cover sheet "what changed today" outranks which subject it is. A **pinned** card keeps the grey locked fill, because 🔒 is a state you must be able to see across a full board. A **§4.9 elective block** is several subjects at once, so no single colour would be truthful — it keeps its dashed steel tint; but in a *teacher's* row the same block is one option, so it is truthfully that subject's colour. A **merged group** keeps its double border and 🔗, and a **break** its hatching.

**Served from `GET /me/colors`**, which needs a session and no permission. `/subjects` and `/classes` are `masters.manage`, so a teacher reading them is a 403 — and a teacher falling back to a different scheme would see Maths in a different colour from the admin looking at the same timetable. The scheme belongs to the school, not to the role. Names and ids only: a teacher already reads every one of these on their own grid.

**On paper**, `print-color-adjust: exact` is applied to `*`, not just the root. The property does not inherit reliably to descendants across engines — Chrome honours it on the root, Safari and some Chromium builds drop a `<td>` background unless the element itself carries it — and the staffroom wall is the copy most people read.

## 23. ERP Master-Data Sync (Phase 22)

The ERP already owns the school's staff, classes, sections, subjects and sessions, and SSO already proves the two systems agree on who a user is. Retyping the same masters into the timetable is the largest remaining piece of pointless work after the §16 importer removed the first.

### 23.1 It is the import pipeline with a different source

`validateWorkbook(rows, existing)` takes **plain rows, not Excel** — §16 was built that way deliberately. So a sync needs no second import engine, only an adapter that produces the same shape:

```
Excel upload ─┐
              ├─→ RawSheet[] ─→ reconcile ─→ dry-run preview ─→ one transaction
ERP REST API ─┘
```

Everything downstream — reference resolution, duplicate detection, the all-or-nothing commit — is shared. What a sync adds is the middle step: an import only ever *adds*, a sync has to *change* an existing row and, since §23.3, remove one.

### 23.2 The ERP owns identity; the timetable owns scheduling

This is the whole reason a sync is safe to run unattended, and it is a declared table (`packages/shared/src/sync/contract.ts`), not a convention each writer follows.

| | ERP owns | Timetable owns |
|---|---|---|
| Teacher | name, active/left | max & min periods/day, periods/week, period pattern, alternate days, class-teacher rule, engagement type |
| Class-section | strength | which timetable, home room, class teacher |
| Subject | name, code | is-lab, requires double period |
| Class | name, sequence | — |
| Academic year | name, dates, which is current | — |

A sync that overwrote `max_periods_per_day` from a staff master would change the next Generate's output with nothing on any screen saying why. `updatePayload` is built from the *reconciled plan*, not from the incoming row, and `applyUpdate` re-checks the table before writing — so a field the ERP does not own cannot reach the database even if the adapter fetched it.

`employment_type` is deliberately timetable-owned: our enum carries `guest`, a §18 concept the ERP has no equivalent for, and mapping their vocabulary onto it would silently change who may be offered as a substitute.

### 23.3 Deleting is allowed, and it is counted first

The first design never deleted: a teacher who left became `is_active = false`, a row the ERP stopped returning was left alone. That was rescinded — an admin who asks for the ERP's list means the ERP's list, and rows nobody has removed accumulate until Readiness reports demand for staff who left two sessions ago.

What makes deleting safe is not refusing to do it. It is **counting the consequences before anything goes**, and one fact about the schema decides how:

> `timetable_slots` has **no foreign keys to the masters.** Only `school_id` and `draft_id` are constrained. Delete a teacher and MySQL raises nothing, says nothing, and every generated and published timetable quietly becomes rows pointing at a teacher that no longer exists — blank cells on the Board with no error anywhere to explain them. The same is true of `users.teacher_id`, `substitution_log.original_teacher_id` and `substitution_log.substitute_teacher_id`.

So `apps/api/src/sync/dependencies.ts` writes the cascade by hand, under two rules:

1. **A dangling reference is never an acceptable end state.** If a master row goes, everything pointing at it goes with it — including the slot rows the database would have let us abandon, and including `users.teacher_id`, which is *cleared* rather than left aimed at an id that will be reused.
2. **The sync never deletes a timetable.** A `timetable_config`, its periods, its draft registry and its publications are not master data and were not what the admin pressed a button about. Where a removal would require deleting one — replacing an academic session, say — the sync **refuses** and names the timetable.

Every step in that file declares its count and its delete **in one object**. Two separate lists would be free to disagree, and the day they did, the confirmation dialog would under-report a destructive write — the one failure this feature cannot have.

The confirmation is therefore a fact, not a warning: *"This deletes 1 Teachers row and with them 4 timetable slots, 3 subject mappings, 1 class-teacher assignment and 1 teacher login (cleared) — 1 of those slots is in a published timetable."* Then the admin types the school's name.

`fingerprint` binds that consent to the numbers shown. The ERP is somebody else's live system; if its answer moves between the preview and the press, the figures move with it and the token stops matching (§21's compare-and-set discipline).

### 23.3.1 Two modes

| | `refresh` (default) | `replace` |
|---|---|---|
| Matching | on the natural key | none — everything goes |
| Existing rows | updated in place | deleted, re-inserted |
| Rows the ERP no longer has | deleted | deleted |
| Resulting data | identical | identical |
| Row ids | **survive** | all new |

Both end with our rows saying exactly what the ERP says. `replace` is right for a first load and wrong for a live school, because every mapping, timetable row and teacher login that pointed at a re-minted id is left behind. `refresh` reaches the same data without that cost, which is why a missing `mode` field selects it — a destructive default is not something an omission should choose.

Two masters are quieter than they look. **Inactive is not absent:** a teacher the ERP still returns but marks inactive is an *update*, and keeps their row, mappings and substitution history. And a **class-section's `sections` rows** (the A, B, C under a class) are deliberately left behind on a removal — they are the class's own alphabet, not the ERP's, and the next sync reuses them rather than minting duplicates.

### 23.4 The adapter: REST only, described rather than coded

The sync reads the ERP's **REST API and nothing else**. An earlier build also offered a direct read of the ERP's database (`erp-map.ts`, one visible SELECT per master); that came out. Two sources meant two things to keep correct for one job, and an integration that needs database credentials on somebody else's production server is a harder conversation than one that needs a read token.

**What an ERP has to provide.** Nothing exotic, and no changes to how it already works: up to five endpoints returning a JSON array of records for one school, plus one that resolves a school `code` to the ERP's own id. No particular field names, no envelope shape, no pagination style is demanded — all of that is *described* in `ERP_API_FILE` rather than required of the ERP, so integrating is filling in JSON, not changing code (`scripts/erp-api.example.json` is the worked template).

```jsonc
// ERP_API_FILE — the ERP's shape, declared rather than coded
{
  "school": { "path": "/schools?code={code}", "pick": "data.0.id" },
  "sheets": {
    "Teachers": {
      "path":   "/staff?school_id={schoolId}&page={page}",
      "list":   "data",                       // where the array lives; "" = the body IS it
      "fields": { "employeeCode": "employee_code",
                  "name": "profile.full_name", // dotted paths for nested JSON
                  "isActive": "profile.active" },
      "page":   { "from": 1, "lastPagePath": "meta.last_page", "size": 200, "max": 50 }
    }
  }
}
```

**The unit of configuration is one master, not the feature.** A master with no entry is *not configured*: its card says so by name, its button is disabled, and the other four sync normally. An ERP that has a staff endpoint today and a sections endpoint next month is integrated one master at a time. There are no built-in default endpoints — an earlier build shipped plausible Laravel-shaped guesses, and a guessed path that 404s reads as "the ERP is broken" when the truth is "nobody configured this".

Three rules the reader holds to. It issues **GET only** — a sync has no business writing to the ERP, and the surface that cannot do it is the one that never will. A field whose path does not resolve is **omitted, not nulled**, because `changedFields` treats an absent field as "this source does not carry it, leave ours alone" — the difference between a partial API and data loss. And pagination always has a **hard stop**, so a misread page field cannot loop against somebody else's production API.

`GET /sync/erp/probe` calls every configured endpoint for real and reports, per master: whether it answered, how many records, which of our fields the mapping failed to produce **by name and with the path it looked at**, and one record exactly as the ERP returned it — because a wrong mapping is only obvious next to what actually came back. Authentication failures say which setting to fix rather than repeating a 401. `POST /sync/erp/reload` re-reads the mapping file from disk, because integrating is an edit-and-check loop and restarting the service between attempts is a poor one.

### 23.4.1 Every run is logged

`erp_sync_runs` records one row per master per run — mode, status, the endpoint called, rows fetched/created/updated/deleted, duration, the ERP's own error text, and the impact the admin consented to. **Failed and refused runs are logged as loudly as successful ones:** "we synced and nothing changed" and "the sync could not reach the ERP" look identical from the outside and have completely different remedies. A destructive run's `detail` carries what was agreed to, so a question six weeks later about a missing teacher has an answer.

### 23.8 Authenticating to a secured ERP

**The ERP's SSO token cannot be replayed at its API, and shouldn't be.** Three reasons, all facts about this system rather than preferences:

1. **It is single-use.** `AuthService` burns the `jti` in Redis and refuses a replay (§15.1). An ERP worth trusting does the same.
2. **It is a login credential with a short `exp`.** A sync happens minutes or hours after login; a scheduled sync has no user and no token at all.
3. **We do not keep it.** `/sso/callback` verifies it and discards it in favour of our own session JWT — which the ERP has no reason to trust, because *we* signed it.

What does carry over is the useful half. `auth.actingUserHeader` puts the ERP user id of whoever pressed Sync on every outgoing request, so the ERP's own audit log can name them. A scheduled run omits it, and **that absence is meaningful** — the ERP can tell an unattended sync from an admin's. Identity propagated, never a credential replayed.

Authentication is **described in the mapping file**, like the endpoints, and handled by `apps/api/src/sync/erp-auth.ts`:

| mode | credential |
|---|---|
| `oauth2` | client-credentials grant against the ERP's token endpoint |
| `bearer` | a static long-lived token (`ERP_API_TOKEN`, or `ERP_API_KEY_HEADER` + `ERP_API_KEY`) |
| `none` | an unauthenticated API — an internal network, or a stand-in |

```jsonc
"auth": {
  "mode": "oauth2",
  "tokenUrl": "https://erp.example.com/oauth/token",
  "clientId": "edutimetable",
  "clientSecretEnv": "ERP_API_CLIENT_SECRET",   // the NAME of the variable
  "scope": "masters:read",
  "actingUserHeader": "X-ERP-Acting-User"
}
```

**The secret is never in the mapping file** — that file is committed, environment is not. `clientSecretEnv` names the variable holding it, and no error message ever echoes its value, because those messages are shown on screen and written to `erp_sync_runs.error`.

Four properties the token cache holds to, each of which is silent when it works and expensive when it doesn't:

- **One token, many requests.** Five masters syncing at once share one in-flight grant — some providers rate-limit repeated grants, others count each as a session.
- **Refresh while still valid.** The cache expires a token 30 seconds before the ERP would, so a token cannot die between our check and theirs — which would be a 401 in the middle of a write.
- **Never cache indefinitely.** A response without `expires_in` gets a bounded assumed lifetime, not eternity.
- **A 401 is retried exactly once**, after discarding the cached token, so a rotated or revoked credential self-heals. Once, not in a loop: if the credential is genuinely wrong, hammering somebody's token endpoint is how an integration gets blocked.

A missing or refused credential is reported **once, by name** — "the ERP client secret is not set; put it in `ERP_API_CLIENT_SECRET`" — rather than as five identical connection failures on five cards. `isConfigured()` is defined as "nothing to complain about", so the boolean the screen greys a button on and the sentence it prints cannot disagree.

### 23.5 Scope and tenancy

The endpoints (`status`, `probe`, `preview`, `apply`, `reload`, `logs` — all `masters.manage`) take **no id from the request**. The school comes from the session, and the ERP is read using that school's `code` — the identifier §15.1 already establishes as the contract between the two systems. A body-supplied code would be a way to pull another school's staff master into this one.

`preview` writes nothing. `apply` recomputes the plan from the ERP and our own tables, so a stale preview can never become the list of writes (§16's rule, and §21's) — the request carries the master, the mode and the confirmation, never the rows. `erp_sync_runs` is scoped like every other table, so a school's history is its own.\n\nThe route family's §17.8 exemption is earned by `erp-sync-smoke.cjs` step 13: two schools against one stand-in ERP, each asserting it sees, writes and logs only its own rows.

---

## 11. Rule-Based Intelligence vs AI — Summary Table

| Capability | Technique |
|---|---|
| Guarantee 100% generation | Feasibility pre-checks (Hall's theorem-based) + CSP backtracking + local-search repair fallback |
| "What should I fix next" | Deterministic rule engine mapping each failed check to a specific master-data row + fix action |
| Overload detection (teacher/class) | Arithmetic aggregation, real-time, on every master-data edit (not just at generation) |
| No double-booking, ever | Database-level UNIQUE constraints (not just app logic) + client + server dual validation |
| Substitute matching | Weighted bipartite matching (Hungarian/greedy augmenting path) |
| Explaining *why* something failed, in plain English | LLM layer, fed the structured constraint-check result (never invents constraints itself) |
| Natural-language bulk data entry | LLM extraction → structured confirmation screen → normal DB writes |
| Drag-and-drop legality + suggestions | Same constraint-check functions as the solver, run ad-hoc per cell in real time |

---

## 12. Build Phases (Recommended Roadmap)

1. **Phase 1 — Masters + Config + Feasibility Engine.** Get the "Readiness Score" live and accurate before writing a single line of solver code — this is the module that makes the product feel intelligent immediately, and it de-risks everything after it.
2. **Phase 2 — Core CSP Solver + Draft generation + Full Allocation Matrix view (read-only first).**
3. **Phase 3 — Drag-and-drop editing with live validation + Publish workflow.**
4. **Phase 4 — Substitute Teacher Engine.**
5. **Phase 5 — Reports + Notifications + LLM explanation layer.**
6. **Phase 6 (optional) — OR-Tools CP-SAT swap-in for soft-optimization goals (workload balancing, gap minimization) once the school wants more than pure feasibility.**
7. **Phase 7 — AI Assistant (role-gated conversational layer).** Natural-language querying over the timetable, AI-generated reports, and a configurable AI-provider settings screen — see §13. Built last deliberately: it consumes the query/report APIs the earlier phases already expose, so it adds zero new data-access paths.

---

## 13. Phase 7 — AI Assistant Module (Chat, AI Reports & Provider Configuration)

A conversational layer that lets authorized staff ask anything about the timetable in plain language — *"What is Mrs. Sharma's load this week?"*, *"Which teachers are free Friday Period 6?"*, *"Which lab is most underused?"* — and generate reports from chat. This module is **strictly read-only and role-gated**: it queries, explains, and composes reports; it never places, moves, or publishes a slot (per §5.7, placement stays with the CSP solver).

### 13.1 Architecture — tool-calling, never raw SQL

The LLM must never generate SQL or receive raw table dumps. It operates through **function calling (tool use)** against a whitelist of read-only query tools that wrap the exact same service functions the Reports module (§10) already uses:

```
User question ──▶ AI Gateway (NestJS module)
                    │  1. AuthZ check: role has ai.chat permission
                    │  2. Injects school/timetable-config scope into every tool call
                    ▼
                  LLM (provider from ai_settings) with tools:
                    getClassSectionTimetable(class_section_id, status)
                    getTeacherTimetable(teacher_id, status)
                    getTeacherLoadSummary(teacher_id?)          -- all teachers if omitted
                    getFreeTeachers(day_of_week, period_number)
                    getRoomUtilization(room_id?)
                    getFreePeriods(class_section_id | teacher_id)
                    getSubstitutionHistory(date_from, date_to, teacher_id?)
                    getReadinessStatus()                        -- current blockers/warnings (§4)
                    getTimetableConfigs()                       -- wings, timings, status
                    generateReport(report_type, filters, format) -- renders via §10 pipeline → PDF/Excel
                    ▼
                  Tool results (structured JSON, scope-filtered server-side)
                    ▼
                  Streamed answer over the existing Socket.IO channel
                  (token-by-token, with a visible "queried: …" trace per tool call)
```

Key properties:
- **Scope injection is server-side:** the gateway stamps `school_id` (and the user's permitted `timetable_config_id`s) into every tool execution — the model physically cannot query outside the user's scope, regardless of what the prompt says.
- **Tools mirror §10's report queries** — one rules/query layer, now four call sites (solver, drag-drop, reports, AI). No new data-access surface to audit.
- **Streaming is mandatory** for chat UX; long answers stream over the same Socket.IO infrastructure used for solver progress (§2).
- **Report generation from chat:** when the model calls `generateReport`, the server renders the *existing* report template (§10) with the model-chosen filters and returns a download link — the LLM composes the request and narrates the result; it never fabricates report contents. The chat shows a report card with PDF/Excel buttons.
- **Grounded answers only:** the system prompt instructs the model to answer exclusively from tool results and to say "I don't have that data" otherwise; every numeric claim in the answer should be traceable to a tool result shown in the collapsible trace.

### 13.2 AI Provider Configuration (admin-configurable, encrypted at rest)

```sql
CREATE TABLE ai_settings (
  id INT PRIMARY KEY AUTO_INCREMENT,
  school_id INT NOT NULL,
  provider ENUM('anthropic','openai','google','azure_openai') DEFAULT 'anthropic',
  model VARCHAR(60) DEFAULT 'claude-opus-5',
  api_key_encrypted VARBINARY(512) NOT NULL,   -- AES-256-GCM, key from env/KMS; never stored or logged in plaintext
  api_base_url VARCHAR(255) NULL,              -- for Azure/self-hosted gateways
  monthly_token_budget INT NULL,               -- hard stop + banner when exceeded
  features JSON,                               -- {"chat":true,"reports":true,"nl_data_entry":false,"conflict_explain":true}
  is_active BOOLEAN DEFAULT TRUE,
  updated_by INT, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE ai_chat_log (                      -- full audit trail, required
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  school_id INT NOT NULL, user_id INT NOT NULL,
  conversation_id CHAR(36) NOT NULL,
  role ENUM('user','assistant','tool') NOT NULL,
  content MEDIUMTEXT,
  tools_called JSON NULL,                      -- which tools ran, with which (scoped) args
  input_tokens INT, output_tokens INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

- **Default & recommended provider:** Anthropic via the official `@anthropic-ai/sdk` (TypeScript), model `claude-opus-5`, adaptive thinking enabled (`thinking: {type: "adaptive"}`), streaming on.

- **The provider abstraction is real, not aspirational.** `apps/api/src/ai/providers/` defines a vendor-neutral contract — system prompt, turn history, whitelisted tools, streamed text, token counts — and the chat gateway drives conversations in those terms rather than in any one vendor's message shape. Each adapter translates to and from its own wire format; anything a single provider does uniquely (Anthropic's thinking blocks, Gemini's safety settings) stays inside its adapter. The same grounding prompt, the same §13.1 tool registry and the same audit trail therefore apply whichever provider a school picks.

  `providers/index.ts` is the single catalogue — which providers are wired, their models, their environment-variable fallbacks and their list prices. `GET /ai/settings` returns it, so the AI Settings screen cannot drift from what the gateway actually speaks, and adding a provider is an adapter plus one entry.

- **Wired today: Anthropic (Claude) and Google (Gemini).** OpenAI and Azure OpenAI are listed and selectable but marked "not yet wired"; choosing one stores the setting and the screen says plainly that the key will not be used.

- **Google Gemini** talks the Generative Language REST API directly (`fetch`, SSE streaming) rather than through an SDK — the surface needed is four stable things (system instruction, contents, function declarations, streaming), and it keeps the api image free of another dependency to track alongside Anthropic's. Five differences the adapter absorbs, each of which failed silently before it did:
  - **CRLF event framing.** Google separates SSE events with `\r\n\r\n`. A reader looking for `\n\n` finds no boundary (there is a `\r` between the two newlines) and yields *nothing at all* — no text, no tool calls, no token counts, and an empty answer bubble with no error to explain it. The splitter accepts CRLF, LF and CR, and is tested against captured output.
  - **Thinking tokens are billed as output but reported separately.** `usageMetadata.thoughtsTokenCount` sits alongside `candidatesTokenCount`; counting only the latter under-reported a turn by roughly fifty times in practice, which would make the §13.2 budget meaningless. Both are summed.
  - **Thought signatures must be replayed.** Gemini 3.x attaches an opaque `thoughtSignature` to the parts of its turn, and a follow-up request replaying a `functionCall` without it is rejected outright. The adapter keeps the model's own parts verbatim (`providerRaw` on the neutral message) and replays those, rather than rebuilding parts from the neutral fields — which would drop the signature, and would have to guess which parts carry one.
  - **No tool-call ids.** Gemini correlates a `functionCall` with its `functionResponse` by function *name*; ids are synthesised so the neutral contract still holds.
  - **A stricter schema dialect.** Function parameters are an OpenAPI 3.0 subset, not full JSON Schema: `minimum`, `maximum` and `additionalProperties` are rejected outright, and a single one of them fails the *whole* request — taking the entire tool registry down, not one tool. §13.1's definitions use some of those, so they are translated rather than dropped: a numeric range moves into the description, which is what actually steers the model. An `OBJECT` with empty `properties` (the no-argument tools) omits the key entirely. Unit-tested against the real registry.

  A turn that yields neither text nor a tool call now **throws** rather than returning empty — the usual cause is a thinking model spending its whole output budget on reasoning, and the error says so and suggests a lighter model. The Ask AI screen likewise replaces a blank answer with an explanation instead of an empty bubble: a silent blank reads as "broken" with no way to tell why.

- **Keys are per provider.** Whichever key a school stores is used for its chosen provider; with none stored, the fallback is that provider's own environment variable (`ANTHROPIC_API_KEY`, or `GEMINI_API_KEY` / `GOOGLE_API_KEY`) and the screen names which one it found. Switching provider without naming a model resets the model to the new provider's default — a Claude model left selected against Gemini fails at the first request with a confusing "model not found".

- **The model list is asked of the provider, not hardcoded.** `GET /ai/settings/models` calls the provider's own model-listing endpoint with the school's key (Gemini's `GET /v1beta/models`, filtered to those supporting `generateContent`; Anthropic's `models.list`), and the AI Settings screen has a **Refresh from provider** control beside the model picker. The catalogue in `providers/index.ts` is a **fallback** for when there is no key yet or the provider cannot be reached, and the response says which of the two it returned.

  This exists because the alternative failed in practice: the catalogue was written from a stale snapshot and offered Gemini 2.5 models for months after the 3.x line shipped. A hardcoded list is only ever as current as whoever last edited it, and providers ship faster than that.

- **Pricing is per model, not per provider.** `gemini-3.5-flash-lite` is $0.30/$2.50 per million tokens against `gemini-3.5-flash` at $1.50/$9.00 — a fivefold spread, so a single per-provider figure would overstate a flash-lite school's spend by that much on the usage meter. `priceFor(provider, model)` resolves the model's own price and falls back to the provider's headline figure for anything newly released or discovered live.
- **"Test Connection"** on the settings screen fires the cheapest round trip the chosen provider offers, with the entered key, before saving; the key is write-only in the UI (masked, never echoed back) and is stripped from any error text the provider returns. Verified by `scripts/ai-providers-smoke.cjs`, which stores a deliberately invalid Gemini key and asserts the failure that comes back is *Google's own message* — proof the request really went to Google and not quietly to Anthropic.
- **Cost visibility:** the settings screen shows month-to-date tokens/queries/estimated cost from `ai_chat_log` aggregates; crossing `monthly_token_budget` disables chat with an explanatory banner (admins with `ai.configure` can raise it).
- Same LLM plumbing serves the earlier LLM use cases (§5.7): conflict explanations, NL data entry (still confirmation-gated), substitute rationales — each individually toggleable in `features`.

### 13.3 Role-Based Access Control (server-enforced, not UI-hidden)

Three distinct permissions, assignable per role on the AI Settings screen:

```sql
CREATE TABLE roles (
  id INT PRIMARY KEY AUTO_INCREMENT,
  school_id INT NOT NULL,
  name VARCHAR(50)                -- 'Super Admin','Principal','Timetable Admin','Teacher','Front Office'
);
CREATE TABLE role_permissions (
  role_id INT NOT NULL REFERENCES roles(id),
  permission VARCHAR(40) NOT NULL, -- 'ai.chat' | 'ai.reports' | 'ai.configure' (+ existing app permissions)
  PRIMARY KEY (role_id, permission)
);
```

- `ai.chat` — see the **Ask AI** screen and query the assistant.
- `ai.reports` — allowed to trigger `generateReport` from chat (a chat-only user without it gets answers but no file exports).
- `ai.configure` — see the **AI Settings** screen: provider, key, budget, feature toggles, and the role-access matrix itself.
- **Enforcement is middleware on every AI endpoint** (REST + the Socket.IO chat namespace) — hiding the nav item is cosmetic; the guard is server-side. Defaults: Super Admin gets all three; Principal and Timetable Admin get `ai.chat` + `ai.reports`; Teacher and Front Office get none until explicitly granted.
- Every conversation is attributable (`ai_chat_log.user_id`) and reviewable by `ai.configure` holders.

### 13.3.1 Rendering the answer

The assistant replies in Markdown, and most of what it has to say **is a table** — a class's week, a teacher's load, a room's utilisation. The chat bubble originally printed the raw string inside `white-space: pre-wrap`, so every one of those arrived as pipe soup the reader had to parse by eye.

`apps/web/src/markdown.tsx` renders it. Two properties matter more than the feature:

- **It emits React elements, never HTML.** No `dangerouslySetInnerHTML` anywhere. Model output is shaped by tool results, which come from the database; treating any of it as trusted markup would put an injection on a page already holding an admin's session. A renderer that can only produce elements cannot inject — asserted directly, with `<script>` and `<img onerror>` payloads both in prose and inside a table cell.
- **It survives half a document.** Answers stream token by token, so it is called on a table with no delimiter row yet, an unclosed `**`, an unterminated fence. A header line alone stays a paragraph and only becomes a table once its shape is known, so a streaming answer never flickers between the two.

It is a deliberately small subset (tables, headings, emphasis, lists, code, quotes, rules) rather than a Markdown library: react-markdown + remark-gfm is ~100KB against a `dependencies` list of six, and anything unrecognised falls through as plain text — the previous behaviour, so the worst case is no worse than before. `scripts/md-render-check.mjs` compiles the real component and renders it with `react-dom/server`, since the web app has no test runner and adding one for a single component was not this change's decision to make.

### 13.5 Natural-language master-data entry (Phase 24)

§12 always listed this — *"natural-language bulk data entry (with confirmation screen)"* — and the confirmation screen is not a nicety in that sentence, it is the mechanism. **The LLM never writes.** It drafts rows; a human applies them.

**A third source into one pipe.** `validateWorkbook(raw, existing)` takes plain rows, which is why §23's ERP sync could reuse it instead of growing a second validator. AI entry is the third:

```
Excel upload ─┐
ERP REST API ─┼─→ RawSheet[] ─→ validate ─→ preview ─→ one transaction
AI prompt ────┘
```

So duplicate detection, cross-sheet reference resolution, `did you mean 'Mathematics'?`, the §4.8 block rule and the weekly-capacity guard all apply to a drafted batch unchanged — not because they were re-implemented for the assistant, but because it is the same code. A separate validator for the AI path would eventually disagree with the Excel one, and the disagreement would be silent.

**One tool, not six.** `draftMasterData` takes several sheets in one call because the validator is cross-sheet: "Class 6 with sections A–D" is Classes *and* Class Sections in one batch, and splitting them would make the sections reference a class that does not exist yet.

**The adapter.** `RawSheet` cells are keyed by header text (`"Employee Code"`), which a model reproduces unreliably and fails at *silently* — the cell just reads blank. `packages/shared/src/ai/data-entry.ts` accepts either the header or the field key, in any casing or spacing, and **reports a key it cannot place** rather than dropping it. Its column guide is generated from the import contract, so a column added to the importer is one the assistant knows about on the next build.

**Apply takes a proposal id, never rows.** The batch is stashed under `s{schoolId}:aiproposal:{id}` with a 30-minute TTL, re-validated at the moment of the write, deleted on success. Nothing a browser holds can become a write; another school's id is simply not found; and a refresh cannot apply the same batch twice.

**Authority.** `masters.manage`, not a new AI permission — the assistant is a different way to exercise an authority the user already has on a screen, never a way around it. The tool is filtered out of the model's tool list for anyone lacking it, and refused again inside the handler.

#### 13.5.1 Changing what already exists (Phase B)

Phase A could only add; a row the school already had came back as "already exists". That is right for an Excel upload, which promises never to overwrite hand-entered data, and wrong for a conversation — *"make Class 5's English six periods"* is the commonest thing anyone says.

**The natural key is never writable.** `UPDATABLE` in `data-entry.update.ts` is the whole of the assistant's authority over existing rows, and every sheet's key columns are absent from it. A changed key reads as a **new row**, not a rename, and the preview says so.

**A field the draft did not mention is not a change.** This is the subtle one, and it is where the first implementation was wrong. `validateWorkbook` returns a *fully populated* row — every column, with defaults filled in for the ones nobody typed — so a diff computed against it reported a change for every untouched field, including a `null` for each blank optional column. Applied, that would have wiped nine fields on a teacher to change one. The adapter now records **which fields the draft actually named** (`mentioned`), and only those are candidates. An omission means "leave it", never "set it to null" — the same rule §23's reconcile engine holds to, for the same reason.

**The diff is computed against the database, in the API layer.** The shared validator knows a row *exists* — it matches names — but not what it currently contains, so it cannot produce `old → new`. Keeping that in the API layer leaves the Excel path untouched.

**Re-planned at the moment of the write**, never taken from the stash: a diff computed half an hour ago is not the diff that should be written now.

**`Subject Mapping` stays add-only.** One drafted row expands to a mapping per class-section and may carry a merged group, so "the row" is not one database row. Updating it needs the expansion logic the importer already owns, and a second copy of that is how the two would come to disagree.

**What it may never do.** Delete anything, ever. Change a natural key. Touch a slot, a publication, a role, an academic year, a room or an elective block. Those are decisions made on a screen, not dictated into a chat box.

#### 13.5.2 The sheet where one row is not one row (Phase C)

`Subject Mapping` was held back from Phase B for a reason worth stating plainly: **one drafted row is not one database row.** A row naming three class-sections creates three `teacher_subject_class_section` rows; the same row with `Merged = Yes` creates a single `merged_teaching_group` with three members instead. Until the row is expanded the way the importer expands it, `change this row` has no referent.

`apps/api/src/ai/data-entry.mapping.ts` does that expansion and nothing else does — a second copy is precisely how the assistant and the importer would come to disagree about what a row means.

**Expand first, diff second.** A row becomes *units*: one per class-section for a plain mapping, one for the whole row when merged. Each unit is matched on its own key and diffed on its own.

**The key is still never writable — but the key differs per unit.** A plain mapping is keyed `(subject, class-section)`, so the *teacher* is a value; that is what makes *"move Class 5-A maths to Rekha"* an edit rather than an impossibility. A merged group is keyed `(subject, teacher, member sections)` — the importer's own dedupe key — so on that side the teacher is part of the identity and cannot move. Same principle, opposite answer, because the two tables are keyed differently. A draft that tries it is **refused by name**, because the importer would otherwise create a second merged group over the same children and nobody would notice until the solver double-booked them.

**The validator had to stop throwing information away.** A row naming five sections where two are already mapped has those two *removed* from `classSections` so the committer leaves them alone. For an Excel upload that is the end of the story — it never overwrites. Phase C needs exactly the half that was taken away, so `ValidatedRow` gained `existingParts`: the natural-key parts that already exist. Recomputing it downstream would have meant a second copy of the matching rules.

**The §18 and capacity guards run at PLAN time.** `assertCanTeach` / `assertCanOwnClass` and `assertWithinWeek` are the same functions the Mapping and Class-Teacher screens call, and a conversation must not be a way round either. Running them while planning turns *"the Apply button exploded"* into a named problem on the preview beside the row that caused it — and they run **again at apply**, because the world may have moved in between.

**`Class Teachers` rides along** as a seventh draftable master: one pointer on a class-section that already exists, governed by the same §18 check, and the thing people ask for in the same breath as a mapping.

**`listSubjectMappings`** is the read tool that makes any of it draftable. `Periods/Week` is a required column on that sheet, so changing only the teacher still means sending the periods already stored — and a model with no way to look it up would guess, silently rewriting it. Scoped like every other read.

**A batch that only changes rows now invalidates readiness.** `applyValidated` returns early when there is nothing to *create*, and its `readiness.invalidate` sat after that return — so the whole of Phases B and C left the Readiness Score cached at its old value. Changing a curriculum row's periods per week is about as direct a change to readiness as exists.

### 13.4 UI — two screens (added to §8's list as screens 11 & 12)

11. **Ask AI (chat)** — full-height chat panel: streaming assistant messages; a collapsible "queried: getTeacherLoadSummary …" trace chip on each grounded answer; small rendered tables for tabular answers; report cards (title + PDF/Excel buttons) when a report is generated; suggestion chips for common questions; a scope selector (which timetable/wing the conversation is about, defaulting to the top-bar selection); "AI can read the timetable, never change it" notice in the header.
12. **AI Settings** — provider & model card (provider select, model select, masked API key + Test Connection, status badge); feature toggles; monthly budget with a usage meter (tokens, queries, est. cost this month); and the **role access matrix** (roles × `ai.chat`/`ai.reports`/`ai.configure` checkboxes). Visible only with `ai.configure`.

Both screens follow the existing design system (`timetable-ui-mockup.html`) and are present in that mockup under the "Intelligence" nav group.

---

## 14. Performance Budget (hard NFR — every transactional page & report ≤ 1 second)

**The rule:** every transactional screen (masters CRUD, wizard steps, readiness dashboard, allocation matrix, draft board interactions, publish, substitute center) and every on-screen report must render usable content in **≤ 1 second at p95** under realistic load (50 class-sections, 2,000 slots, ~40 concurrent admin users). This is a release gate, not an aspiration — a page over budget is a bug.

### 14.1 Per-layer budgets (how 1s is spent)

```
End-to-end p95 ≤ 1000 ms =
  API response (p95)        ≤ 300 ms   (DB query ≤ 100 ms + serialization)
+ network                   ≤ 100 ms
+ client render to usable   ≤ 600 ms   (first meaningful paint of the grid/table)
```

### 14.2 What makes the budget achievable (design decisions, already in this spec)

- **Everything heavy is already off the request path:** solver runs (§2, §5) and bulk notification fan-out (§9) are BullMQ background jobs — no page ever waits on them.
- **Indexes are mandatory, not optional:** every query filters on indexed columns; the §3 unique keys double as covering indexes for slot lookups. Every new query ships with an `EXPLAIN` check — no full table scans on `timetable_slots` (the largest table, still only ~thousands of rows per school; index-hit queries are single-digit ms).
- **Redis caching for computed views:** readiness results (§4, already cached), the published-timetable matrix per config (invalidated on publish/substitution — not per-request recompute), and report aggregates (room utilization, teacher load summary) cached with event-driven invalidation on the relevant `masters.changed` / `slots.changed` events.
- **Virtualized rendering:** the 50×40 matrix and all large tables use react-window/AG Grid (§8.3) — DOM stays small regardless of data size; grids paint progressively (visible rows first).
- **Payload discipline:** list endpoints paginate; the matrix endpoint returns a compact slot array (ids + display strings), not nested ORM object graphs; report endpoints return render-ready rows, computed in SQL/cache, never assembled client-side from N calls (no N+1 — batch/`IN` queries or joins only).
- **Instant-feel interactions:** drag-drop legality is client-side first against the in-memory matrix (§7.1 — 0 ms perceived), server revalidation async on drop-confirm.
- **Exports are the one sanctioned exception:** on-screen reports must meet 1s; **file generation** (multi-page PDF, Excel) may exceed it but must acknowledge within 1s (job queued → progress → download ready notification, reusing the §2 job/WebSocket infrastructure). Same for AI chat (§13): streaming must *start* fast; total answer time is not page-budgeted.

### 14.3 Enforcement (how it stays true)

- **Perf tests in CI:** load tests (k6/autocannon) against the seeded 50-section school assert p95 budgets on the critical endpoints (matrix load, each report, readiness, board fetch, substitute matching). A budget regression fails the pipeline like a failing unit test.
- **Runtime observability:** API latency histograms per route + slow-query log (>100 ms) reviewed as part of every phase's exit criteria; the Teacher Load / report screens display server timing in dev builds.
- **Review gate:** any PR adding a query, endpoint, or screen states its measured latency in the PR body (see `/review-code` and `/git-workflow`).

---

## 15. Edunext ERP SSO & Role/Permission Model

The Timetable application has **no login screen of its own**. Users authenticate once in the existing Edunext ERP; clicking the **Timetable** menu item there opens this application via SSO. Inside the app, a dedicated **Roles & Responsibility** page lets the Admin control exactly who can see and do what — down to "a teacher sees only their own timetable and their class's timetable."

### 15.1 SSO flow (ERP → Timetable)

```
1. User logs into Edunext ERP (existing auth, untouched).
2. User clicks "Timetable" in the ERP menu.
3. ERP issues a short-lived signed SSO token (JWT, RS256) — see the claim
   contract below.
4. Browser opens the Timetable app at /sso/callback?token=...
5. Timetable backend: verifies signature (ERP public key) + exp + single-use nonce
   (Redis, replay protection) → finds-or-provisions the local user row → maps
   erp_role → timetable role (mapping table below, Admin-overridable) → issues the
   Timetable app's own short session JWT (also used for the Socket.IO handshake).
6. An invalid/expired token, or a deactivated user, lands on a "return to ERP" page —
   never a local password form. Logout / ERP session end invalidates the app session.
```

**Token claims (the ERP integration contract).** The ERP is the source of truth for school identity — the Timetable app never hardcodes or invents a school name:

```jsonc
{
  "erpUserId": "E-1042",              // required — identity link
  "name": "R. Sharma",                // required
  "email": "rsharma@school.edu",      // required
  "erpRole": "TEACHER",               // required — mapped to a timetable role
  "teacherId": 42,                    // optional — set for teacher logins (§15.3 scoping)

  // The school this session opens in. `code` is the contract: it is the ERP's
  // stable identifier and the only one meaningful across databases, since
  // numeric ids repeat between them. The rest is descriptive and is refreshed
  // on EVERY login, so renaming a school in the ERP renames it here.
  "school": {
    "code": "SCH-001",                // required
    "name": "St. Xavier's High School", // required
    "shortName": "SXHS",              // optional
    "logoUrl": "https://…",           // optional
    "timezone": "Asia/Kolkata",       // optional
    "address": "…"                    // optional
  },

  // Optional — present when the school belongs to a trust (§17, scenario 2).
  "trust": { "code": "TR-07", "name": "Xavier Education Trust" },

  // Optional — every school this user may work in. A trust administrator gets
  // several; this is exactly what the in-app school switcher offers, and the
  // server will not switch to anything outside it.
  "schools": [
    { "code": "SCH-001", "name": "St. Xavier's High School" },
    { "code": "SCH-002", "name": "St. Xavier's Primary" }
  ],

  "jti": "…",                         // required — single-use nonce, replay-checked
  "exp": 1234567890                   // required — now + 60s
}
```

A school named on the token that this deployment has not seen is **provisioned on the spot**: the `schools` row is created, its permission registry and ERP role mappings are seeded (so its users can sign in immediately), and it is registered in the control-plane tenant registry (§17.3). Every school in `schools[]` is provisioned the same way, so a trust administrator's switcher is populated on first login.

> **Backward compatibility.** A legacy `schoolId` number is still accepted when `school` is absent, but only to *find* a school that already exists — a number carries no name, so nothing can be provisioned from one. A token naming an unknown numeric school is refused with a message telling the ERP to send the code and name.

```sql
CREATE TABLE users (
  id INT PRIMARY KEY AUTO_INCREMENT,
  school_id INT NOT NULL,
  erp_user_id VARCHAR(50) NOT NULL,          -- identity link to the ERP
  name VARCHAR(100), email VARCHAR(120),
  teacher_id INT NULL REFERENCES teachers(id), -- set for teacher users: powers scoped views
  role_id INT NOT NULL REFERENCES roles(id),
  is_active BOOLEAN DEFAULT TRUE,
  last_login_at TIMESTAMP NULL,
  UNIQUE KEY uq_erp_user (school_id, erp_user_id)
);

CREATE TABLE erp_role_mappings (              -- ERP role → default timetable role
  id INT PRIMARY KEY AUTO_INCREMENT,
  school_id INT NOT NULL,
  erp_role VARCHAR(50) NOT NULL,             -- 'ADMIN','PRINCIPAL','TEACHER','FRONT_OFFICE',...
  role_id INT NOT NULL REFERENCES roles(id),
  UNIQUE KEY uq_erp_role (school_id, erp_role)
);
```

Provisioning is **sync-on-login**: name/email/teacher link refresh from the token each SSO entry; the timetable **role**, once overridden by an Admin on the Roles & Responsibility page, is not overwritten by the mapping default.

### 15.2 Permission registry (app-wide, one model)

`roles` / `role_permissions` (§13.3) are the single permission store for the whole app — the AI permissions are just three entries in this registry. Full registry:

| Permission | Grants |
|---|---|
| `masters.manage` | Setup wizard + all master-data CRUD |
| `timetable.generate` | Run feasibility/generation |
| `timetable.edit` | Drag-drop editing, locking, auto-fill |
| `timetable.publish` | Publish workflow |
| `timetable.view.own` | View **own** teacher timetable (requires `users.teacher_id`) |
| `timetable.view.class` | View timetables of class-sections **linked to the user**: sections they teach in (`teacher_subject_class_section`) or are class teacher of (`class_sections.class_teacher_id`) |
| `timetable.view.all` | View every class-section/teacher/room grid (matrix, boards, all reports) |
| `substitute.manage` | Mark absences, confirm substitutes |
| `reports.view` / `reports.export` | On-screen reports / PDF-Excel export (scoped by the view.* level held) |
| `notifications.view` | Notification center |
| `roles.manage` | The Roles & Responsibility page itself |
| `ai.chat` / `ai.reports` / `ai.configure` | §13.3 — AI answers are additionally filtered by the user's `view.*` scope |

**Default role → permission sets** (editable on the Roles & Responsibility page):
- **Super Admin:** everything, incl. `roles.manage`.
- **Principal:** all `view.all`, reports, notifications, `ai.chat`/`ai.reports`; no masters/edit/publish by default.
- **Timetable Admin:** everything except `roles.manage` and `ai.configure`.
- **Teacher:** `timetable.view.own` + `timetable.view.class`, `reports.view` (scoped), `notifications.view`. Nothing else.
- **Front Office:** `substitute.manage`, `timetable.view.all` (read-only screens), `notifications.view`.

### 15.3 View scoping — enforced in the query layer, not the UI

The three `timetable.view.*` levels are **row-level scope filters injected server-side** into every timetable/report query (the same injection pattern as the AI gateway, §13.1 — one scoping module, used by REST, Socket.IO, reports, and AI tools):

```
scope(user) =
  view.all   → no filter
  view.class → class_section_id IN (sections user teaches ∪ sections user is class teacher of)
  view.own   → teacher_id = user.teacher_id   (teacher-dimension views)
  none       → empty set (403 on any timetable data request)
```

So a logged-in **teacher** sees: **My Timetable** (their own weekly grid, free periods marked, today's substitutions overlaid) and **My Classes** (the class-section grids they're linked to) — and nothing else: no other teachers' grids, no matrix, no drafts (draft-status data additionally requires `timetable.edit` or `timetable.generate`). The UI hides what the role can't reach, but the guard is the server-side scope filter — a hand-crafted API call returns 403/empty, never leaked rows.

### 15.4 Roles & Responsibility screen (Admin-only, `roles.manage`)

A dedicated administration page, separate from the setup wizard:

- **Roles list** — the five defaults + "＋ Add Custom Role" (e.g., "Exam Cell"); rename/deactivate custom roles; defaults can be edited but not deleted.
- **Permission matrix** — roles × the full registry above, grouped by module (Build / Manage / View & Reports / AI / Administration), with the three-level view-scope shown as a radio group (Own / Own + linked classes / All) rather than three raw checkboxes.
- **ERP role mapping** — table mapping incoming `erp_role` values to timetable roles (drives provisioning defaults, §15.1).
- **User overrides** — per-user role reassignment (e.g., one teacher is also the timetable-in-charge), plus the teacher-record link (`users.teacher_id`) with an "unlinked teacher login" warning, since scoped views depend on it.
- **Audit** — every change to roles/permissions/mappings is logged (who, what, when) and takes effect on the user's next request (permission cache in Redis, invalidated on save).

Changes here are enforced by the same guard middleware on every REST endpoint and Socket.IO namespace (§13.3) — screen visibility is cosmetic; the server is the authority.

---

This is the complete architecture. If you want, I can go deeper on any single module next — for example, a full working TypeScript implementation of the Phase A feasibility engine, the exact backtracking solver code, or fully-styled React components for the drag-and-drop board.

---

---

## 16. Master Data Import (Phase 8)

Typing a real school's masters through the Setup Wizard is hundreds of rows and the single biggest onboarding barrier — schools already hold this data in spreadsheets. §16 adds a **one-file import**: download a pre-formatted workbook, fill it, upload once.

The design principle is that this is a **validation engine that happens to write rows**, not a parser that hopes for the best. Its promise — *no wrong, duplicate, or garbage data can enter* — is enforced by six stages, each producing issues that name the exact sheet, row, cell, value and fix (the same contract §4 uses for feasibility blockers).

### 16.1 The workbook

One sheet per master, ordered by dependency, plus `Instructions` and `Reference` sheets. Humans type **names, never ids** — the importer resolves them, and a reference may point at a row being added in the same upload. `packages/shared/src/import/contract.ts` is the single declarative definition that drives the template generator, the parser, the validator and the docs.

The template is generated with exceljs: locked styled headers, frozen panes, a note on every heading, real dropdowns on every enum column, blue-tinted required columns, and greyed `e.g.` sample rows the importer ignores. **Export current masters** produces the same workbook filled with the school's data, so it doubles as a backup and a bulk-edit round trip.

### 16.2 Validation stages

- **A Structural** — file type and size; workbook opens; headers matched **by name, not position**, so columns may be reordered or hidden; missing required columns named; unknown columns ignored with a note.
- **B Cell** — trim, collapse whitespace, strip control characters; required-ness; coercion of Excel dates (objects, serials, dd/mm/yyyy), numbers-as-text, and booleans (`Yes/Y/TRUE/1`); enum membership with a nearest-match suggestion; numeric ranges; and **string length against the exact `VarChar` limits** — the main garbage guard.
- **C Duplicates** — within-file on each natural key, naming *both* rows; against the database → classified **skip**, never overwrite.
- **D References** — resolved case-insensitively against *this workbook ∪ the database*, with a Levenshtein "did you mean 'Mathematics'?" and the sheet where the value should be defined.
- **E Business rules**, reusing what the app already enforces: the §4.8 block rule, weekly capacity (§3.10), merged groups needing ≥2 sections, `alternate_day` requiring a day-set, and class teachers having to be active.
- **F Feasibility preview** — the dry run reports the current Readiness score so the admin can see what the import is working toward.

**Every row reports all of its independent problems at once** rather than one per upload cycle: a reference error does not mask a block-overflow error in the same row.

### 16.3 Guarantees

- **Dry run first, always.** `POST /import/dry-run` never writes. The preview shows, per sheet, rows read / to add / already exist / errors.
- **All-or-nothing.** One error anywhere blocks the entire import; `POST /import/commit` re-parses and re-validates the uploaded bytes rather than trusting a plan held by the client, then writes everything in **one transaction** in dependency order.
- **Idempotent.** Natural-key matching means re-uploading the same file is a no-op — verified by `scripts/import-smoke.cjs`.
- **Fix in place.** `POST /import/annotate` returns the uploaded file with an `Import Errors` column per sheet and the offending cells tinted red.
- Endpoints are `masters.manage`-gated, capped at 10 MB and 5,000 rows per sheet, and `readiness.invalidate()` runs once at the end.

---

## 17. Multi-School / Multi-Tenancy (Phase 9)

One deployment serves many schools. The three shapes a customer can present — a single school, a trust group running several schools, and a school that requires its own database with its own credentials — are **not three architectures**. They are two physical modes behind one tenant registry:

| Deployment shape | Mode | Mechanism |
|---|---|---|
| Each school its own DB + credentials | `dedicated` | the registry holds an encrypted connection URL per school; requests route to it |
| One trust, several schools | `shared` | one database, many `school_id`s, in-app school switcher |
| Single school | `shared`, one tenant | zero configuration — the pre-Phase-9 behaviour |

A trust wanting isolation *inside* one MySQL server (a database plus a MySQL user per school) is `dedicated` with different URLs, not a third code path. Mode is a property of the school in the registry and is resolved at runtime, so one API instance serves both.

### 17.1 Row ownership — the scoping extension (9.1, implemented)

`school_id` is on **every one of the 30 tables**. Phase 9.1's migration denormalized it onto the 16 that previously reached their school only through a parent join — including `timetable_slots`, the largest and hottest table, where a join would have breached the §14 100ms DB budget. Every scoped query is therefore a direct indexed predicate, and moving one school to its own database later is a plain `WHERE school_id = ?` export.

Scoping is enforced in **one module** (`apps/api/src/prisma/school-scope.ts`), a Prisma client extension over `$allModels` — the row-ownership counterpart to §15.3's `ScopeService` for user visibility. It reads the ambient school from an `AsyncLocalStorage` tenant context (**not** a Nest request-scoped provider, which would cascade through the ~40 classes injecting `PrismaService` and threaten the §14 300ms API budget) and applies it per operation:

- **reads with a flexible where** — the school is ANDed in, never merged, so a caller's own filters survive and a caller cannot widen the query by passing a different school.
- **`findUnique` / `findUniqueOrThrow`** — cannot carry a non-unique predicate, so the school is applied to the *result*. The original operation runs on whatever client the caller used, which matters inside an interactive transaction where a re-issued read would not see that transaction's own writes.
- **creates** — the school is stamped into the payload, recursively through nested relation writes (a merged group's `members: { create: [...] }` never arrives as its own operation).
- **`update` / `delete` / `upsert`** — the row is read first and the write refused when it demonstrably belongs to another school. `upsert` with no row of ours becomes a plain create, because a stock upsert would silently **update** a colliding foreign row.
- **cross-school references** — every id a write points at is checked. Row scoping alone does not cover this: a write stamped as School B can still *name* School A's class id, producing a row B owns that points into A's data. Scoped reads hide it from A, so nothing looks wrong — but B's readiness and solver would then pull A's class-section into B's timetable. The reference map is built from Prisma's own DMMF, so it cannot drift from the schema.

The rule for both the ownership and reference checks is **"reject what is provably foreign", not "require proof of ownership"**. These checks read through the un-extended client, so inside an interactive transaction they cannot see rows that transaction has just written — and the bulk import (§16) legitimately creates a class and then a class-section referencing it in one transaction. Nothing is lost: another school's row is by definition already committed, hence always visible and always caught.

Outside a tenant context the extension is a pass-through, and says so in the log unless the caller announced itself via `runUnscoped()`. Only genuinely cross-school work qualifies — the health probe, migrations, and SSO provisioning, which resolves the user's school as its *input*.

### 17.2 Cache and event isolation (9.1, implemented)

- **Redis keys are namespaced per school** (`s{schoolId}:…`), defined once in `redis/cache-keys.ts` and shared by the API and the solver worker. Invalidation SCANs only its own prefix. Previously keys were global and `invalidate()` ran `redis.keys("readiness:*")`, so one school's subject edit flushed every school's readiness and slot caches.
- **Socket.IO events are addressed to a `school:{id}` room.** The gateway previously used `server.emit(...)`, broadcasting solver progress, completion summaries, failure reasons and readiness invalidations to every connected client in the deployment. Job events carry only a job id, so the school is resolved from the job's own data and memoised for the run.
- **Background jobs carry their school.** BullMQ is one queue across all schools: job data carries `{ schoolId, configId }`, the worker opens its tenant context from it before touching the database, and a job without one is refused rather than guessed at. The "latest job" lookup matches school as well as config — a config id alone would expose another school's summary and failure reason.

### 17.3 The control plane (9.2, implemented)

**`school_id` has a parent row.** Before 9.2 it was a bare `Int` on 30 tables — no name, no code, and nothing preventing a typo from inventing school 4711. The `schools` table now holds each school's identity (code, name, short name, logo, timezone) and **all 30 `school_id` columns carry a real foreign key to it**, `ON DELETE RESTRICT`. A row can only belong to a school that exists, and a school holding data cannot be deleted out from under it. `GET /me` carries the session's school; `GET`/`PUT /school` reads and renames it. There is deliberately no `POST` or `DELETE`: creating a school is provisioning (it must register in the tenant registry in the same breath, or it would be a school nobody can sign in to) and deleting one is a platform operation — the scoping extension refuses both at the data layer regardless. `code` is not editable from inside the school, because it is what the registry resolves incoming logins against.

**The registry** (`trusts`, `tenants`, `erp_instances`) answers the question "an SSO token arrived claiming ERP installation X, school code Y — which database, and which `school_id` inside it?". `tenants` carries the mode, the AES-256-GCM-encrypted connection URL for dedicated schools (same key custody as AI provider keys, §13.2 — never selected into a response, never logged), the local `school_id`, the applied schema version and the status. `erp_instances` holds one public key per ERP installation, which is what will confine an ERP to its own schools once 9.5 selects keys by `kid`.

The registry is **load-bearing, not decorative**: SSO consults it on every login and refuses a suspended school — before burning the token's nonce, so the login can simply be retried once the school is reinstated. It is also **optional**: a deployment with no `CONTROL_DATABASE_URL` degrades to "no registry" and behaves exactly as it did before Phase 9, which is what a single school has.

> **Deviation from the Phase 9 plan, recorded per the CLAUDE.md convention.** The plan said the control plane would default to living *in* the application database. It cannot, for two reasons that only surfaced in implementation: (1) **chicken and egg** — under `dedicated` mode the registry cannot live inside a tenant database, because you need the registry to *find* that database, so it must be reachable from a single boot-time env var; and (2) **Prisma cannot host two migration histories in one database** — both schemas would write `_prisma_migrations` and each would read the other's rows as drift. It is therefore a separate schema (`prisma/control/schema.prisma`, its own generated client and migration folder) on the *same* MySQL server, created automatically by `docker/mysql-init/`. The cost in practice is nil: no new container, no new credentials, no operator action.

Commands: `pnpm migrate:control`, `pnpm generate:control`, `pnpm seed:control` — the last being idempotent and safe on every boot; it registers every school the application database already has and never invents or removes one.

### 17.4 School identity and switching (9.5–9.6, implemented)

**The ERP owns school identity.** Names are never hardcoded and never invented by the application: they arrive on the SSO token (§15.1's claim contract) and are refreshed on every login, so renaming a school in the ERP renames it here without anyone re-typing it. A school the deployment has not seen is provisioned on the spot — `schools` row created, permission registry and ERP role mappings seeded so its users can sign in immediately, and registered in the tenant registry with its trust. Descriptive fields are only overwritten when the token actually sends them, so a token omitting a logo does not erase one configured here.

**A trust administrator switches schools inside the app.** The token's `schools[]` resolves to local ids at login and rides in the session token; `POST /auth/switch-school` re-issues a session for another of them. The authority is the signed token, not a permission — a permission could be granted by an admin of one school and would say nothing about whether the ERP grants access to another. The user is **re-provisioned in the target school**, because their role there is that school's business: Admin in one and Teacher in another is a normal arrangement in a trust. A new token is issued rather than the current one mutated, so every downstream check — REST scoping, Socket.IO rooms, the AI tool layer — keeps reading the school from exactly one place.

Because the server takes the school from the session and never from a request body, "create a timetable for another school" means *being* in that school: the Timetables screen offers the school alongside the name, switches first, then creates. There is no way to create a timetable somewhere you are not.

`GET /me` carries the active school, the switchable list and the trust, so the top bar names the school and shows a switcher only when there is more than one. The sidebar shows the school's own logo in place of the product mark when one is set, with its short name beneath — and hides a logo URL the browser cannot reach rather than leaving a broken image in the chrome.

**School Profile** (Administration → School Profile, `masters.manage`) is where the local settings live, and its job is to be honest about a split that is otherwise invisible:

| Field | Owner |
|---|---|
| `code` | ERP — not editable at all: it is what an incoming sign-in is matched against, so changing it would lock the school's own users out |
| `name` | ERP — editable, but refreshed from the token on every sign-in, and the screen says so |
| short name, logo, address, timezone | **local** — only overwritten when the ERP explicitly sends them, so what an admin sets here sticks |

Showing an editable name with no warning would be the worst of both worlds: the admin renames the school, signs in again, and it silently reverts. That ownership split is asserted by `scripts/sso-schools-smoke.cjs`, which sets the local fields, signs in again with a token carrying only code and name, and checks the ERP's name won while the short name, logo, timezone and address survived untouched.

### 17.5 Connection routing (9.4, implemented)

A school in `shared` mode lives in the application database and is separated by `school_id`; a school in `dedicated` mode has its own database and its own credentials. One deployment serves both, and which one a request reaches is decided by the tenant registry, not by configuration.

**`PrismaService` is not a connection — it is a pointer.** It is a proxy whose every property access resolves against the tenant context. This is what let 9.4 change *where* queries go without touching any of the ~40 classes that inject it: `this.prisma.room.findMany()` compiles and runs exactly as it did in Phase 1. The lookup is deliberately synchronous, a Map read; the async work — resolving the tenant, decrypting its URL, opening a pool — happens once per request in `JwtAuthGuard`, which binds the resolved client to the context.

**Tenant id, not school id, is the routing key.** A dedicated tenant's local `school_id` is usually 1 — and so is everyone else's. That collision is not hypothetical: `pnpm tenant:create` produces exactly it, and the 9.4 smoke test is built around it, because a routing bug would not error. Every query would succeed against the wrong database and return plausible data. The session token therefore carries `tenantId` and the grant list is tenant ids; `POST /auth/switch-school` takes a `tenantId` and refuses a bare `schoolId` as ambiguous whenever the session spans tenants.

**Connections are bounded**, because every open client holds a pool and `open_clients × connection_limit ≤ MySQL max_connections` is a real constraint. The registry enforces a hard cap (`TENANT_MAX_CLIENTS`, default 20), sets each tenant's pool size itself rather than trusting whatever was typed into a URL (`TENANT_POOL_LIMIT`, default 5), evicts the least-recently-used client past the cap, closes idle ones (`TENANT_IDLE_MS`, default 10 min), and coalesces concurrent opens for the same tenant. `GET /health` reports the budget and the open clients so an alarm can watch it rather than a stall discovering it.

**Everything that writes routes**, not just the request path: the solver worker resolves its own connection from the job's `tenantId` (a dedicated tenant's generation writing into the shared database would produce slots nobody can see), and so does the solver-completed notification listener. Each tenant client is wrapped in the 9.1 scoping extension as well — a dedicated database is not a reason to stop filtering by `school_id`.

**Per-installation ERP keys.** A single `ERP_PUBLIC_KEY` is fine with one ERP and wrong with two: any installation holding it could mint a token for any school. `erp_instances` holds one key per installation and a token selects its own by the `kid` in its JWT header (or its `iss` claim). A token naming a `kid` that is not registered is **rejected**, never silently fallen back to the global key — falling back is precisely how one installation would end up trusted to sign for another's schools. Choosing the key from unauthenticated header data is safe: it only decides which public key to try, and the signature check is what grants anything.

**Migrating N databases, and refusing the one you forgot.** Once schools can have their own databases, "run the migrations" stops being one command and becomes N — and the one you forget fails *quietly*: not on deploy, but later, inside a query, as `Unknown column 'trust_code' in 'field list'`, on whichever screen happens to touch the new column first, with nothing pointing at the cause.

So the version is checked at the door. The application knows which migrations it ships (the folders in the image); each database knows which it has (`_prisma_migrations`); a database that is behind is **refused on connect**, with a message naming the school, the gap, the missing migration and the command that fixes it. The database is asked directly rather than trusting `tenants.schema_version` — that column is a cached summary for the Platform Console and would be wrong the moment anyone migrated out of band.

- A database that is *ahead* is tolerated and logged: that happens mid-rollout, when the schema is migrated before every instance is replaced, and refusing would take the deployment down for a condition that resolves itself.
- The **shared** database is held to the same rule, for the same reason. `GET /health` is public and bypasses it, so a deployment in this state can still be asked what is wrong; it reports `schema: "behind"` and degrades.

```
pnpm --filter @edutimetable/api migrate:all             # every school's database
pnpm --filter @edutimetable/api migrate:all -- --dry-run # report only, change nothing
```

`migrate:all` walks the registry so nothing is forgotten, migrates the shared database **once** however many schools live in it, and stamps each tenant's applied version. One school's failure does not stop the rest — an unreachable database should not block every other school's upgrade — and it is reported at the end with a non-zero exit. Idempotent, so running it twice is a no-op and running it after a partial failure resumes.

**Provisioning a dedicated school is an operator command, not an API call** — creating a database carries credentials and is nothing a login should trigger implicitly:

```
pnpm --filter @edutimetable/api tenant:create --code SCH-042 --name "St. Xavier's High School"
```

It creates the database, applies the application migrations, seeds the school row and its permission registry, and registers the tenant with its connection URL encrypted at rest. A school the ERP mentions that nobody has provisioned lands in the **shared** database — the safe default, since the app cannot conjure a database.

### 17.6 The Platform Console (9.8, implemented)

A level above every school: which schools exist, are they reachable, are their databases current, and should this one be served right now.

**Platform access is not a permission**, and that is the load-bearing decision. Every permission in this app lives in a school's own `roles`/`role_permissions` (§15.2), granted by that school's Super Admin. If platform access were one of them, the admin who manages their own roles could grant it to themselves — authority over other schools' status, connections and existence, obtained from inside the thing it governs. So it lives in the control plane's `platform_users`, keyed by **ERP identity**, since that is the only identity that survives across schools: the same person is a different `users` row in every school they work in.

**It is not carried in the session token either.** A flag minted at sign-in would stay true for the token's whole 8-hour life, so revoking someone's access would not actually revoke it until they signed out. It is re-checked per request behind a 30-second memo, so a grant or a revocation takes effect on an existing session without anyone signing in again.

**Granting is a command, not a screen** — the first platform administrator cannot be granted through a console that requires already being one, and afterwards authority over the registry should take a deliberate act on the host rather than a click by whoever currently holds it:

```
pnpm --filter @edutimetable/api platform:admin -- --list
pnpm --filter @edutimetable/api platform:admin -- --grant ERP-1 --name "R. Ahuja"
pnpm --filter @edutimetable/api platform:admin -- --revoke ERP-1
```

`PLATFORM_ADMIN_ERP_USER_IDS` is a bootstrap escape hatch for an operator locked out of their own console; the listing shows when one is in play, so an env grant is never invisible.

The console is **deliberately narrow**, and says so on the screen rather than leaving an operator hunting for missing buttons:

| It cannot | Because |
|---|---|
| Create a school | That provisions a database, which carries credentials — `pnpm tenant:create`. A console button that quietly creates databases is how you end up with databases nobody remembers creating. |
| Delete a school | A school holding data is not something to remove through a web form. **Suspend** is the reversible equivalent, and is what an operator actually wants. |
| Show a connection URL | Those are credentials (§13.2 custody). It reports *whether* one is stored and whether it works, never what it is. |
| Grant platform access | See above. |

What it does: a deployment summary (schools by mode and status, how many are behind this build, the connection budget), the school list grouped by trust with mode / schema / status, an on-demand **connection test** per school (on demand rather than on the listing, because a hundred schools would mean a hundred connections to render a table), and **suspend / reinstate**, which stops and restores sign-in for that school (§17.3).

### 17.7 Operations: tagging and fairness (9.9, implemented)

**Every log line names its school.** With one school, "which school was this?" is not a question; with many it is the *first* question about any line. Answering it by hand at every call site would mean editing hundreds and getting the next one wrong — the same trap 9.1 avoided for query scoping. So it is done once: a `TenantAwareLogger` set at `NestFactory.create` wraps Nest's console logger and prefixes each line with the ambient school read from the same AsyncLocalStorage the request, socket message or queue job already runs inside. No call site changes; a line simply gains `[school 1 · tenant 7]` when there is a school to name, and gains nothing when there is not (boot, health, the control plane — all genuinely school-agnostic). The tenant is included alongside because school ids repeat across databases (§17.5), so the school id alone would be ambiguous in exactly the situation the line is most needed.

**One school can no longer monopolise the worker.** `concurrency: 1` is right for a single school — generation is CPU-bound and single-threaded — but with many it is a head-of-line block: a school whose generation takes a minute stalls every other school's five-second job behind it, and the smaller school's wait is entirely someone else's doing. Two changes together fix it, and neither works alone:

1. **Concurrency above one** (`SOLVER_CONCURRENCY`, default 3). Even on one core, timesharing beats queueing for fairness: a 5-second job behind a 60-second job finishes at 65 seconds with concurrency 1 and at roughly 10 with concurrency 2. Nobody finishes later than they would have; the small job finishes far sooner.
2. **A per-school cap of one running job.** Concurrency alone is not fairness — one school queueing four jobs would simply take all four slots. With the cap, the slots go to *different* schools.

A capped-out job is **deferred, not failed**: BullMQ's `moveToDelayed` + `DelayedError` returns it to the queue after a short wait without consuming a retry or recording a failure. It is not starvation, because the running job releases the slot when it finishes. The slot is a Redis key with a TTL, so a worker that dies mid-job cannot lock a school out permanently, and it is released only by the job that holds it — releasing unconditionally would let a job whose lock had already expired free the slot of the *next* job for the same school, and two of that school's jobs would then run at once. BullMQ's own job groups would do this natively but are a Pro feature; this is the OSS equivalent.

**The job lock is sized to the work, not to BullMQ's default.** A running job holds a lock that BullMQ renews halfway through a 30-second window, using a timer — and that assumption does not hold for this workload. Generation is *synchronous* CPU work: a solve running its full `budgetMs` blocks the event loop, the renewal timer never fires, and the lock expires underneath a job that is working perfectly well. BullMQ then treats it as stalled and may hand it to another worker while the first is still solving, producing duplicate generation or a job that reports neither completed nor failed to the Generate screen. Raising `SOLVER_CONCURRENCY` above one made this *more* likely, since CPU-bound solves timesharing one loop each take proportionally longer in wall-clock. `WORKER_LOCK_DURATION_MS` (default 5 minutes) covers a 30-second solve plus a 120-second CP-SAT pass plus writes, under contention. Erring long is the right asymmetry: too long merely delays the retry of a job whose worker really died, while too short duplicates work that is still running. It stays below the 15-minute per-school slot TTL, so a job always loses its BullMQ lock before it loses its school's slot.

**Saturation and fairness are reported, not inferred.** `GET /health` and the Platform Console carry `connections.saturated` (at the cap, every new school evicts another's connection) alongside the `TENANT_MAX_CLIENTS × TENANT_POOL_LIMIT` budget, and the solver's waiting / active / delayed counts with **which schools are actually running** — a long queue held by one school is a very different situation from the same queue spread across many.

## 18. Teaching Scope, Engagement and Extra Classes (Phase 11)

**A teacher's grade band was a description, not a rule.** The substitute engine derived `classIds` from the mappings a teacher already had — useful for scoring, but it cannot constrain the mappings that produce it, so nothing stopped a Nursery teacher being given Class 12. `teacher_class_eligibility` makes it declared: a **set** of classes, not a range, because the PE teacher covers Nursery and Class 12 and a range cannot say that. The UI offers presets (Pre-primary, Primary 1–5, Middle 6–8, Secondary 9–10, Senior 11–12, All) that expand into the set, so the ordinary case is still two clicks.

The rule bites in one place per call site, in `masters/teacher-scope.util.ts`: subject mappings, merged groups, elective options, class-teacher assignment and the importer all call the same `assertCanTeach`. The Feasibility Engine re-checks it as **Check 8** (`TEACHER_NOT_ELIGIBLE`), which is not redundant — the endpoints cannot see data that arrived before the rule existed, and cannot see a scope *narrowed after* the mappings were made, which is the mistake a person is most likely to make and least likely to notice. An unstated scope is a single aggregated warning for the whole school (`TEACHER_SCOPE_UNSET`), never one per teacher: a school that has never filled it in has *every* teacher unscoped, and a hundred identical rows would drown a dashboard whose whole point is that each line names a fix.

**Engagement** (`permanent | adhoc | guest`) is recorded on every teacher and does two things. A **guest may not be mapped into the regular curriculum at all** — they are engaged for a lecture or a revision series, and the timetable must not quietly depend on them (`GUEST_IN_CURRICULUM`). And in substitution, guests are never offered (they are not on site) while permanent staff take a +1 tie-break over adhoc. Load caps are *not* set from the type: a default that silently overrides what an admin typed is worse than no default.

**Extra classes run in a window the solver cannot reach.** A school at 40/40 has no spare period, so an extra class that took a regular one would displace a lesson Phase A has already proved must exist. `extra_periods_per_day` appends periods after the teaching day; because the solver's domain is `1..periodsPerDay`, they are free space *by construction* rather than by a new rule it must remember. `daySegmentsFromRows` excludes them too — otherwise the final teaching run would silently lengthen and a double period could be told it may span from the last lesson into an extra class.

An extra class is stored as an ordinary `timetable_slots` row with `source = 'extra'`, which is the point: the same three unique keys that stop a double-booked teacher in a normal lesson stop it here, and every grid, report and substitute plan already reads that table. It is written to **both** draft and published so it shows whichever the school is looking at, and three paths were taught to leave it alone — regeneration (`writeDraftSlots` excludes `source: 'extra'`), publish (which neither deletes nor promotes it), and `draft-from-published` (which must not count it as "a draft already exists", or the button would be permanently unusable for any school running one). Re-running generation is not a cancellation of next week's revision class.

They are placed by hand, not solved: an extra class is a specific arrangement — this teacher, this group, this slot — and there is nothing for a search to decide. Scope still applies; the guest restriction is the one rule this screen exists to lift.

## 19. Fixed Room Assignment (Phase 12)

Two facts were recordable and had no effect on anything.

**`class_sections.home_room_id` has existed since Phase 1 and the solver never read it.** Every ordinary lesson was written with `room_id = NULL`, so a school that carefully noted that Class 1-A sits in Room 12 all week got a timetable that never mentioned Room 12. The solver now claims the home room for any lesson that does not need a lab, which does three things at once: the timetable says where each lesson is, `uq_room_slot` starts guarding physical rooms rather than only labs, and a room accidentally assigned to two class-sections becomes a real collision instead of a paper one.

That last point is why **Check 9** exists. Two sections both timetabled 40/40 cannot share a room, so `HOME_ROOM_SHARED` is a blocker naming both — caught in Phase A rather than as a late solver failure. A section with no home room is a single aggregated warning (`HOME_ROOM_UNSET`): its lessons simply show no room, which is the pre-Phase-12 behaviour and not something to refuse over.

**Labs were interchangeable.** `findFreeLab` returned the first free room of type `lab`, so a biology period could be held in the physics lab because it happened to be empty. `room_subjects` records which subjects a room is set up for, and the solver now draws from that subject's own labs. Crucially, **a lab with no subjects listed is a general lab and still serves every lab subject** — so every school that existed before this keeps working unchanged until it says otherwise, and the migration's name-matching backfill (`%biology%` → Biology) is deliberately narrow for the same reason: anything it misses stays general.

Check 5 asks whether there are enough lab periods in total; Check 9 asks whether the *right* labs exist, which is the question a school with one Bio lab and one Physics lab actually has — `LAB_SUBJECT_UNSERVED` when nothing teaches a lab subject, `LAB_SUBJECT_OVERFLOW` when its own labs cannot hold its periods, both naming the rooms.

**The mapping is set from either side.** `class_sections.home_room_id` stays the single source of truth, but the Rooms screen writes it too — "which room is this class in" and "which class is in this room" are the same fact, and a school thinks of it both ways. The Rooms sheet of the import workbook gained `Home Room For` and `Lab For Subjects` for the same reason. A room may be home to exactly one class-section, refused at the endpoint with both names rather than left to the solver.

Merged groups fall back to the first member's room when they have none of their own; elective options already carry their own rooms, and the member sections' rooms stay free because those students are in the option rooms.

### 17.8 Verification (9.10, implemented)

**The isolation suite is one gate, and it is self-maintaining.** `pnpm test:isolation` (`scripts/isolation-suite.sh`, run inside the stack) executes every check below in one command with one exit code, so "is tenancy still sound?" has a single answer rather than nine scripts somebody has to remember. CI fails on it the way it fails on a unit test.

The centrepiece is `scripts/isolation-sweep.cjs`, and its design decision is that **it does not contain a list of endpoints**. A hand-written list answers the question only on the day it is written: the next controller added is untested, nothing says so, and the suite keeps passing — reporting a safety it never checked, which is worse than having no suite. Instead it asks the running application for its route table (a dev-only `GET /dev/routes` built from Nest's own metadata) and requires **every** route to be either swept or explicitly classified with a recorded reason. A new endpoint fails the build until somebody decides which it is.

Each route is then exercised as a **controlled experiment rather than a one-sided probe**: the same URL and the same body, once as each school, with only the caller differing. "School B got 404" proves nothing on its own — a route that is dead, mis-permissioned or renamed refuses everyone and sails through an isolation check while thoroughly broken. So B must be refused *and* A must get a different answer; a 400 for A is a perfectly good control, meaning the request reached A's row and failed on its merits. Where both sessions receive the same answer nothing was proved, and the run says so and fails rather than counting it as a pass. Both schools are created by the script and deleted afterwards — the sweep includes DELETE and publish, and a suite that mutates live data to make its point is one you can only run once; the seeded school is used solely as a witness that nothing strayed. Across 108 registered routes: 49 parameterised routes discriminate by session, 26 collections share no ids, request-body smuggling is refused on every endpoint that accepts another school's ids, all 11 AI tools answer about the caller's school alone, and no Redis key escapes its school's prefix.

Writing the sweep found four endpoints that answered **success for another school's id**. None leaked data — row scoping held in every case — but `POST /notifications/:id/read`, `PUT /teachers/:id/unavailability`, `GET /timetable-configs/:id/generate/latest` and `PUT /ai/settings/roles/:id` each performed a scoped no-op and reported `{ok: true}` or `{state: "none"}`. That is the wrong contract: someone else's id is *not found*, and an endpoint that says "fine" instead is indistinguishable from the outside from one that really did the write — and would become a real write the moment a refactor replaced its `updateMany` with an `update`. All four now return 404.

**The dedicated-mode test runs against a second real MySQL server.** `docker compose up` starts `mysql-b` with its own host *and its own credentials*, and `scripts/dedicated-db-smoke.cjs` provisions a school onto it. The distinction from §17.5's same-server test is the point: on one server, code that ignored the registry's stored URL and fell back to the default connection would still find a database of the right name and every assertion would pass while routing did nothing. A user that exists only on `mysql-b` cannot open a socket to the default server, so "the registry URL is actually used" becomes something the suite can fail on — and the test asserts that asymmetry outright rather than relying on it silently.

`scripts/fair-scheduling-smoke.cjs` measures the noisy-neighbour fix with real jobs and real timings, using the `demo` queue because generation has no predictable duration: school B's short job finished at **1,025ms while school A's 6,129ms job was still running** — under the old `concurrency: 1` it could not have finished before roughly 6,700ms — and school A's three queued jobs ran one at a time (~3s apart) rather than taking every slot, with school B still getting through in the middle and nothing failing while it waited.

`scripts/platform-console-smoke.cjs` proves the containment property the console rests on: a school's own Super Admin, holding all 15 of that school's permissions, is refused 403 on every platform route; the CLI grant then admits **the same session token** without a fresh sign-in, and revoking refuses it again — demonstrating that access is re-checked rather than minted. It also suspends a real school, confirms its users can no longer sign in, reinstates it, and asserts no connection URL or credential appears in any response.

`scripts/migrate-all-smoke.cjs` proves the migration loop end to end: it provisions a real dedicated school, genuinely rolls its database back one migration — dropping the columns, not just the bookkeeping row — then asserts the dry run names the school and the pending migration, that signing in is **refused** rather than half-working until it reaches the new column, that `migrate:all` repairs it and stamps the registry, that the school then works, and that the shared database was migrated once rather than once per school.

`scripts/dedicated-tenant-smoke.cjs` proves connection routing against a real second database, built around the school-id collision described above: the session lands in the tenant's database, its user row and every write land there and nowhere else, neither school can see the other despite sharing a local id, a session cannot switch into an ungranted tenant, and the connection budget is reported.

`scripts/sso-schools-smoke.cjs` proves the ERP owns school identity end to end: a school named on the token is created with that name and immediately usable, the same code with a new name renames it rather than duplicating, a trust token provisions every school it lists and groups them under the trust, the user switches between them and lands in the right one with that school's role, an ungranted school is refused, and a timetable created after switching belongs to the new school and is invisible from the other.

`scripts/control-plane-smoke.cjs` asserts the schools table is populated, all 30 foreign keys exist, a row naming a nonexistent school is refused by the database, every school is registered as a tenant, a shared tenant stores no credentials, a suspended school cannot sign in and a reinstated one can, and the control plane is unreachable from the application API.

`scripts/tenant-isolation.cjs` stands up a real second school against the live stack and attempts, from School B's session, every cross-school read, edit, delete, reference and nested-write laundering; asserts B's own writes land stamped as B's on parent and child tables; runs a real solver generation for B and checks every slot it wrote; and asserts School A is **byte-identical** afterwards. `scripts/tenant-socket-check.cjs` connects one client per school and asserts B's socket receives nothing when A acts. `school-scope.spec.ts` unit-pins the extension's reasoning.

## 19a. Cache invalidation on publish (§14)

Report aggregates are cached for an hour (`CacheKeysService.report`). Publishing used to drop only the `slots:*` keys, so a class-section report anyone had opened *while the timetable was still a draft* went on being served afterwards — a full week of "Free" for a timetable that had just gone live, on exactly the sections somebody happened to look at early.

**Every write that changes a published slot or a substitution calls `CacheKeysService.invalidateTimetable()`** — publish, extra classes (which write published rows directly) and the substitute engine. It drops the config's slot caches and *this school's* report aggregates, by SCAN, never `KEYS`. Reports are keyed by what they are about (a class-section, a teacher, a date) and never by config, so there is no way to delete "the reports affected by publishing config 7" one key at a time; they are cheap to recompute and publishing is rare, so the whole set goes.

The substitute engine's version of this was `redis.keys("slots:*")`, wrong three ways: `KEYS` blocks the whole Redis instance (§14), the pattern stopped matching anything once §17 put the school prefix in front of every key — so it was a silent no-op — and had it matched it would have flushed every other school's caches too. `scripts/report-cache-smoke.cjs` (isolation suite step 13) publishes twice over a warmed cache and checks the report against the database.

## 20. Minimum Periods per Day (Phase 13)

`teachers.max_periods_per_day` has always bounded the top of a teacher's day. Nothing bounded the bottom, and the solver's value ordering actively preferred the emptiest day — so a light load was smeared one period at a time across the week and a teacher could travel in to teach a single period. `teachers.min_periods_per_day` (default **3**) is the floor.

**The rule is "zero or at least N", not "at least N every day."** A teacher with 8 periods in the week cannot have 3 on each of 5 days; demanding it would make every part-time teacher unschedulable. Concentrating those 8 into two proper days is the outcome a school actually wants — days off stay days off.

### The effective minimum (`packages/shared/src/feasibility/min-day.ts`)

One module turns the declared minimum into the number every other component uses, so the Feasibility Engine, the CSP search, the CP-SAT payload and the drag-drop board cannot disagree. It is the declared value clipped by two things:

- the teacher's **weekly load** — 2 periods a week means a 2-period day, not two 1-period days;
- their **daily reach**: the most their own subjects could put in one day, i.e. Σ over their (section, subject) pairs of that pair's `max_periods_per_day`, with merged groups and elective blocks counted once. A French teacher running one class's third-language block (5 periods a week, 1 a day) can never have more than one period on any day, whatever their personal maximum says. Judging them against `max_periods_per_day` would demand three and no timetable could deliver it.

### Check 10 — Feasibility

The mirror of Check 4a: that one asks whether a load can be spread thinly enough, this one whether it can be packed densely enough. A load `L` divides into whole days of `[min, cap]` exactly when `ceil(L/cap) <= floor(L/min)` and that many days are available.

- `MIN_DAY_IMPOSSIBLE` (blocker) — no whole number of days works, naming the numbers and two fixes.
- `MIN_DAY_RELAXED` (warning, aggregated) — the declared minimum is more than the teacher's load or reach allows, saying **which bound binds** so the admin fixes the right number.

### Enforcement in the solver

The rule is a lower bound, so no single placement can break it — adding a lesson only ever helps. What a placement *can* break is the ability to finish: opening a fourth day for a teacher with two lessons left strands the days already started. So `SolverState` carries, per teacher, a **shortfall** (periods owed to started days) and a **budget** (periods left to place), and `check()` refuses any value where `shortfall > budget`. Because the budget reaches zero exactly when the last lesson lands, a completed search satisfies the rule by construction — which is also how `verifyAssignment` holds a CP-SAT answer to it, and why CP-SAT models it directly as a reified `works[t][d]` literal.

Value ordering changes to match: a day the teacher has started but not filled is the cheapest place for a lesson (−8), opening a fresh day is the most expensive (+6), and past the minimum the old spread preference resumes.

### Completeness wins

A school whose sections are 100% full and whose average teaching load per teacher-day sits barely above the minimum has very little slack, and there the rule and completeness pull against each other. `solveTimetable` therefore runs two passes: the enforced one first (40% of the budget), and if it leaves lessons on the floor, **the pre-§20 solver exactly** with the full budget. A timetable missing four periods is worse for a school than one where two teachers have a short Tuesday.

Whatever survives is then improved by `consolidateShortDays`, which only ever *moves* lessons and so cannot cost a placement. It evacuates a thin teacher-day **all or nothing** — taking one lesson off a two-period Tuesday leaves a one-period Tuesday, which is worse — and swaps rather than merely moves, because a 100%-full school has no empty cell for a move to land in. `stats.shortTeacherDays` and `stats.consolidatedDays` report what was achieved rather than hiding it.

On the drag-drop board the rule is a **warning, not a refusal**: refusing would freeze every card on a day sitting exactly at the minimum, including the ones you would move to clear it properly.

## 21. Auto-resolve (Phase 14)

The Readiness Dashboard names every problem and recommends a fix. Auto-resolve applies the recommendation, for the issues where "the recommendation" is a definite thing rather than a judgement call.

### The remedy is data, not prose

Every issue already carried `fix` — *"Reassign [5-A Maths: 6 periods] to another teacher, or raise their max load"* — written for a person. A resolver that parsed that would be guessing at the exact moment it was about to write to a school's master data. So `FeasibilityIssue` gained a structured `remedy`, emitted where the numbers are already in scope, and the applier gets exact writes with no judgement of its own:

```ts
remedy: { kind, summary, changes: [{ op: "set", entity: "teacher", id: 41, field: "maxPeriodsPerDay", from: 5, to: 6 }] }
```

`packages/shared/src/feasibility/remedy.ts` owns every *choice* a remedy makes — which teacher, which room, which days — so the reason one candidate beat another lives in one place and is testable without a database.

### Three kinds, because they carry different risk

| Kind | Meaning | Consent |
|---|---|---|
| `complete` | Fills in something the school has not stated: a class teacher, a home room, a teaching scope, a lab's subjects | Covered by "do not ask again" |
| `redistribute` | Real change, no rule loosened: the same teaching moved to somebody with room for it | Covered by "do not ask again" |
| `relax` | Raises a cap or lowers a floor | **Always asks**, as one grouped card |

This split is the safety property, not a nicety. Nine of the eleven relax-able codes work by loosening a limit, so a resolver free to apply them could take any school to a Readiness Score of 100 **without changing one real thing** — and the score is the product's central promise. `TEACHER_OVERLOAD` therefore only ever offers to move classes off the teacher; the "or raise their max load" half of its own printed fix is deliberately not on offer here.

### Three rules in `AutoFixService`

1. **The server never applies a change the engine did not propose.** A request names issue keys and the changes consented to; the engine is re-run server-side and only *its* current remedies are applied. The payload is not what gets written — it is only what gets matched. A crafted change is refused (`outcome: "changed"`), and a `WRITABLE` allow-list bounds which fields any remedy may touch at all.
2. **Compare and set.** Every change carries the value the field held when the admin looked. Moved since → skipped and said so, the same discipline as the drag-drop board's `expect`.
3. **Fixed is a verdict, not a claim.** After applying, feasibility re-runs; an issue counts as fixed only if it has actually gone. A remedy that applies cleanly and resolves nothing reports `applied-not-resolved` — that is a bug in the remedy, and hiding it would be worse than the bug. The same property is pinned without a database by the round-trip tests, which apply each remedy to a snapshot via `applyToSnapshot` and re-run the engine.

### What "do not ask again" reaches, and what it does not

Ticking it applies `complete` and `redistribute` on the next press with no drawer at all. It never reaches `relax`: those are shown as **one grouped card** — nine dialogs is not consent, it is attrition — with every change priced (`Allow 2 periods/day of Maths, up from 1`) and every box starting unticked.

The server cannot enforce this and does not pretend to: a blanket consent and a deliberate tick arrive as the same list. What the server owes is the record, so every outcome carries its `kind` and a run that loosened a limit says so in `auto_fix_runs` for as long as the log is kept.

### Relax remedies change the rule, never the teaching

Each of the eleven picks the half of its own printed fix that touches configuration rather than what children are taught or who is responsible for them:

| Issue | Applied | Deliberately *not* applied |
|---|---|---|
| `SAME_PERIOD_IMPOSSIBLE` | Turn the same-period rule off | Cut the subject's periods/week |
| `CT_P1_DEADLOCK` | Set the Period-1 rule to `random` | Remove a class teacher from a section |
| `BLOCK_FRAGMENTED` | Shorten the block to the day's longest run | Move a break — it lands on every class in the school |
| `BLOCK_MATH_INVALID` | Fit blocks/week to the periods available | Raise periods/week to justify the blocks |
| `ELECTIVE_DAILY_PIGEONHOLE` | Raise the block's periods/day | Cut the block's periods/week |
| `OVER_MAPPED` | Trim mappings to the curriculum, never to zero | Delete a mapping |
| `MIN_DAY_IMPOSSIBLE` | The largest minimum the load can actually keep, found by search | - |

`MIN_DAY_IMPOSSIBLE` is searched rather than computed because the printed fix ("one less than the effective minimum") is usually right and occasionally is not: a load of 5 with a cap of 3 fails at a minimum of 3 *and* at 2. A remedy that leaves its own issue standing is not a remedy.

`DAILY_PIGEONHOLE` and the other cap-raisers are bounded by the day itself - and, for an alternate-period teacher, by every other period of it. Past that the number is not what is stopping them and no remedy is offered.

### Undo

Every run is one transaction recorded in `auto_fix_runs` with the value each field held before it. *Undo this run* reverses them in reverse order, guarded by the same compare-and-set, so a value edited by hand since is named rather than stamped over.

---

## 22. Multiple Named Drafts — the Draft Board (Phase 17)

### 22.1 The requirement

A school does not generate one draft and publish it. They generate, look, tweak the masters, generate **again as a new draft**, edit one by hand, and only then decide which of the three is the timetable the school will live with for a term. That comparison needs numbers, not memory: each draft must carry its **generation percentage, total allocation (required lessons), actual allocation (placed lessons), and error count**, visible side by side, so "which draft is looking good" is a reading, not a recollection. The Draft Board grows a **draft selector (dropdown)** in its filter row and a **stats card row directly below it**, and Publish operates on *the selected draft*.

### 22.2 Schema — one table still, one new dimension

Invariant 3 (draft vs. published in one table) survives intact; drafts become **rows in a registry** and a **scope column** on the slots:

```sql
CREATE TABLE timetable_drafts (
  id INT PRIMARY KEY AUTO_INCREMENT,
  school_id INT NOT NULL REFERENCES schools(id),        -- §17: on every table
  timetable_config_id INT NOT NULL REFERENCES timetable_config(id),
  draft_no SMALLINT NOT NULL,                           -- per-config sequence: Draft #1, #2…
  label VARCHAR(80) NULL,                               -- optional: "Labs freed on Friday"
  status ENUM('draft','published','archived','discarded') DEFAULT 'draft',
  -- stats snapshot (recomputed after generation and after every board edit batch)
  required_lessons INT NULL,      -- total allocation: Σ curriculum periods/week, Check-1 arithmetic
  placed_lessons  INT NULL,       -- actual allocation: lessons placed (option rows counted, extras excluded)
  generation_pct  DECIMAL(5,2) NULL,   -- placed / required × 100
  error_count     INT NULL,       -- unplaced lessons + hard-constraint violations on the stored grid
  warning_count   INT NULL,       -- §20 short teacher days, gap warnings — advisory, never blocking
  locked_count    INT NULL, manual_count INT NULL,
  solver_stats    JSON NULL,      -- runtime, backtracks, optimizer adopted, fallback used
  generated_at DATETIME NULL, created_by INT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  published_at DATETIME NULL, published_by INT NULL,
  UNIQUE KEY uq_draft_no (school_id, timetable_config_id, draft_no)
);

ALTER TABLE timetable_slots
  ADD COLUMN draft_id INT NULL REFERENCES timetable_drafts(id),
  ADD COLUMN draft_scope INT NOT NULL
    AS (CASE WHEN status='published' OR source='extra' THEN 0 ELSE draft_id END) STORED;

-- the three §3 unique keys each gain draft_scope after status:
--   uq_class_slot   (timetable_config_id, status, draft_scope, class_section_id, day_of_week, period_id)
--   uq_teacher_slot (timetable_config_id, status, draft_scope, teacher_occupancy_key, day_of_week, period_id)
--   uq_room_slot    (timetable_config_id, status, draft_scope, room_id, day_of_week, period_id)
```

**Why a generated `draft_scope` and not `draft_id` in the keys directly** — the same trick as `teacher_occupancy_key`, for the same reason: the key must collapse where the guarantee must stay global. All **published** rows collapse to scope `0`, so there can never be two published sets for a config no matter which draft each came from; each **draft** keeps its own scope, so Draft #1 and Draft #2 may both put Mrs. Sharma in Monday P3 — they are alternative futures, not a double-booking. `source='extra'` rows also collapse to `0` (they exist once per config, in both statuses, outside any draft — §18's "regeneration is not a cancellation" survives verbatim, and `draft-from-published` still must not count them as a draft).

**Migration of existing data:** every config with existing draft rows gets one `timetable_drafts` row (`draft_no = 1`, back-stamped stats), and its slots get that `draft_id`. Published rows keep `draft_id` as provenance ("published from Draft #2 on…"), which the Publish Confirmation screen shows.

**Cap:** at most **5 live drafts** per config (`draft`,`archived` count; `discarded` do not). The sixth "New draft" asks which one to discard. A draft is ~2,000 rows; the cap is about legibility, not disk.

### 22.3 The stats — defined once, computed in one place

| Card | Definition | Source of the arithmetic |
|---|---|---|
| **Generation %** | `placed_lessons / required_lessons × 100` | derived, never stored independently of its parts |
| **Total allocation** | required lessons for the config: Σ `periods_per_week` over the curriculum, block-aware | **Feasibility Check 1's own function** — never re-derived at a call site (the §20 rule) |
| **Actual allocation** | grid cells filled in this draft: **section rows only** (`class_section_id IS NOT NULL`), `source='extra'` excluded, restricted to teaching periods | the same counter the Matrix fill-rate uses |
| **Errors** | unplaced lessons + hard-constraint violations reported by replaying `SolverState.check()` over the stored grid (0 by construction after a solve; can rise after imports or concurrent master edits) | the one rules engine, third call site |
| **Warnings** | `stats.shortTeacherDays` (§20) + gap warnings | solver stats, advisory |

**Both sides count grid cells, not lessons.** An earlier draft of this table defined actual allocation as "section rows + elective option rows" — invariant 9's *lesson* meaning. That is the wrong unit here: Check 1 counts a §4.9 block **once per member section**, so a school with electives would divide 2,360 placed by 2,240 required and report a generation percentage of **105.4%**. Required and actual must be the same unit or the ratio is meaningless, and the unit that makes "how full is this timetable" answerable is the grid cell. (The *lesson* count is still the right one for a teacher's own week — invariant 9's distinction is per-consumer, exactly as §4.9 Phase 15's follow-up established.)

Recomputed and stamped onto `timetable_drafts` when: a generation completes, a board edit batch is confirmed, an import touches the draft, or on demand (`POST /drafts/:id/recompute`). Reads come from the row — the Draft Board never counts 2,000 slots per render (§14 budget).

### 22.4 Lifecycle

- **New draft** = a `timetable_drafts` row + (optionally) a copy of another draft's or the published set's rows (`draft-from-published` now targets a *named* draft). Generate always runs **into the selected draft**, deleting and rewriting only that draft's rows (`source='extra'` excluded, locked rows honoured as fixed).
- **Publish** is one transaction, per config: supersede the current published set (archive its rows), flip the selected draft's rows `draft → published` (they keep their `draft_id`), stamp `timetable_drafts.status='published'`/`published_at`, and leave every other draft untouched — the school keeps them for next term's thinking. Cache invalidation as §19a.
- **Discard** marks the registry row `discarded` and deletes its slot rows. **Archive** keeps rows read-only (board opens it, drag-drop disabled).
- **Substitutions** (invariant 4) remain date-specific overlays over the *published* set only — drafts never take substitutions.

### 22.5 Draft Board UX

The Board's filter row gains, left of the class-section selector: **Draft ▾** (`Draft #2 — "Labs freed Friday" · 98.4%`), a **＋ New draft** button, and **Compare**. Directly below the filter row, five cards (`.stat-box` row): **Generation %**, **Total allocation**, **Actual allocation**, **Errors** (red when > 0), **Warnings** (amber when > 0). The status pill reflects the selected draft (`DRAFT #2 — not published`, `ARCHIVED`, `PUBLISHED 14 Apr`). **Compare** opens a side-by-side table of every live draft's card row, best value per column highlighted, with Publish available per row — the "which one is looking good" moment happens on numbers, on one screen. Switching draft re-renders the same board (one `?draftId=` on `GET /timetable-configs/:id/slots`); every existing consumer that reads draft rows takes the same parameter, defaulting to the config's **latest live draft** so single-draft schools see no change.

**As built (Phase 17).** `＋ New draft` **forks the draft on screen** rather than creating an empty one — an empty draft is two thousand cells of nothing to drag, and "try something on a copy of this" is what the button is for. In the Compare table, a column where every draft **ties is not highlighted**: marking all of them as the winner tells a reader nothing, and the panel exists to answer "which one is looking good". Discard lives in the Compare rows, because the five-draft cap needs an escape or a school reaches it and is stuck. The board's status pill states the *selected* draft's standing (`not published` / `ARCHIVED` / `PUBLISHED`), and the publish button carries its id, so a Compare row publishes the draft it names.

**Generating at the cap (Phase 21).** The Generate screen carries a **Write into ▾** picker: `＋ A new draft` by default — so no button press can destroy hand-editing — plus every live draft with its number, label, status and fill %. The cap itself is unchanged; what changed is that reaching it no longer forces a school to throw work away. At the cap the new-draft option is disabled and **the Generate button stays disabled until a target is chosen**: when every remaining option overwrites a week somebody may want, there is nothing safe to default to. The picker states in words what the choice does, and `DraftsService.assertWritable` refuses a *discarded* draft — generating into one would produce a timetable no screen shows.

Nothing in the writer needed changing: `writeDraftSlots` already scopes its delete to `status='draft' AND draft_id = <this draft>`, keeps 🔒 pinned cells and skips `source='extra'`, and `buildSolverInput` already resolves locked cells per draft — so regenerating Draft #4 respects Draft #4's pins, not Draft #2's. Phase 17 built the targeting; only the way to ask for it was missing.

**Regenerating a *published* draft is allowed, and is not the trap it looks like.** Publish flips the draft's rows in place, so a published draft has no `status='draft'` rows left — which is why the Board renders it empty. Generating into it refills that working copy and cannot touch the published set, which lives at `draft_scope = 0`. "Revise what we published" is a real workflow, so it is offered rather than blocked, and the picker says exactly that instead of leaving the admin to infer it.

**RBAC:** drafts stay behind `timetable.edit`/`timetable.generate` (§15.3); draft CRUD wants `timetable.generate`; Publish keeps `timetable.publish`. All new routes are swept or classified by the §17.8 isolation gate like any other.

---

## 24. Guided Setup — the wizard that fills an empty school (Phase 25)

A new school arrives at an empty app, and §16's spreadsheet import only helps a school that already keeps its data in a spreadsheet shaped the way we want. §24 adds the other door: **eleven steps that ask what a school looks like and derive everything else.** The welcome screen offers three of them — Manual entry (the existing Setup Wizard), this guided wizard, and (§24.6) the same questions in conversation.

### 24.1a When the welcome screen opens by itself

Two independent reasons, OR'd: **an unfinished draft**, and **a school with no `timetable_config` at all**. The second one is not once-ever — it holds on *every* sign-in until a timetable exists. A school that has not built one has not started using the product, and the only thing between it and a timetable is knowing where to begin; an offer that appears once and never returns leaves the app's whole job behind a button nobody has a reason to look for.

What stops that being a nag is a **split of authority, not a weaker rule**. The server answers *is there anything to offer* (`shouldPrompt`) — a question about data, which the client has none of, and which a second definition in the browser would drift from. The browser answers *has this sitting been asked*, in `sessionStorage`, so the welcome screen opens once and closing it quiets the rest of the day. `setToken` clears that flag, because sign-in, the SSO callback, entering a school, creating one and switching schools all pass through it — a fresh session is a fresh offer even in a tab that has been open since breakfast, and putting it at the five call sites instead guarantees a sixth arrives without it.

So **"I'll do this later" means later, not never.** `users.onboarding_dismissed_at` is still written, per user, and a colleague's is deliberately independent — but it no longer suppresses the offer, and the code says so where it is written rather than leaving a field that looks like a gate. `onboarding-smoke.cjs` asserts the reversal directly: after a dismissal, `shouldPrompt` is still `true` while the school has no timetable.

Two things this does not do. It never opens for somebody without `masters.manage` — an offer to set up the school is noise to a teacher who could not act on it. And it stops entirely once a timetable exists: a modal in front of the app on the three-hundredth sign-in of a working school is a thing people learn to dismiss without reading, which would waste the one screen that gets to explain the three doors.

### 24.1 The wizard is a face, not a fourth committer

Nothing in the wizard writes a master row. Every step builds the **§16 importer's own sheets** and hands them to `commitSheets`, which is what the Excel upload, the ERP sync and the AI assistant already use. Two properties fall out of that and both are load-bearing:

- **Idempotency is free.** The importer skips rows that already exist by natural key, so pressing Next twice, resuming a draft or re-running a step creates nothing extra. The alternative — the wizard keeping its own "have I made these yet?" bookkeeping — is precisely where duplicate classes come from.
- **Validation is identical.** An over-long name, a class-section naming a year that does not exist, a section already claimed by another timetable: all refused by the code an upload meets, with the same messages.

Two things are deliberately outside it. Period and break structure is not master data, so wings and the week go through `POST /timetable-configs` and `PUT /:id/structure`, which already own that shape; and the §24.5 settings live on `timetable_config`, written directly by `finish`.

### 24.2 Answers are a draft, not data

`onboarding_sessions` holds one row per person per school: current step, mode, and an `answers` JSON. Answers are **merged** on save, never replaced — a step sends only its own keys, and a client that sent the whole object would blank a step it never rendered, which is exactly how a Back button loses work. An abandoned wizard therefore leaves nothing in `classes`, `rooms` or `teachers`; a completed one is marked `completed_at` rather than deleted, so "did this school come through the guided setup?" stays answerable.

### 24.2a Step 3 opens with the usual three wings

A wing is a word the admin meets for the first time on step 3, and the step used to answer it with an empty text box — asking them to invent a name for something they have just been introduced to, which is the slowest possible first move in the whole setup. It now opens with **Primary Wing (Class 1–5), Secondary Wing (Class 6–10) and Higher Secondary (Class 11–12)**, each one tap to add, with *Add all 3* for the school that has all three.

Three details make them suggestions rather than a menu. The **name is editable before it is added**, because a school that calls it "Junior School" should not have to delete ours and retype; the **range comes with them**, so tapping *Primary Wing* opens the next step's slider on Class 1–5 instead of the generic default; and **nothing is stored until it is tapped** — an untouched suggestion is not an answer, so it lives in screen state and never reaches `answers`.

The list is `WING_SUGGESTIONS` in `packages/shared`, beside `CLASS_LADDER`, for two reasons. The ranges are *ladder indices*, so they are only as correct as the ladder they were written against — inserting a rung in the middle would silently turn "Primary Wing" into Class 2–6, a wrong school created by tapping a button that says the right thing; the unit tests therefore assert the class **names** each suggestion resolves to, and that the three tile Class 1–12 without overlapping (`planClasses` reports a class claimed by two wings as an error, so an overlap would make the fastest path through the screen the one that produces an error message). And the §24.6 interviewer offers the same three by name from the same constant, so the two doors into the setup cannot start naming the same thing differently.

### 24.3 The suggesters, and what they are not allowed to propose

Steps 8–10 propose rather than ask: rooms from the classes and subjects, a curriculum from a per-band weight table, and mappings from what each teacher said they teach. The rule governing all three is that **a proposal that cannot generate is worse than no proposal, because it looks like an answer.** Every one of the following was a real defect caught by the Feasibility Engine refusing a school the wizard had just built:

- A curriculum is **scaled to the wing's real weekly capacity**, in *both* directions — a fixed table hands an 8-period week a 40-period curriculum, and rounding that only ever trims leaves eight subjects each a fraction short and two unallocated periods per class.
- `maxPerDay` is floored at `ceil(periods / days)`. Six periods a week at one a day needs six days; in a five-day week that pair is impossible however it is staffed, because it is a property of the curriculum row rather than of who teaches it.
- A teacher's real weekly ceiling is their **daily reach** (Σ of their subjects' per-day caps) × working days, not `max_periods_per_week`. Assigning to the weekly cap alone produces a school that looks fully staffed and cannot be timetabled.
- Labs are **sized to demand**, not one per subject: at ten sections a single lab supplies 40 periods a week against 50 required. Every proposed lab carries its `room_subjects` mapping, because a lab with no subjects listed is general and serves everything (§19).
- Home rooms are **linked**, not merely created. `class_sections.home_room_id` is written from the Rooms sheet's `Home Room For` column; without it every ordinary lesson shows no room, and generation still succeeds, so nothing but Readiness notices.
- `min_periods_per_day` is written as **0**, not the application default of 3. That default is right for a school that chose it and hostile as a silent imposition — a one-subject teacher with 13 periods a week and a floor *and* ceiling of 3 has no whole number of days that works. §24.5 offers it as a decision.

Anything a suggester cannot cover is **named, with its reason**, never silently left out — the same "tell me what to fix" contract the Feasibility Engine holds to.

### 24.4 The correction wins

Each suggested step stores its edits under its own key in `answers`. The server reads that key if it is there and re-proposes if it is not, so going back to add a teacher changes the proposal while an edit made here survives. Three rules keep that honest:

- **The halves fall back independently.** `mappings` and `classTeachers` are two tables on one screen; treating them as one edited object means reassigning a single lesson wipes every class teacher in the school.
- **Periods/week is quoted, not stored.** Who teaches a class is step 10's decision; how many periods it runs for is step 9's. A stored quote goes stale the moment the curriculum is edited, and Readiness then reports *"only 7 of 8 periods/week mapped"* — a blocker whose cause is two screens from where it is named. `withCurriculumPeriods` refreshes the quote at every use.
- **Coverage is stated once.** `coverageGaps` is the function the mapping screen shows live *and* the commit uses for its issue list, because a proposal's own `uncovered` list stops describing reality the moment a row is edited. Load and capacity are deliberately *not* re-checked in the browser: the importer runs `assertWithinWeek` on every row it writes, and a second opinion the server contradicts is worse than none.

### 24.5 Settings, and the one that is not a flag

Step 11 writes `class_teacher_gets_first_period`, `allow_consecutive_periods` and `min_periods_per_day`. **Inter-wing teaching is not a setting** — turning it on clears the `teacher_class_eligibility` rows step 7 wrote, because an empty scope means "not stated" rather than "no classes" (§18). An existing, already-enforced mechanism, rather than a new flag nothing reads.

### 24.6 The third door — the assistant as interviewer (Phase 25.5)

The same eleven questions, asked in conversation. The design is a refusal to build a second setup: the interviewer fills in the **same** `onboarding_sessions.answers` and commits through the **same** `POST /onboarding/commit/:step`, so switching between chat and wizard mid-setup loses nothing and there is exactly one definition of what a school is.

**The model is offered one tool, `recordSetupAnswers`, and none of the §13.1 registry.** It cannot read the school, draft master data or place a slot; it gains no authority the conversation did not already have. What that tool writes is a *draft* — the same JSON a person produces by typing, which becomes rows only when somebody presses Next, at which point the §16 importer validates all of it again. So `interview.answers.ts` is not the safety net; it is what keeps the draft **coherent**, and it holds to three rules:

- **An unknown key is dropped, and said.** Every refusal is handed back as the tool result. Silently ignoring a field the model believed it recorded produces a conversation where the assistant confirms something that never happened.
- **Classes are named, never indexed.** The ladder position is an implementation detail of a slider; asking a model for `fromIndex: 4` is asking it to hallucinate an integer. It says "Class 1" — or "class 5", "Grade 5", "std 5", "LKG" — and an unknown name is refused *with the vocabulary attached*, because a guess here is a wing quietly covering the wrong classes.
- **Progress is derived, never taken from the model**, which will happily announce step 5 while three of step 3's answers are missing.

**A turn accumulates; it does not replace.** The draft's own merge is per top-level key, which is right for a wizard screen holding a whole list and catastrophic for a conversation adding to one: "and we also have three part-time teachers" would *delete* every teacher named before it, and the setup would shrink as the conversation went on — the worst possible failure, because it looks like progress. So collections merge by the thing that identifies them (employee code, else name), restating one is a **correction** rather than a duplicate, and `replace: ["subjects"]` is the only way to remove something — the model declaring a list complete.

**The conversation covers steps 1–8 and stops.** The curriculum is a matrix, the mapping a table and the settings three toggles: read at a glance, painful to hear dictated one cell at a time. At the handover the wizard opens at step 8 on the same draft. *(The plan said "Setup Wizard → Curriculum"; that was written before 25.4e gave the guided wizard its own curriculum matrix, which is the better destination.)*

**Every question offers ready-made answers.** The tool returns two to four `options` beside its `nextQuestion` — the ordinary answers, commonest first — and the screen renders them as chips with **"Something else…"** always last. Tapping one *sends it as the message*, deliberately the same path a typed answer takes, so it is recorded, confirmed and moved past identically; a second route into the draft is a second place for the two to disagree. Options are cleared the instant anything is sent, or chips from "which working days?" would sit under a question about periods a day looking answerable. The model is told to leave them empty for a genuinely open question — the school's name, its subjects, its staff — because an option there is a guess at something only the school knows, and "Something else…" is what makes an incomplete list honest rather than a dead end.

**The prompt carries today's date, and this is why.** Asked for session options without it, the model proposed *2024–25* from memory — plausible, tappable, and a whole year of timetable filed against the wrong session. It now receives the date and the April–March convention, and proposes the same session the wizard's own `defaultSession()` would, so the two doors cannot differ about what year it is.

**Opening the door is not walking through it.** The run begins on the first *message*, server-side, where `chat_since` is stamped before anything is logged — not when the screen mounts. Starting it on mount meant a draft was created merely by looking, and a draft makes the welcome screen re-offer itself: somebody who opened the conversational setup and closed it again then met a modal on every page load afterwards. Relatedly, the welcome screen auto-opens **once per sitting** rather than on every page load — see §24.1a for the full rule and why the per-sitting flag is what makes a permanently-true `shouldPrompt` bearable.

**The conversation is resumable, and the transcript is the audit log.** Coming back reloads both the answers and the thread — the answers always survived a refresh, and a blank chat beside a panel full of collected facts reads as though the assistant has forgotten a conversation it can still remember. The transcript is read from `ai_chat_log` rather than copied into a second store, because two transcripts would eventually disagree and the one on screen would be the one nobody could check.

That log is **never deleted**: the monthly AI token budget is summed from it, so clearing a conversation would refund what it cost and spend-discard-repeat would make the cap meaningless. A fresh setup therefore moves a boundary instead — `onboarding_sessions.chat_since` — and both the screen and the model's replayed history read only rows after it. A finished setup shows no live conversation at all.

Two things had to be fixed to make any of this work. The conversation id is now **derived** (`setup-{schoolId}-{userId}`) and no longer accepted from the client, which is both what makes the thread resumable and what stops somebody reading a colleague's setup by naming their thread. And the assistant's turn is logged **as the person saw it** — `reply` holds only streamed prose, and a model that answers entirely through the tool call streams none, so every assistant row was being written empty while the question the user actually read lived in `nextQuestion`.

**Testing it does not require a provider key.** `POST /dev/interview-turn` is the same dev-gated seam as `/dev/ai-tool` (§17.8), for the same reason: the property under test — *does a model's report become the draft the wizard would have produced?* — is not a property of the model, and a test that needed a key would be a test nobody runs.

### 24.7 Users and teacher logins (Phase 25.6)

A self-serve school has to be able to create its own logins, and the shape of the feature follows from one distinction that is easy to blur: **an account is a person; a `users` row is a membership.** Credentials live once in the control plane, `users` is one row per school per person and carries the role and the teacher link, and every scope filter in §15 and §17 reads the membership. So inviting somebody is two writes in two databases meaning two different things — the account may already exist and belong to someone with schools of their own, while the membership is always new and always this school's business.

**`roles.manage`, not `masters.manage`.** Deciding who signs in is the same authority as deciding what a role may do. Anything less would let whoever maintains the teacher list mint logins.

**Refused outright for an ERP school.** There the ERP owns identity and provisions on login (§15.1); a user created here would be overwritten on the next sign-in, or would survive as a second way in the ERP cannot revoke. The screen is read-only behind a banner that says which, and the server refuses independently.

**An invitation is not a way to take over an account.** Where the address already exists, the invitation attaches to that account and changes nothing else about it — not its password, not its `kind`, not its verification. An invite that could downgrade an owner to a member would let any administrator strip school-creation from anyone whose email address they can guess.

**The `users` row is created at invite time, not at acceptance**, and that is not a hole: until they accept, the account holds an unguessable password and `status: pending`, so there is nothing to sign in with. What it buys is that revoking an un-accepted invitation is the same action as revoking a live login, and that the list can distinguish **invited** from **active** — which looks identical in a list of names and is the commonest thing an administrator needs to see. Acceptance is therefore purely control-plane work: `POST /schools/:id/enter` already refuses an account with no active `users` row, and an invitation revoked between sending and accepting should be refused at the door rather than remembered.

**Looking at an invitation is not accepting it.** `GET /auth/invite/:token` names who was invited without spending the token, because a mail client that pre-fetches links would otherwise burn it before anybody clicked. Accepting is a POST, once, and the link is dead afterwards.

**Deactivate, never delete.** A user named in `audit_log` must stay resolvable, and the row is what resolves them. The last login that can manage roles cannot deactivate itself — counted on the *permissions* of the remaining roles rather than on the name "Super Admin", since a school may rename it or build its own.

**Bulk invite reports rather than counts.** Teachers who already have a login, teachers with no email address, and `guest` teachers (§18 keeps them off the regular timetable, so there is nothing for them to look at) are each named, because each has a different fix. A count that quietly excluded them would say "invited 40 of 40" while eight people got nothing. The preview and the write run the same server-side arithmetic, so the confirmation cannot describe something the write does not do.

**The prompt to invite lives on the publish screen**, because publishing is the first moment there is anything for a teacher to look at; before it, an invitation lands somebody in an empty app. It renders from the same dry run the Users & Access screen uses — so the two cannot disagree about who is missing a login — and renders nothing at all when the answer is not usable: a teacher gets a 403, an ERP school gets a 403, a fully-invited school gets an empty list.

**One change this phase forced elsewhere.** `schoolsFor` was keyed on `schools.created_by_account_id`, which was the same set as "schools I can enter" until an invited teacher created nothing — and `POST /schools/:id/enter` had always stated the real rule in words: *an account may enter a school exactly when it has a user row there.* The list is now keyed on membership; the school cap still counts what the account created, so being a teacher in six schools does not exhaust an allowance to run one's own.

### 24.5a Knowing how far you are

Eleven steps is a long way, and what carries somebody to the end of a long form is knowing the last bit worked. So each committed step is marked, and the marking is built to be information rather than applause.

**The message says what actually happened.** *"14 sections — the shape of the school is in"* rather than *"Nice work!"*, because a compliment after every step is noise somebody reads past by the third one, while the count is the thing they would otherwise scroll back to check. The numbers come from the §16 importer's own tally, so they cannot drift from what the database got.

**Percentage counts steps completed, not the step on screen.** Showing 9% for having opened the first question is the kind of progress bar people stop believing.

**Celebrated only when the advance is real** — the commit landed *and* the new position saved. A flourish for something that then failed to save is worse than none.

The burst is canvas and the sound is two oscillators: a confetti library and an audio file is weight on every page load for a flourish most people see eleven times, ever. `prefers-reduced-motion` turns both off — somebody who has told their operating system that motion makes them unwell has answered this already, and offering our own toggle instead would be ignoring the answer. Sound is additionally **opt-in and remembered**, because a school office is a shared room.

**Progress appears on the Timetables page as its own card, not on each timetable's.** A card is one `timetable_config`; the guided setup is one draft per person per *school*, and it is what creates those configs. Drawn per card it would be the same number repeated against the wrong thing — and would be invisible on a school with no timetables yet, which is exactly when somebody most needs it. It disappears once the setup is finished: a permanent "11 of 11" is clutter on every visit forever.

### 24.5b Carrying on, and moving about

**"Carry on" reopens the setup itself, not the welcome screen.** Somebody pressing it has already chosen a door and walked through it; showing them the three doors again asks a question they answered twenty minutes ago. Which door reopens comes from the draft's own `mode`, so a conversation resumes as a conversation. The wizard and the chat each resume from the saved draft on their own, so nothing has to carry the step.

**The rail is navigable, as far as the answers reach.** A step is open when every step before it is complete — derived from the answers by asking the *same* validator the Next button asks, eleven times, rather than by a second set of rules that would drift from it. Derived rather than remembered as a high-water mark, which means it survives a refresh and a different machine, and it tells the truth in the other direction too: empty the teacher list and the steps after it stop being reachable. A step that is not open says which one to finish first rather than merely greying out.

**The progress card names the wings the setup is building**, because a guided setup is one draft for the *whole school*: step 3 names every wing at once and everything after it covers all of them. So "which wing is this progress for?" answers "all of them", and the useful form of that answer is the list — a bar per wing would be the same number drawn several times. `weekReady` is the one genuinely per-wing fact worth surfacing: step 5 is filled in wing by wing, so a two-wing school can be half-way through a single step, and nothing else on the screen would show it.

Moving **backwards is free** — those rows are already written, and going back to look at something must never be a write. Moving **forwards commits each step it passes over**, in order, because steps 2–10 create real rows and skipping one would land somebody on a screen whose data does not exist yet. Every commit is idempotent, so re-crossing ground already covered costs a round trip and changes nothing.

### 24.5c Carrying on with a school that already exists

*Edit* on a timetable card has always meant the step-by-step Setup Wizard, which is the wrong tool for somebody who built the school through the guided steps and wants to carry on there. **⚡ Guided** beside it reconstructs a guided draft from what the school already has — wings as ranges on the ladder, each wing's week from its periods, the subject list, the staff and the subjects they are already mapped to — and opens the wizard on it. Which step it opens at needs no storing: that has always been derived from the answers, so it lands on the first thing still missing.

**This is a narrowing of something the plan put out of scope**, and the narrowing is the whole argument. "Editing an existing school through the wizard" was ruled out because pointing a first-run flow at a published timetable needs a diff-and-merge story of its own — which is still true. What is safe is the subset that **fills gaps and never edits**: every wizard commit goes through the §16 importer, which *skips* rows that already exist by natural key. It cannot update one and cannot delete one. So re-walking the steps over an existing school adds what is missing and leaves the rest untouched; renaming a subject or removing a teacher stays on the master screens, where it belongs. `onboarding-smoke.cjs` tests that claim rather than repeating it — the school's class, section and config counts are identical before and after a re-commit.

Two refusals worth stating. **A live draft is returned, not rebuilt**: somebody's unfinished typing is not ours to throw away. And **a wing whose classes are not on the fixed ladder is left out and named**, because a wing is expressed as a range and a school that named its classes something else cannot be described that way — guessing a range would quietly create the wrong classes, which is far worse than saying which wing to use the Setup Wizard for.

### 24.6a Outgoing mail

Four flows are a one-shot link in an inbox — verification, password reset, teacher invitation, bulk invite — so a deployment that cannot send is a deployment that cannot onboard anybody. There are **two transports**: `smtp`, which is the real one and speaks the protocol every provider offers, so choosing between SES, Postmark, Mailgun or a school's own server is a matter of credentials rather than code; and `log`, the default, which writes the link to the application log so an unconfigured deployment is *obviously* unconfigured rather than quietly failing to deliver.

**Verified at startup, not at the first send.** A missing `MAIL_HOST` discovered when somebody registers is a broken sign-up; the same mistake discovered when the container boots is a line in the log before anybody has tried. A pooled connection, because the bulk teacher invite sends one message per teacher and a TLS handshake each is how a fifty-teacher school times out. A server that is down at boot is logged, not fatal — refusing to start the API over it would take the application down with the mail server.

**A failure to send does not always mean the same thing.** `register` and `forgot` swallow it, loudly logged: those endpoints answer identically for a known and an unknown address, and letting a mail failure become a 500 would break that in the most useful direction for an attacker — known address errors, unknown one succeeds, and the difference is a customer list. They also have another way through (since 25.7 registration signs the person straight in, and a reset can be asked for again). An **invitation** is only a link, so it surfaces: the membership is created *first* and the mail sent last, so a failure leaves an invitation that still shows as "invited" and a Resend button, rather than an account with no membership to attach it to.

**Dev speaks SMTP too**, to a Mailpit container. That is not a convenience: for a long time `log` was the only implementation, which meant the path production would use had never run while four flows were exercised through it daily. Every message is readable at `http://localhost:8026` — 8026 rather than Mailpit's own 8025, which is taken on the primary dev machine, exactly as 3000 and 5173 are.

`scripts/mail-smoke.cjs` asserts against the **inbox**, not the capture. Every other suite reads its links out of the Redis capture, which runs for every transport — so those suites pass just as happily when nothing is being delivered. This one registers, resets, invites, follows each link, and checks that an unknown address is sent nothing while still receiving the same answer a real one gets.

### 24.7b The school name is the way back to My Schools

Clicking the school in the top bar takes a self-serve admin to *My Schools*, where they can switch or **add another** — the screen that owns schools, rather than a dropdown that can only choose between the ones that already exist. For an ERP user it stays exactly what it was: a switcher over what the token granted, because their schools come from the ERP (§15.1) and creating one here is not theirs to do. `MeResponse.isLocalAccount` decides which, and — as ever — it is cosmetic: `POST /schools` refuses an ERP account independently.

*My Schools* is declared **outside** the authenticated branch of the router, with the other account-level screens. It was inside it, so somebody already in a school who followed the school name fell through to the app shell's catch-all and landed back where they started — which from the outside looked exactly like the button doing nothing. The screen is about the account, not about any school, so holding a session must not hide it.

**`POST /auth/account/token` exists because the two credentials expire independently.** The session token lasts eight hours and the account token was minted at sign-in; somebody deep into an afternoon would otherwise be bounced to a login form while holding a perfectly good session, losing the school they were in to reach the screen that lists it. The exchange grants strictly **less** than the session already does — an account token reaches `/schools`, which lists the schools that account has a `users` row in, the same set the session token's own `schoolIds` names — so it is the same authority expressed against the other credential, not an escalation. Refused for an ERP user, who has no account and never will.

### 24.7a Getting in without a detour (Phase 25.7)

Verification originally gated sign-in and every school. A new customer therefore filled in the form and was sent to their inbox before seeing anything at all — the highest-friction moment in the product, spent on a round trip. It now gates the **second** school: an unverified account may sign in and create one. That preserves what the gate was for — an unverified address must not be able to fill the registry with rows nobody can reach, and registration is already per-IP throttled — while letting somebody start on the thing they signed up to build. The email still goes out, and *My Schools* carries a banner saying what confirming is for.

**The anti-enumeration property in §15.3 is unchanged, and it shaped how this was done.** `POST /auth/register` still answers identically whether or not the address exists; returning a token for a new account and a message for an existing one would say which, in a single response. So the client signs in afterwards with the credentials it already holds — if the address was new that works, and if it belonged to somebody else, login refuses it in the same words it refuses any wrong password, which is a check it already performs.

`AccountService.byId`, which every account-token request passes through, had to move with `login`: it also required `active`, and left alone would have issued a token that every subsequent request rejected.

**The demo roles live on the sign-in screen**, where somebody trying to get in can see them. They render only where the dev ERP stub is live, and the screen asks the server that question rather than guessing from a hostname — `/auth/methods` reports the same condition `POST /dev/erp-token` gates itself on, so the two cannot drift into offering four buttons that all 404. Each one walks the real `/sso/callback`; it is the production hand-off with a stand-in ERP, not a route around it.

### 24.8 Exit criteria

`scripts/guided-setup-smoke.cjs` drives the whole story against the live stack: a stranger registers, verifies, creates a school, and walks steps 1–11. It asserts **100% Readiness with zero blockers in every wing, and a generation with nothing unplaced** — plus that an edited curriculum row and an edited assignment are what reach the database. If that path cannot produce a solvable school, the phase has not worked however good the screens look.

`scripts/interview-smoke.cjs` does the same for the third door: eight scripted turns, then the assertion that matters — the answers equal the wizard's, the staff list accumulated across two turns rather than being replaced, a hallucinated class and an unknown field were both refused *by name*, and the resulting draft commits through the same endpoints to a school at 100% Readiness.

`scripts/users-smoke.cjs` covers §24.7, and its assertions are deliberately mostly negatives — a teacher who can reach a write endpoint is the whole feature failing quietly. Invite, accept once (and the link is dead the second time), sign in, land in the one school they were invited into, read their own timetable but **not** another teacher's, and be refused by the server with a 403 on every write endpoint and on `POST /schools`. Then: the bulk preview names the guest and the emailless rather than counting them, deactivation shuts the door while keeping the row, the last remaining administrator cannot deactivate themselves, and an ERP school refuses the lot.
