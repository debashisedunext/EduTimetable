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

-- which subject applies to which class (curriculum)
CREATE TABLE class_subjects (
  id INT PRIMARY KEY AUTO_INCREMENT,
  class_id INT NOT NULL REFERENCES classes(id),
  subject_id INT NOT NULL REFERENCES subjects(id),
  periods_per_week INT NOT NULL,        -- e.g. English = 6 periods/week
  max_periods_per_day INT DEFAULT 1,    -- prevents same subject twice same day unless intended
  same_period_across_week BOOLEAN DEFAULT FALSE,  -- "same subject same period every day" rule
  UNIQUE KEY uq_class_subject (class_id, subject_id)
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

**Cross-wing teachers:** a teacher who teaches in more than one timetable (e.g. a Class 2 art teacher who also covers Class 6 art) is mapped via `teacher_subject_class_section` rows that point at class-sections in *different* `timetable_config`s — this is allowed by design (the table has no config-scoping of its own). The Feasibility Engine's Check 2 (§4.2) sums that teacher's `periods_per_week` **across every timetable_config they appear in**, not per-config in isolation, so a teacher can never be silently over-loaded just because the overload is split across two wings' configs. The Readiness Dashboard for either wing surfaces the same blocker, with a note naming the other timetable involved.

**Solver scope:** Phase B (§5) solves one `timetable_config` at a time — its variable set is exactly the class-sections scoped to that config — so Middle Wing can be regenerated, edited, and published independently of Senior Wing without touching its slots. `timetable_slots.timetable_config_id` (already the leading column in every unique key in §3) is what makes this safe: two configs' slots never collide in the uniqueness checks even if, coincidentally, they'd otherwise land on the same `(day, period)` — because their teachers, rooms, and class-sections are typically disjoint by wing, and where they aren't (the cross-wing teacher case above), the load-sum check in §4.2 is what catches it, not the slot-uniqueness constraint.

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

`GET /me` carries the active school, the switchable list and the trust, so the top bar names the school and shows a switcher only when there is more than one.

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

### 17.6 Verification


`scripts/migrate-all-smoke.cjs` proves the migration loop end to end: it provisions a real dedicated school, genuinely rolls its database back one migration — dropping the columns, not just the bookkeeping row — then asserts the dry run names the school and the pending migration, that signing in is **refused** rather than half-working until it reaches the new column, that `migrate:all` repairs it and stamps the registry, that the school then works, and that the shared database was migrated once rather than once per school.

`scripts/dedicated-tenant-smoke.cjs` proves connection routing against a real second database, built around the school-id collision described above: the session lands in the tenant's database, its user row and every write land there and nowhere else, neither school can see the other despite sharing a local id, a session cannot switch into an ungranted tenant, and the connection budget is reported.

`scripts/sso-schools-smoke.cjs` proves the ERP owns school identity end to end: a school named on the token is created with that name and immediately usable, the same code with a new name renames it rather than duplicating, a trust token provisions every school it lists and groups them under the trust, the user switches between them and lands in the right one with that school's role, an ungranted school is refused, and a timetable created after switching belongs to the new school and is invisible from the other.

`scripts/control-plane-smoke.cjs` asserts the schools table is populated, all 30 foreign keys exist, a row naming a nonexistent school is refused by the database, every school is registered as a tenant, a shared tenant stores no credentials, a suspended school cannot sign in and a reinstated one can, and the control plane is unreachable from the application API.

`scripts/tenant-isolation.cjs` stands up a real second school against the live stack and attempts, from School B's session, every cross-school read, edit, delete, reference and nested-write laundering; asserts B's own writes land stamped as B's on parent and child tables; runs a real solver generation for B and checks every slot it wrote; and asserts School A is **byte-identical** afterwards. `scripts/tenant-socket-check.cjs` connects one client per school and asserts B's socket receives nothing when A acts. `school-scope.spec.ts` unit-pins the extension's reasoning.
