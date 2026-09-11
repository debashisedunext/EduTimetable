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

### 3.10a New Timetable *is* New Wing (Phase 41)

The Timetables screen's **New Timetable** button created a `timetable_config` and then handed the admin the step-by-step Setup Wizard, which asked them to build a school around it master by master. That was a leftover from before the guided setup existed, and by §8.2 it had become the odd one out: the thing the button had just made — a named week that some classes belong to — is exactly what the guided setup's **step 3 (Wings)** makes, and the very next question in either flow is *which classes does it teach*.

So the button now finishes step 3 and opens **step 4 (Classes)**. Nothing new is modelled: a wing has always been a `timetable_config` (§3.10), and this is the second door onto the same row.

**`POST /onboarding/session/wing/:id`** (`masters.manage`) records a config that already exists as a wing in the caller's guided draft, and returns the draft — whose `currentStep` is where the client opens. Four details, each of which was a way to get it wrong:

1. **The id is in the path, not the body.** §17.8's sweep addresses a route by its path parameters, so a body field would have left this one merely *classified* — a sentence in a table asserting it is safe — where a path parameter makes it a controlled experiment the suite actually runs (it does: `A 201 · B 404 on the same config`). The wing's *name* is read off the row rather than taken from the request, which is what makes another school's id a 404 instead of a wing named after somebody else's timetable.
2. **With no draft, the school's own answers are rebuilt first.** `prefillFromSchool` deliberately does not save (§27.12), so a draft holding only the new wing would be the *first* row for that person — and every subject, teacher and room already entered would be gone from the guided setup for good.
3. **A wing already in the draft is not added twice.** Names are the natural key throughout this flow — `commitWings` skips by name, the §16 importer skips by name — so a duplicate row would be silently ignored later while showing twice on screen now.
4. **The draft's session is aligned to the config's own year.** Step 4 writes class-sections through the importer with an `Academic Year` column taken from `answers.session.name`; naming a different year files them against the wrong session (§3.11) and the wing looks empty afterwards. The client picks the year the same way `commitWings` does, so a wing created here and a wing created there land in the same session.

**Which wing step 4 opens on travels in the URL** (`/guided-setup?at=4&wing=…`), not in the draft. It is where somebody is being *sent*, not something they have said: stored as an answer it would keep forcing that tab on every later visit; in the URL it is spent as soon as they navigate. On a school already running three wings, landing on the first one's ladder read as the button having done nothing.

The default range for a brand-new wing (**Class 1 – Class 6**, or the matching entry in `WING_SUGGESTIONS` if the name is one of the three suggested ones) lives in `packages/shared` as `wingRangeFor`. There are three doors that create a wing — step 3's *+ Add wing*, `answersFromSchool` rebuilding a wing that has no classes yet, and this button — and all three carried their own copy of `4`, `9` and `2`. The **section count** is no longer a constant at all: §3.10b asks the school what shape it is, and `DEFAULT_WING_SECTIONS` survives only as the answer for a school that has not told us yet.

### 3.10b The Classes Step Cannot Describe a Smaller School Than Exists (Phase 44)

Step 4 was a pure **plan**. `planClasses` expanded the slider range by "sections per class", applied the per-class overrides, and handed the result to the §16 importer. Nothing in the flow ever asked the database what the school already was.

The reason that went unnoticed for so long is the reason it mattered. The importer **skips by natural key and has no delete path**, so a screen showing two sections for a class that runs four created nothing, deleted nothing, and reported success. Nothing broke. The number was simply believed — and *Remove* and the per-class counter both looked destructive while being incapable of destroying anything, which is the worst of both: it teaches the reader that this screen deletes, while lying about the school at the same time.

Two places put the wrong number there:

- **`recordWing`** (§3.10a) pushed `DEFAULT_WING_SECTIONS` — a hardcoded **2** — without looking at the school. In a school running four, pressing Next made the guess true.
- **`answersFromSchool`** collapsed a wing's per-class counts to the commonest and rebuilt no `overrides`, so a wing running four sections to Class 8 and two above it was drawn entirely at four.

**The rule: a class's section count is a fact about the SCHOOL, so the floor is the most sections any one §30 pool runs for that class.** A timetable may add sections, and may decline to teach the class at all; it may not run fewer than the school does.

That is a rule about the school's own record, **not a §30 resource-sharing check**. Every pool still gets its own `class_sections` rows and shares nothing — an individual timetable is floored at four *and* gets four rows of its own, which `pnpm test:classfloor` asserts as one step, because the two are easy to conflate and the second is what §30.9 exists to protect.

**The floor lives in `planClasses`, not in an `<input min>`.** That function is what the grid draws *and* what `classSheets` turns into importer rows, so a floor the screen showed and the commit ignored is impossible by construction — §10.6's rule about never re-deriving at a call site, in its other form. `GET /onboarding/classes-shape` supplies it, read fresh on every call rather than stored in the draft for the same reason `stampPools` re-reads the pool mode: a copy of a fact about the school, held in somebody's half-finished setup, is a copy that goes stale.

`SchoolShape` carries two facts that look alike and are not. **`floors` is school-wide** — the widest any *one* pool runs, never the total, or an individual timetable would be floored at the main school's four *plus* its own two. **`existing` is per pool**, keyed by wing name, and answers the different question "is this row a record or a plan?", which `floors` cannot. Both are optional throughout: absent means "not stated" (invariant 7) and yields exactly the pre-§3.10b behaviour, which is what keeps the unit tests and the AI interviewer working unchanged.

Two consequences on screen. **A class this wing already teaches loses its Remove button** — the button only dropped the class from the *sheet*, so its rows survived and the grid stopped listing children who are still timetabled; deleting a cohort belongs on the Classes master, which counts what is about to go before it goes (§27.11). And the grid **marks which sections are new**, since a step that creates rows and a step that describes rows look identical when everything is one colour.

One default with two authors had one that won silently: `recordWing` asked the school, found four, and never used it — because `answersFromSchool` had already listed the new config as a wing with two, and the "already in the draft" guard skipped the write. `defaultSections` is now the single definition both doors call.

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

### 3.13 Deleting a Timetable

A school that builds the wrong wing needs a way to remove it, and `DELETE /timetable-configs/:id` was one line: detach the class-sections, delete the row. It returned 200 and the card disappeared, which is exactly why it went unnoticed — **`timetable_slots` and `timetable_publications` have no foreign key to `timetable_config`.** Every generated row survived, pointing at a timetable that no longer existed: on no screen, in no count, unreachable forever. MySQL raised nothing, and never would.

So the cascade is hand-written, in `masters/config-deletion.ts`, and each step declares its **count and its delete in one object** — the §23.7 rule, for the same reason: two lists are free to disagree, and the day they do, a confirmation dialog under-reports a destructive write.

**What goes:** every draft's slots (including the §18 `source='extra'` rows, which sit outside every draft and which a per-draft delete misses), the `timetable_drafts` registry, the extra-class rows, the periods and breaks, the auto-resolve history, the publication log, and the config. Slots must go *before* drafts — `draft_id` is the base column of the generated `draft_scope`, so its FK is RESTRICT and MySQL refuses to remove a draft that still has rows. The cascading tables are deleted explicitly rather than left to MySQL, because the confirmation has to be able to say "and its 40 periods"; a silent cascade is a destructive write nobody was shown.

**What stays:** class-sections are *detached*, never deleted, and they keep their strength, home room, class teacher and curriculum — the state a newly created section is in anyway. Classes, subjects, teachers and rooms are untouched. **Deleting a wing must not delete the children in it**, and that line is what a person pressing Delete is expecting.

**A published timetable is refused, by name.** A school may be teaching from it, and `substitution_log` points into its rows with no FK of its own — substitutes are only ever assigned against published slots, so this refusal is also what keeps that table from being orphaned. The refusal names what to do instead rather than greying out a button that explains nothing, and it is enforced when the DELETE arrives: the plan is recomputed server-side, never taken from the request, so a preview held open for five minutes is never the list of writes.

**On the screens.** The Timetables card gains a Delete button that opens the counted plan and asks for the timetable's name to be typed — the list above it is long, the action cannot be undone, and the cards are three lines apart. And the guided setup's wings step (§24.2a) loses "Remove" for a wing that has already been **created**: it only ever removed the wing from the draft, leaving the `timetable_config` standing, so the admin met it again on the Timetables screen wondering what the button had done. A wing that has *not* been created keeps its Remove, and must — otherwise a mistyped name is created on Next, deleted from the Timetables screen, and proposed again by the draft on the next Next.

`scripts/delete-timetable-smoke.cjs` counts rows rather than reading responses, which is the only way this feature can be tested: the bug it exists for returned 200.

### 3.14 Withdrawing a Published Timetable

The lifecycle had no way back. A school could publish, and publish again, and that was all — and two other screens told them otherwise: §27.11's allocation reset and §27.15's cell delete both refuse published work with "unpublish it first", which was advice about a button that did not exist. `POST /timetable-configs/:id/board/publish/unpublish` is that button.

**The rows are flipped, not copied and deleted**, and that is the load-bearing choice rather than an optimisation. `substitution_log` refers to slots by id and has no foreign key of its own, so a copy-and-delete would leave every recorded cover pointing at a row that no longer exists, and republishing would mint a new set of ids that no substitution matches. Flipping keeps every id, which makes the whole operation reversible by pressing Publish again — the smoke asserts exactly that: the same 160 rows, the same ids, back as v2.

**Back into the draft it came from, when that draft is still empty.** Publishing flips a draft's rows in place and leaves the registry row behind as provenance, so the ordinary case is one `draft_id` shared by every published row pointing at a draft with nothing in it; flipping them home is the exact inverse, with the same draft number and label. Anything else — rows from before §22 with no draft id, or a draft since filled again — goes into a new draft. That is not caution for its own sake: `draft_scope` is in all three unique keys, so flipping a week into a draft that already holds one would collide on the first cell and roll back with a database error instead of an explanation.

**The version is kept and marked withdrawn** (`withdrawn_at`, `withdrawn_by_id`). Deleting the publication row would make v3 disappear and renumber the next publish back to v3, quietly rewriting the school's own record of what was on the wall in September.

**What it does not touch:** §18 extra classes, which live in both statuses and are no part of the publish lifecycle; the drafts a previous publish archived, since nothing records which they were and guessing would resurrect work a school had moved on from; and the substitutions, which are counted and named in the confirmation instead — they vanish from the Substitute Center while the timetable is a draft and line up again on republish, which is a consequence worth being told before pressing the button rather than discovering afterwards.

**Everyone who was told it went live is told it came down.** The publish notification says "v3 is now live — view yours"; without the other half a teacher opens My Timetable to an empty week with no way to tell whether the school changed something or the app broke.

It asks for `timetable.publish`, the same authority that put it there — `timetable.edit`, which is enough for "draft from published" because that only *adds* a working copy, is deliberately not enough to take the school's timetable down. The isolation gate caught the first version answering a stranger `200` with an empty plan: every query in it is school-scoped, so another school's config id matched nothing and produced a plausible "nothing published" answer instead of a 404 (§17.8, "another school's id is 404, never a successful no-op").

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

### 4.7b Time off for a class, a subject and a room

§4.7a gave a teacher an availability grid. Three other things in a school have exactly the same kind of fact and could not say it: a **class** is not in school on a half-day, a **subject** may not be taught in a given slot ("no games in period 1"), a **room** cannot be used while it is being cleaned. `class_section_unavailability`, `subject_unavailability` and `room_unavailability` are the teachers' table three more times, and one **Availability** screen edits all four — a tab per kind, the same week grid, the same quick patterns.

**Three tables, not one polymorphic one.** An `entity_type`/`entity_id` pair would have saved two migrations and cost the foreign key, and a blocked cell pointing at a teacher who has been deleted is a constraint nobody can find. It would also leave the §23 sync cascades unable to name what they delete, which §23.7 requires. The sameness lives in the code that reads them — `blockedCells` in `feasibility/time-off.ts` is the one definition of **"`period_number` NULL means the whole day"**, used by the solver, the board and the engine — rather than in a column that erases what a row is about.

**Where each one binds:**

| Kind | Solver | Feasibility |
|---|---|---|
| Teacher | domain pruning (§4.7a) | Check 2 subtracts it from weekly capacity |
| Class-section | domain pruning — the cell is gone for every variable of that section | **Check 1 makes the week smaller** |
| Subject | domain pruning — gone for every variable of that subject, in every class | **Check 1b**: does the subject still fit in the cells it is allowed? |
| Room | the cells are written into the occupancy map at construction | the §19/§19.1 room supply counts what is left |

**The class one is the load-bearing one, and it is a capacity fact, not a preference.** Check 1 computes `available = days × periods`; without subtracting the blocked cells a class with Friday off still reads as having 40 slots, Readiness says 100%, and the solver then fails to place a curriculum that no longer fits — which reads as the solver's fault. The message says so in full: *"Class 2-A needs 40 periods/week but only 32 slots exist (5 days × 8 periods, less 8 blocked)"*, and the fix names the Availability screen, because time off is the newest of the three reasons and the one somebody may not remember setting. Days outside the working week cost nothing: a school that blocks Saturday and then drops Saturday from its week has said the same thing twice, and the second saying must not shrink the week again.

**A blocked room is a room that is already taken.** Its cells go into `SolverState`'s occupancy map at construction, with the same sentinel §7.4's locked cells use, rather than becoming a fourth condition in each of the five places that pick a room — the home room, the lab pool, §19.1's own-room pool, a mapping's preferred room and each §4.9 option's fixed room. All five become correct at once, and no future room-picking branch can forget it. The two branches that name a specific room say *"the room is not available then"* rather than *"occupied"*, because the second is a fact about the timetable and the first is a fact somebody can go and change.

**A multi-section or multi-subject variable needs every one of them free** — a §4.10 merged group where any member class is out, a §4.9 block where any option's subject is blocked, cannot run. The same intersection rule the option *teachers* already followed, for the same reason: the lesson happens once, in one cell, for all of them.

Two states, not three. The screens this pattern comes from offer a middle "conditional — use only if necessary", which is a **soft** preference and therefore a scoring term in the §5.6 objective rather than a pruning rule. That is a different mechanism from everything above and is deliberately not built: available or not available, hard, like every other §4.7 rule.

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
0. **Timetables** — the landing screen: every timetable_config the school runs (Primary Wing, Middle Wing, Senior Wing, …), each with its classes covered, periods/day, timing, and status. "+ New Timetable" starts a fresh wizard without disturbing the others; "Edit" re-opens an existing one directly at its config step. **Each card carries five actions, coloured by what they do**: ✎ Edit and ⚡ Guided are the two ways to get on with the work (filled brand, and brand-tinted — siblings, not neighbours), ◎ Readiness checks it (accent), ⧉ Clone copies it (neutral), 🗑 Delete destroys it (signal). Five identical grey outlines made Clone and Delete look like the same kind of thing, which is the one pair here that must not. The status pill moved up beside the timetable's name, where it describes rather than acts — standing in the action row it was also what made the row ragged, being a pill 12px shorter than every button beside it.
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

### 8.1d The nav collapses to icons

Twenty-four entries in seven groups is a lot of navy down the left of every screen, and the screens that need width most — the allocation matrix, the draft board, the curriculum grid — are the ones looking at it. So the sidebar collapses from 236px to **64px of icons**, remembered per browser in `localStorage`: which way somebody likes their nav is a preference, not a fact about the school, and it never goes to the server.

**The width is a root token, not a width on the sidebar.** `--sidebar-w` is what the §24.5d guided-setup dialog insets itself by, so collapsing sets it on `document.documentElement`. Setting it locally would shrink the nav while the dialog kept a 236px gap down its left edge — a strip of dead page that would be very hard to trace back to a nav toggle. It is read before the first paint, so the nav does not flash open and snap shut on every page load.

**The icons are inline SVG, not emoji**, and the reasons are all about the collapsed state. They inherit `currentColor`, so an icon goes white on the active row exactly as its label does — twenty multicoloured emoji in a navy panel would be the loudest thing on screen, and the nav is the one part of the app that should never compete with the timetable. They render identically on every platform, which matters when the icon is the *only* thing identifying a screen. And `icon` is a **required** field on a nav entry, so a new screen cannot be added without choosing one.

**The label slides out of the icon and back in.** One flyout element for the whole nav, `position: fixed`, its top measured from the hovered row. Two things about that are load-bearing: a label nested in its own row cannot work, because `.sidebar-nav` scrolls and therefore clips, and CSS has no way to be scrollable on one axis and visible on the other; and the flyout **stays mounted**, fading and sliding in both directions, because an element removed on mouse-leave has nothing left to animate — "and then go inside" needs the thing to still be there on the way back. Keyboard focus opens it too, and `prefers-reduced-motion` turns the movement off.

What is left when the labels go: the group headings become 1px rules, so seven groups still read as seven groups rather than one column of twenty-four icons; the school's name, the user's name and the sign-out text fold away by the same rule; and every row keeps `title` and `aria-label`, so the name reaches a screen reader and a native tooltip whatever the animation is doing.

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

### 10.6 The Timetable Wall (Phase 42)

A canvas of small week cards, each pinned to one **teacher, class-section, room or subject**, picked from an empty cell. Routed at `/wall`, under **Reference** beside Reports, gated on `reports.view`. It reads and never writes.

Most of it already existed: `WeekGrid`, the two grid endpoints, `/reports/options` and the §10.5 colour scheme. What did not, and what building it turned up, is below.

#### 10.6a A period number stopped being an identity — and a defect that came from that

`teacherTimetable` took its day shape from `slots[0].timetableConfigId` — whichever row the database happened to return first — and the renderer then walked *that* wing's periods. §3.10 makes a cross-wing teacher ordinary (the art teacher who also covers Class 6), and for every one of them the grid was wrong twice over:

- a lesson at a period number the chosen wing does not have **was never drawn**, because the renderer had no row to draw it in;
- and the grid map is keyed `day:periodNumber`, so Junior's Monday P3 and Senior's Monday P3 **collided and one silently won**.

Measured on a two-wing fixture (6 periods from 08:00 against 8 from 07:30, one teacher in both): **3 of 20 lessons vanished**, and Senior's P7 and P8 had no row at all. `scripts/reports-grid-smoke.cjs` drives exactly that fixture, and the pre-fix behaviour was restored once to confirm it fails.

The fix is a row **key**:

```ts
rowKey = (configId, periodNumber) => `c${configId}p${periodNumber}`
cellKey = (day, key) => `${day}:${key}`
```

Uniformly, never "sometimes the number and sometimes this" — a two-mode key is a bug waiting for the first school with two wings. `GridRow` carries `key`, `configId`, `wing`, and the card carries `wings[]`. `shapeFor(configIds)` returns the **union** of every involved wing's rows, ordered by clock, so two wings interleave exactly as the morning does. A single-wing card — every class-section card, and most teacher cards — keeps precisely the shape it had.

Rows are deliberately **not merged** across wings even when the times match: a card is true of one entity, and merging would have to pick one of two period numbers and be wrong about the other. Aligning cards to one clock is a property of a *wall of cards*, so it lives on the client, where the collection is known.

#### 10.6b Two new cards, and one correction to the plan

**Room** (`GET /reports/room/:id`) — cells headline the class-section, subtitled subject and teacher. It must include §4.9 **option rows** (`class_section_id = NULL`); a query by section would find none of them and a room running three language options would read as free. That is invariant 9 one level out.

**Subject** (`GET /reports/subject/:id`) — a subject is not one lesson. Maths runs in eight sections at Monday P1, so a cell drawn like a teacher's would name one and discard seven. The cell is a **count plus its sections**, heat-tinted against a `busiest` scale the server sends, so two subject cards are comparable. It answers what the other three cannot: *is this subject stacked where the school said it should be* — §26's priority and lunch rules, audited after the fact.

**Both need `view.all`**, and this corrects the plan. Scope elsewhere in this module is a row-level *filter* — a class-scoped teacher sees their own sections. Filtering a room's occupancy produces a grid saying **"Lab 2 is free on Monday P3"** when another class is in it: a wrong answer, not a smaller one. `roomUtilization` already required `view.all` for the same reason. `/reports/options` therefore offers rooms and subjects only to `view.all`, rather than listing a picker whose every entry 403s.

#### 10.6c One request for the whole wall

`GET /reports/wall?cards=t:1,cs:44,r:7,sub:3&date=…` — the compact `type:id,…` form §29.3's `units=` already uses, so a heterogeneous id list has one shape in this codebase rather than two.

- **Capped at 24 and the cap is reported** (`max`, `dropped`). A truncation nobody is told about reads as "that is everything".
- **A refused card is data, not an error**: `{ kind, id, denied, reason }` in its own place on the wall, so a shared wall degrades per viewer instead of blanking. Only `Forbidden` and `NotFound` are caught — anything else still 500s, or the wall becomes the one screen where a real fault renders as a tidy grey card.
- **An unknown or malformed entry is skipped, not refused** (§21's "the screen may be stale"): a saved wall outlives the things on it, and one deleted teacher must not make the other eleven unreachable.
- Each card still goes through its own function, so a card on the wall and the same card on the Reports screen are byte-identical — the saving is round trips and shared Redis reads, not a second query path. Measured on Second Branch (122 teachers, 2,360 published slots): **179 ms cold, 8 ms warm** for 24 cards, against the §14 budget of 300 ms.

#### 10.6d The screen

- **One clock down the left.** The axis is the union of every card's start times, so cards from different wings line up by real time. Period numbering is a toggle — a timetable clerk thinks in period numbers, a head of department in minutes. A card with nothing at an axis time gets a hatched row rather than being skipped, or the rows below would slide up and the alignment would silently be a lie. **This is only truthful because of §28.5** (one period duration per config); if that is ever revisited, this axis must be revisited with it.
- **Cross-highlight.** Hovering a lesson lights it in every card showing it, because the payload carries `slotIds` per cell — three cards showing one `timetable_slot` is a fact the server states, not something the screen infers by matching names. The highlight is an inset ring, not a border: a border would resize the cell and nudge every card as the pointer moved.
- **One date for the whole wall**, pushed into every card — the morning briefing, with substitutions in cyan.
- **A search, not four menus.** One box over all four kinds; the reference school has 122 teachers, and §8.5's rule is that a long list gets a filter before it gets a better menu.
- **Three densities.** `full` reuses `WeekGrid`; `compact` and `dots` use the wall's own renderer — `WeekGrid` is right for one printed sheet and wrong for twelve at once. They share the payload and the §10.5 colour rules, which is where agreement matters.
- **Who is free at this moment.** Pinning a lesson reports which teachers *on this wall* are free then — and says exactly that, because it is a far weaker claim than the Substitute Centre's and presenting it as more would be the wrong-answer failure again. A card whose wing does not run at that time is counted as neither free nor busy.
- **Resizing preserves position.** The cells are a flat array; growing the columns without remapping moves every card one place left and reads as the wall shuffling itself.
- **Only the next free cell offers the search box**; the rest are a thin `＋` until clicked. A 4×3 wall holding four cards otherwise draws eight identical full-height invitations — most of the screen given over to asking a question nobody asked, eight times.

**The wall is a column of flex rows, not one CSS grid — and that is the fix for a real bug, not a preference.** Every card was painting on top of the card below it. The mechanism is worth stating because it is not obvious: **a grid item taller than its track is not clipped by the track, it is painted over the next row**. So any disagreement between a card's height and its track's height becomes an *overlap* rather than a scrollbar, and `overflow: hidden` on the card cannot help — the card's box *is* its content height, so nothing overflows the card; what overflows is the track.

Two fixes were tried against the track sizing and neither worked: `grid-auto-rows: minmax(0, auto)` → `auto` (a `0` minimum does remove the automatic minimum track size, and it was wrong to have there, but it was not the cause), then `align-content: start`. The third attempt would have been another guess at a subtlety.

Stacked flex rows cannot express the problem at all: a flex row is as tall as its tallest child by construction, and the next row begins after it because that is what block flow does. There is no track to disagree with. The row also became a real element, which is what lets `align-items: stretch` give every card in a row the same height — and an empty cell `align-self: flex-start`, so one tall card does not give its row a full-height `＋`.

The lesson generalises: **when a layout's correctness depends on two independently-computed heights agreeing, choose the structure where only one height exists.**

#### 10.6e Deliberately not built

- **Editing on the wall.** Drag-and-drop belongs on the Board, where the rules engine, the legality highlighting and the §29.1 freeze guard live. A second editor over the same rows is how two answers to "may this move?" come into existence.
- **A free-form canvas.** A grid is what makes the shared clock axis mean anything.
- **Per-card dates.** The wall's whole claim is that its cards are one week seen from several sides; different dates per card would make cross-highlight quietly untrue.

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

### 19.1 A subject taught in its own room

§19 gave the solver three ways to choose a room: a mapping's `preferred_room` (one class's one subject), a lab subject's mapped labs, and otherwise the class-section's home room. What no school could say was the **ordinary middle case**: Music happens in the Music Room, for everybody, and it is not a lab. `subjects.taught_in_own_room` is that sentence.

**One column, and deliberately no room id beside it.** Which rooms a subject uses is already recorded — `room_subjects` has meant "this room serves these subjects" since §19, and it is what stops a biology period being sent to the physics lab. A `subjects.room_id` column next to it would be a *second* answer to "where does Music happen?", free to disagree with the first, with both feeding the same solver; and it would be a worse answer, since a school with two music rooms cannot say so in a single foreign key. **The flag says WHETHER, `room_subjects` says WHERE.** The Subjects screen edits both — which is what was asked for — while the database keeps one source of truth.

**The room ladder, in order.** `preferred_room` (most specific: one class, one subject, one named room) → **the subject's own rooms** → the lab pool → the home room. Own-room sits *above* the lab branch on purpose: a school that ticks the box on Biology and names the Bio Lab is being narrower, and the lab branch would widen it again by falling back to every general lab — precisely the "it went somewhere else because that was free" the tick exists to prevent.

**Ticked with no room named is UNSTATED, not "anywhere"** (invariant 7). Treating an empty pool as every room in the school would scatter Music through whichever classrooms happened to be free. The lesson takes the home room exactly as before, and Check 5b says the tick is doing nothing — silence there would leave the screen contradicting the timetable.

**Check 5b** is the Phase A half, and it is per **subject**, unlike the lab aggregate: two music rooms and a pottery room are not interchangeable capacity, so a total would hide the shortage. `SUBJECT_ROOM_OVERFLOW` is a blocker naming the room ("Music needs 112 periods/week in 1 room (Music Room), which holds 40"); `SUBJECT_ROOM_TIGHT` warns at 90% — tighter than the labs' 80% because a lab pool is interchangeable and a subject room is one place; `SUBJECT_ROOM_UNSET` is the half-said case above. Without this, ticking the box on a school of 56 sections asks for something arithmetic forbids and the failure surfaces as the solver's fault.

**The board gets the same rule for free** (one rules engine, three call sites) — with one addition: a card whose subject has *several* rooms may re-home between them on a drop, exactly as a lab card re-homes to a free lab. A card sitting in some other room — dragged there before the flag was ticked — keeps that room as a hard constraint rather than being silently moved.

**A bug found on the way.** `roomSheets` never wrote the `Lab For Subjects` column. `suggestRooms` computes those subjects with some care — its own note says a lab proposed without them "does not create a science lab, it creates a second general-purpose room with a misleading name, and the solver will happily put Hindi in it" — and the sheet dropped them on the floor, so **every lab the guided setup has ever proposed arrived general**. Harmless while only labs read the table (a general lab serves everything) and load-bearing now, since this is the column §19.1 learns WHERE from. The header is not renamed, because it is the key in every workbook already downloaded; only the help text widened.

That gap had a workaround: the guided setup ran a second pass (`attachLabSubjects`) after each step-8 commit, upserting the same rows, under a comment claiming "the Rooms SHEET has no column for" the mapping — which was not true even when it was written. So one fact had two writers on one path. Filling the column in retires the workaround, and it is gone: the sheet is the writer, as it is for every other master fact, and the importer's Rooms loop runs for every row rather than only new ones, so re-committing the step still updates the mapping. The guided smoke proves it with the second writer removed — every proposed lab still carries its subject.

On the doors: the manual Subjects master gets the checkbox and a room picker (the rooms exist there, with ids); the guided setup's Subjects step gets the checkbox only, since which subjects a room serves is a fact about the *room* and the Rooms step already says it; the Subjects sheet gains `Own Room`, while `room_subjects` keeps its single importer writer on the Rooms sheet — a room name typed on the Subjects sheet would have to exist by the time Subjects is read, and Subjects is read first.

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

### 24.5d The guided setup is as wide as the pane

The wizard opened as a centred 840px card. That is a good width for reading a paragraph and a bad one for a class × subject matrix: steps 4, 7, 8, 9 and 10 are the widest content in the app, and all five scrolled sideways inside a dialog with half the screen dimmed and empty beside them. So the dialog is now sized to the **working pane** — everything to the right of the navy nav — via `.pane-overlay` / `.pane-dialog`.

Three details make it behave rather than merely fill:

- **The overlay still covers everything.** Only the panel is inset; the nav is dimmed with the rest, because a modal whose nav still looks live is an invitation to click it.
- **`--sidebar-w` is a token**, used by `.sidebar` and by the overlay's left padding. Two hard-coded 236s in two files would eventually disagree, and the dialog would either overlap the nav or leave a strip of dead page down its left edge.
- **The dialog is wide; the content is not always.** `WIDE_STEPS` names the five table-shaped steps, which fill; the six form-shaped ones keep an 880px measure and centre. A 1600px-wide "what is your school called?" box is not more usable than a 700px one, only harder to read across — and stating which steps are which, beside the list they refer to, makes a new step choose rather than inherit.

Below 900px the padding drops and the dialog takes the whole width: sizing to the pane is about using the room there is, and on a narrow screen it would be about giving room away.

**The step rail spans the strip too**, which it did not when the dialog grew: eleven dots stayed bunched at the left with fixed 10px connectors, packed tight while most of the bar was empty — a cluster rather than a route. The connectors are the flexible part now, so the dots space themselves to whatever width the pane has. And with the room to show them, **every step is named** rather than only the current one; the labels sit *under* their dots because eleven labels in a row spaced the dots unevenly ("Curriculum" is three times "Wings"), and under them they cost the strip no width and truncate rather than collide when the pane is narrow.

The welcome screen keeps its centred card deliberately — three doors spread across 1700px would read as three things lost on a page rather than a choice — and the conversational setup is already full-screen, which is more room than the pane, not less.

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

---

## 30. Individual and Grouped Timetables (Phase 43)

A timetable can be **grouped** — sharing cohorts and staff capacity with the other timetables in its pool, which is today's behaviour — or **individual**: its own cohorts, calculated alone, so several timetables can cover Class 1 without seeing each other.

Reading the code first turned up two things that shaped the design:

- **Almost nothing is shared today.** Exactly two couplings exist between two timetables: a class-section belongs to one `timetable_config` (invariant 11) and teacher *weekly load* is summed across configs in the same year (Check 2). Room contention, home rooms and per-period occupancy are already per-timetable.
- **Two timetables can already put the same teacher in Monday P3.** `timetable_config_id` is the leading column of `uq_teacher_slot` and the solver never loads another timetable's slots. §3.10 records this as deliberate — but a weekly total does not stop Mrs Rao being in two places at 09:14. It cannot simply be switched on, because occupancy is keyed by period *number* while Junior's P3 and Senior's P2 both start 09:14; §28.5 already names tick-based occupancy as the real answer.

### 30.1 The resource group

The thing that exists is the **pool**, not a flag. A flag has to be interpreted at every call site; a pool is a narrower `WHERE`.

```
timetable_groups        id, school_id, academic_year_id, name, mode('grouped'|'individual')
timetable_config        + resource_group_id NOT NULL
class_sections          + resource_group_id NOT NULL
                        unique (class_id, section_id, academic_year_id, resource_group_id)
```

**Invariant 11 is generalised, not broken.** *Before:* a class-section belongs to exactly one `timetable_config`. *After:* **within a resource group**, a class-section belongs to exactly one `timetable_config`. With one pool per school-year — which is exactly what the migration creates — those sentences say the same thing, and every existing school behaves identically.

The pool **owns** the cohort row; `timetable_config_id` keeps meaning "which timetable in this pool teaches it", and `NULL` still means "not attached yet" — available to the pool, not to the school. A pool is per session because everything it scopes already is (§3.11).

`individual` is a pool holding exactly one timetable and refusing a second. That refusal *is* "an individual timetable cannot have more than one wing", expressed where it is checkable rather than as a rule the Wings step has to remember.

### 30.2 One writer, because the database cannot be one

`class_sections.resource_group_id` and `timetable_config.resource_group_id` are the same fact stored twice, and MySQL cannot tie them together: a generated column may only read its own row, and this value lives in another table. §22's `draft_scope` had the database to compute it; this does not.

So `ResourceGroupService` (`@Global`, like `FreezeService`, and for the same reason — **the failure mode is a new write path that never asks**) is the single resolver, and it states the rule once: *a class-section attached to a timetable takes that timetable's pool; an unattached one takes its session's.* Seven write paths use it — the masters screens, the §16 importer, the ERP sync, cloning, the dev seed and the two guided-setup doors that reach the importer.

One of those was found by hand rather than by the compiler: `sync.service.ts` types its transaction client as `any`, so a missing required column compiles and fails at runtime. Worth remembering as the file where the type checker is not the safety net.

`pnpm test:groups` is the guard, and its central assertion runs across the **whole database** rather than its own fixture — the write path that forgot is by definition the one not under test. It also asserts both halves of the key change: a second Class 1-A in the *same* pool is still refused, and one in a *different* pool is now accepted.

### 30.3 Every cross-timetable question asks the pool

There is exactly **one** cross-timetable calculation in the codebase, so stage 2 is one query. `crossConfigTeacherLoad` in `solver/input.ts` filtered by `academicYearId`; it now filters by `resourceGroupId`, and the argument is Phase 19's one level in: next year's teaching does not consume this year's capacity, and *an individual timetable's teaching does not consume the main one's* — otherwise a school could not sketch an alternative without its real timetable reporting everybody overloaded. A pool belongs to exactly one session, so the pool filter **subsumes** the year filter rather than sitting beside it; two filters that must agree are two filters that can come to disagree.

§29.3's reassignment engine reads the very same `crossConfigTeacherLoad` field off the very same snapshot, so it is corrected by that one line rather than by anything near the restaff code.

**`capacityForClass` deliberately stays year-wide**, and that is worth recording because narrowing it to the pool is the obvious change and it is wrong. A curriculum row is keyed `(class, subject, year)` and is *shared* across pools — what Class 1 studies is a fact about the class and the session. A shared row therefore has to fit in every pool that teaches that class, so the tightest week across the session is exactly the right cap. Scoping it to one pool would let somebody enter 40 periods against an 8-period individual timetable and hand the 6-period grouped wing a Readiness blocker instead of a form error — a worse place to find out, and a rule the person who typed it never saw.

Two guards are written now although neither can fire until stage 4 creates a second pool, for the reason that a guard added at the same time as the thing it guards is a guard nobody has yet had a chance to need:

- **`PUT /:id/class-sections` refuses a cohort row from another pool.** The existing check only catches a section another *timetable* holds; one sitting unattached in a different pool has `timetable_config_id` NULL and sailed straight through it, which would have put a row in a pool its own timetable is not in — the exact drift `ResourceGroupService` exists to prevent, arrived at through a legitimate screen.
- **`GET /class-sections?timetableConfigId=` narrows to that timetable's pool.** Optional, and unfiltered still means the whole school; it is the hook the screens use once "Class 1-A" would otherwise appear twice in every picker. An id naming nothing in this school leaves the list unfiltered rather than empty — the alternative tells a stranger "that timetable has no classes", a fact about a school they cannot see.

### 30.5 When a timetable applies

A timetable carries `effective_from` / `effective_to` (DATE, both nullable), and **two published timetables whose windows overlap may not share a class**. Null at both ends means the whole session — every school before this feature — which is why the rule cannot fire on existing data: two configs could not share a class at all before §30.1.

    Timetable 1 · Class 1-3 · 01 Apr – 30 Jun   ┐ both publishable,
    Timetable 2 · Class 1-4 · 01 Jul – 31 Aug   ┘ the windows are disjoint

    Timetable 1 · Class 1-3 · 01 Apr – 31 Aug   ┐ refused, naming Class 1, 2 and 3
    Timetable 2 · Class 1-4 · 01 Jul – 31 Aug   ┘ and the timetable already live

**This is what makes individual timetables safe rather than a hole.** Pools let two timetables cover Class 1; this stops both being live for those children at once.

Three details of `ValidityService` are load-bearing:

- **By CLASS, not by class-section.** With pools, "Class 1-A" is a different row in each pool for the same children. Comparing rows would find no overlap and the rule would never fire.
- **Against currently *live* publications** (`withdrawn_at IS NULL`). §3.14 keeps a withdrawn publication row and marks it, so withdrawing genuinely frees the window — which is what makes "withdraw this one, publish that one" an ordinary Tuesday.
- **Never retroactive.** A window ending unpublishes nothing. Publication is a decision (§3.14), not a lease; a timetable that went dark overnight is what §29.2 refused when it made a staffing change a record rather than a mode.

Checked at **publish** and at **re-dating**, because re-dating is the other way to create the overlap publishing prevents. Re-dating passes the *proposed* window to `assertPublishable` so the question is asked before anything is written — the alternative is store, ask, roll back: three writes to answer a question, with a window briefly applied that the school is about to be told it cannot have.

`timetable_publications` has `timetable_config_id` and **no Prisma relation** to the config, exactly as §23 records for `timetable_slots` and the masters, so "which configs are live" is its own query rather than a `publications: { some }` filter. Here the type checker catches it; that is the lucky version of the trap.

**Not reusing §25's terms**, though they are also dated spans. §25 states that *"a session is term-wise if and only if it has term rows"*, so creating terms to date a timetable would flip that school's whole app into term-wise mode — term selectors, per-term publishing, the Board loading one term at a time. They also answer different questions at different levels, which is what stops them competing: the **session** is the year, the **window** says *which* timetable is live for these children, and a **term** says *which shape of week* that timetable uses within itself.

`currentFor(classId, date)` resolves which timetable is live for a class on a day, in §25.2's shape — asked-for id, else the window containing the date, else the undated one. Nothing reads it yet, because until stage 4 there is only ever one candidate and every caller already knows it. It is written here because the rule and its resolver are one idea, and splitting them across two stages is how they come to disagree.

**Showing the period everywhere** costs one field on `TimetableConfigSummary`, which already reaches eighteen screens through `ConfigContext`: the top-bar selector, the Timetables cards, the printed sheet's masthead and the §10.6 wall card. `windowLabel` (in `packages/shared`, so the server's refusal prose and the client's chrome cannot drift) returns **null** for an undated timetable, and every caller then falls back to the session's own name — printing dates for a school that never uses this would put a number on every screen that means nothing. On the wall the window rides on each **wing** rather than on the card, because a card can span two wings whose windows differ.

### 30.6 Creating an individual timetable

`POST /timetable-configs` takes `mode: 'grouped' | 'individual'` — grouped by default, which is what every timetable was before this. An individual one gets a pool of its own (`createIndividual`, named after the timetable and suffixed on collision, since a pool's name is a label while a timetable's is the real identity). `resourceGroupId` names a pool to *join*, verified to belong to this session first — a pool id is not a capability, the same rule §25.2 states for a term id.

**"An individual timetable cannot have more than one wing" is `assertAdmits`**, a property of the pool rather than a rule the Wings step has to remember — so every door that creates a timetable is covered by writing it once, including the ones that do not exist yet.

#### The importer's existence key had to learn about pools

This is the change the whole of stages 1–3 was for. The §16 importer decided a class-section already existed by its **label alone** (`has(existing.classSections, "Class 1-A")`). With pools that is wrong in the one direction that matters: an individual timetable importing Class 1-A would find the main wing's, call the row existing, skip it — and open with **no classes and no error**.

So the check reads a separate, pool-qualified list. Separate, and not the existing one, because `existing.classSections` is also what every other sheet's `Class Section` column is validated against and what the template offers as a reference list; qualifying those labels would fail every one of those lookups. The row's own pool is resolved from its `Timetable` column, falling back to its session's — the same rule `ResourceGroupService.forSection` applies on the write, stated in the validator so the dry run and the commit cannot disagree about what already exists.

Both maps are optional. The AI drafting path (§13.5) builds `ExistingData` by hand and data that predates §30 has none, and in that case the key collapses to the label — exactly the old behaviour.

#### Filter, do not qualify — except where the qualifier already exists

Per §5.3 of the plan, the top-bar selector is the scope: `GET /class-sections?timetableConfigId=` narrows to that timetable's pool, and the pickers on **Electives**, **Extra Classes**, **Subject Mapping** and the advanced setup pass the id they already hold.

The **Classes master deliberately does not filter.** It is where cohort rows are *managed*, including ones attached to no timetable at all, and filtering would make those unreachable from the one screen that exists to reach them. It can afford to show every pool because it already distinguishes them — its table has a Timetable column, which is the qualifier decision §30 asks for wherever several are legitimately in view.

### 30.6a Moving a timetable between pools

`GET /timetable-configs/:id/resource-group/preview` and `POST /timetable-configs/:id/resource-group`.

**The plan is recomputed at apply, never taken from the request** (§21's rule: a preview is not the list of writes) — the request names a *destination*, never a set of rows. The plan is the §3.13 shape: **the count and the write are declared in one object**, so a confirmation cannot under-report what it is about to do.

- **Grouped → individual is always safe.** A brand-new pool has nothing to collide with. It *loosens* — fewer timetables competing for the same cohorts and staff — so it is never automatic and the screen says so.
- **Individual → grouped can refuse**, and refuses **by name**: the destination may already hold Class 1-B, which within one pool would be two rows for the same children. The refusal says which row and what to do about it.
- The move is **one transaction** over both columns — the config's pool and every one of its cohort rows' — because they are the same fact stored twice and a half-applied move is precisely the drift `pnpm test:groups` exists to catch.
- **An emptied individual pool is removed**, but only when it holds neither a timetable nor an unattached cohort row: it was named after a timetable that is no longer in it, and nothing can make that name true again. A *grouped* pool is the session's own and is never removed here.

Instead of predicting a Readiness score, the plan reports `loadChanges`: the teachers whose weekly total is summed against a different set of timetables after the move, with exact before/after numbers and their cap. Those are the numbers **Check 2 itself uses**, so they are checkable — a predicted score would mean simulating the whole engine against a pool that does not exist yet, and could be wrong in either direction.

**Deliberately not freeze-guarded** (§30 decision 4): a pool change alters what is *validated* and never what is placed, which is the argument §4.7 availability is exempt on. That was accepted knowing it might bite, so the deferral is kept answerable — the move is written to `audit_logs` and Readiness is dropped immediately, so a blocker it creates appears now rather than at the next Generate, weeks later, with nobody remembering what changed.

### 30.7 Clashes between live timetables

§30.5 makes the case that matters impossible — a class cannot be in two live timetables at once. What is left is two timetables over *different* classes that share a teacher or a room: Primary and Senior, all year, both with Mrs Rao. That is a real-world collision the app has never reported, and it exists in schools' data today with nothing to do with individual timetables.

**Compared by wall clock, never by period number.** Occupancy everywhere else is keyed by period number — that is what `uq_teacher_slot` and `uq_room_slot` compare, and within one timetable it is exactly right. Across two it is not: Junior's P3 starts 09:14 and Senior's P2 starts 09:14, so comparing numbers would refuse a pair that does not overlap and allow a pair that does. §28.5 already names tick-based occupancy as the real answer and records it as the reason per-class period lengths are refused; this is that arithmetic applied to the one question that can be answered without it — not *preventing* a clash while placing, but *reporting* one that already exists.

`findClashes` is pure and lives in `packages/shared`, indexed by key and day rather than compared pairwise: each side of the reference school is ~2,400 engagements, and the quadratic version is six million comparisons on a screen with a 300 ms budget (§14). Touching is not overlapping, or every back-to-back pair in the school is a clash.

Two things the occupancy builder must get right, both §4.9 and §4.10 one level out: **elective option rows carry a teacher and a room and no class-section**, so a query by section would miss a language teacher taken by two wings entirely; and **a merged group is one occupancy however many sections attend**, so without deduplication one clash is reported once per member section.

#### It is not a feasibility Check, and that is the point

The engine is Phase A: it reads a snapshot of *demand* and answers "can a solution exist?", with no placements in it at all. This compares two weeks that are already *placed*. Putting it in the engine would mean handing the pre-flight engine the output of the thing it is supposed to run before — so `ValidityService.clashesFor` computes it and `ReadinessService` appends the issues **after** `runFeasibility`.

After the **score**, too, and for §28.1's reason: a clash with another timetable does not make this one less able to generate, and a dashboard falling for answering reads as the warning having broken something. `pnpm test:groups` asserts the score is identical with the clash and without it, on a fixture scoring **82%** rather than the floor, so the assertion could actually fail.

Always a **warning with no remedy**. Whether two timetables genuinely run at the same time is a fact only the school has — and if they do not, narrowing one window (§30.5) is the fix.

#### The cache rule that had to change with it

`invalidateTimetable` now sweeps **readiness** as well as slots and reports, by pattern rather than by config id. A readiness answer used to be about one timetable alone, which is why an existing test asserted the opposite and was right to; it now carries the clashes with the other live timetables, so publishing B genuinely changes what A says — and the answer that went stale belongs to a *different* config from the one being published, which is exactly what a per-config sweep cannot reach. This is the third entry in the comment that already reads *"every write that changes a published slot belongs here"*.

### 30.8 What stages 1 and 2 deliberately do not do

Nothing is choosable yet. Every timetable joins the pool it would have been in anyway, and no screen mentions pools. The exit criterion for both stages was that **every existing suite passes with no assertion changed** — isolation, freeze, staffing, grids, guided setup, clone, drafts, electives, ERP sync, report cache, year scope, teacher scope, auto-fix, room assignment, AI data entry, shared 498 and api 215.

The thirteen smoke scripts that write rows with a raw `PrismaClient` did change, because they bypass the app and therefore carry the schema's shape. They share one helper (`scripts/resource-groups.cjs`) for the reason the service exists: a value written in thirteen places is written differently in one of them.

## 31. The Master Grid (Phase 44)

One screen, five pivots, no horizontal scroll: the whole school's week at once, read-only. Stage 1 is the grid; the strip that explains a clicked cell is stage 2.

### 31.1 Twenty-seven pixels decides the design

Five working days x eleven periods is **55 columns**. On a 1,920px screen, less the nav and the page inset, the grid gets about 1,600px; less a row header, that is **27 pixels a column** — measured, not estimated: the reference school's `Main Timetable 2026-27` really is 5 days x 11 columns.

Twenty-seven pixels holds two or three characters, and every other decision on the screen follows from that:

- **Initials, not names** — hence `teachers.initials` reaching the payload, and the Teachers master finally gaining a box to enter one (§31.3).
- **Colour carries the second fact.** §10.5 already gives every subject and class a stable colour, so a cell showing three characters and a hue is showing two things rather than one.
- **The tab rail is vertical.** Horizontal tabs cost a row of school; vertical ones cost 34px of width the row header wanted anyway.
- **Breaks get a hairline column.** They carry no cell, so they are 0.6% of the width and their name lives on the tooltip, giving the real periods their width back.
- **No emoji markers in a cell.** A lock or a link glyph is about eleven pixels — 40% of the cell — so a pin becomes a dark left border and a substitution keeps its cyan (§10.5: an existing meaning outranks a new one).
- **Column widths are percentages**, so "no horizontal scroll" is a property of the layout rather than a hope about the viewport. A `minWidth` below which the table scrolls sideways is the honest limit: a grid that shrinks a cell below what a character fits in is lying about what it shows.

### 31.2 Four pivots are one function

`GET /timetable-configs/:id/slots` already serves flat tuples (§14). Four of the five tabs — Whole, Teachers, Classrooms, Subjects — differ only in **which field of the tuple names the row**, so `pivotSlots` in `packages/shared` is one function and `PIVOT_FIELD` is one table. Four grouping functions is how three of them end up handling §4.9 correctly and the fourth does not; the same argument §10.6 made for exporting `rowKey`/`cellKey`.

**Which rows fall out of which pivot IS invariant 9**, and is the load-bearing part:

| pivot | keyed on | what is skipped, and why |
|---|---|---|
| `section` | `class_section_id` | option rows — they are not a cell in anybody's grid |
| `teacher` | `teacher_id` | member rows; the **option rows are kept**, which is what stops a school's third-language teachers reading as unscheduled |
| `subject` | `subject_id` | member rows — a block's point is that the children are doing different subjects |
| `room` | `room_id` | nothing; a room used only by an elective option is occupied, and reporting it free is a wrong answer rather than a smaller one |

**A cell holds a list, and "how many things are in it" has two right answers.** `cellEvents(entries, pivot)` owns that: on the **teacher** pivot a §4.10 merged group is **one occupancy event** — drawing "4" would claim four lessons where the school ran one — while on the **subject** pivot those same four rows are four sections doing the subject, which is exactly what §10.6's subject card counts. It is not an edge case: on the reference school **every one** of the 30 teacher cells holding more than one row is a merged group, and none is anything else, which is `uq_teacher_slot` doing its job through `teacher_occupancy_key`.

A cell with more than one event draws the **count**. On the reference school 386 of the Subjects tab's 548 cells hold more than one lesson and the busiest holds 16 — so the count is not a fallback, it is what that tab mostly shows, and naming one arbitrary section's teacher would be a smaller answer that reads like the whole one.

### 31.3 A teacher's initials are the school's answer, not ours

`initialsOf(name, stored)` in `packages/shared` returns a stored value **untouched** and derives one only when the school has never given any: a school writing `S.-PE` on its own wall chart is describing a person, not a name, and deriving `SP` would quietly overrule them. Three characters when derived, not two — on a staff of 122, "R. K. Sharma" and "R. K. Singh" have to be tellable apart and both fit.

There were already two derivations at call sites (`Board.tsx` took three letters, `Substitutes.tsx` took two), so the same person was `RKS` on one screen and `RK` on the next. Survivable while initials are decoration beside a full name; not survivable when they are the only thing identifying the teacher.

`teachers.initials` could be written by the §16 importer and the guided setup but **not by the Teachers master** — so a school that entered its staff on that screen had no way to say. §31 adds the field there, and normalises blank to NULL: empty means "not stated" (invariant 7), which is permission to derive; an empty string would be a stored answer of "nothing", and a blank 27-pixel cell reads as a free period.

### 31.4 The Lesson grid is the odd tab out

Class-sections down, **subjects** across, periods per week in the cell, with a per-row total — the same shape as §27's Allocation grid, read-only and at grid density. It is not a pivot of the slots at all: it reads the **curriculum**, so a cell reading 6 means Class 1-A is *meant* to have six periods of English whether or not a timetable has been generated.

`GET /timetable-configs/:id/context`, deliberately **not** `/class-subjects`, which serves the same rows: that controller is `masters.manage` and this screen is `timetable.view.all`, so a principal who may look at the whole school's week would have met a 403 on one tab out of five. Same controller and same permission as `/slots` means the screen answers to exactly one authority.

Three things it has to say out loud:

- **Cells are keyed by CLASS, not by class-section.** `class_subjects` is keyed by class (§27), so 5-A and 5-B are two rows showing one curriculum. A per-section payload would look like two answers that merely happen to agree.
- **The year filter is required** (§3.11): a class that has run three sessions would otherwise contribute three curricula to one grid, and the cell would show whichever loaded last. It comes free, because the payload reads `buildFeasibilitySnapshot`, which already applies it.
- **`weekCapacity` is this WING's week**, deliberately not `capacityForClass` — which is year-wide across every pool the class sits in because it guards a *write* (§30). Here it only labels a row total, and the honest denominator for "does this class's week fit" is the week this timetable offers.

A §4.9 block carries its own periods/week and is not a curriculum row, so an elective's options are **not** columns here — a grid showing French and German would be claiming Class 5 is taught both.

### 31.5 The four pivots are read-only; the editing tabs are the real editors, embedded

Phase 44 shipped this screen read-only, on two arguments. §31.10 and §31.11 kept both arguments and dropped the conclusion, because the arguments were never against *editing here* — they were against **building a second editor**:

- **§27 makes the Allocation grid the one writer** for curriculum and mappings, and a second editor over the same rows is how two answers to "how many periods does 1-A get?" come into existence.
- **Placement edits belong on the Board**, where the rules engine, the legality highlighting and the §29.1 freeze guard live — and a 27px cell is the worst drag target in the app. Same answer §10.6 gave.

Both hold exactly as written, and both are satisfied by **embedding the real screen** rather than reimplementing it. The Lesson grid tab renders `StepAllocation` (§31.10) and the Draft board tab renders `Board` (§31.11), each with its own props, its own commit path and its own guards. There is still one writer for curriculum and one for placement; each now has two doors.

So the read-only rule survives, narrowed to what it was always about — **the four pivot tabs**. Whole, Teachers, Classrooms and Subjects draw cells at 27 pixels and nothing there is editable, because a 27px cell is a bad target and a fifth writer would be a real one.

Two refusals that did not change:

- **It does not replace the Allocation Matrix.** They read the same payload and answer different questions: the Matrix has wide cells naming subject *and* teacher, for reading one class's week; this has narrow cells showing the shape of the whole school's. Adding pivots to the Matrix would have made its cells too small for what it is for.
- **One wing at a time.** The top-bar selector picks the timetable, and §3.10 wings keep different hours — two wings in one grid would need §10.6's wall-clock axis and would still leave most cells blank.

### 31.6 The strip

One row along the bottom that never moves and never covers the grid. Clicking a cell fills it; clicking another replaces it. It is what makes 27 pixels survivable: the grid is the map and the strip is the legend, and neither is much use alone.

**A strip and not a popover.** A popover over a 27-pixel cell covers the neighbours you are comparing it with, and comparing is almost always why the cell was clicked — the same argument §8.5 made for putting a master's form beside its list rather than below it. It is **always rendered**, at a fixed height, even with nothing selected: appearing on the first click would shorten the grid under the pointer at the exact moment somebody is reading it, and the row they clicked would move.

Four groups widening outwards from the cell to its context — what the cell is, whose class, whose lesson, and what else that class studies. **Arrow keys move the selection**, because the useful reading is *across* a row (this teacher's Monday, then their Tuesday) and reaching for the mouse fifty-five times is not reading. Left and right skip break and activity columns, which hold no cell. An **empty** cell is selectable too: a free period is a fact, and the strip is the only place with room to say whose it is.

#### One endpoint, because clicking has to stay cheap

Four facts the strip needs are not in a placement: a class-section's home room and class teacher, a teacher's weekly cap, and the curriculum. `GET /timetable-configs/:id/context` carries all four — one payload fetched once beside `/slots`, never a request per click, because clicking idly is how this screen is meant to be used.

The curriculum, the caps and the cross-pool loads are **read off `buildFeasibilitySnapshot`**, the same builder the solver and Readiness use, so the strip cannot disagree with them. It is cached under the config's own slot prefix, which `invalidateTimetable` already sweeps and a master-data edit takes with the school — without that, every page load would pay for a full snapshot.

#### The number that is easy to get wrong

"How full is this teacher's week" has a trap CLAUDE.md already records: **a line round one wing reads 67% where the truth is 87%.** So the strip states the wing's own count against the cap, and then *names* the pool's other timetables and their periods rather than folding them in — two limits with two different fixes, never one blended figure. The figure it names is `crossConfigTeacherLoad`, which CLAUDE.md calls "the only cross-timetable calculation in the codebase"; a strip quoting a different number from the one Check 2 enforces would be worse than a strip quoting none.

#### Two vocabularies, because the tabs ask different questions

On a **timetable** cell the four groups are the cell (subject, clock, room, pin/substitute), the class (label, home room, class teacher), the teacher (name, initials, load, sections) and the class's curriculum. A §4.9 cell also lists **every option** with its teacher and room, because that cell genuinely is several lessons and the grid has room for none of them; a §4.10 group names every section attending. A cell holding several *events* — a subject taught to sixteen sections at once — is listed rather than described as one lesson: that is the case the grid draws as a bare count, and the whole reason the count needs somewhere to expand.

On a **Lesson grid** cell there is no clock at all. It shows the subject, its period count, that the count is a *class* fact, and then **who shares the lesson** — every class-section, every teacher, every room. That list is not decoration: several sections on one lesson is a §4.9 block or a §4.10 merged group, and it is the only place on the screen where that becomes visible. When nothing is placed yet it says so, because "not generated" and "nobody teaches it" are different facts.

Two derivations are pure and therefore live in `packages/shared` beside the pivot, where they are unit-tested: `blockSections` (a block's attending sections, from the member rows — invariant 9 again, since option rows carry no section and contribute none) and `cellEvents`.

### 31.7 Placed against required

The Lesson grid's cells are the **curriculum** — a 6 means Class 5-A is meant to have six periods of Maths. §31.7 adds the other half, so the screen says `5/6` at the moment somebody is looking at the row rather than leaving it for Readiness to mention later.

**Two numbers only when they differ.** A number that is always two numbers is a number nobody reads. The cell drops the subject's colour and takes the signal red when it does differ — §10.5's own rule cuts this way, since "this row is short" is the more urgent fact and the column header is still carrying the subject's colour. The same rule and the same arithmetic drive the strip's curriculum chips and the Lesson-grid strip, from one module (`packages/shared/src/timetable/coverage.ts`), so the grid and the strip cannot disagree about whether a row is short.

**The point of the module is being *sure* about a difference.** A screen that cries wolf about a missing period is worse than one that says nothing, because the first thing a false report costs is the reader's trust in the other five hundred cells. Five things make the count wrong if they are not handled:

1. **Required is a CLASS fact; placed is a SECTION fact** (§27). "Six periods of Maths" is true of Class 5 and therefore of 5-A *and* 5-B separately. Summing the two sections and comparing 12 against 6 would report every class in the school as massively over-taught.
2. **§18 extra classes are not the syllabus.** Counting next week's revision class would hide a genuine shortfall. The filter is the same `teachingPeriods` set the fill rate uses, so the two figures on the screen cannot disagree about which periods are the week.
3. **A §4.10 merged group places one row per section**, and both sections are credited — this is the one place in §31 where merged rows are deliberately *not* collapsed. `cellEvents` collapses them because a teacher is in one place; here the question is what each class received.
4. **A §4.9 option row cannot be attributed.** It belongs to no class-section (invariant 9), so a school that also holds French as a curriculum row would read `0/4` for every section while the children are sitting in French. A subject that runs as an elective option is marked **not comparable** and the curriculum figure stands alone.
5. **"Nothing placed" and "nothing generated" are different facts.** Before a generation every cell would read `0/6` — not five hundred missing periods, an empty week — and a notation that screams on a blank screen teaches the reader to ignore it. A section with no placed teaching lesson at all is not compared. A *partly* generated one is, because there the gaps are real.

A placed lesson with **no** curriculum row is deliberately out of scope: it is a different question, Readiness owns it, and it would only ever be visible in the cases where some other class happened to give the subject a column.

Validated against the reference school as well as the fixture: 844 (section, subject) pairs compared, 8 sections matching exactly, 8 correctly skipped as ungenerated — and **zero over-placed pairs**, which is the shape a merged-group or elective mis-count would take. The 444 under-placed pairs are that school's own curriculum genuinely exceeding its week (Class 1 is owed 67 periods in a 40-period week), which is the feature doing its job.

### 31.8 Windowing the grid body

The Teachers tab on the reference school is **122 rows x 56 columns = 6,832 cells**, every one a `<td>`. The Allocation Matrix gets away with ~2,750 today; this does not, and CLAUDE.md has listed grid virtualisation as outstanding debt since §14 was written.

#### Thirty lines, not `react-window`

CLAUDE.md names `react-window` / AG Grid as the sanctioned answer, and for a generic grid it is. This grid is not generic in the one way that matters: `react-window` renders absolutely-positioned `<div>`s, and everything that makes §31 correct is table machinery — the `<colgroup>` of percentages that makes "no horizontal scroll" a property of the layout (§31.1), two `position: sticky` header rows with `colSpan` day grouping, and a `position: sticky` first column. Rebuilding those three as positioned divs to gain a dependency would trade a working layout for a library that cannot render a `<tr>`. Windowing a table body with two spacer rows keeps all of it, and the arithmetic (`viewport.ts`) is small enough to test exhaustively — thirteen tests, including a sweep over the whole scroll range asserting that everything visible was drawn.

#### The row height is measured, never assumed

The spacers stand in for the rows that are not drawn, so the height they reserve must be the height those rows would have had. That is two independently-computed heights having to agree, which §10.6 records as the shape to avoid: a CSS row height and a JavaScript constant drift the moment anybody adjusts padding, and the symptom is a scrollbar that lies. So the height is read from a rendered row and the module is pure arithmetic over it.

Two details that cost a frame each if got wrong, both of them lessons already in this document:

- **`useLayoutEffect`, not `useEffect`**, for measuring the pane — §8.1d's rule. A passive effect runs after paint, so the first frame would be computed for a viewport of zero: seven rows, then thirty-six a frame later, which reads as the grid filling itself in on every visit.
- **A seeded fallback height** so the *first* paint is already windowed. Starting from "unmeasured" would draw the whole 6,832-cell grid once and then shrink it — the exact frame this stage exists to remove. The measurement always wins; the constant is a guess for one frame.

And one that would have quietly undone the saving: the ref that measures is attached to whichever row is drawn first, and **that row changes as the window slides**, so React detaches and reattaches it on every scroll frame. Reading `offsetHeight` there forces a synchronous layout on each one. An epoch counter, bumped only by the resize observer, makes it measure once per layout instead of once per scroll.

#### Arrow keys move through data the DOM may not hold

§31.6's keys move the selection through the row *list*; windowing means the row they land on can be outside the drawn slice. `scrollTopFor` brings it into view — to the **bottom** when arrowing downwards, because jumping it to the top moves everything the reader was comparing it with. It returns null when the row is already visible rather than the current `scrollTop`, since assigning that on every keystroke fights any scroll already in flight.

#### Measured

| | cells | tree build + serialise |
|---|---|---|
| before | 6,832 | median **50.8 ms**, p95 **102.3 ms** |
| after (700px pane) | 2,016 | median **10.5 ms**, p95 **13.8 ms** |

**4.8x less work**, and 70% fewer cells at a typical pane height (75% at 560px, 52% at 1200px — the saving narrows as the pane grows, which is correct: a taller pane genuinely shows more).

The honest limit of that table: it is `renderToString` in Node over the same cell shape, so it measures **building and serialising the element tree**, not browser layout and paint. §14's "render-to-usable ≤ 600ms" is a paint budget and this stack has no headless browser, so that budget remains unverified for this screen. What is verified is that the work which changed got 4.8x smaller, and that the node count — which layout and paint scale with — fell by 70%.

### 31.9 What Phase 44 shipped

Five tabs, four of them read-only pivots, and no editing anywhere. §31.10 and §31.11 revised that — see §31.5 for how, and why the rule it revised is still standing.

Proof: `pnpm test:mastergrid` (live: initials, the pivots over real generated rows, the §4.10 collapse both ways, the strip's four facts, the cross-wing load, the cache, coverage on a clean week and after one deletion, and §17.8), `viewport.spec.ts` + `coverage.spec.ts` + `pivot.spec.ts` (**38 unit tests**), and the §17.8 sweep, which classified the new route with no help.

### 31.10 The Lesson grid is the Allocation grid

The Lesson grid began as its own read-only table of class-sections against subjects. It is now `StepAllocation` itself — the guided setup's step 9, the one writer for curriculum and mappings (§27) — rendered inside the tab at `density="compact"`, with its toolbar portalled into the Master Grid's own bar and its cell selection feeding the strip.

Three props carry the whole difference, and each removes a temptation to fork:

- **`density="compact"`** — percentage columns instead of content-sized ones, and the room out of the cell. Twenty subjects then fit with no horizontal scroll, which was the point of putting the grid here at all.
- **`toolbarHost`** — the host already draws a toolbar, and a second one below it costs a row of a screen whose whole design is about not spending rows.
- **`onSelectCell`** — the tab hands the strip **facts**, not ids. The grid edits draft answers that are not on the server yet; resolving ids here would be a second derivation, free to disagree with the grid it sits under, and certain to the moment somebody edits without saving.

`onFocusMode` is deliberately not passed: it exists so the step can ask the wizard's shell to fold its chrome away, and here the vertical tab rail *is* the frame. The Focus button renders only when the prop is given, so omitting it removes the control without touching `Allocation.tsx` — which is what embedding rather than forking buys.

The draft lives in the **host**, not the tab, which is what makes moving between the five tabs free: the tab unmounts, the work does not. Only leaving the screen is guarded, and by a module-level `guardUnsaved` rather than `useBlocker`, because `main.tsx` mounts a plain `<BrowserRouter>` and converting the app's routing to data routers to guard one screen is a large change for a small feature. Saving is one deliberate act: the wizard saves on Next, a tab has no Next, and auto-saving a grid that takes single digits with no Enter would commit half-typed numbers. `commitAllocation` is the two calls step 9 makes, in one place so the two doors cannot drift — `commitWeeks(answers, {changedOnly: true})` for the period *length* (a `timetable_config` fact, so it cannot ride through the §16 importer), then `POST /onboarding/commit/9`, whose skip-by-natural-key is what makes pressing Save twice create nothing.

### 31.11 The Draft board is a tab, under Whole

Same move, same reasons, one screen further. `Board` gains four optional props — `embedded`, `draftId` + `onDraftChange`, `toolbarHost`, `onStrip` — and `/board` is untouched, because every one of them is optional.

**Under Whole**, deliberately: Whole is what the week *is* and this is where it is changed, so the reading and the fixing sit together.

**The host owns the draft.** The Master Grid already has a picker governing its other four tabs, and two selects over one screen is two answers to "which draft am I looking at?". So `draftId` goes down and `onDraftChange` comes back up; the board hides its own select whenever the host offered to listen. The host refetches its **draft list** as well as its slots on that callback, and the second refetch is not redundant: discarding the draft the server had chosen sends `null`, and if the picker was already on `null` that sets no state, changes no URL and refetches nothing — leaving `data.draftId` naming a draft that no longer exists. For the same reason the Draft/Published select is **hidden** on this tab rather than disabled: a board over a published week is not a narrower thing to offer, it is a contradiction, and a greyed control invites somebody to work out why.

**The strip is fed from the board's payload, not the host's.** The board resolves a clicked cell against the tuples its own cards were drawn from and hands up finished groups. The host is looking at its own copy of `/slots` — possibly a different draft — and a strip resolved against that would explain a lesson that is not on the screen. Emitted on **content**, not identity: the host puts the groups in state, which re-renders the board, which rebuilds them, so comparing the serialised groups is what makes the loop impossible by construction rather than by every value upstream staying memoised.

**One screen, and the scarce dimension is height.** Three things that cost rows on `/board` are gone rather than shrunk. The five stat boxes moved **into the strip**, which already existed and was showing nothing on this tab — they are the figures the draft is judged on, and the strip is a row that is drawn either way. The draft comparison **replaces** the grid instead of sitting above it, because it is a different way to look at the same drafts and not an addition to this one. The paragraph under the grid became the strip's opening line. What is left is a flex column whose pane scrolls inside itself, so nothing below it — least of all the strip — is pushed off the bottom of the page.

The **tray is a column beside the grid**, not a band under it, and sticky: height is scarce and width is not, and a drag target that has scrolled off the top is a drag nobody can finish. Cells are denser through a `.board-compact` class rather than by changing the defaults — `/board` is a page of its own with a screen to spend, and a card with room for a subject, a teacher and a room is easier to read than one without. The numbers are set against a real week: every wing in the reference school runs 8 teaching periods and 2 breaks, so the pane holds 8 rows at 42px, two breaks at 17px, a day header and ten 6px gaps — about 450px, against the ~600px a 1080-tall screen leaves after the topbar, the toolbar and the 86px strip.

A cell is selectable **only where there is a strip to answer in**, so `/board` is unchanged there too. Clicking does not fight the drag: the `PointerSensor` is armed at `distance: 4`, so a press that never moves is not a drag and the click still arrives, while a real drag ends with pointerdown and pointerup in different cells and fires no click on either. An **empty** cell is selectable, because a free period is a fact — and it is the one the tray is about to fill.

Two things the tabs must not become a way round. **Permissions**: `/board` needs `timetable.edit` and `/allocation` needs `masters.manage`, and the left nav hides each accordingly — so the Master Grid takes both as props and drops the tab it may not offer. The server refuses either way; the cost of not asking would be a tab that answers 403 rather than one that is not there. **Freshness**: the four pivots are drawn from the host's own copy of `/slots`, so the host now listens for `slots:changed` on the school's socket room exactly as the board always has. Without it, dragging a lesson and switching to Whole shows it where it used to be.

### 31.12 `classes.sequence` is the ladder position, and had two vocabularies

The Whole tab drew LKG-A, Class 1-A, Class 1-B, LKG-B, Class 1-C, LKG-C — the school's rows out of school order. The screen was innocent: every list of class-sections in the app is `orderBy: [{class: {sequence}}, {section: {name}}]`, and two classes held sequence 3, so MySQL resolved the tie however it liked and the section names then interleaved.

The collision came from **one column with two vocabularies**. `planClasses` (the guided setup) writes the `CLASS_LADDER` position; `POST /classes`, the §16 importer and the §23 ERP sync all defaulted to **`0`**; and `scripts/school2-model.cjs` hand-numbered a 14-class school with no LKG or UKG from 1 to 14. They met when an LKG was added to that school through the guided setup: it got position 3, which Class 1 already held.

`0` is the worst available default, and not merely a lazy one — it is not "at the end", it is **first**, tied with every other class created the same way. A school adding five classes on the master screen gets five rows above the whole school in an order nothing defines.

**It was never only an ordering.** `bandOf` and `subjectSuitsClass` in `suggest.ts` compare this number against *absolute* ladder positions to decide which subjects a class is offered, so the school numbered 1..14 had Class 9 reading as "upper" rather than "senior" long before anything looked wrong on a screen. That is why the fix is the ladder position rather than a gap-closing renumber, and why `ladderSequence` returns **0** for a name the ladder does not know instead of "the next number": we know where Class 7 belongs and we do not know where Playgroup belongs, and guessing is how the two vocabularies started.

One definition (`ladderSequence`, in `wizard.ts`, which `suggest.ts`'s `AT` now is) and one resolver for a create (`classSequence`, in the API, used by all three doors): an explicit sequence always wins, a ladder name gets its position, and an off-ladder name goes **after** the ladder — last, visibly, where a human can move it.

The repair migration renumbers only schools whose **every** class name is on the ladder. A school with a Playgroup or a Grade 5R is left completely alone: reordering somebody's own vocabulary on a guess is worse than the tie being fixed, and `classSequence` stops those schools acquiring a collision from here on. For every school it does touch, the relative order either stays exactly as it was — the classes were already in ladder order, differently numbered — or was undefined. No school that was reading correctly changes.


### 31.13 The guided setup hands the allocation over, and every step is reachable

Four changes, and the first three are one decision followed through.

**The wizard has no Allocation step.** Rooms is followed by Settings, and Settings carries a button across to the Master Grid's Lesson Grid — which is the same `StepAllocation` component (§31.10), so nothing was rebuilt and nothing moved twice. A screen people come back to for years does not belong halfway through a nine-question setup.

**The step NUMBERS did not change.** `WIZARD_STEPS = [1..8, 10]` is a list of which steps are shown, not a smaller `TOTAL_STEPS`. `POST /onboarding/commit/:step`, the stored `current_step`, `migrateStep` on the server and `ALLOCATION_STEP` in `commit-allocation.ts` all still mean what they meant; renumbering would have been a second migration of everybody's stored step for a change to a menu. A draft saved on step 9 resumes on Settings, through `visibleStep`.

The wizard therefore no longer commits the allocation, and that is deliberate rather than an omission: `/onboarding/finish` only ever wrote settings, so the rows were always written by whichever step was walked, and the Lesson Grid's Save is now the one that writes these. The proposal is not lost — the Lesson Grid reads the same draft answers, so it opens on the suggestion `suggestCurriculum` had already made.

**Every step is reachable, always.** The rail used to open a step only when every step before it was complete, with "Finish Rooms first" on the ones it refused. Defensible for a wizard walked once; wrong for a screen somebody returns to, where adding a room should not require finishing the session dates. So a forward jump commits each step it passes **that is ready**, skips the ones that are not, and always lands — naming what it skipped afterwards instead of refusing to move. Nothing is lost by a skip: every commit is idempotent, so pressing Next through that step later writes exactly the rows the jump did not. `problemAt` still guards **Next**, which is the deliberate "I have finished this step" action, and the rail marks an unfinished step with an amber ring — informing where the lock only refused.

**The Lesson Grid has no draft controls.** Curriculum and mappings are `class_subjects` and `subject_mappings`: master rows, one set per school, which every draft of every wing is generated *from*. A draft picker there would offer a choice that changes nothing and imply that "Class 5-A gets 6 periods of Maths" could differ between Draft #3 and Draft #4. It cannot. The other four tabs are placements — which is exactly what a draft *is* — so they keep the picker, the Draft/Published select and the chip, and follow whatever is chosen.

**The nav lost two entries and gained a move.** Allocation Matrix and Draft Board are Master Grid tabs now (Whole and Draft board), and a menu offering the same week twice teaches people that two entries must be two different things. Master Grid moves to **Build, directly below Masters**, standing where Allocation used to — its Lesson Grid *is* that screen. The **routes stay**: Generate links to `/matrix`, Publish links to `/board` three times, and people bookmark screens; removing a menu entry is a change to how a screen is found, not a decision to delete it. `/allocation` redirects to `/master-grid?tab=lesson`, which is also what the Settings step's button opens.


### 31.14 The assistant's launcher has one home

It floated at the bottom-right of every screen, which is fine until a screen puts something there — on the Master Grid it sat over the strip's issue count. §31.11 docked it in that screen's own toolbar, which fixed the collision and introduced a smaller one: a control people reach for by memory was in a different place on one page out of thirty.

So the slot lives in `Shell`'s **top bar**, beside the notification bell and the timetable picker, and every page inherits it. The floating corner button stays as the fallback for anything rendered outside the shell.

The panel's `top` is still *measured* from the slot rather than being a constant — the top bar's height is not fixed, since a §30.5 dated timetable adds a line under the picker — and the lookup is still a `useLayoutEffect` keyed on the route, because a passive effect shows the floating fallback for one painted frame before the portal moves it, which reads as a button jumping out of the corner on every page load.

One label bug came with the same change: the wizard's Next button read `STEP_TITLES[step]`, the title one index along, which was the same thing while the sequence was 1..10 and stopped being it the moment §31.13 took 9 out — Rooms offered "Next: Allocation" and landed on Settings. It reads `stepAfter(step)` now, the same function the press itself uses, so the label and the destination cannot disagree again.


### 30.9 The guided setup was the last place that did not know about pools

§30 gave every timetable a **resource pool**: a grouped one competes with the rest of the school for classes, rooms and a teacher's week; an individual one stands alone and competes with nobody. The solver, the feasibility engine and the §16 importer were built that way from the start — `crossConfigTeacherLoad` filters by `resource_group_id`, `classSectionsInPool` matches a class-section by label **and** pool, and `class_sections` is unique on `(class, section, academic_year, resource_group_id)` precisely so the same cohort label can exist twice.

The guided setup was not. It read every `timetable_config` into one flat list of wings sharing one class namespace, so a school that added an individual timetable running Class 1–6 was told, six times over: *"Class 1 is in both Main Timetable 2026-27 and Weekly Timetable. A class belongs to one wing — narrow one of the two ranges, or remove Class 1 from one of them."* Both offered fixes are changes the school must not make.

**A wing carries its pool, and a boolean is enough.** `WingAnswer.individual` identifies the pool completely, which is not a shortcut: an individual pool holds exactly one timetable (`assertAdmits`), so the wing *is* the pool; grouped wings all share the session's one pool, so absent identifies that pool just as completely. `wingScope()` in `packages/shared` turns it into the identity two wings must share to conflict, and `planClasses` keys its class-claim map on `(pool, class)` rather than on class alone.

**It is stamped on the way out of the database, never trusted from the draft.** `individual` is not an answer — it is a fact about the timetable, chosen on the Timetables screen and changeable afterwards by §30.6a. A copy stored in somebody's draft can be wrong in two ways, and both matter: a draft saved before this field existed carries none at all, which is every draft in every school today and would have left the bug exactly where it was; and a draft saved before a move carries the old answer. So `draftFor` re-stamps every wing from the live configs on every read, matched by name — the same key `commitWings`, the §16 importer and the tab strip already match wings by.

**The wizard narrows in one place.** `answers.wings` is read by the ladder, the week, the room suggestion, the teacher pinning, `planClasses` and two summary boxes; a filter at each is six chances to forget one. So the wizard holds a `scope`, hands every step `answersInScope` — the draft with `wings` narrowed to that pool — and `patch` splices the edited subset back into the full list in place. The **stored draft keeps every wing**: losing the others on a save would be far worse than the bug being fixed. Two steps had to learn to clamp their active-wing index, because a list that can shrink under a stored index renders "add a wing first" for a wing that is plainly there.

**The switcher appears only when the school has more than one pool**, which for almost every school is never. It sits beside the step line rather than above step 4's tab strip, because it governs every step — the week, the teachers pinned to a wing and the rooms are per-wing too, and a scope that changed between steps would be worse than none. Arriving from "New Timetable" (§3.10a) scopes to the wing named in the URL, once: after that the switcher belongs to the person.

**The Master Grid's Lesson Grid had the same leak.** It builds its model from the same draft, and `computeLoads` sums a teacher's periods across every wing it is handed — so a teacher taking six periods in the main school and four in an individual timetable was shown at ten against one weekly limit. `AllocationTab` now narrows by the selected timetable's `resourceMode` before `StepAllocation` sees it, which fixes `suggestCurriculum`, `suggestMappings`, `computeLoads` and `coverageGaps` in one move.

**The commit had to be narrowed too, and that was the half the school actually hit.** `commit(4)` runs `planClasses` over the wings it is handed and throws on the first issue — and the server commits from the *stored* draft, which holds every wing. So a school setting up an individual timetable was refused with "Class 1 is in both Main Timetable 2026-27 and New": a **real** conflict between two grouped wings, named on a screen showing neither of them, offering two fixes it cannot make. `POST /onboarding/commit/:step` and `GET /onboarding/preview/:step` now take the scope, and `narrowToScope` applies it once for every step rather than per step — steps 7 and 8 read the wings too, and a filter per step is three chances to forget one. An **unknown** scope is refused rather than ignored, because falling back to every wing would put the bug back silently. Changing scope also clears the error banner and the praise line: both are about the pool that produced them, and an error is state, so it sat there after the switch looking like a fresh refusal.

**The banner remembers which pool raised it** (§30.10). Narrowing the wings, the warnings and the commit still left one way for the wrong message to be on screen: `error` was a bare string. A school selected the main school, pressed Next, was refused with a real clash between two grouped wings, then switched to its individual timetable — and the message stayed. `changeScope` clears it, but that is one of **nine** places this state is written from, and "every writer remembers to clear it" is not a property anybody can keep true; React Fast Refresh preserves state across a hot reload, so an error could outlive the code that raised it. The state is now `{scope, message}` and the banner is rendered only where it was raised, which makes the wrong one impossible rather than unlikely. The setter keeps its old signature, so all nine writers are untouched — the read is what changed. `next()` also clears it *first* rather than after the step validates and the draft saves, so a persist that fails no longer leaves the previous attempt's message standing over a fresh one.

**What is deliberately still shared, and is not a bug:** the **curriculum**. `class_subjects` is keyed `(class, subject, academic_year)` with no pool column, because a class's periods-per-week is a statement about what those children study rather than an asset anyone competes for — and `capacityForClass` stays year-wide for the reason CLAUDE.md already records: scoping it to one pool turns a form error into a Readiness blocker in a different timetable. An individual timetable running Class 5 therefore inherits Class 5's curriculum. Giving it its own would be a schema change, not a validation tweak.

Proof: `pnpm test:pools` — the pool mode reaching the wizard, a draft saved without it getting it back on read, no cross-pool clash while a same-pool one still reports, the same cohort label as two rows in two pools, the step-4 commit refused unscoped and accepted scoped with nothing of the main school's landing in the individual pool, an unknown scope refused, and `elsewhere: 6` in the other grouped wing against `elsewhere: 0` in the individual one — which is what makes "shares nothing" true of capacity and not only of classes. Plus four unit tests in `wizard.spec.ts`.


### 31.15 The Lesson Grid edits in the bar, not in a popup

Clicking a cell opened a dialog. That is right for a decision made once and confirmed; it is wrong for this grid, where somebody works across a row — Maths 6, English 6, Science 5 — and a popup that opens, takes one value and closes costs two clicks and a re-read of where they were, per cell. It also covers the neighbours, which is the argument §31.6 already made for the strip being a strip.

**A click now selects.** The number is typed straight into the grid — which the keyboard handler already did, with one bug that made it useless for anything above nine: each press *replaced* the value, so "12" ended as 2 and ten was unreachable without the dialog. Digits now accumulate within a 900ms window on the same cell; a pause, a different cell or any other key starts a new number, and a digit the capacity check refuses is dropped from the buffer rather than left for the next press to build on.

**Everything the popup held is in the toolbar** (`CellBar`), in the bar the filter already lives in, above a grid that stays entirely visible. There is no Save in it: the dialog had one because it batched several fields behind a confirmation, and a toolbar that asked you to confirm each field would be a dialog wearing a different shape. Every edit lands in the draft as it is made — exactly as typing a digit already did — and the Master Grid's own Save is what writes it to the school. The refusals are the dialog's, unchanged and computed through the same `computeLoads` the load rail uses, so the bar and the chip two inches above it cannot disagree.

`applyCell` is the one definition of what a `CellSave` does, and it exists because both doors produce that shape: the periods before the block, so a cell this very save created has a curriculum row for the block to be written onto. Two copies of an order-dependent sequence is how two doors come to disagree about a double period.

The dialog is kept, reached by **Enter** or by **⋯ More**, for the two things that genuinely do not fit a bar: what a change does to every affected teacher's week, and the sections a §4.10 merged group covers. The teacher select in the bar still carries each candidate's load in the option text, because "have they got room?" is the question anybody picking a teacher is actually asking and a name alone cannot answer it.

**Start again, Clear saved data, Hover detail and Help moved into a hamburger.** They are pressed once in the life of a school — twice for the toggle — and they were taking the width the cell's fields now need; on this screen the toolbar's width is width the grid is not getting. It is a `<details>` rather than a hand-rolled popover: it opens on click, closes on Escape and is keyboard-reachable without an outside-click handler, which are the three things a bespoke menu usually gets wrong. Start again and Clear saved data are separated by a rule, because a menu makes two items look more alike than two buttons did and the difference between a rethink and a demolition is the whole point.

Two selections that must not go stale: the bar is cleared when the wing changes, since it now *edits* rather than merely describes — a bar pointing at a section the grid no longer shows would write to a class nobody is looking at — and the block control is disabled at zero periods, because `setBlock` returns early without a curriculum row and an enabled control there would silently do nothing.


### 31.16 The cell is the field

§31.15 made the number typeable with the cell selected, and that was not enough: nothing on screen said so. A cell with no caret and no box looks read-only however it behaves, and the Periods field sitting in the toolbar answered the question "where does the number go?" before the grid could — which is how a working keystroke stayed invisible.

**The selected cell holds a real `<input>`.** Click it and the caret is there. That forces one structural change: an `<input>` inside a `<button>` is invalid HTML, the button swallows the click that would place a caret, and a control inside a control is announced twice — so `CellShell` renders a `<button>` normally and a `<div>` when selected, with one shared style object rather than two that drift. The div claims no ARIA role of its own; the labelled input inside is the control.

**The typed value is a string, and that is the point.** Binding the input to `periodsOf` would put a `0` back under the caret the instant the last digit was deleted, and "12" typed over it would read as "012" — a number cannot express "empty", and empty is what somebody halfway through typing has. An empty field therefore writes nothing rather than writing zero, so passing through it on the way to a two-digit number does not drop the row's periods and flash the load rail.

**The arrows move cells, not the caret.** The window handler ignores a focused input by design, so navigation has to live in the field — and inside a two-character field selected on arrival there is no caret position worth navigating to. A grid where Right sometimes moves a column and sometimes a character is a grid nobody moves around confidently. Focus follows the selection in a **layout** effect (§8.1d): a passive one runs after paint, so the caret would arrive a frame late on every move.

**Backspace changed meaning, and had to.** It opened the removal confirmation — right while every cell was a button, dangerous the moment one is a field, and worst of all *conditional*: it would have meant "delete a digit" or "delete this curriculum row" depending on where the caret happened to be. `Delete` keeps the job and the toolbar's ✕ is the visible route. Escape blurs and **does not** clear the selection, because the selection also draws the toolbar's fields — clearing it would make Escape silently mean "stop editing the teacher and the room as well".

**The Periods field left the toolbar.** Two boxes holding one number is two answers to "where do I change this?", and the one further from the grid wins by being easier to see — which is exactly how the cell came to look read-only. What remains in the bar is precisely what a 58-pixel cell cannot show: the teacher, the room, the block and the class-teacher role. The count is still *stated* there, because the bar's refusals quote it and a reason naming a number nothing on the bar shows is a reason nobody can check.

There is no headless browser in this stack, so the interaction itself is unverified by test — the arithmetic behind it (capacity refusal, the load preview) is the same `computeLoads` the rail and §31.15's bar already use.


### 30.11 Independence is a property of the timetable, not of the request

§30.9 narrowed the wizard's wing list and threaded a `?scope=` through the commit. That fixed the screen and got the shape wrong: it made an individual timetable independent **only on the paths that remembered to say so**. A caller that forgot — an older client, a script, the AI — got the old behaviour back, and independence that depends on the request being phrased correctly is not independence.

**One predicate, and it needs no mode check.** Two timetables are comparable **iff they share a `resource_group_id`**. `assertAdmits` guarantees an individual pool holds exactly one timetable, so "same pool" is already false for an individual one against anything else. Every site that compares two timetables filters candidates by that column and nothing else.

The audit of every such site:

| Where | What it compares | Before |
|---|---|---|
| `planClasses` | a class claimed by two wings | fixed in §30.9 |
| `crossConfigTeacherLoad` | a teacher's load elsewhere | already filtered by pool |
| `uq_class/teacher/room_slot` | slot occupancy | already keyed by `timetable_config_id` — **there is no cross-timetable occupancy constraint in the database**, and never was |
| `setClassSections` | a section claimed by another timetable | rows are per-pool already |
| `commit(4)` | a clash blocking the write | blocked every pool on any pool's issue |
| `assertPublishable` (§30.5) | a class live in two timetables at once | **blocked** across pools, by explicit design |
| `clashesFor` (§30.7) | a teacher or room in two live timetables | **warned** across pools |

**§30.5 now stops at the pool boundary**, and the comment that argued against exactly this filter is rewritten. It was written before the product decided what an individual timetable *is*; blocking one on account of a timetable it cannot see is that decision not being kept. Within a pool the rule is untouched: two wings of the main school still cannot both put Class 6 on the wall over the same dates. The school gets **no signal at all** across pools — a deliberate call, made knowing the cost: if the individual timetable really does run at the same time of day as the main one, the app will not say so.

**§30.7 stops there too**, for the same reason and with less at stake: it is a warning either way.

**`commit` refuses pool by pool, computed from the data.** Narrowing the request would have hidden the problem rather than fixed it, so the pools carrying issues are dropped, everything else is **built**, and the refusals come back in the response for the caller to show against the pool they belong to. Every issue from `planClasses` now names its pool, which is what makes that possible. A throw survives for the case where nothing is left to build, because then nothing happened and silence would read as success.

Proof (`pnpm test:pools`): an **unscoped** commit builds the individual timetable's cohorts while two grouped wings clash, and still reports the clash; the individual timetable takes a date window over a class the live main timetable teaches, while a **sibling wing** over the same class and dates is still refused; and Readiness raises no occupancy warning across pools.

## 25. Term-wise Timetables (Phase 26)

A school currently has one timetable per wing per session. Many schools do not work that way: the week changes at the term boundary — a subject teacher moves, a games afternoon shifts, Class 6 gets a different shape after the October exams. Until now the only way to express that was to overwrite the timetable in November and lose what Term 1 actually was.

§25 lets a session run **year-wise** (exactly as before) or **term-wise**: two or more named spans of dates, each with its own timetable, all of them live at once.

Four decisions bound the feature, and the first is what makes the rest cheap:

1. **Placements only.** Every term shares one curriculum, one set of teacher mappings and one Readiness score. Terms differ in *where lessons sit* and *who takes a given cell* — never in what is taught or how much.
2. **Each term publishes separately**, with its own version history.
3. **Generate acts on the selected term only**; copying one term over the others is a separate, explicit action.
4. **Read-only screens open on today's term**, falling back to the first when today is in the holidays.

### 25.1 A term is a scope, not a second timetable

`term_id` on `timetable_slots`, with a stored generated `term_scope = COALESCE(term_id, 0)` inside all three unique keys — the §22 device exactly, for the same reason. `uq_class_slot` already carried `(config, status, draft_scope, section, day, period)`, so Term 1 and Term 2 both placing 5-A on Monday P1 collide and **a second term cannot physically exist**. That is invariant 1 doing its job, which is why this needs a new dimension in the key rather than a new screen.

Two alternatives were rejected on invariants the schema already holds. *One `timetable_config` per term* breaks §3.10 — a class-section belongs to exactly one config, so 5-A cannot be in both terms'. *One named draft per term* breaks §22 — `draft_scope` collapses every published row to `0`, so two terms could never be live at once, which is the whole feature.

`COALESCE` rather than a bare `term_id` for the reason `draft_scope` has it: a NULL inside a unique key is treated as distinct, so year-wide rows would stop guarding each other — silently undoing invariant 1 for every school that never uses terms. The FK is `RESTRICT`, which MySQL would insist on anyway for the base column of a stored generated column, and which is right on the merits: `SET NULL` would push a deleted term's rows to scope 0 to collide with the year-wide set.

What falls out of this is the whole argument for the design:

- **A year-wise school is untouched.** `term_id IS NULL` → `term_scope = 0` → byte-identical behaviour, and the migration rewrites **no existing row** — which is what makes it safe to run on every school's database (§17.3) rather than only where terms were asked for.
- **The solver and the six feasibility checks do not change at all.** Terms share a curriculum, so `runFeasibility` and `SolverState` see what they already saw; generation solves once and the writer stamps a term.
- **`BoardEngine` does not change either.** The board loads one term's rows and checks against them, so "no double-booking" is per-term because the row set is.

`term_id` also goes on `timetable_drafts` (a draft spanning every term would make its §22.3 stats a number about several timetables at once, which is not a number — and the five-live limit is per term), on `timetable_publications` (each term has its own version 1; publishing Term 3 in November must not renumber Term 1), and on `extra_classes` (a Saturday revision class runs in the term it was arranged for).

**No column says which mode a session is in.** A session is term-wise **if and only if it has term rows** — one source of truth, which cannot come to disagree with the rows the way a flag can. The same reasoning as "an empty eligibility scope means *not stated*" (§18).

### 25.2 One resolver, and the date decides

The sharpest risk here is not the schema, it is the **missing filter**. `substitutes.service.ts` counts published slots by teacher and day-of-week; `reports.service.ts` filters on `status: 'published'` alone. With three terms, marking a teacher absent once would report 3× the affected periods and every load summary would treble. Nothing would error — the numbers would just be wrong.

So the filter has one owner, `TermsService`, exported like `DraftsService` and for the same reason. It resolves in order: an id the caller asked for, **verified to belong to this config's own session** because a term id is not a capability; otherwise the term containing the date in question, defaulting to today; otherwise the first term, for a date in the holidays, which belong to no term at all; otherwise `null` — a year-wise session.

That date rule is what makes the term selector a default rather than a chore: a teacher opening their timetable in November is shown November's.

`GET /timetable-configs/:id/terms` is **session-only, with no permission** — the §10.5 `/me/colors` argument exactly. Every role needs the list (an admin on the Board, a teacher on My Timetable, Front Office in the Substitute Center), no single permission is common to them (a Principal holds `timetable.view.all`, a Teacher `.own` and `.class`, and the guard is AND), and a role that could not read it would show the wrong term's timetable with no way to tell. Writing the calendar is `masters.manage`: a term boundary decides which timetable a Tuesday in October belongs to.

`GET /academic-years/:id/terms` checks the **session exists** before listing, and that is not ceremony. Scoped by the tenant context, a query for another school's year returns zero rows — and `[]` is indistinguishable from "this session runs as a whole year", so a stranger would be told a fact about a school they cannot see in the same words its owner gets. The §17.8 gate caught exactly this, on a check whose own assertion had been written loosely enough to tolerate it.

### 25.3 Splitting a session, and the screen that asks

`splitSession` in `packages/shared` answers "where would N boundaries fall?" — by **whole months** when that is meaningful (the session starts on the 1st and divides evenly), which is what a school recognises: 1 Apr–30 Sep and 1 Oct–31 Mar, not 1 Apr–1 Oct and 2 Oct–31 Mar. Anything else — a session starting on the 15th, a 40-day summer school, five terms in twelve months — splits by days. That narrowing is deliberate: "six months each" has no obvious meaning for a session running 15 Apr to 14 Apr, and a rule that guessed one would put a boundary somewhere nobody chose. Month ends are asked for as *day 0 of the following month*, so a leap February needs no special case and cannot acquire a wrong one.

There is deliberately **no endpoint** that proposes a split. The guided setup asks the question before the academic year exists, so a server call could not answer it there; the shared function runs unchanged on both sides, as the feasibility and board engines already do.

`validateTerms` is the same function on both sides too, so the message on screen is the message that would come back — not a second and kinder set of rules. It reports per row with a fix, the Feasibility Engine's contract: an overlap names **both** terms and the date to start at, since a day cannot belong to two terms or the timetable for that day is two timetables. Gaps between terms are legal — the holidays are not in a term.

The controls live in one component with two containers. `TermsEditor` loads and saves (the Academic Years screen and the Setup Wizard); `DraftTerms` only collects (the guided setup's session step, where there is no year yet — step 2's commit writes the terms straight after the importer creates the year, matched **by name** so pressing Next twice re-dates the same terms rather than replacing them and orphaning a term's timetable).

The whole set is saved in one PUT: no-overlaps and at-least-two-terms are rules about the *set*, and saving a row at a time would walk through illegal states and could stop in one. Rows carrying an id are updated in place, which matters more than it looks — every slot, draft and publication points at a term id, so re-dating Term 2 must move the term the timetable is filed under. A term with rows in it cannot be removed by a Save button; the refusal names the term and how much is in it.

### 25.4 Verification

`scripts/terms-smoke.cjs` runs the calendar end to end: a year-wise session reports no terms and no current term (which is how the selector knows to hide); a split is proposed, saved, renamed and grown while keeping its ids; overlaps, terms outside the session and a lone term are each refused by name with the saved calendar left exactly as it was; today's term is what a request with no term gets; another school's session is a 404 both ways; a teacher may read the list and not write it; and the guided setup's step 2 writes the terms once and creates nothing on a second press.

`packages/shared/src/terms/terms.spec.ts` covers the arithmetic away from any database — the two-, three- and four-term splits, contiguity and exact coverage, the leap February, the day-split fallbacks, every validation rule, and `termForDate` including a date in a gap.

---

## 26. Subject Placement Rules (Phase 27)

A school knows things about its subjects that the app had no way to hear. Maths in the morning while children are fresh; Games after lunch but never *immediately* after it; Art and Library late. Until §26 all of it was expressed by dragging cards on the Board after every generation.

### 26.1 The Teachers step shows what a teacher teaches

The guided setup's Teachers step rendered **every** subject in the school as a toggle chip in **every** teacher row — 22 × 122 at the reference school. A wall of grey, most of it about subjects the teacher does not teach, with the one fact the cell exists to show buried inside it. Past about eight subjects the step stopped being usable, which is most secondary schools.

The cell now shows only the chosen subjects, as removable chips, plus a **＋** that opens a searchable picker ordered by §26.2 priority. The cell's size no longer depends on the school's subject count, and Enter takes the top match.

The panel is `position: fixed`, measured from the button, and that is forced rather than chosen: the step's table lives in a `Scroll` (`overflow: auto`), so an absolutely-positioned panel is clipped by it and scrolls away with the rows — the same trap the §8.1d nav flyout hit, with the same answer. `useAnchored` was extracted the second time it was needed.

### 26.2 What a subject is: category and priority

Four columns on `subjects`, because these are facts about the *subject*: "Games is not taught straight after lunch" is true of Games, not of Class 5's Games. `category` (scholastic / co-scholastic), `priority` (1–5), `lunch_rule` and `gap_after_lunch`. **Every default reproduces the previous behaviour exactly** — priority 3 is the neutral middle, `any` restricts nothing, the gap is off — so a school that upgrades and changes nothing generates precisely what it generated before.

**The intelligent defaults come from the classifier that already existed.** `WEIGHTS` in `suggest.ts` already sorted subject names into families for the curriculum suggester, so it gained a defaults field per family rather than acquiring a second table beside it: two tables would eventually disagree about whether Games is co-scholastic, and only a school would find out. `defaultsFor(name)` is the one way anything in the product guesses — the guided setup, the Subjects master, the §16 importer and the ERP sync all ask it. **An unrecognised name gets the neutral answer rather than a guess**, because a wrong guess quietly constrains the solver on behalf of a school that never said so.

Blanks are filled from the name **at the point of commit**, not when a row is created, so renaming "Sports" to "Games" picks up the Games rules where a value baked in at creation would keep Sports'. An explicit value always wins, and an update changes only the fields it sends.

**Priority is deliberately soft, and that is the correct call.** "Maths must be in period 1" cannot hold for twenty sections at once, so as a hard rule it would make every real school infeasible. It is a fourth term in `optimize/objective.ts` — the module that already is the single definition of "nice" — scored as `Σ (priority − 3) × (period − 1)`. Lower is better, like every other term, and the sign falls out directly: a priority-5 subject scores 0 in period 1 and +10 in period 6, so sitting late costs it, while a priority-1 subject scores the mirror image, so pushing Library late is as much of a gain as pulling Maths early. Priority 3 contributes exactly nothing, which is what makes the term invisible to a school that never sets it.

That one definition buys three things: the CSP's value ordering prefers earlier periods for high-priority subjects, CP-SAT minimises the same term, and `scoreTimetable` keeps "optimised mode is measurably better" provable. An earlier draft negated the term on the reasoning that "high priority early" ought to be the low number — it already is, and negating pushed Maths to last period and called it an improvement. The unit test is what said so.

### 26.3 Where a subject sits: the lunch rules

`lunch_rule` (`any` / `before` / `after`) and `gap_after_lunch` are **hard**, and hard means pruned before search (invariant 2). `domainFor` in `solver/variables.ts` is the single place a domain is built, and they join the alternate-day, blocked-cell, P1 and break-straddling rules already there. `lunchAllows` is checked over **every period of a block**, not just its start: a double period beginning before lunch would otherwise reach into the afternoon while claiming to be a morning slot.

That needs one new fact, `lunchAfterPeriod`. `daySegments` collapses breaks into run lengths and loses which one was lunch, so it is derived separately — a break named for lunch, else the longest, else the one nearest the middle of the day — and is `null` when the day has no break at all, which switches both rules off rather than attaching them to a guess.

A split elective applies **every option's** rules, since the options run at once: one Games option drags the whole block after lunch, which is correct and is precisely why the check below has to see it first.

**Check 11 — lunch-side capacity.** A hard constraint with no feasibility check is a generation that fails, which is the one thing the two-phase split exists to prevent. So per class-section, the periods a rule confines a subject to must fit the cells that rule leaves — counted with **the same `lunchAllows` the solver prunes with**, so Readiness can never promise a cell the search will refuse.

Grouped by the exact `(rule, gap)` pair rather than by side, and the reason is a bug its own smoke caught: a subject with only the gap rule — *any time, but not straight after lunch* — has the whole week minus one cell a day, and an earlier draft filed it under "after lunch" and refused a school that was perfectly fine. Groups still overlap in the cells they compete for, so the check **under-detects rather than over-detects**: that is the right direction to be wrong in, since a false blocker stops a school that could have generated, where a missed one leaves the solver to report what it could not place — which it already does well.

There is deliberately **no auto-remedy** (§21). Every way out of this loosens a rule somebody set for a physical reason, and `relax` is only ever applied with explicit consent.

### 26.5 A teacher's instruction, in plain English

A school knows things it has no field for: *"Mrs Rao leaves at 1pm on Fridays."* Until now that had to be translated by hand into `teacher_unavailability` rows, by somebody who knew that screen existed. §26.5 lets them type the sentence.

**The whole design is one rule: the model translates, it never schedules.** Invariant 14 is not bent here and is not merely respected by convention — the model's *entire vocabulary* is a closed set, every member of which is a constraint the solver already enforced long before any AI was involved: unavailability, the daily and weekly ceilings, the §20 floor, the back-to-back limit, the first-period rule, the §4.7 pattern, §18 class eligibility, and whether they may be offered as a substitute. There is no term for "put her in period 3 on Tuesday", so there is no way to ask for one.

That is what makes the green tick mean something. It does not mean *the AI understood*; it means **this compiled to constraint X, and constraint X is enforced whether the assistant is switched on or not**. Turn the school's key off tomorrow and its timetables do not change, because by then the instruction is ordinary rows. The compiled result is read back in words on the row — *"not available on Friday"* — so the tick is auditable rather than trusted.

Five refusals worth stating, each of which was a decision:

- **Anything outside the vocabulary is denied, by name.** "Put her with the nicer classes" comes back as a sentence a person can read, not a silent no-op.
- **A partially understood instruction is refused whole.** Accepting the half that compiled and showing a tick would tell the school the other half is being honoured — the one lie this feature must not tell.
- **A refused instruction is kept.** It is what somebody typed; discarding it to teach them about phrasing is not our call.
- **A day the school does not teach on is refused**, because a constraint that never binds reads on screen as a rule being honoured.
- **A `onlyClasses` list that resolves to nothing is refused**, because §18 reads an empty scope as *not stated* — so an instruction meant to narrow a teacher's classes would silently widen them to every class in the school.

The rows an instruction owns are marked (`AI: …` on the reason) so re-evaluating an edit **replaces** them rather than accumulating a teacher into unavailability nobody asked for, one edit at a time — while never touching a block an admin set by hand on the §4.7a screen.

**The guided setup and the importer collect but do not evaluate.** Neither has teacher rows at the moment the text arrives, and evaluating at commit would be one model call per teacher — 122 for the reference school, to answer a question nobody has asked yet. It arrives as `pending`, and the Teachers screen turns it into rules one deliberate press at a time.

### 26.4 Verification

`scripts/subject-rules-smoke.cjs` reads the generated slots rather than an API response — a 201 from Generate says nothing about where Games landed. It asserts that a rule which cannot fit is refused *before* generation with both numbers in the message, that widening it clears the blocker, that the generated week puts **no** Games before lunch and **none** in the period straight after it, and that priority-5 subjects sit measurably earlier than priority-1 ones (a mean over the week, since priority is a preference and an assertion about one lesson would be flaky by construction).

Its own setup is loud: a fixture step that fails exits naming the call. The first run built no class-sections and reported "Readiness refuses it — score 0", because a school with no data scores 0 and raises no blockers — six checks failed describing a feature that had never been exercised.

`guided-setup-smoke.cjs` is the regression that matters most: the guided setup now classifies Games as after-lunch-with-a-gap automatically, and the school it builds must still reach 100% readiness and generate with nothing unplaced.

`scripts/teacher-instructions-smoke.cjs` does the same job for §26.5, and its last section is the only one that proves the feature rather than the UI: it generates a real timetable and asserts the teacher is **never** scheduled on the day her instruction ruled out. It also checks that a refusal writes nothing, that a refused instruction is still stored, and that an edit replaces the previous rows rather than adding to them. Where no key is configured it **skips and says so** — a green tick from a deployment that cannot evaluate would be worth less than no test. Where a school in the same database has one, it borrows the *encrypted* blob (the encryption key is deployment-wide), so the test runs without the secret ever being read or printed.

`instruction.compile.spec.ts` is the boundary itself, tested without a model in the loop — including the case that caught a real defect: an instruction naming a period outside the school day used to collapse to "unavailable all day", silently a far stronger rule than anybody asked for.

---

## 27. One Allocation Grid (Phase 28)

The guided setup asked the same question across two steps. **Curriculum** was a class × subject grid of periods a week; **Mapping** was a flat list of who teaches each row, plus a second table for class teachers. They share a data model, and the split was arbitrary — the proof was already in the codebase: `withCurriculumPeriods` exists for no reason except to stop step 10 quoting a number step 9 had since changed.

§28 merges them into one **Allocation** step, and the wizard drops from eleven steps to ten.

### 27.1 One grid, three facts per cell

Rows are **class-sections**, grouped by class; columns are **subjects**. Every cell carries periods a week, the teacher's initials, and the room — coloured by the §10.5 palette module, so Maths is the same colour here, on the Board and on the Matrix.

The one thing the merge must not hide: **periods are a class fact; the teacher and the room are section facts.** `class_subjects` is keyed `(class_id, subject_id, academic_year_id)`, so changing 6 to 5 in Class 5-A's Maths changes all four sections of Class 5. Rather than paper over that, the grid is shaped by it — rows group by class and the **Load column spans the group** with `rowSpan`, so the table's own shape says which facts are shared. The cell dialog says it in words as well.

Class-teacher assignment stops being a second table: the ring on a cell marks it, set where that person actually teaches. A class teacher who takes none of the section's lessons was never useful to the §4.7 first-period rule anyway.

### 27.2 The load rail, and one rule this phase reverses

`Syllabus.tsx` carried a rule that was right when it was written:

> **Load and capacity limits** are deliberately not re-implemented in the browser. The §16 importer runs `assertWithinWeek` on every row it writes. A second opinion here that the server then contradicts would be worse than no opinion at all.

A live load rail cannot ask the server after every keystroke, so this screen needs the opinion. The resolution is not to break the rule but to **remove the second opinion**: the arithmetic moved into `packages/shared/src/onboarding/load.ts`, and the server calls the same function. One answer, computed twice.

Two pieces of that arithmetic are owned there rather than at any call site:

- **A merged group costs its teacher one lesson, not one per section** (§4.10). Several sections taught together are a single occupancy event — which is exactly why merging relieves a load without taking a subject away from anybody. Multiplying by `classSections.length` regardless would make the advisor's own merge suggestion appear to change nothing.
- **Daily reach is a ceiling separate from the weekly cap.** A teacher whose subjects all run one period a day per class can teach at most `reach × days` however generous their weekly limit is — Check 3's other half. It is reported *beside* the weekly figure, never folded into it: two limits with two different fixes, and a blended percentage would name neither.

**Bands.** Under 75% is quiet; 75–99% is amber; **exactly full is its own colour, not red**, because a teacher at their limit is the outcome the screen steers towards; over is red. Collapsing `full` and `over` would leave the rail unable to say which teacher must be acted on — and at a real school most staff sit above 75%, so a single warning threshold paints everything red and stops being a signal.

**Refusal at the limit** is a refusal to *exceed* it: an edit that would take a class past its weekly capacity, or a teacher past their cap, is blocked with the arithmetic shown. A class exactly at capacity is correct and stays green.

### 27.3 Easing a load speaks three verbs

`relieveLoad` uses the **§21 remedy vocabulary the Feasibility Engine already speaks**, which is what keeps it a product decision rather than a new invention:

- `redistribute` — move a class to a lighter eligible colleague, or **merge sections into one teaching group**. Nothing about the school changes except who stands in front of whom.
- `complete` — name a lesson nobody has been given, and who could take it.
- `relax` — raise a limit. Always **last, in its own group, and priced in plain words**; never applied by a standing consent (invariant 19), because a resolver free to loosen limits can take any school to a clean board without changing one real thing.

**Merging is offered only for co-scholastic subjects**, read from the §26.2 `category` (falling back to the same `defaultsFor` classifier, never a second guess beside it). Four sections of Games on the field is ordinary; four sections of Maths in one room is a decision about children, not about load, and this module must not make it. A subject the list does not mention is treated as core — the safe direction.

The unit test that matters asserts **convergence**: applying only the `redistribute` and `complete` remedies clears an over-loaded school completely. Without that, `relax` would be the real answer wearing a warning label.

### 27.4 Reading without opening

A cell abbreviates three facts into about 58 pixels, so **hovering opens the full record** — five different cards, because five different things are being pointed at: a cell (periods, the teacher's real name and load, whether they listed this subject, the room *and why that room*, the class teacher), a teacher chip (their whole week, per class, plus the reach warning where it binds), the Load column (the class total broken down subject by subject), the ring in the row header, and a subject heading (demand against the staff behind it). The rule is that **nobody should have to open a cell to understand it**; opening is for changing.

Everything that is not the grid is collapsed by default — the load rail to a single row of slivers, the explanation behind `? Help`, and the step rail behind **Focus**. Nothing but the grid scrolls, so the page never grows a second scrollbar that moves what somebody is pointing at.

### 27.5 Period length

A period's length is `timetable_config.period_duration_mins` — a **wing** fact, because the solver places into period numbers on one shared grid and two classes in a wing cannot have different period lengths. It is *shown* here (`6 × 40 = 240 minutes a week`, and the class's weekly total) because minutes are the unit a head teacher is accountable for, and *changed* here because this is the screen somebody is looking at when they ask.

It cannot ride through the §16 importer with the rest of the step — it is not a master row. So the dialog writes it into step 5's own draft key and Next re-runs step 5's committer, **narrowed to the wings that actually differ** (`commitWeeks(answers, { changedOnly: true })`): `PUT /:id/structure` rewrites the period rows wholesale, and re-pushing an unchanged week would rebuild a grid for nothing. The smoke asserts the risky half — that rebuilding the week after the curriculum and mappings are already committed disturbs neither.

### 27.6 The renumbering, which is the only thing that can hurt

Eleven steps became ten, and the collision is exact: **old step 10 was Mapping, new step 10 is Settings.** A stored `currentStep` alone cannot say which is meant, and a resumed draft that lands on the last screen with every allocation unset reads as the wizard having lost twenty minutes of work.

So a draft records the scheme it was written under (`__stepScheme`, stamped by the server on every save — including `adoptFromSchool`, because a marker only half the writers set is worse than none). `migrateStep` shifts anything without it down one from step 10. `step-scheme.spec.ts` covers the collision directly.

### 27.7 Verification

`guided-setup-smoke.cjs` is the regression that matters: one commit now writes both sheets, so both corrections — an edited curriculum row and a reassigned teacher — have to be in the answers before that single commit, which is exactly what the screen does. It still ends where it always did: 100% readiness in both wings and a generation with nothing unplaced.

`load.spec.ts` covers the arithmetic, including the merged-group cost, the band split at `full`/`over`, a mapping naming an unknown teacher (a coverage problem, not a load one — adding a phantom to the rail would answer a different question badly), and the convergence claim above.

---

## 28. Generation Settings (Phase 29)

Three settings a school checks before it generates. A fourth — **per-class period duration** — was asked for at the same time and is deliberately absent; §28.5 says why.

### 28.1 The load alert line

`timetable_config.load_alert_pct`, default 75. It replaces `LOAD_WARN_AT`, which was a constant in `packages/shared/src/onboarding/load.ts`, and it feeds three places that already existed: `loadBand()`, the §27 Allocation rail, and **Feasibility Check 12**.

**It is a warning and never a blocker.** A teacher at 80% of their weekly limit is a normally employed teacher; refusing to generate at a number a school picked for its own reporting would make most real schools ungenerable, and what was asked for was an alert, not a refusal.

**It does not move the readiness score**, and that exemption is the part worth remembering. Readiness answers one question — *can this school generate?* — so a school where everybody is inside their limit reads 100, and must keep reading 100 after somebody asks to be told when a teacher passes 75%. The first school to try the setting would otherwise watch its dashboard fall to 98% for saying yes to a report and reasonably conclude the setting had broken something. `finalize` therefore excludes this one code from the arithmetic; it remains a `warning` for every other consumer, because the dashboard, the AI tools and the auto-fix screen all already know what to do with two levels and a third would make each of them decide again.

**One grouped row, not one per teacher.** At 122 staff a warning each buries every real blocker under thirty rows of "this is fine, but". And **no remedy**: every way to lower the percentage is either a `redistribute` the §27 advisor already offers on the screen where the work is done, or a `relax` that raises the very cap the percentage is measured against — a fix whose only effect is to move the goalposts.

### 28.2 Activities either side of the day (§28.3, §28.4 as requested)

Assembly, attendance, bus dispersal. **One table, `daily_activities`, for both ends** — an assembly and a dispersal differ only in `placement`, and two tables would duplicate every rule about duration, days and staffing so the two could eventually disagree.

An activity produces a **third kind of band** in `periods`, beside `is_break` and `is_extra`. Not a flavour of break: a break is unstaffed by definition, and the whole point of an activity is that somebody is on duty and the timetable should say who. `days` is per activity, because assembly on Monday only is the ordinary case; `teacher_id` and `room_id` are nullable, and null means *not stated* rather than *nobody* — the reading §18 gives an empty scope.

**The load-bearing property is what is absent: an activity has no period number.** `domainFor` builds cells only for `1..periodsPerDay`, so the solver cannot reach one — exactly as it cannot reach the §18 extra window. That is what lets this whole feature exist without teaching the solver a new kind of constraint. Widening the domain to include activities would put a teacher on assembly duty into a slot `uq_teacher_slot` cannot check, because that key compares period *numbers*.

Two decisions inside `buildPeriodRows`:

- **A before-first activity runs earlier; it does not push period 1 later.** `startTime` is what a school means by "when does teaching begin", and it is printed on the wall. An assembly written down for the first time is a fact that was already true — nobody had recorded it — so recording it must not make every published period time twenty minutes late. The day grows earlier at the front and `endTime` is untouched.
- **An after-last activity sits after the §18 extra window too.** A school running revision classes disperses after those; putting the dispersal before them would print a bus departure in the middle of a lesson.

`daySegmentsFromRows` and `lunchAfterPeriodFromRows` both exclude activity rows, and that filter is not cosmetic: an activity row is not a break, so without it the run counter reads an assembly as a *teaching* period — telling the solver the day has a longer unbroken run than it has, and letting a double period straddle a boundary that does not exist.

`PUT /:id/activities` replaces the set and **rebuilds the day**, because `periods` is a projection of the config plus its activities; an activity saved without the rebuild would exist in the database and appear on no timetable, which reads as the save having failed. `PUT /:id/structure` reads the activities back for the same reason in reverse — it rewrites period rows wholesale, so a structure save that ignored them would silently delete every assembly band a school had set up.

### 28.5 What is deliberately absent: per-class period duration

A school asked for Class 1–10 at 30 minutes and Class 11–12 at 40, inside one timetable. It is not built, and the reason is invariant 1.

```
Class  9 @30:  P1 08:00–08:30   P2 08:30–09:00   P3 09:00–09:30
Class 11 @40:  P1 08:00–08:40   P2 08:40–09:20   P3 09:20–10:00
```

A teacher in **Class 9 P3** and **Class 11 P2** overlaps from 09:00 to 09:20 — and `uq_teacher_slot` cannot see it, because it compares `period_number` and those are 3 and 2. The database-level guard against double-booking silently stops guarding.

The same hole already exists across wings, documented at §5: `uq_teacher_slot` is scoped to `timetable_config_id`, so a shared teacher can be placed in two wings' Monday P3, and *"the load-sum check in §4.2 is what catches it, not the slot-uniqueness constraint"*. Per-class durations bring that collision inside a single wing, where nothing mitigates it.

The design that works is **tick-based occupancy**: a `period_grids` table, a companion `slot_occupancy` keyed on `(teacher, day, 5-minute tick)` with a unique index, and `SolverState` holding tick sets rather than `busy[teacher][day][period]`. It keeps the guarantee in the database — the property that matters — and dropping `timetable_config_id` from that key closes the cross-wing hole as well. It also means the Matrix and the Board can no longer have a single column header row, which is an information-design problem rather than a styling one.

Until then the supported answer is the one the product already has: **a different period length is a different wing.** `periods_per_day`, `period_duration_mins` and `start_time` all belong to the config, and "Higher Secondary" is one of the three suggested wings.


### 28.6 The request that was too large

Pressing **Next** on the Subjects step of a real school failed with a raw `request entity too large`. Two things were wrong, and only one of them was the limit.

**The wizard sent the whole draft on every save.** `persist` carried a comment reading *"Only this step's keys go up; the server merges"* — and sent the entire `answers` object. That was harmless while drafts were a few kilobytes; §27 put the curriculum and every subject mapping into the draft, and Second Branch (16 classes, 64 sections, 122 teachers, 20 subjects, **957 mappings**) reached **145kb** against Express's 100kb default. A step that had changed three kilobytes of subjects was uploading a hundred and forty-five.

The wizard now tracks which answer keys were actually edited and sends only those, which is what the server has always been built for — `save` merges rather than replaces. That also closes the bug the original comment was written to prevent: a step could previously overwrite a key it never showed. The touched set is cleared only after a **successful** save, so one failed request cannot lose somebody's typing.

**And the limit was too low for an honest school.** The `mappings` key alone is 98kb here; a larger school exceeds 100kb sending one key, so the delta fix on its own would only move the cliff. `BODY_LIMIT` is now 2mb — room for roughly a thousand-section school — and Nest is created with `bodyParser: false` so ours replaces its 100kb default rather than sitting behind it.

`scripts/body-size-smoke.cjs` proves both halves at the size that broke: a 147kb draft is accepted and lands in the database, a 1kb delta does **not** wipe the 957 mappings it never mentioned, and a 3mb body is still refused with 413.

One adjacent bug surfaced while fixing it: `finish()` called `patch({ settings })` and then `persist()` on the next line, which reads state from the render that scheduled the update and cannot see it. A school that pressed Finish without opening the Settings step therefore stored **no settings at all** — the first-period rule, the §20 floor and the §28.1 alert line all silently kept their database defaults. `persistWith` now takes the value the caller decided rather than whatever React has got round to.


### 27.8 Initials in the cell, and a narrower picker

Two changes to the same control, from the same cause: a cell has room for about six characters and a real school has 122 teachers.

**The cell shows initials, not the employee code.** `EDX-1041` spends every character it has on a prefix every teacher in the school shares. Initials are what a staff room says.

Second Branch's teachers have no `initials` in the database, so the grid has to derive them — and the derivation is the interesting part. Uniqueness is a property of the **list**, not of a row: two Yadavs both propose `AY`, and `teachers.initials` is unique per school. `assignInitials` is therefore shared with `teacherSheets`, which mints them at commit. One function, so the initials somebody is **shown** are the initials the database **gets** — a display-only derivation would show `AY` for a teacher the importer then stored as `AY2`, a lie that only surfaces when a school goes looking for somebody by the initials it was given. `suggest.spec.ts` asserts the two agree directly. `adoptFromSchool` now carries `initials` through as well: a school that already uses them has them printed on cover lists, and deriving fresh ones would show it somebody else's shorthand for its own teachers.

**The teacher dropdown offers the people who teach the subject**, with a one-click *Show all*. It previously listed everybody and marked the ones who had not listed the subject — which is the filter's job, done somewhere nobody can act on it. The escape hatch remains because the original reasoning was sound: a school reassigning in a hurry knows something the subject list does not, and §18 scope is checked at commit either way; it is one click away rather than the default. **Guests are excluded from the default list** rather than merely labelled — §18 refuses them the regular curriculum, so offering one as an ordinary choice offers something the commit will reject.

Two things the filter must never do, both of which are silent when got wrong: **hide the teacher already in the cell** (a `<select>` whose value matches no option renders blank and reassigns on save), and **show an empty list** (when nobody has listed the subject it shows everybody and says why, rather than a dropdown containing one dash).


### 27.9 Which classes a teacher takes

The Teachers step asked which *subjects* somebody teaches and, where a school has more than one wing, which wing they belong to. The Allocation grid then staffed the curriculum from those two facts — so a Maths teacher pinned to Primary was a candidate for every Primary class, and correcting that meant reassigning cells one at a time on the next step.

`TeacherAnswer.classes` names them directly, and the §18 `teacher_class_eligibility` rows follow from it: the "Teaching Scope" column of the Teachers sheet is the declared classes where there are any, and the wing's classes where there are not.

**The cell starts with every class ticked and you remove what does not apply.** Blank would have meant the same thing to the importer — invariant 7 reads an empty scope as *not stated*, which falls back to the wing — but it says nothing on screen, and "which classes does she take?" would have had an empty box for an answer.

What is **stored** stays empty while nothing has been removed, and that is deliberate three times over: it keeps "not stated" meaning what invariant 7 says; it keeps a draft from carrying sixteen strings per teacher that convey no information; and it means a teacher whose wing changes later follows the new wing instead of silently keeping the old one's class list.

Two refusals in the cell, both of which would otherwise be silent:

- **The last class cannot be removed.** Doing so would store `[]`, which means *all* — so taking one class away would hand the teacher every class in the wing. Refused rather than reinterpreted: a control that does the opposite of what the click said is worse than a click that does nothing.
- **Changing the wing clears the list.** A narrowing belongs to the wing it was made in; carrying "Class 1, Class 2" into Senior would leave the screen showing every Senior class while the commit wrote two Primary ones.

The scope is honoured in three places, not one, because a rule enforced in only some of them is a rule a school finds by being contradicted:

- `suggestMappings` staffs only the declared classes, so the Allocation grid arrives filled in accordingly — and when nobody is scoped to a class it says exactly that (*"Nobody who teaches Maths is scoped to Class 3"*) rather than the older, misleading *"Nobody in Junior teaches Maths"*. Being told to hire when the fix is a tick box wastes a morning.
- The Allocation cell's **teacher dropdown** offers only teachers scoped to that class, under the §27.8 *Show all* escape hatch.
- `relieveLoad` checks it on every proposal. A remedy that moved Class 5 Maths to somebody scoped to Class 9–10 would be applied by a click and then refused by the importer — the advisor looks wrong *and* the school still has the overload.

`adoptFromSchool` reads the existing eligibility rows into the draft rather than re-deriving them, for the same reason it now carries `initials`: a school that has already said Mrs Rao takes Class 1 and 2 has said it, and an adopted draft that quietly widened her to the whole wing would re-staff the school against a scope nobody chose.

`SubjectPicker` became `ChipPicker`: the classes cell has the same shape as the subjects cell — a few chosen out of many, in a table cell, where "many" is twenty subjects or sixteen classes — so it is one control with a `noun` rather than two that drift. It gained `keepOrder`, because classes have one right order and Pre-Nursery through Class 12 sorted alphabetically puts "Class 10" before "Class 2".


### 27.10 The way back to the proposal

The Allocation grid staffs itself from the Teachers step — what each teacher teaches and which classes they take — and stores the result the moment anything is edited. From then on the stored plan wins, which is right: an edit somebody made must not be undone by a suggester re-running.

**Merging Curriculum and Mapping dropped the control that made that survivable.** Both old steps carried *"Start again from the suggestion"*; the merged step carried neither. Without it the stored plan wins for ever — somebody adds a teacher, or changes who teaches what on step 7, comes back and nothing has moved. From the outside that is the Allocation page ignoring the Teachers step, because from the outside it is exactly what it is doing.

Two controls, because two situations:

- **A quiet ↺ Start again**, present whenever the page holds an edit. It confirms first and says what it will not touch, since throwing away a re-staffed school by accident is expensive.
- **A banner when the disagreement is real** — an assignment naming somebody who no longer teaches that subject or is no longer scoped to that class (§27.9), or cells a fresh proposal would cover and this one leaves unstaffed. A quiet link is right for *"I would like to start over"*; it is not enough for *"what is on your screen contradicts what you just typed"*, so the mismatch is named and counted.

**The reset sends `null`, not `undefined`**, and that is not a style choice. Since §28.6 the wizard sends only the keys a step touched, and `JSON.stringify` drops an undefined one — so the server would merge nothing and the stored plan would survive a reset that appeared to work. `edited()` reads any non-array as "not stated" and re-proposes, so `null` clears it. The smoke asserts both halves: that the stored edit really is gone, and that the dry run then comes back with a complete staffing rather than nothing.

**One limitation, stated rather than hidden:** the §16 importer skips rows that already exist by natural key — it does not update them. So re-staffing changes the draft and the grid, and a mapping already committed for `(subject, class-section)` keeps the teacher it was committed with. Before the first commit of that step, which is where a school setting itself up actually is, the reset does what it says. Changing a committed assignment is the Subject Mapping screen's job.


### 27.11 Clearing the allocation

§27.10 gives the page a way back to the *suggestion*: it rebuilds the draft and leaves the database alone. That is the right tool while a school is still setting itself up, and the wrong one afterwards — the §16 importer skips rows that already exist by natural key, so a mapping already committed for `(subject, class-section)` keeps the teacher it was committed with however many times the draft is re-proposed. Somebody who has pressed Next once and wants to start the allocation over needs the rows gone.

So there are **two controls, and the difference between them is the point**: *↺ Start again* is a rethink, *⌫ Clear saved data* is a demolition. One button meaning both would be the last thing anybody read before losing an afternoon.

`allocation-reset.ts` is built the way §3.13's config deletion is, for the same three reasons:

- **Every step declares its count and its delete in one object**, so the confirmation can never under-report the write (the §23 rule). A count and a delete written apart drift, and the drift is only ever found by a school that agreed to something else.
- **The plan is recomputed server-side before the write**, never taken from the request: a preview held for five minutes is not what is true now, and it is never the list of writes.
- **A published timetable refuses it**, on the write as well as in the preview. Its slots name subjects and teachers whose *reasons* this would delete — the grid on the wall would keep working while Readiness reported a school that teaches nothing, and two answers to "what is Class 5 taught?" is worse than either.

What it removes: merged teaching groups, subject mappings, curriculum rows, class teachers (cleared, not deleted — the section keeps everything else), and the **draft timetable rows generated from them**. That last is the reason it is worth doing: a draft built from a curriculum that no longer exists is a timetable of lessons the school does not teach, and leaving it puts a stale grid on the Board beside a Readiness score of zero.

Three scoping rules that are easy to get wrong and silent when wrong:

- **Curriculum is deleted by class AND academic year** (§3.11). `class_subjects` is keyed `(class_id, subject_id, academic_year_id)` and a class has rows in every session it has ever run; clearing this timetable must not take next year's planning with it.
- **A merged group belongs to this timetable only when every member does.** `merged_teaching_groups` has no FK to a config — it is scoped through its members' class-sections — so one straddling two wings belongs to neither alone, and deleting it while clearing one would silently take teaching out of the other. §4.9 elective blocks are scoped the same way, which is why they are *counted and named* rather than removed: they are the Electives screen's.
- **Another school's config is 404**, on both the plan and the write, through the one `ownConfigOr404` §27.8 added.

The confirmation is a **typed word**, not a second OK. Every count on the card is a row somebody entered, and "are you sure?" is a question people learn to answer without reading. The card lists what will go with its counts, and — equally important — what will not: subjects, teachers, rooms, classes, sections, the week, and any elective blocks.

The smoke covers both halves in the order that matters: it publishes a wing, asserts the reset is refused *and* that the refusal is enforced on the write; then clears the other wing and asserts the mappings, class teachers and 400 draft rows are gone while 64 teachers, 8 subjects and 10 sections stand, and the published wing is untouched.


### 27.12 A master is entered once, and used for ever

A school that has run a timetable has its session, its classes and sections, its subjects, its teachers, its rooms and its curriculum. Asking for them again because it is starting a second timetable — or because somebody deleted the first — is asking it to retype its own records.

**Two things were true, and only one of them was obvious.**

Deleting a timetable has never deleted a master. `config-deletion.ts` removes slots, drafts, extra classes, periods, auto-fix runs and publications, and **detaches** class-sections; subjects, teachers, rooms, classes and the academic year are untouched, and the smoke now asserts every one of those counts across a delete rather than leaving it to be believed.

What was wrong is what happened *next*: the guided setup opened blank. `adoptFromSchool` — which rebuilds the wizard's answers from the database — existed and was reachable only from a **⚡ Guided** button on an existing timetable's card. Delete the timetable and that card is gone with it, so the one route to the machinery disappeared exactly when it was needed. From a school's point of view the masters had been deleted, because the app asked for them again.

**`GET /onboarding/session` now falls back to the school itself.** With no draft it returns the rebuilt answers flagged `prefilled`, and **does not save them**. Not saving is the point: opening the guided setup to look at it must not create a draft, or `shouldPrompt` would offer that school a resume for ever afterwards. The client marks every prefilled key as *touched* so the first Next writes them — without that, a step whose answers only ever existed in the browser would commit nothing and report *"There is nothing to create yet"*, which is §28.6's failure one level up.

`answersFromSchool` was split out of `adoptFromSchool` for exactly that reason — one derivation, read by a path that persists and a path that does not.

**It now carries the plan as well as the masters.** Rooms, curriculum, mappings and class teachers were missing, and the omission was visible: adopting a school with 957 mappings produced an Allocation grid that re-staffed all of them from scratch and reported hundreds of unstaffed cells. A plan somebody has already made is an answer, not a blank. Curriculum is read for the **active year only** (§3.11) — a class has rows in every session it has ever run, and two sessions' rows would collapse into whichever loaded last.

A genuinely new school still gets question one and an empty form, which is right: §27.12 is about not asking a school that has already answered.


### 8.1d (revised) — the nav starts collapsed

The collapsible nav shipped defaulting to *expanded*, with the choice remembered per browser. It now starts **collapsed on every load**, and expanding lasts the visit rather than being persisted.

The reasoning is that the collapsed state is the designed one: every item is an icon whose name slides out of the rail on hover, so nothing is hidden, only folded — and the screens behind it are the 50×40 allocation matrix, the drag board and a guided-setup dialog that insets itself by `--sidebar-w`. All three want the 172px more than a standing list of twenty-four labels is worth.

The trade-off is real and is stated in the module rather than left to be discovered: somebody who genuinely prefers the labels re-opens it each time. Making it sticky again is one line — read `localStorage` in the `useState` initialiser and write it in `toggle`.

**One implementation detail decides whether this reads as a default or as a fault.** `--sidebar-w` defaults to 236px in the stylesheet, so until the root is stamped the nav renders open. `apply` therefore runs in a **`useLayoutEffect`**, which fires before the browser paints; as a passive `useEffect` it fired after, which showed every user an expanded nav snapping shut on every single page load. That was survivable while collapsing was a minority choice and became everybody's first impression the moment it was the default.


### 27.13 What a teacher teaches, recorded about the teacher

A school set up its first wing, told the Teachers step that Ajit D teaches Maths, generated a timetable — and then started a second wing to find every "Teaches" cell empty and the line *"16 teachers have no subject yet."*

**It was never stored.** The guided setup asked the question, used the answer to propose mappings, and threw it away. The only surviving trace of "Ajit D teaches Maths" was whatever `teacher_subject_class_section` rows happened to exist, so a teacher created but not yet allocated taught nothing as far as the app was concerned — and neither did one whose allocation had since been cleared. The `Teachers` sheet had no Subjects column at all, which is why an Excel round-trip lost it too.

Derived-from-mappings is the mistake §18 already corrected once. `teacher_class_eligibility` is **declared, not derived**, precisely because a scope read back from existing mappings can only ever describe what somebody has *already* been given and can never constrain what they are given next. A teacher's subjects are the same kind of fact, so `teacher_subjects` is the same shape of table, written by the same importer step, from a new `Subjects` column on the same sheet.

Three rules carried over verbatim, because each one is a way this could quietly go wrong:

- **Absent means "not stated", never "teaches nothing"** (invariant 7). The importer writes the table only for rows that named subjects; a commit that cleared it would empty a teacher's subjects the first time anybody uploaded a sheet with the column blank — which is every sheet exported before this existed.
- **Readers take the union of declared and mapped.** Declared is the fact and survives having no mappings yet, which is the case that was broken; the mappings are still read because every school predating the table has no declarations, and reading only the new one would empty the column for all of them.
- **The migration backfills from the record**, so the declaration starts out agreeing with what the school has been doing rather than contradicting it — from mappings, from §4.10 merged groups, and from §4.9 elective options. That last matters: a French teacher whose only teaching is inside a split block would otherwise read as teaching nothing, the same bug that once made nine of the reference school's teachers look unscheduled.

The §23 sync cascades were extended to name it. The foreign key cascades either way, which is exactly why the step has to exist: a silent cascade is a destructive write nobody was shown, and §23's contract is that the confirmation cannot under-report.

**What the fix cannot do is recover what was already lost.** A school whose teachers were created before this has no declarations and no mappings to backfill from — the information was genuinely discarded. Those subjects have to be entered once more, and this time they stay.

### 27.14 Turning the hover card off

The Allocation grid's hover card is the fastest way to read a cell: four facts about a 58px button without opening anything. It is also a panel that follows the pointer across a grid somebody may be *scanning* rather than reading — running an eye down a column of periods, the card is in the way of the next cell. Both of those are true at once, which makes it a preference rather than a decision to take on everybody's behalf. **Hover detail** in the toolbar is a checkbox, ticked by default.

Three things about it are decisions:

**The switch is on the handlers, not on the card's render.** Gating the `<Tip>` at the bottom of the component is the one-line version and it is the wrong one: `onMouseMove` sets state on every pixel the pointer travels, so on a 50-section × 22-subject grid each mouse move re-renders the whole table. Hiding the card at the end of that chain leaves every one of those renders happening for nothing — somebody who turned the card off to make the page calmer would get the same page, doing the same work, with the answer thrown away. `peek()` returns `{}` when the setting is off, so React attaches no listener at all. It also collapsed six pairs of duplicated `onMouseEnter`/`onMouseMove` handlers into one call site each.

**The preference is remembered across visits**, unlike the §8.1d nav collapse, and the difference is not an inconsistency. The nav's collapsed default is the shape the school wants everyone to start in; someone who turns hover cards *off* has told us something about how they work, and making them say it again every visit is precisely the annoyance they were switching off. Storage that throws — a browser with site data blocked — falls back to the default and a working page rather than an error.

**The label says what the state is, not what pressing it does.** "☑ Hover detail" over "Turn hover detail off": half the readers of the second form take it as a description of the current setting. The Help text switches with it too — telling somebody who has turned the card off to hover a cell for the detail describes a page they are not looking at, so it points at the click instead. Clicking a cell always opened the full dialog; with the card off, that is the way in, and it is the same way in it always was.


### 27.15 A class does not take a subject

Two halves of one complaint: **"Biology in Pre-Nursery"**. The Allocation grid proposed every subject in the school's list to every class in it, and there was no way to say that a particular class simply does not take one.

**The ladder (`suggest.ts`).** The classifier knew Biology is a 4-6 period laboratory science and had no opinion at all about who is old enough to take it. Each `WEIGHTS` family now carries an optional `from`/`to` — inclusive positions on `CLASS_LADDER` — and a subject off its rung is not proposed for that class: Physics, Chemistry and Biology from Class 9 (below that a school teaches "Science", which is a row of its own from Class 1); Economics, Accountancy, Business Studies, Psychology, Sociology from Class 11; a third language — Sanskrit, French, German, Spanish, Urdu — from Class 5, while Hindi and a regional second language run the whole ladder.

Three limits on that, each of which is the difference between help and interference:

- **It shapes the proposal, never a rule.** A school that teaches French from Nursery clicks the empty cell and types a number. Nothing argues.
- **An unrecognised name has no range** and is offered everywhere. A missing proposal costs one click; a wrong one is corrected only if somebody notices.
- **It stands aside rather than leaving a class with nothing.** A pre-primary wing whose school listed only Physics and Accountancy gets them: the school's own list is better evidence than the ladder in that case, and an empty week is a Readiness score complaining about 40 free slots per class.

An empty cell now says why it is empty — *"Biology usually starts at Class 9 — type a number to teach it here anyway"* — because a blank the page produced on purpose is otherwise indistinguishable from one it lost.

**The deletion (`allocation-cell.ts`, `RemoveSubject`).** The ladder cannot know that this school drops Computer Science in Class 12, so there is also a way to say so: ✕ **Not taught in {class}** in the cell dialog, and Delete on the keyboard cursor. It is not the same as setting the periods to zero, which leaves the teacher mapped to a subject nobody is taught; it removes the curriculum row, the mappings across every section of the class, the §4.10 merged groups that taught it there, and the draft lessons already placed for it.

**Why the wizard calls the server here, when it is otherwise draft-only.** Clearing the draft is the whole of the change right up until the step has been committed once. From then on the §16 importer skips by natural key and removes nothing, so a curriculum row that has reached the database survives every re-import: the cell would empty on screen while Readiness went on demanding four periods of Biology a week for a class of four-year-olds. **An empty cell that does not mean "not taught" is worse than no delete button, because it is believed.**

Built like §27.11's reset — count and delete declared in one object, the plan recomputed server-side before the write, never taken from the request — with two deliberate differences. The refusal is **narrow**: §27.11 blocks on any published slot because it deletes everything, while this asks only whether the wall chart teaches *that subject to that class*. And there is **no typed word**: this removes one class's one subject and putting it back is clicking the same cell and typing a number, where the reset destroys a timetable's whole planning. The counts are still shown in full. Asking twice is a clean `{ok: true, total: 0}` rather than a 404 — "there was nothing to delete" is a successful outcome of asking for a deletion — while a class or subject that does not exist at all is still a 404, because that is a request about something else.

**The fallback is per WING, not all-or-nothing.** `answers.curriculum ?? proposal` reads fine until a school with one planned wing adds a second: the stored array is not empty, so it won for the whole school and every class in the new wing arrived with no subjects at all. §27.12 makes that the ordinary path rather than an edge case — an existing school's answers are prefilled from its master data, so the array is populated before anybody has touched the page. The proposal now fills wings the plan has never covered, for the curriculum, the staffing and the class teachers alike. A **wing** is the unit that decides, and not a class, because absence has to keep meaning something inside a wing that has been planned: a class somebody emptied on purpose — which this phase makes a normal thing to do — must stay empty, and a class-level fallback would put it straight back.

### 8.1d (revised) — the flyout was painting under the page

With the nav collapsed, hovering an icon slides its name out of the rail. It was sliding out *behind* the content: the label appeared, crossed the rail's edge, and vanished under the white panel.

The cause is a rule that is easy to forget. **`position: sticky` creates a stacking context unconditionally** — unlike `relative`, which needs a `z-index` to do so. `.sidebar` is sticky, so `.nav-fly`'s `z-index: 60` was only ever competing with the sidebar's *other children*; the rail as a whole took part in the root stacking context at `auto`, and the page content painted over it.

So the fix is on the rail, not the flyout: `.sidebar` now carries `z-index: 50` — above the sticky topbar (5), below the §24.5d pane overlay (200), which is supposed to dim the nav rather than duck beneath it. The flyout's own z-index was never the problem, and raising it further would not have helped.

Fixing it exposed a second thing. Nav items carried both `aria-label` and `title`; while the flyout was hidden, only the browser's grey tooltip was visible, so the duplication never showed. With the flyout painting correctly the two arrive together — the label slides out of the rail and a tooltip drops on top of it a moment later saying the same word. `title` is gone; `aria-label` stays, because that is the part a screen reader needs when the visible label is folded away.

### 8.1d (revised) — scrolling the rail without a scrollbar (`nav-scroll.tsx`)

The nav list scrolls when the groups do not fit, and it did so with a styled 6px scrollbar. That was designed for the 236px nav, where a scrollbar is a thin edge detail. Collapsed, the rail is 64px with the icons centred in it, so the same 6px bar runs the full height of a navy panel a few pixels from the icons — it stops reading as a browser affordance and starts reading as a design element nobody chose.

So the scrollbar is hidden (`scrollbar-width: none` plus the WebKit pseudo-element) and the information it carried — *there is more this way* — is carried instead by a small chevron at each end of the list. A chevron says the same thing and is also a control: pressing one scrolls 60% of a screenful, smoothly, with enough overlap that the row being read is still on screen afterwards. Wheel, trackpad and keyboard scrolling are untouched.

Three details are the design rather than decoration:

- **Both chevrons are drawn only when the list actually overflows.** On a tall screen the whole nav fits and neither exists. A permanently dimmed pair would be two rows of dead space in the one column the collapse exists to make room in.
- **When it does overflow, both slots stay mounted** and the one at the end you have reached fades to 22%. Unmounting the spent one would shift every icon by 17px at the moment somebody was aiming at one.
- **They are `aria-hidden` and out of the tab order.** Scrolling this list from the keyboard already works — tabbing through the nav scrolls the focused item into view — so these are a pointer affordance, and putting them in the tab order would add two stops in front of every nav item on every page to duplicate something that already happens.

The `ResizeObserver` watches **both** the scroller and an inner content wrapper, because either can change without the other: the viewport changes on a window resize, and the *content* changes when the nav collapses — every label folds away, the rows shorten, and a list that overflowed a moment ago now fits. Watching only the scroller leaves the chevrons showing on a nav that no longer needs them.

The chevrons are drawn as SVG paths matching `icons.tsx`'s stroke, not typed as `⌃`/`⌄`: those are typographic marks, not arrows — off the optical centre, differently sized in every font, and on some systems falling back to a face with nothing to do with the nav.

### 8.2 The masters, on top — and the wizard that stopped being one

The five master screens were the first five steps of a nine-step Setup Wizard. That is the right shape exactly once: the day a school is set up. Afterwards "add a teacher" is not step 5 of anything, and reaching it meant walking a stepper past four screens that were already done. **A wizard is a sequence; masters are a set.**

So `/masters` is a row of entity buttons — Subjects, Classes, Classrooms, Teachers, Academic Years — over the same lists and forms the wizard used, moved rather than rewritten. A second form over the same rows is how two screens start disagreeing about what a subject has. Selecting Classes also shows **Lessons**: what that class-section is taught, by whom, how often, and where.

**Lessons is read-only, deliberately.** The Allocation grid (§27) writes curriculum and mappings, and it is the only thing that does — a curriculum row and the mapping that teaches it are one decision. This answers the other question, "what does 5-A actually do all week?", which the matrix shape of the Allocation page makes you read column by column. It has to include §4.9 elective options: a block's member row carries no subject (invariant 9), so a class's week rendered from mappings alone shows the period as free — the exact bug `ReportsService.classSectionTimetable` exists to avoid.

**What the wizard became.** Its five master steps are the Masters screen; Curriculum and Teacher Mapping are the Allocation page, which was already the better answer to both; Electives keep their own screen. What is left at `/setup` is the timetable's own week — the period grid, its breaks, its §28 activities and which class-sections a wing covers. Those are facts about **one timetable**, not about the school, so they belong beside the timetable and not among the masters. The welcome screen now offers two doors rather than three: guided, or describe it to the assistant. Manual entry was a third way to set up the same rows, and a third writer over data two paths already own.

**The Allocation nav entry is a door, not a screen.** It opens the guided setup at its Allocation step rather than porting the grid to a second component, because the grid works on the draft answers and commits through the §16 importer — the one path that writes those rows. §27.12 is what makes opening it directly sensible: `GET /onboarding/session` falls back to answers rebuilt from the school, so a school that finished its setup months ago opens it and sees its own curriculum rather than an empty draft.

### 8.3 The guided setup is a page, not a popup

It opened as a modal, and §24.5d had already grown it to exactly the size and position of the pane beside the nav — a dialog filling the whole content area while dimming a strip of navigation nobody was reading. At that point the overlay costs things and buys nothing: focus is trapped, the URL does not say where you are, the browser's Back button does not close it, and two of the things behind it (the setup itself and the §27 Allocation grid) are screens a school works inside for an hour rather than questions it answers and dismisses.

So `OnboardingWizard` takes an `inline` prop and the same component renders either way. `/guided-setup` opens at the saved step, `/allocation` opens it at step 9, and the dialog form is kept for the one case that is genuinely modal: the welcome flow, where arriving IS a hand-over from something else and closing has to give it back.

**Opening it is now navigation, and that lives in one place.** The welcome screen's door, the "carry on" button and the §24.6 chat hand-over all mean "open the guided setup", so `Onboarding` turns its own `view === "wizard"` into a `nav("/guided-setup?at=…")` rather than each caller learning the route. The `openOnboardingAt` event that predated this is **removed** rather than left beside it: two mechanisms for opening the same screen is exactly the divergence this codebase spends its comments avoiding. The redirect runs in an effect, not during render — setting state while rendering in order to return a redirect is the shape that produces a render loop somebody has to debug later.

`.pane-page` drops the border-shadow-radius of a floating panel, because it no longer is one, but keeps the **fixed height**: step 9's grid pins its own header and footer and scrolls between them, and a page that grows instead would put a second scrollbar under the first and move the row somebody is reaching for.

### 8.4 Giving the height back to the grid

The Allocation grid had about 320px of chrome above its first row: the app topbar, 26px of page padding, the wizard's step line, a praise banner, a serif heading, and a bordered load rail. On the one screen in the app that is genuinely short of vertical room — 50 class-sections down, 22 subjects across — that is eight rows of school spent on saying where you are.

Six changes, each removing something that was not carrying information:

- **The page's own margin was 26/28/60.** The 60px of bottom padding was pure dead space: no screen ends at the fold. Now 12/14/14, which is enough that a card does not touch the chrome.
- **`.content` scrolls instead of the window**, which is what lets a full-height page ask for the height it has *been given* rather than `100vh` minus a number somebody measured once. `.main` is a viewport-tall column, `.content` is a flex item of it, and `.pane-page` is `height: 100%` — change the padding and everything follows. The print block undoes it (`height: auto`, `overflow: visible`), because a document inside a viewport-sized scroller prints as one clipped page with nothing on the sheet to say the rest is missing.
- **The guided setup and the Allocation page are full-bleed.** Both are frames in their own right — their own border, their own pinned header and footer, their own scrolling — and an inset around one of those is a margin inside a margin. Listed in `Shell`, because it is a fact about the layout: a page cannot remove padding its parent applied.
- **The praise banner floats on a tall step.** "Wonderful! Your rooms are ready" is worth saying and worth nothing once read; it was holding a permanent 60px band to say it. It now sits over the top-right corner on step 9 and stays a banner everywhere else, where there is room to spare.
- **The "Who teaches what" heading went.** The step line two rows above already says *Allocation*, and nobody looking at a class × subject matrix wonders what it is.
- **The load rail is a strip, not a card.** A border, a radius and 6/11 padding drawing a box around one row of chips cost ~20px; a rule underneath separates it from the table just as well.

Together that is roughly 150px, or four more class-sections visible without scrolling. The step header, body padding and footer all tighten on a *tall* step (`TALL_STEPS`) and keep their breathing room on the form steps, where readability is what matters and there is height to spare.

### 16.1 A commit is not only a create

Reported as *"I defined the classes in the guided setup, why is Readiness 0%?"* — a school with every class entered, both wings created, and `timetable_config_id` NULL on all 32 class-sections.

**The sheet was right and the importer was reading it.** `classSheets` puts the wing in the Class Sections sheet's `Timetable` column, and the importer sets `timetable_config_id` from it. What went wrong is what happens the *second* time: the natural key for a class-section is `(class, section, year)` and the timetable is not in it, so a section created before its wing existed was skipped for ever after. The link is not part of any key, so nothing would ever fill it in.

Two changes, and the second is the more important one.

**An existing section that belongs to no timetable is attached.** Deliberately the §21 `complete` shape rather than an update: only a NULL is filled. A section already assigned to another wing is left alone — a class-section belongs to exactly one timetable (invariant 11), and moving it between wings is a decision somebody makes on purpose, not something a re-import does on their behalf. Every other field keeps the "the importer does not change existing rows" contract exactly.

**`commit` no longer returns early when there is nothing new to create.** It used to answer *"everything here already exists — nothing to add"* the moment `create === 0` and skip the transaction entirely. But creating is not the only thing a commit does: it also **links rows that already exist** — a section to its timetable, a lab to its subjects (§19.1), a teacher to what they teach (§27.13) — and none of those links are part of a natural key. So "nothing new" was silently being read as "nothing to do", and the one action a person could take to repair the school did nothing at all, twice as invisibly because the message said everything was fine.

The pass is safe to run with nothing new: every create loop filters on `isNew`, and the linking steps are idempotent because they already ran on every commit that had *any* create. The message now distinguishes the three real outcomes — rows added, nothing added but something repaired, or genuinely nothing to do — because they are different things to somebody who has just pressed Next.

### 27.16 Which classes a subject is taught to (Phase 38)

Asked for as *"in subject master provide the option where I can choose the classes for which the subject is applicable, and this should be automatically picked in Allocation."*

The setup already had an opinion about this. §27.15 gave each `WEIGHTS` family an optional `from`/`to` on `CLASS_LADDER`, so Biology is not proposed to Pre-Nursery. But that opinion is **read off the subject's name**, and a guess is all it can ever be: a school that calls it "Bio-Science" gets no opinion at all, and one that teaches French from Nursery is simply contradicted. So the ladder shapes a proposal and is deliberately never a rule.

`subject_classes` is the school saying it instead — the same promotion §18 made when it replaced a teaching band *derived* from existing mappings with a **declared** one, and for the same reason: a fact read back from what somebody has already been given can describe the data but can never constrain what they are given next.

**A row per class, not a range.** A range is only expressible on the ladder, so a school with its own class names could not use one; and it cannot say "Class 5 and Class 8 but not 6 or 7", which is an ordinary thing for an elective to be. At this size a row costs nothing and can say anything.

**Empty means "not stated", never "no classes"** (invariant 7). That single reading is what leaves every school built before this behaving exactly as it does today — the ladder proposes, nothing refuses anything — and it is why there is no backfill in the migration: backfilling from existing curriculum rows would recreate precisely the derived fact this table exists to replace.

**Where it wins, and where the ladder still speaks.** They are two filters that look alike and are not, and collapsing them into one is the mistake worth naming. The declaration is applied first and never reconsidered; the ladder applies only to subjects nobody declared, and it may **stand aside** when it would leave a class with nothing. That fallback runs over the subjects the declaration allows, not over every subject — otherwise a class whose only candidate was excluded would be quietly handed it back, which is the proposal arguing with the answer rather than with a guess. A class left empty because the school excluded everything stays empty, and Readiness reports the free slots, which is the truth.

**Three doors, one field.** The Subjects master (a `ChipPicker` beside the subject's name), the guided setup's Subjects step (the same control, offering the classes the wings define), and the workbook's new `Classes` column on the Subjects sheet — which gives the Excel template, the export, the ERP sync and §13.5's AI drafting the field for free. The importer writes it only for rows that named classes, exactly as `Teaching Scope` and `Subjects` on the Teachers sheet do: a blank column is "not decided yet", and clearing on blank would wipe a school's declarations the first time anybody re-uploaded a sheet exported before the column existed.

**Enforcement is where §18 puts it.** `assertSubjectApplies` refuses a curriculum row at the point of the mistake, naming both halves — *"ZZGS Physical Education is not taught in Class 5. It is set for Class 1 on the Subjects screen."* The Allocation grid refuses the same edit client-side rather than writing into the draft what the commit will throw out, and names the screen that owns the statement, because that is where it is changed. The empty cell explains itself differently from §27.15's: a rung ends *"…type a number to teach it here anyway"*, a declaration says where it was said. One writer per fact.

**Check 13 is the backstop, and it is a WARNING.** Rows written before a declaration existed, or through a workbook, never passed the guard, and there is no other way to find them — a curriculum row and a subject's class list live on two different screens. It reports as one grouped row naming the first three. It is not a blocker, and the distinction from Check 8 is worth stating: a teacher outside their scope blocks because generating would *enact* the wrong thing, putting them in front of a class they may not take. This one would generate a lesson somebody typed on a screen that let them. What is wrong is that two statements disagree — and refusing to generate the whole school over a disagreement turns a convenience into a trap. No remedy, for the §21 reason: one way out is deleting teaching the school may genuinely do, the other is widening an answer somebody gave on purpose, and neither is safe under a standing consent.

**A long selection is summarised, not listed.** §27.9's "All 14 classes" chip covered only half the problem, and the half that shows up second: remove one class and the cell went from a single chip to thirteen — the same wall §26.1 pulled down, arriving the moment somebody uses the control. `ChipPicker` now summarises above three (*"11 of 14 classes"*), keeps the names in the `title` so a hover still answers "which ones?", and the summary chip is itself the opener, since a second control beside it would be two buttons doing one thing.

**A chip never wraps mid-name, and Teaches is not the leftover column.** "Computer Science" was breaking *inside* its own pill — two lines of white text in a rounded blue box, with the ＋ pushed onto a third, and every row in the table grown to match. Two causes: chips had no `white-space: nowrap`, and Teaches was the one column with no width, which sounds flexible and is not — every other column takes a fixed width, so "flexible" meant "whatever is left", and what was left fitted "Computer" but not "Computer Science". It now takes a `min-width` rather than a fixed width, so a school of one-word subjects is not made to look at 190px of white space. The classes columns went the other way: since they summarise into one chip they no longer need 18%.

**The picker follows its row instead of closing** (`ui/anchored.tsx`). A `position: fixed` panel does not travel with the row it belongs to, and the first version paid for that by closing on any scroll. Once the panel held fourteen classes that was wrong twice over: the scroll listener is in the **capture** phase — a table's own scroller does not bubble — so the panel's own scrollbar closed the panel, making a long list impossible to scroll at all. And closing was never the right answer anyway: the panel is not stale when the page moves, only misplaced. It now ignores scrolls that originate inside itself, re-measures against its anchor for everything else, and closes only when the anchor has genuinely left the viewport. The list's own `min-height: 0` is load-bearing beside it — a flex item defaults to `min-height: auto` and refuses to shrink below its content, so without it the list ignores the panel's `max-height` and grows down the page instead of scrolling inside it.

**The isolation gate learned a new shape.** `/availability/:kind/:id` (§4.7b) was sitting unclassified: one controller over four tables, so the sweep could not map `/availability/` to a single resource. The answer was not a waiver — `:id` really is another school's row id and really must 404 — so the sweep now expands a discriminating path segment into the concrete routes it serves, and each sweeps like any other. It is still driven by the app's own route table: a fifth kind added to `KINDS` and left out of the expansion appears as a new unclassified route and fails the build.

## 29. Staffing changes on a settled timetable (Phase 39)

Asked for as *"once the timetable is published and frozen, no changes in allocation are permitted at any level"*, with a scoped release for the case that makes it necessary: a teacher resigns, goes on maternity leave, or a new one joins, and their classes have to go somewhere without disturbing anybody else's week.

### 29.0 The load-bearing decision: reassign, never regenerate

The requirement is *"no other timetable will get impacted; the rest of the timetable will be the same."* There are two ways to attempt that and only one of them keeps the promise.

A **scoped re-solve** — release some teachers, lock everything else, run the solver — cannot. The solver is a search: if a freed lesson does not fit, it wants to move something else, and the only way to stop it is to make the run fail instead. "No impact elsewhere" would hold by luck rather than by construction.

So: **the cells never move; only the teacher standing in front of them changes.** Class 5-A still has Maths on Monday P3, and who teaches it is the only question being answered. `uq_class_slot` and `uq_room_slot` are untouched because neither the class nor the room moves; only `teacher_occupancy_key` changes, which is precisely what is validated. Every other teacher's week is byte-identical because no row of theirs is written.

That makes this a **weighted bipartite matching** rather than a CSP — the shape §6's substitute engine already solves, but over a week instead of a day and permanently instead of as an overlay. The consequence is stated rather than hidden: if no available teacher can cover a vacated class, it is **named and left uncovered**; nothing starts moving other classes' periods to make room. That is Phase A's promise applied to staffing — prove it, or name the exact row.

**The unit of reallocation is a mapping, not a period.** `teacher_subject_class_section` is unique on `(subject, class_section)`: one teacher owns Class 5-A Maths, all six periods, and that is what a school means. Five sections of a leaver's Maths may go to five different teachers; one section's Maths is never split between two. Assignment happens at mapping granularity, **validation at slot granularity** — a candidate must be free at every one of those six cells or they do not qualify. Four things carry "who teaches" and all four are in scope: mappings, merged teaching groups (§4.10), elective options (§4.9), and `class_sections.class_teacher_id`.

### 29.1 Freeze

`timetable_config.frozen_at` / `frozen_by_id`. Two columns rather than a `status` value, because `status` already means draft/active/archived and a second meaning on one column is how a field ends up unable to say "archived AND frozen" — and because a timestamp answers *when*, which is the first thing anybody asks of a change they did not make.

**Freezing is a deliberate act, never a side effect of publishing.** `POST /timetable-configs/:id/freeze` requires a live publication and says which of the two is missing rather than refusing flatly; NULL is every timetable that exists today, so nothing changes until a school presses the button. It is idempotent, and pressing it twice keeps the original timestamp: the answer to "when was this settled?" must not be rewritten by a double-click. `POST .../unfreeze` is the wide escape hatch and is logged as such — §29.2's scoped thaw is the narrow tool.

Both take **`timetable.publish`**, not a permission of their own: whoever may put a week on the wall may declare it settled. A new permission would need a §15.2 registry entry and a per-role decision for every school that already exists, bought for a distinction nobody has asked for.

**What it refuses.** Anything that could contradict the printed copy in every classroom: curriculum, mappings, merged groups, elective blocks, class teachers, class-section edits and deletion, the week's structure, §28 activities, which classes the wing covers, allocation reset, §27.15's cell delete, generation, every board edit, draft creation and editing, publishing, withdrawing, and deleting the timetable. Board edits touch *draft* rows rather than the published set, which makes them tempting to leave alone — that would make the freeze theatre, since a draft edited and then published is the published week changed by two clicks instead of one.

**What it deliberately does not refuse.** Adding a teacher, a room or a subject; creating next year's session; cloning this timetable into a new one (the source is only read); and every read, preview and dry-run — seeing what a change would cost is not making one. A freeze that blocked hiring would be a freeze people work around.

**Availability (§4.7a/§4.7b) is also not frozen, and that is a decision rather than an omission.** "Mrs Rao now leaves at 1pm on Fridays" is a fact about a person, not an allocation, and it is exactly the fact a school records *before* re-staffing; refusing it would leave them unable to write down the thing that prompted the change. Accepted, it makes Readiness report a published week that no longer satisfies a hard constraint — which is true, and is the school being told there is something to fix.

**The importer and the guided setup are the blunt exception.** Both resolve names to rows deep inside one transaction and cannot say up front which timetables they will touch, so they refuse while *any* wing is frozen. The narrow version would have to re-derive the importer's own name resolution, and a second copy of that is how the two would drift.

### 29.1a One definition, and the test that makes it safe

`FreezeService` is the shape §18's `assertCanTeach` and §27.16's `assertSubjectApplies` already use: one definition of the rule and its message, called at every attachment point. Four resolvers, because a write identifies its timetable in four ways — by config id, by class-section (mappings, groups, blocks, class teacher), by class and year (the curriculum, which is class-keyed under §3.11 and so may reach several published weeks at once), and "any in the school" for the bulk committers.

§17's Prisma-extension approach was considered and rejected: school scoping reads an ambient context and needs no query, whereas "is this row's timetable frozen?" needs a lookup per write for models that reach a config through two joins, and the §14 budget is not the place to pay for that on every insert.

The cost of the call-site shape is that a **new** write path can simply not ask. `scripts/freeze-smoke.cjs` (`pnpm test:freeze`) is what stops a school discovering that: it drives all 28 guarded routes against a frozen timetable and requires each to refuse by name. It also asserts the two things a refusal test usually omits — that **every one of them works again after unfreezing** (a guard that refused permanently would pass the first half and have broken the product), and that reading, previews, hiring and next year's session are untouched.

The message is worded once, in the service, and each call site passes only *what* it was about to change. That is why the second half of the sentence — which will name staffing changes once §29.2 lands — is one string rather than twenty.

### 29.2 The staffing change: a record, not a mode

The scoped release of §29.1, and deliberately a **record** rather than a mode. A mode that is switched on and off cannot answer *"who taught Class 5-A Maths before September, and why did it move?"*, which is the question the whole thing exists to make answerable.

Three tables. `staffing_changes` is the plan — its timetable, the reason, an optional effective date, a note, and a status of `planning` / `applied` / `reverted`. `staffing_change_teachers` names the teachers on each side. `staffing_change_items` is what actually moved, written by §29.4's apply, and is the undo record.

**`reason` is an enum, not free text**, because it chooses the default *shape* of the change: a resignation releases everything a teacher holds, an adjustment releases what somebody picks. `note` is where the school's own sentence goes.

**`effective_from` is recorded and never acted on.** A change takes effect when somebody applies it. A timetable that rewrote itself overnight on a stored date — against a week that may have moved since the plan was made — is exactly the behaviour §29 was asked not to have.

**A teacher is `releasing` or `receiving`, never both**, which the composite primary key enforces. Both at once is not a shape the engine can score: a candidate must have a settled load before anything is offered to them, and a teacher simultaneously losing and gaining has two answers to "how full are they?". The refusal says so and suggests two changes.

**One open change per teacher.** Two plans that both intend to move Class 5-A Maths would each look valid alone and collide at apply — and the second would be applied against a week the first had already changed, so its own preview described a school that no longer exists. The refusal names the change that already holds them.

`staffing_change_items` is a real table rather than `auto_fix_runs`-style JSON, and that precedent is close enough to answer: an auto-fix change is a heterogeneous field-set replayed only as a unit, whereas every row here is the same fact — this unit moved from X to Y — and answers a standing question JSON cannot index. Its `unit_id` is polymorphic with **no foreign key**, which §4.7b argues against for live rows and which is right for this one: an FK would delete the record when its mapping is deleted, and a mapping being deleted is exactly the case you most want the record for. `label` is denormalised for the same reason — the row has to survive its subject, and a join cannot.

**A change may be opened on a timetable that is not frozen.** Freezing is what makes this *necessary*, not what makes it useful; a school that never freezes still has teachers resign, and the plan, the validation and the record are worth the same to them.

### 29.2a Four things carry "who teaches"

`staffing-units.ts` enumerates the vacancy, and a release covering only the first would leave a resigned teacher still running a merged group and still named as somebody's class teacher:

1. **mappings** — the ordinary case;
2. **merged groups** (§4.10) — one teacher, several sections at once, and **one occupancy event however many attend**, so its cells are deduplicated by day/period rather than counted per member;
3. **elective options** (§4.9) — the one that is easy to miss, because an option row carries `class_section_id = NULL` by design, so anything looking for a teacher's work *by section* finds none of it;
4. **class teacher** — not a lesson at all, which is why it has no cells, and exactly why it must be listed: it drives `always_first_period`, and it is the thing a school notices first.

Everything is scoped to the config throughout: a teacher may work in two wings, and releasing them from Primary must not silently vacate their Secondary classes. Only **published** rows are counted — draft rows belong to a working copy nobody is teaching from, and counting them would report a leaver as carrying lessons that do not exist.

Zero lessons means two different things and is never left to stand alone. A class-teacher role has none by nature; a mapping added since the last publish has none *yet*. Both still have to be reassigned, so the unit carries an explicit `unpublished` flag and the screen says which it is.

### 29.2b The assertion this step exists for

`scripts/staffing-smoke.cjs` (`pnpm test:staffing`) builds a school where one teacher holds all four kinds of unit, publishes and freezes it, then opens a change, reads everything the leaver carries, edits it twice and discards it — and requires that **the entire published week, every mapping, every merged group, every elective option and every class teacher are byte-identical afterwards**, by hashing them before and after. Step 2 writes no allocation at all, and that is the cheapest place to build the device §29.4 will use to prove "no other teacher's week moved".

### 29.3 The engine: who can take a class whose teacher has gone

**The plan for §29 said this module would reuse `SolverState.check()`. Building it made clear that would have been the wrong reuse**, and naming the difference is the whole design:

- `SolverState.check()` answers **"can this lesson go in this cell?"**
- This engine answers **"can this teacher take this lesson where it already is?"**

In a reassignment the cell does not move (§29.0). The class-section slot, the room, the subject, the period and the span are all unchanged by construction, so re-checking them re-derives facts that were true before anybody pressed anything — and forcing the question through `check()` would mean building a `SolverVariable` that lies about span, `dayKey`, `samePeriodKey` and the room pools, then discarding most of the answer.

So what is re-checked is exactly the **teacher-side** half, and it draws its data from the same places the solver does rather than deriving its own: `buildTeacherCtx` for §4.7a availability, the alternate-day set and the P1 rule; `effectiveMinByTeacher` for §20; `buildFeasibilitySnapshot` for caps, §18 scopes, §27.16 declarations and cross-config load. Deliberately **not** re-checked, because the cell is not moving: `uq_class_slot`, `uq_room_slot`, room availability, a subject's per-day cap, §4.6's same-period rule, §4.8 contiguity and §26.3's lunch rules.

**Hard filters**, every one of which produces a named reason rather than a silent rejection: §18 guest and teaching scope, §27.13 declared-or-mapped subjects, §27.16 subject classes, §4.7a availability, alternate-day, occupancy at *every* cell (three of four is a refusal — this is a permanent handover, not a day's cover), the daily and weekly caps, `max_consecutive_periods_per_day`, `alternate_period` as a hard rule (invariant 2), and the class-teacher P1 rule. Empty scope, empty subject list and empty subject-classes all mean "not stated" (invariant 7), never "nothing".

**Soft scoring**, in the order that matters: continuity by a wide margin (a class-section keeping a teacher it already has is worth more than every tie-break put together), then declared subject specialism, then *fractional* spare capacity — a raw count would always prefer the part-timer with the smallest cap simply because they teach fewest periods — then §20's week shape, which is **scored and never enforced**: refusing an otherwise legal assignment because it left a short day would trade a covered class for a tidier week, and completeness outranks shape.

**Two things that only show up across a whole week**, and are the reason a substitute lookup is not enough here:

1. **A teacher's week is mutated as the plan fills it.** Three units that each fit somebody alone will together break their weekly cap; scored independently all three would go to the same person.
2. **The hardest unit is settled first** — fewest legal candidates, then most periods — because a greedy pass in list order spends its only qualified teacher on an easy unit and then has nobody for the hard one. The assignments are re-sorted into the school's own order before returning, so the screen reads as the vacancy does rather than as the algorithm's queue.

**Replace** validates unit by unit rather than as a whole. A flat yes/no would be useless: what a school needs to hear is *"four of these five fit; Class 9-B Maths clashes with their Thursday P2"*.

`GET /staffing-changes/:id/plan?mode=replace|redistribute` is a **GET**, because it is a question — nothing written, nothing stashed, and asking twice answers against whatever the week says now. The mode is chosen by the caller rather than derived from `reason`: a school that hires one teacher for half a leaver's classes and spreads the rest is doing both, and guessing would take that choice away.

The one difficult thing in the API layer is that **the occupancy handed to the engine must be the published week with the released units already taken out**, and it is subtracted **by slot id**, never by teacher: a change that releases only part of somebody's work would otherwise free lessons they are still teaching. Merged-group rows are deduplicated to one occupancy event per cell (§4.10), or a group's teacher looks doubly busy at the same period.

### 29.3a Redistribute: the ejection pass, and how it was justified

Hardest-first ordering — fewest legal candidates, then most periods — turns out to be strong. Every case I could *construct* by hand for the depth-1 ejection pass the plan called for was already handled by the ordering, which is a good sign about the ordering and a bad sign about shipping the pass on faith.

So it was justified by search instead: a random sweep over 4,000 small instances (3 teachers, 2–5 units, random cells and random subject competence) had the pass fire **58 times** — about 1.5%. One of those cases is now a deterministic unit test, and it is worth reading because it shows exactly what the ordering cannot see:

> Three units all wanting Wed P3. Teacher A teaches all three subjects, B teaches two of them, C only one. Every unit therefore has exactly **two** legal candidates, so hardest-first cannot separate them and falls back to "most cells first" — which hands the two-cell unit to A. B then takes the second, and the third has nobody: A and B are both standing in Wed P3. The pass takes the two-cell unit back off A, sees that C can hold it, and gives Wed P3 to the third.

The count of legal candidates is a **prediction made before anything is assigned**, and it only ever goes stale downward. The pass is where the plan gets a second look at the cases the prediction missed.

**Depth 1, deliberately.** Chaining turns a bounded pass into a search, and the failure mode of a search here is not a worse plan but a slow screen. **Both halves must succeed** — the displaced unit finds a new home *and* the stuck one becomes legal — or a rescue would swap one uncovered class for another and report progress. And it may only move units **this plan gave somebody**: the school's standing week is not ours to rearrange, and moving it would be §29.0's promise broken from the inside.

A 500-instance property sweep (deterministic xorshift seed, so a failure reproduces) asserts the three things a post-hoc rearrangement is most likely to break: no teacher is given two units in the same cell, no teacher ends over their weekly cap, and every uncovered unit has candidates that all failed *with reasons* — an unexplained vacancy is the one outcome §4's "tell me what to fix" promise cannot survive.

### 29.3b The load report, and moving only part of a teacher's work

**`loads` carries a §28.1 `alert` flag**, measured against the teacher's **whole** week rather than this timetable's share of it: somebody at 20 of 30 here and 6 in another wing is at 87%, and a line drawn round one wing would say 67% and be comfortably wrong. It is a warning and never a refusal — exactly Check 12's rule — while going *over* the cap is a refusal that names the limit. What a school is really deciding here is whose week gets heavier and by how much, so the report sits above the assignment table rather than under it.

**`units=` narrows the release.** A resignation moves everything a teacher holds; an **adjustment** moves what somebody picks, and without a subset filter the two reasons would differ only in the word printed on the record. A key naming something not in the release is ignored rather than refused — the list comes from a screen that may be a moment out of date — but a selection that matches *nothing* is refused, because silently planning the whole release when somebody asked for one piece of it is the worst of both.

**An uncovered unit lists every candidate's reason, not the best one's.** The single-best version read as one person's problem and sent people to fix the wrong thing; *"Rekha is busy Thursday P2 · Anil does not teach Maths · Priya would be over 30 a week"* is three different remedies, and only one of them is usually worth doing.

### 29.4 Applying it

The one place in §29 that touches a published week. Three rules shape all of it.

**1. The plan is recomputed server-side, never taken from the request.** The same rule §21's auto-resolve follows: a preview an admin held for five minutes is not what is true now, and it is never the list of writes. The request carries the *choice* — replace or redistribute, who, which units, whether gaps are accepted — and the server works out the consequences again from the live database.

**2. Slots are UPDATED in place, never deleted and recreated.** `substitution_log` points at slot ids with no foreign key (the fact that made §3.14's withdraw *flip* rows rather than copy them), so recreating would orphan every recorded cover. It also means the three unique keys are never transited through a bad state: the class and the room are not moving, so only `teacher_occupancy_key` changes, and it changes to a cell the engine has already proved free.

**3. The carrier moves too, not only the lessons.** A mapping, a merged group, an elective option or a class-teacher pointer is what the next Generate reads. Move the lessons and leave the mapping, and the leaver is quietly back the first time anybody presses Generate, with nothing to connect the two events.

**Every write is compare-and-set**, scoped by `teacherId: from` as well as by the unit. That single extra predicate is what makes apply safe against a week that has moved since the preview: a row somebody else has already changed is simply not matched, rather than being overwritten with an answer computed from a school that no longer exists.

**A gap is chosen, never discovered.** Apply refuses while anything is uncovered unless `acceptGaps` is explicitly true, and the refusal names what it is refusing over. Refusing outright would be safer and is wrong — a school losing a teacher mid-term may genuinely have no cover for one class and still needs the other nine moved today.

**An accepted gap leaves its unit exactly as it is**, and records an item with no destination. Not nulled: nulling the slots would destroy the only surviving statement of what that class needs, and §29.0's promise is that nothing is damaged to make a change look complete. The record says "this one did not move", and the school deals with it deliberately.

Applying twice is refused, and an applied change can no longer be edited or discarded — a record that can be rewritten afterwards is not one (§3.14's rule for a withdrawn publication). The teachers who *gained* classes are notified; the leaver deliberately is not, and a notification that cannot be delivered never rolls back a timetable that has already been written.

### 29.5 Putting it back

Built from `staffing_change_items`, not by re-planning: a revert is not a decision, it is the reversal of a recorded one. Every write is **compare-and-set on what the change actually did** — a carrier that no longer points at the teacher this change gave it to has been moved again by somebody else, and quietly overwriting that would make revert a way of losing work rather than of undoing it. Those units are **skipped and named**: *"Class 5-A Maths has been moved again since"* is the sentence that tells somebody where to look; "3 could not be put back" is a number nobody can act on.

The change row is **kept and marked `reverted`**, with `applied_at` still on it, and its items are kept — §3.14's rule again: deleting it would rewrite the school's own record of what happened.

### 29.6 The proof

`pnpm test:staffing` — 68 assertions. The four that are the design:

1. **Every other teacher's published week is byte-identical** after a real apply (sha256 over every row not belonging to the two teachers in the change).
2. **No cell moved at all** — same rows, same class-section, same period, same room, compared field by field before and after. That is §29.0 reassign-don't-regenerate, verified rather than asserted.
3. **The same slot ids changed hands** (16 of 16), so nothing recorded against them is orphaned.
4. **All four carriers moved** — mappings, merged group, elective option and class-teacher — and the leaver's work in the *other* wing is untouched.

Then the round trip: after revert, the whole published week hashes identical to before the change. And with `acceptGaps`, one unit moves, four are recorded with no destination, and the uncovered lessons keep their teacher rather than being emptied.

### 29.7 A regression worth remembering: the colours that vanished

Reported as *"subject colours are not displaying, earlier it was working"* — and every part of the feature was working. `/me/colors` returned the right names, the palette assigned them, the grid read them.

`colors.tsx` exported the React context **and** the provider component from one module. React Fast Refresh preserves a module's state only when it exports components and nothing else, so Vite could not fast-refresh that file and **invalidated** it instead — which it does whenever anything it imports changes, `hooks.ts` most of all. Each invalidation re-evaluated the module and minted a **new** `createContext` object, while grids that had not been re-evaluated went on reading the old one. `useContext` then found no matching provider and returned the default — which for colours is *"no colour at all"*, so every cell quietly went white with nothing anywhere reporting an error.

The fix is the split: `colors-context.ts` (no JSX, therefore not a Fast Refresh boundary) owns the context, the hook and `classOfLabel`; `colors.tsx` exports only `ColorProvider`. Confirmed at the mechanism level — the dev server now reports `hmr update /src/colors.tsx` where it used to report `hmr invalidate`.

**The general lesson is about the default, not about Vite.** A context whose default means "switched off" fails silently by construction: a consumer that has lost its provider is indistinguishable from a feature nobody turned on. Colour genuinely is optional here (§10.5: a role that cannot read the lists gets none, and the grid still works), so a throwing default would be wrong — which makes the module boundary the only place left to get it right. Vite's own warnings say the same thing about several other files in this app ("Could not Fast Refresh — `inputStyle` export is incompatible"); none of the others hold a context, which is why this one is the only one that has bitten.

### 8.5 The masters edit beside the list, not below it

Reported as *"for every edit I have to scroll down; everything should be visible on the first screen"* — and the reasoning was already written down. §8.1c made exactly this observation for the manual Curriculum step: *"at 14 classes × 8 subjects a form below the table means pressing Edit scrolls the row off the screen."* It drew the right conclusion there and edited in the row; it simply never reached Subjects, Class-Sections, Rooms or Academic Years, which kept the table-then-form arrangement that only works while the table is short.

The symptom is precise: pressing Edit scrolled the form into view and the row **out** of it, so while you typed you could no longer see the thing you were editing.

In-row editing is not available here — a subject has eight fields, a room five — so the answer is the other half of the same idea: **put the form where scrolling cannot take it away.** Two columns, each scrolling inside itself, and the page never scrolls at all. The list is always on screen; so is the form.

**One component, not four.** `masters/MasterPane.tsx` owns the shape. The four masters had four copies of the same arrangement, which is why the fix had to be made four times over and why it will not drift now that it is made once. The list takes the remaining width and the form is a fixed 340px, rather than a percentage split: a form's width is set by its widest control and gains nothing from more room, while a six-column table always does.

**The form's heading is the state indicator** — "Editing Class 5-A" against "Add a class-section". Before this, *am I adding or editing?* was answered only by the label on a button that was usually below the fold, which is how somebody renames a class they meant to create.

Three screens needed more than a re-layout:

- **Classes** was two stacked cards, and the second — class-sections — was the one that matters, because it is where *"belongs to no timetable"* is visible at all. Class-sections became the list (they are the scheduling unit, §3.10) and classes moved into the form column, where a school touches them once a year. Class-sections keep editing **in the row**, as they already did: three fields fit, and it means the row being changed never moves.
- **Academic Years** opened its §25 term calendar *below* the table, which put a three-term editor between the list and the form and created the very scroll being removed. It opens in the form column, beside the session it belongs to.
- **Lessons** (the read-only curriculum) was stacked under the class-sections table, which guaranteed a page scrollbar however the panes above were arranged. It is a toggle in the tab bar now — a second view of the same tab.

**Teachers is deliberately untouched**: it already swaps the whole pane for its form, so it never had the problem.

Two implementation notes worth keeping:

- **`DataTable` wraps its table in an `overflow-x: auto` div**, and that div is what a sticky header sticks to — a container with no height of its own, which never scrolls vertically, so the header would never have stuck. The scrolling is handed to the pane instead (`.master-scroll > div { overflow: visible }`), which makes both axes work in one place.
- **Below 1080px the panes stack and the page scrolls again.** That is the honest cost of the width: a 340px form squeezed beside a six-column table is unreadable in a different way.

### 30.12 A Class Taught by Two Pools Is Still One Curriculum (Phase 47)

Pressing **Save** on the Master Grid's Lesson Grid refused with *"There are still 322 error(s) — nothing was written. Run the preview to see them."* Every one of the 322 was a duplicate row:

| count | sheet | message |
|---|---|---|
| 209 | Subject Mapping | This Subject + Class-Section is already on row N |
| 89 | Curriculum | This Class + Subject + Year is already on row N |
| 24 | Class Teachers | This Class-Section is already on row N |

The refusal was **right**, and it is the only reason nothing was corrupted.

Since §30.9, two wings in different §30 resource pools may legitimately both run Class 1 — a main wing and an individual timetable teaching the same grade. `planClasses` therefore returns one entry per *wing* per class, and everything built by walking that list emitted each shared class twice. But `class_subjects` is keyed `(class_id, subject_id, academic_year_id)` with **no pool column** — CLAUDE.md states the curriculum is deliberately shared across pools — so the second copy is not a second row, it is the same row again. The §16 importer refuses a sheet holding two rows on one natural key, and did.

The 24 class-teacher duplicates are the cleanest confirmation of the diagnosis: exactly 6 shared classes × 4 sections.

**`dedupeCurriculumCells` is the rule, and the tighter row wins.** A shared row must fit the *narrowest* week that teaches the class; keeping the larger one would propose a curriculum that cannot fit one of its own wings, and Readiness would report it against a wing nobody was editing.

**Deduplicated in two places, deliberately.** `suggestCurriculum` and `suggestMappings` fix what the *screen* shows — the Master Grid was counting 1,168 allocated periods where the school has 846, and the Load column compared a doubled total against one week's capacity. `curriculumSheets` and `mappingSheets` fix what the *commit* writes, and that gate is the one that always runs: a school that has edited the grid commits from `answers.curriculum` and `answers.mappings`, which never pass through the suggester at all.

**Not fixed in `planClasses`.** A class taught by two wings in two pools is real, and step 4 needs both entries to create both pools' cohort rows (§30.9). What is not real is two curricula.

**A known limitation, stated rather than hidden.** A class-section *label* is not unique across pools — "Class 1-A" names one row in the main wing and a different one in an individual timetable — and neither the Subject Mapping nor the Class Teachers sheet carries a timetable column, so the importer resolves a label to whichever row it finds (`sections` is a `Map<label, id>`). Deduplicating by label is therefore correct for the sheet as it exists today, and it is also why an individual timetable cannot yet be given its own mappings through the guided setup. Giving the curriculum and its mappings a pool dimension is the schema change CLAUDE.md already records as outstanding.

`pnpm test:pools` drives the real step-9 preview **and commit** over a class taught by two pools, because the failure was in what the server builds out of a stored draft — the layer a pure-function test cannot reach.

### 30.13 One Timetable Selector, and One Timetable at a Time (Phase 48)

The guided setup's Subjects step carried **three** controls answering one question: the app's top-bar *Viewing timetable* selector, a **"Setting up"** dropdown choosing the §30 pool (§30.9), and a **"Teaching"** wing tab strip choosing the wing within that pool (§32.3). Two of them inside the page, one above it, and nothing on the screen said which the step was obeying.

**The top bar's selector is the one that stays.** It is the control that already exists on every other screen, so it is the one people reach for by memory — the same argument §31.14 made for docking the assistant's launcher there.

Two halves, and the second is what removes the strips:

- **`scope` is derived from the top bar, not stored.** `allWings` carries `individual`, stamped from the database on every read by `stampPools`, so the selected timetable's *name* identifies its pool completely. Switching the bar clears the error banner and the praise line, which are about the timetable that produced them (§30.10).
- **Every step is handed exactly one wing.** Pool narrowing alone was not enough — a grouped pool holds several wings, so step 4 still drew a tab strip and step 6 drew another. Each already renders its strip only when `wings.length > 1`, so handing them one wing removes both by construction rather than by deleting markup.

**Step 3 is the exception and has to be.** It is the screen that *creates* wings and lists the ones that exist; narrowed to one it could never add a second.

**The fallback is not a nicety.** On a brand-new school nothing is selected, because no `timetable_config` exists until step 5 creates them — so `activeWing` is null and the old whole-pool behaviour applies, which is the only behaviour that can work when there is nothing to select. Step 3 therefore calls `refetch()` after `commitWings`, or a school walks 1 → 2 → 3, creates its wings, and arrives at step 4 with an empty selector.

§3.10a's *New Timetable* now points the **top bar** at the wing it created rather than a scope of its own, so "open the setup on this wing" and "show this wing in the bar" are one action instead of two that can disagree.

#### The bug this nearly shipped with

`mergeWings` puts a step's edited wing list back into the stored draft, which must keep every wing. It matched on the **§30 pool** — correct only while a step saw every wing in its pool. Once it saw one, a grouped pool holding Main and New matched *both* rows, took the single incoming wing for the first and `undefined` for the second, and `if (take)` then dropped New out of the draft entirely: **a silent deletion of a timetable on any save by a school with two grouped wings.**

It now merges against the wings the step was **shown**, by reference — `wingsInScope` is a `filter`/`find` over `allWings`, so the objects are the same ones, and the match stays *positional* because a rename is exactly what a step comes back with and the name is the key everything else in this flow uses.

It moved to `packages/shared` as `mergeShownWings` for one reason: `apps/web` has no test harness, and this function can lose a school's timetable. Six unit tests cover it, the first being the deletion above.

## 32. A Timetable Teaches the Subjects It Declares (Phase 46)

`subjects` is school-wide, and until now there was no way to narrow it: every timetable saw every subject the school had ever entered. A Junior wing that does not teach Chemistry, an individual timetable set up for a handful of languages, a subject added for one wing only — none of them were expressible.

The guided setup's Subjects step offered a red **✕** that looked like the answer and was not. It removed the row from the *draft*; the §16 importer creates subjects and never deletes one, so the subject stayed in the database, kept its curriculum and its mappings, and went on being taught by a timetable that had stopped listing it. That is the §3.10b shape exactly — a control that appears destructive, cannot destroy anything, and leaves the screen disagreeing with the school.

**`timetable_subjects` is a declaration per `timetable_config`**, and **empty means "not stated", never "teaches nothing"** (invariant 7). That is what makes the migration a bare `CREATE TABLE` with no backfill: every timetable that exists today has no rows and keeps seeing every subject, which is what it sees now.

**Per config, deliberately not per §30 pool.** Two grouped wings share a resource pool and are precisely the case that motivates this — Junior and Senior are one pool and teach different subjects, and a pool-level answer could not say so. An individual timetable gets its own list for free, since its pool holds exactly one timetable.

**Selection only.** A subject's code, category, priority, placement, lab flag, own-room flag and double-period flag remain one answer per subject, school-wide: they describe the subject, not the week. A subject that is a lab is a lab in every timetable that teaches it.

### 32.1 Where it is enforced, and the half that is easy to miss

In **`buildFeasibilitySnapshot`**, because that snapshot is what the solver, the Feasibility Engine, Readiness, `/context` and the Master Grid's strip all read — filtering anywhere else would be a second answer to "does this timetable teach Chemistry?", free to disagree with the first.

It is applied to **demand**, not to the subject list. A subject this timetable does not teach simply has none: the solver never sees it, Check 1 never counts its periods, Readiness never reports it missing. The rows themselves are untouched, because another timetable may teach the same class the same subject, and deselecting is not a deletion.

**Four carriers of demand, not one.** Filtering `class_subjects` alone looked complete — `/context` dropped the column and Readiness dropped the periods — and **generation went on placing the subject anyway**. `solver/variables.ts` builds one variable per **mapping** and takes the period count from `m.periodsPerWeek`; the curriculum row only supplies the block size and the per-day cap. So the filter covers the curriculum, the **mappings**, the §4.10 **merged groups** (which carry their own `periodsPerWeek`) and the §4.9 **elective options** — filtered at the option, so a language block whose school has taken German out of one wing still runs with French and Sanskrit, while a block left with no options is dropped rather than emitted empty for the solver to fail on.

### 32.2 "All of them" is stored as nothing

A timetable that teaches every subject is describable two ways — every subject listed, or nothing listed — and the two are indistinguishable today. They differ tomorrow: a subject added later through the Subjects master, an Excel upload or the §13.5 assistant belongs to a timetable that stated nothing, and belongs to no timetable that listed every subject it had at the time. So "all" is stored as the absence, and the table records **narrowing** rather than restating the subject list once per timetable.

The consequence worth knowing: once a timetable **has** narrowed, a subject added by another door is not in it until somebody ticks it. That is the honest behaviour — the school said "these subjects" — and it is why the step lists every subject the school has rather than only the draft's.

### 32.3 The screen

The Subjects step gains a **tick column in front of the subject**, and the same wing tab strip step 4 uses: "which subjects does the school teach" is one question, but "which of them does *this* week run" is one question per wing, and the wizard's own scope switcher narrows §30 pools rather than wings.

Unticking the **last** subject is refused, for the reason §27.9 and §27.16 refuse the same move: `[]` reads back as "not stated" and therefore as *all*, so taking one away and getting everything back is the one behaviour nobody would predict.

**A subject that is already a `subjects` row has no ✕.** Deselecting is the honest control; deletion belongs on the Subjects master. A row somebody has just typed is still theirs to take back. The committed set is read from the server rather than derived from the draft, because a resumed or adopted setup has subjects in its answers that were committed long ago and a draft cannot tell you which — empty on failure, so nothing is removable, which is the safe direction to be wrong in.

The step is also now in **`WIDE_STEPS`**, which it should always have been: its table is ten columns and an 880px measure clipped "Scholastic" to "Schola" and "CHEM" to "CHEN" while carrying several hundred pixels of empty gutter on each side. A measure is for prose; this is a spreadsheet.

**Deliberately not freeze-guarded** (§29.1). That section's "not frozen" list already names subjects, and this writes no slot: a frozen timetable's published week is untouched. What it changes is what the *next* generation would produce, which is what editing the curriculum does too.

`pnpm test:subjects` is the proof, and its load-bearing assertion is a real generation: 8 lessons across 2 subjects where an unfiltered run gives 16 across 4.


## 33. A Longer Lesson Is a Double Period (Phase 49)

A school asked for **Class 1 on eight 30-minute periods and Class 10 on four 60-minute periods, same start time and same finish.** §28.5 refuses per-class period durations, so the first answer was no — and it was the wrong answer, because this case is not the one §28.5 is about.

§28.5's example is **30 against 40**. Those do not line up, so "period 3" means two different windows, `uq_teacher_slot` compares period *numbers*, and a teacher overlapping from 09:00 to 09:20 is invisible to it. The database guard inverts: it accepts real collisions and refuses legal placements.

**60 is exactly two 30s.** Nothing is unaligned. There is one grid of eight 30-minute periods, and Class 10's hour is a lesson that occupies two of them — which is a **double period**, placed atomically since the solver was written (invariant 10).

The load-bearing fact is in `apps/api/src/solver/writer.ts`: a placement of span N emits **N slot rows, one per period number**. So Class 10's 08:00–09:00 hour holds period 1 *and* period 2, and a teacher who also has Class 1's 08:30–09:00 lesson collides on period 2 and is refused. Nothing is switched off — and this is **stricter than the §30 wings route**, where the same collision across two wings is only a §30.7 warning.

`pnpm test:periods` asserts that against MySQL directly rather than by trusting the solver not to try: it takes a generated hour and attempts the colliding insert.

### 33.1 The model

`timetable_class_spans (timetable_config_id, class_id, span)`.

- **A span in base periods, not minutes.** The solver wants a block size; storing minutes would mean re-deriving it at every call site and going stale whenever the config's own duration changed underneath. Minutes are what the *screen* shows — `span × period_duration_mins` — so changing the base from 30 to 35 moves every class proportionally, which is what a school means by "make the periods longer".
- **Keyed by `(config, class)`**, because the base duration belongs to the config (§28) and §30.9 lets one class sit in two pools with different bases.
- **Empty means "not stated", never span 0** (invariant 7), which is what makes the migration a bare `CREATE TABLE`: every class in every school today keeps span 1. Setting a span back to 1 **deletes the row** — "not stated" and "one base period" are the same answer, so the table records only what was changed.

### 33.2 A floor, never a multiplier

The span reaches the solver in `buildFeasibilitySnapshot`, as `Math.max(row.consecutiveBlockSize, span)`.

`max`, not "override": a class on 60-minute lessons whose Science is a double *lab* wants two hours, and the curriculum row already says 2 in base periods. Taking the larger keeps both statements true.

And deliberately **not multiplied**. A curriculum row's block size is already in base periods — it is what `writer.ts` counts — so multiplying would turn a school's existing double period into a quadruple the first time anybody set a class span.

### 33.3 The screen

**It lives behind a link beside the period-duration field, not in a section under it.** A table under the week's own form was wrong twice over: most schools run one length for everybody, so per-class lengths are the *exception* rather than the setting, and the table pushed the weekly-capacity note — which every school reads — below the fold. The link carries its own summary ("2 classes differ" rather than a bare "Per class…"), because a control that never says whether there is anything behind it teaches nothing; the summary and the dialog are **one fetch**, so they cannot disagree about the number sitting next to them. It appears only once the wing *is* a timetable and teaches somebody — before step 5 there is no config to hold the answer, and a link to an empty dialog is worse than no link.

The form offers **lengths, never a free number**: the server sends every whole multiple of the base that fits the day, so a length that does not divide the grid is not a value the screen can produce. The divisibility rule has one author and there is no invalid state to validate against.

Where a span does not divide the day evenly, the leftover is **reported beside the number rather than refused** — it is a real state while somebody is mid-edit, and they may be about to change the period count next.

**When school closes is read off the `periods` rows, never recomputed.** `start + periods × duration + breaks + activities` is the arithmetic, and every term is already a row with a real end time; adding them up again would be a second answer free to disagree with the grid on screen — and it would get §28.4 wrong, where an activity before the first period makes the day start *earlier* rather than pushing period 1 later. The §18 extra window is excluded, the same exclusion the Matrix's fill rate makes.

The Timetable step joins `WIDE_STEPS` for this: it now carries a class-wise table, which is a grid by any reading.

### 33.4 The limit, and when to use wings instead

This works whenever every period length is a whole multiple of the shortest. 30/60 needs an 8-column grid; 30/45 needs a 15-minute base and 16 columns; **30/40 needs a 10-minute base and 24 columns before breaks**, at which point the §30 wings route is the better answer and §28.5 stands unchanged.

The question to ask a school is therefore *"is every period length a multiple of the shortest one?"* — not *"do your classes have different period lengths?"*

### 33.5 The week on one screen

The Timetable step was a single column of full-width sections — working days, then four numbers, then breaks, then a three-line note, then the activities, and finally, below the fold, the weekly-capacity readout that every one of those inputs exists to produce. Three problems, and the third is the one that mattered:

1. **The measure was the whole pane.** §33 put this step in `WIDE_STEPS`, so a single column left half the screen empty while making the page twice as tall.
2. **Every field cost two lines.** A block label over a 150px input is right for a form of prose fields and wrong for four numbers that read as one sentence — *"eight forties from eight o'clock"* was eight rows.
3. **The answer was last.** "40 periods a week" is what somebody is on this screen to decide, and it sat under everything, so the number moved while nobody was looking at it.

The shape of the day on the left, the things inside it on the right, and the readout in a strip at the **top**, beside the controls that change it. Nothing was removed: the same five inputs, the same breaks, the same activities.

The strip also carries **when school closes** — `dayEndsAt` in `packages/shared`, and it is deliberately a *second* function rather than a reuse of what `GET /:id/class-periods` returns. They answer different questions: the endpoint reads the `periods` rows, which is the authority for a timetable that exists and which gets §28.4 right; this answers *"what will this be when I press Next?"*, where no rows exist yet and arithmetic is the only answer available. Collapsing them would mean either showing a stale figure from the last save while somebody types, or the server recomputing what it can already read. It returns **null** rather than a confident wrong answer for a half-typed time, and refuses to wrap past midnight into a plausible-looking morning.

### 33.6 Still to build

- **Entering the curriculum in lessons rather than base periods.** A class on 60-minute lessons that takes 3 English a week needs `periods_per_week = 6`; typing 6 today means six base periods, which is three hours. Until the translation exists, the number entered is in base periods.
- **An odd count cannot be all doubles.** 5 base periods at span 2 is two doubles and one leftover single — a correct timetable for the data given, but not what the school meant. It should be reported.
- **Printing a class's week as 4 rows, not 8.** The data is adjacent identical pairs; collapsing them is display-only work.
