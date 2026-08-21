# EduTimetable — Detailed Implementation Task Plan

Sequential task breakdown for all phases. Section references (§) point to `AI-Timetable-System-Architecture.md`. Each phase lists its tasks in execution order — a task assumes everything above it is done. Durations assume 2–3 developers (1 backend-lead, 1 frontend, 1 full-stack) and are calendar estimates, not effort totals.

**Total timeline: ~26–30 weeks** (Phases 0–5 + 7 core = ~24 wks; Phase 6 optional).

```
Phase 0 ──▶ Phase 1 ──▶ Phase 2 ──▶ Phase 3 ──▶ Phase 4 ──▶ Phase 5 ──▶ Phase 7
(2 wk)     (6 wk)      (5 wk)      (4 wk)      (3 wk)      (4 wk)      (4 wk)
                                                            Phase 6 (optional, 3 wk,
                                                            any time after Phase 2)
```

---

## Phase 0 — Project Foundation (2 weeks)

> **Status: ✅ complete** (branch `phase0/foundation`). Ports note: host api **3001** / web **5174**.

**Objective:** A running skeleton with auth, database, and CI so every later phase ships into a working app.
**Dependencies:** none.

> **Docker-only rule (applies to every phase):** the application is developed, tested, and deployed exclusively inside Docker. No Node/MySQL/Redis on the host — every command in this plan (`pnpm install`, migrations, tests, lint) runs as `docker compose exec <service> …`. Dev and prod share the same multi-stage images; dev adds bind mounts + hot reload. A change that only works outside Docker is broken by definition.

| # | Task | Detail | Deliverable |
|---|------|--------|-------------|
| 0.1 | Docker environment (first task, before any code) | `docker-compose.yml` + `docker-compose.dev.yml` defining `api`, `web`, `worker`, `mysql` (MySQL 8), `redis`; multi-stage Dockerfiles for api/web/worker (dev target: bind mounts + hot reload; prod target: built artifacts); named volumes for MySQL/Redis data; healthchecks; `.env.example`; service-name hosts (`mysql`, `redis`) wired via compose env — never `localhost` in app code | `docker compose up` boots the full (still empty) stack |
| 0.2 | Repo & monorepo scaffold | pnpm workspace: `apps/api` (NestJS + TypeScript), `apps/web` (React + Vite + TS + TailwindCSS), `packages/shared` (types, constraint interfaces shared by solver/validation/UI) — installed and run inside the containers from 0.1 | Repo builds, lints, and hot-reloads inside Docker |
| 0.3 | Database & migrations setup | Migration tool (Prisma or TypeORM migrations) running via `docker compose exec api pnpm migrate` against the `mysql` service. Create `schools`, `users`, `roles`, `role_permissions` (§13.3) and seed roles: Super Admin, Principal, Timetable Admin, Teacher, Front Office | `migrate` + `seed` scripts (containerized) |
| 0.4 | Edunext SSO + AuthZ layer (§15) | **No local login.** `/sso/callback` verifying the ERP's short-lived RS256 token (signature, exp, single-use nonce in Redis), sync-on-login user provisioning (`users`, `erp_role_mappings`), app session JWT (REST + Socket.IO handshake), invalid-token → "return to ERP" page. Permission guard middleware (`@RequirePermission('...')`) + the **query-layer scope filter module** (`view.own/.class/.all` → row filters) used by every module from day one | SSO round-trip from a stubbed ERP token works; guarded route rejects missing permission; scope filter unit-tested |
| 0.5 | Infra plumbing | BullMQ wiring against the `redis` service, Socket.IO gateway with auth handshake, config/env management, structured logging | Health-check endpoint green; sample job round-trips through the queue between the `api` and `worker` containers |
| 0.6 | App shell UI | Sidebar + topbar + screen routing per the mockup design system (fonts, palette, CSS tokens from `timetable-ui-mockup.html`), role-aware nav rendering | Empty shell served from the `web` container with all nav groups |
| 0.7 | CI/CD | CI builds the same Docker images, then runs lint, typecheck, unit tests, and migration check **inside them**; staging deploys those images | Pipeline green on main |

**Exit criteria:** on a clean machine with only Docker installed, `docker compose up` brings up the entire stack; a logged-in user with a role sees the app shell; a queued dummy job streams progress to the browser over Socket.IO; CI runs the full suite in the same images.

---

## Phase 1 — Masters, Config & Feasibility Engine (6 weeks)

> **Status: ✅ complete** (branch `phase1/masters-feasibility`). Deferred: teacher-unavailability entry UI (API exists), elective-block setup screen (schema exists).

**Objective:** All master-data entry + the live Readiness Score (§4) — the product feels intelligent before any solver exists.
**Dependencies:** Phase 0.

### 1A — Schema & Master CRUD (weeks 1–2)

| # | Task | Detail |
|---|------|--------|
| 1.1 | Core schema migration | All §3 tables: `academic_years`, `classes`, `sections`, `class_sections`, `rooms`, `subjects`, `teachers`, `teacher_unavailability`, `class_subjects`, `teacher_subject_class_section`, `timetable_config`, `periods`, `holidays` — plus §3.10 columns (`description`, `start_time`, `end_time`, `class_sections.timetable_config_id`) and §4.7/§4.8 columns (`class_teacher_period_rule`, `period_pattern`, `alternate_day_set`, `consecutive_block_size`, `consecutive_blocks_per_week`) |
| 1.2 | Merged/split group schema | §4.9: `merged_teaching_groups`, `merged_teaching_group_members`, `elective_blocks`, `elective_block_members`, `elective_options` |
| 1.3 | Config Service (API) | CRUD endpoints for every master, with validation (e.g., `consecutive_block_size × blocks_per_week ≤ periods_per_week` at entry). Every write emits a `masters.changed` event (feeds 1.10) |
| 1.4 | Timetables landing screen | Screen 0 (§8.1): list of `timetable_config`s with classes covered, timings, status; "+ New Timetable", "Edit" |
| 1.5 | Setup Wizard shell + steps 1–4 | Stepper UI; Academic Year → Classes/Sections → Rooms → Subjects screens (list-first, form-second pattern) |

### 1B — Mappings & Timetable Configuration (weeks 3–4)

| # | Task | Detail |
|---|------|--------|
| 1.6 | Curriculum mapping step | `class_subjects` grid with periods/week, max/day, same-period-across-week, consecutive-block fields (§4.8) |
| 1.7 | Teacher Directory + form | §8.1a: directory table (load vs. capacity live), Add/Edit form incl. §4.7 placement rules with the alternate-day day-set picker |
| 1.8 | Teacher Mapping step | §8.1b: Class-Teacher Assignments table (writes `class_sections.class_teacher_id`) + Subject Mapping list/form incl. merged-group checkbox and elective-block setup. **Bulk add:** the form takes one teacher + one subject + a multi-select of class-sections, and one Add creates a mapping row per selected section (duplicates skipped and reported) — no section-by-section re-entry |
| 1.9 | Timetable Configuration step | Name/description/classes-covered (class-picker disables sections claimed by another config, §3.10), working days, periods, breaks builder, zero period, server-computed period times + end time |

### 1C — Feasibility Engine (weeks 4–6) — the core of this phase

| # | Task | Detail |
|---|------|--------|
| 1.10 | Feasibility engine service | Pure, unit-testable TypeScript module in `packages/shared`. Implement the six checks in order: **Check 1** slot capacity (§4.1) → **Check 2** teacher load, pattern-aware capacity math and cross-config summing (§4.2, §4.7, §3.10) → **Check 3** daily distribution incl. block packing & fragmentation (§4.3, §4.8) → **Check 4** cross-section daily overlap + tightness score (§4.4) → **Check 5** shared-room contention (§4.5) → **Check 6** structural conflicts incl. merged-group common-slot intersection (§4.6, §4.9) |
| 1.11 | Blocker/warning result model | Every failed check returns `{severity, message, entity_ref, suggested_fix}` — the message text exactly per §4's examples, `entity_ref` deep-links to the offending master row |
| 1.12 | Live recomputation | Recompute on every `masters.changed` event (debounced), cache in Redis, push readiness delta over Socket.IO |
| 1.13 | Readiness Dashboard screen | Score ring, error/warning summary, clickable blocker list → jumps to the master screen with the row focused; persistent mini Readiness panel above the (future) Generate button |
| 1.14 | Feasibility test suite | Golden-case fixtures: overloaded teacher, impossible daily spread, alternate-period capacity, class-teacher P1 deadlock, merged-group empty intersection, cross-wing overload. **This suite is the contract Phase 2 builds against** |

### 1D — Access Administration (week 5–6, parallel with 1C)

| # | Task | Detail |
|---|------|--------|
| 1.15 | Roles & Responsibility screen (§15.4) | Admin-only (`roles.manage`): roles list + custom roles, permission matrix grouped by module with the view-scope radio (Own / Own + linked classes / All), ERP role mapping table, per-user role overrides + `users.teacher_id` link with "unlinked teacher login" warning, change audit log, Redis permission-cache invalidation on save |
| 1.16 | RBAC negative-test suite | Every endpoint shipped so far rejected without its permission; scope filter returns exactly the linked sections for a teacher user; provisioning respects Admin role overrides on re-login |

**Exit criteria:** entering the sample school (50 sections, ~40 teachers) produces a correct Readiness Score; every seeded defect is flagged with the exact actionable message; 100% of §4 checks covered by tests; an Admin can reshape any role's permissions/scopes on the Roles & Responsibility page and see them enforced on next request.

---

## Phase 2 — CSP Solver & Draft Generation (5 weeks)

> **Status: ✅ complete** (branch `phase2/solver-generation`, commit `ad4fa55`). Deferred from 2.11: grid virtualization + k6 perf suite in CI (compact cached endpoint shipped).

**Objective:** One click generates a complete, conflict-free draft for a config that passes feasibility (§5).
**Dependencies:** Phase 1 (esp. 1.10 — the solver trusts feasibility's guarantee).

| # | Task | Detail |
|---|------|--------|
| 2.1 | `timetable_slots` schema | §3 table + §4.9 additions: `merged_group_id`, generated `teacher_occupancy_key`, the three unique keys (`uq_class_slot`, `uq_teacher_slot2`, `uq_room_slot`). Integration test that proves MySQL itself rejects a double-booking insert |
| 2.2 | Variable builder | Expand mappings into solver variables; collapse into macro-variables for consecutive blocks, merged groups, elective blocks (§5.1). Unit tests: variable counts match required slots exactly |
| 2.3 | Domain builder + pruning | Per-variable legal `(day, period)` domains; pre-prune for `always_first_period`, `alternate_day`, unavailability, breaks-as-segment-boundaries (§4.7, §4.8) |
| 2.4 | Constraint propagation core | `isConsistent` + `forwardCheck` implementing all 10 hard constraints of §5.1; shared with Phase 3's drag-drop validation — build it as a reusable `ConstraintChecker` in `packages/shared` |
| 2.5 | Search engine | Backtracking with MRV + degree ordering, LCV value ordering, conflict-directed backjumping (§5.2–5.3); deterministic seed option for reproducible tests |
| 2.6 | Repair fallback | Min-conflicts local search with random restarts + time budget; reports exact unplaced periods (§5.4) |
| 2.7 | Solver worker + progress | BullMQ job wrapping 2.2–2.6; streams "N/M slots placed" over Socket.IO; writes draft rows transactionally, honors `is_locked` rows as fixed (§7.4) |
| 2.8 | Generate screen | Trigger button (disabled until Readiness = 100%), live progress bar + log, result summary with unplaced-slot list |
| 2.9 | Full Allocation Matrix (read-only) | §8.3: virtualized 50×40 grid (AG Grid / react-window), sticky headers, By Class-Section / By Teacher / By Room dimension switch, search, fill/conflict stats, merged-cell link icon |
| 2.10 | Solver benchmark & soak tests | 2,000-slot school solves in target budget (≤30 s); property-based test: any input passing feasibility must solve to 100% — failures become new feasibility checks |
| 2.11 | Matrix performance budget (§14) | Compact slot-array endpoint (no nested ORM graphs), `EXPLAIN`-verified index-only lookups, Redis-cached published matrix with event-driven invalidation; k6 perf test asserting matrix load p95 ≤ 1s (API ≤ 300 ms) at 50 sections / 40 concurrent users — wired into CI |

**Exit criteria:** sample school generates 100% with zero conflicts, reproducibly; matrix screen loads in ≤ 1s p95 at full 2,000-slot scale; the feasibility→solver guarantee holds across the fixture library.

---

## Phase 3 — Drag-and-Drop Editing & Publish (4 weeks)

> **Status: ✅ complete** (branch `phase3/dragdrop-publish`). Shared `BoardEngine` (client legality + server revalidation, one rules engine), Draft Board with @dnd-kit + legal-destination glow + swap/lock/tray, publish diff/preview + one-transaction flip + `timetable_publications` version log, `scripts/board-smoke.sh` (18 live checks: RBAC negatives, stale 409s, lock conflicts, publish-during-edit). Notes: By-Teacher board view is read-only; merged-group cards move/lock but don't swap or remove (regenerate covers them).

**Objective:** Manual adjustment with live legality, and the draft→publish lifecycle (§7, §6 of screens list).
**Dependencies:** Phase 2 (reuses `ConstraintChecker` from 2.4).

| # | Task | Detail |
|---|------|--------|
| 3.1 | Client-side matrix store | Zustand store holding the draft slot-matrix; synced via Socket.IO for concurrent-admin awareness |
| 3.2 | Draft Board grid | §8.4: per-class-section and per-teacher views, `@dnd-kit` cards (`Subject · Teacher · Room`), breaks/zero period as non-draggable rows |
| 3.3 | Live legality engine | On drag-start: highlight every legal destination (green glow) by running `ConstraintChecker` against all cells (§7.2). On drop: green snap / red shake + beep + specific-reason toast (§7.1) |
| 3.4 | Swap vs. move semantics | Occupied target proposes a swap, validated both ways (§7.3); merged/split group cards drag as one linked unit (§4.9 UI note) |
| 3.5 | Server-side revalidation | Drop-confirm endpoint re-runs the check server-side, rejects stale state; DB unique keys as last-resort guard |
| 3.6 | Slot locking | Pin/unpin UI + `is_locked`; "Auto-fill remaining gaps" re-runs solver over unlocked cells only (§7.4) |
| 3.7 | Publish workflow | Publish Confirmation screen: diff vs. currently published version, unallocated-slot warnings; publish as single transaction (archive previous → flip `status`, §3 note) |
| 3.8 | Concurrency tests | Two admins editing the same draft: stale-drop rejection, lock conflicts, publish-during-edit |

**Exit criteria:** an admin can hand-tune the generated draft with instant feedback, never able to create a conflict through the UI or API, and publish atomically with a reviewable diff.

---

## Phase 4 — Substitute Teacher Engine (3 weeks)

**Objective:** One-click, explainable substitute assignment for absences (§6).
**Dependencies:** Phase 3 (needs a published timetable).

| # | Task | Detail |
|---|------|--------|
| 4.1 | Absence schema + API | `teacher_absences`, `substitution_log` (§3); mark-absent endpoint (manual now; leave-integration hook for later) |
| 4.2 | Candidate finder | Per affected slot: subject/grade-band eligible, free at that period (own timetable + today's substitutions), not unavailable, under daily max (§6.1 step 2) |
| 4.3 | Weighted matching | Preference scoring (+3 specialist, +2 continuity, +1 adjacent free, −1 already 2+ covers) + Hungarian/greedy-augmenting assignment (§6.1 steps 3–4); unmatched slots flagged with the three fallback options |
| 4.4 | Substitute Center screen | §8.2: absence banner, per-slot suggested substitute + alternates dropdown, "Confirm All" writing date-scoped overlay rows (`source='substitute'`) |
| 4.5 | Overlay rendering | Boards/matrix/reports show date-specific substitutions layered over the published grid without mutating it |
| 4.6 | Fairness & edge tests | Load spread across substitutes, multi-teacher same-day absences, absent teacher who is themselves a substitute today |

**Exit criteria:** marking a teacher absent yields a full reviewed assignment in one screen; base timetable provably untouched; every substitution audit-logged.

---

## Phase 5 — Reports, Notifications & LLM Explanations (4 weeks)

**Objective:** The reference layer (§9, §10) plus the first LLM features (§5.7).
**Dependencies:** Phase 4 (substitution history feeds reports).

| # | Task | Detail |
|---|------|--------|
| 5.1 | Report query service | One shared query shape over published slots, filterable by class/section/teacher/room/day/date-range/subject (§10). **This service is deliberately the future AI tool layer (§13.1) — design its function signatures accordingly** |
| 5.2 | Report renderers | Class-section weekly grid, teacher weekly grid (free periods marked), room utilization, teacher load summary; screen + print-styled PDF + Excel export |
| 5.3 | Reports screen | Filter bar, on-screen grid, export buttons |
| 5.4 | Notification engine | `notifications` table + Socket.IO in-app delivery + email/push provider integration; wire all §9 triggers (overload, solver done, published, absence, substitute assigned, none found, stale draft) |
| 5.5 | Notification Center screen | Timeline UI with read/unread, deep links |
| 5.6 | LLM explanation layer | Anthropic SDK integration (`claude-opus-5`, streaming): turn structured feasibility results into plain-English blocker text, and "why can't I place this here?" on drag rejections — fed the constraint-check result, never inventing constraints (§5.7). Provider abstraction built here is reused by Phase 7 |
| 5.7 | NL data entry (behind flag) | "Add English, 6/week, Mrs. Sharma in 5-A…" → LLM extraction → confirmation screen → normal CRUD writes (§5.7); ships disabled by default (toggle arrives with §13.2 settings) |
| 5.8 | Report & app-wide performance budget (§14) | Report aggregates Redis-cached with event-driven invalidation; render-ready rows computed in SQL/cache (no N+1); heavy PDF/Excel exports queued with ≤ 1s acknowledgment + progress + ready-notification; extend the CI k6 suite to assert p95 ≤ 1s on **all** critical endpoints (each report, readiness, board fetch, substitute matching, masters lists); slow-query log (>100 ms) + per-route latency histograms in observability |
| 5.9 | Scoped teacher views (§15.3) | **My Timetable** (own weekly grid, free periods marked, today's substitutions overlaid) and **My Classes** (grids of linked class-sections) for `view.own`/`view.class` users; reports honor the same scope; draft data blocked without edit/generate permission. Negative tests: a teacher's hand-crafted API/socket call for another teacher's or an unlinked class's data returns 403/empty |

**Exit criteria:** all four reports export correctly **and every on-screen report loads in ≤ 1s p95** (heavy exports acknowledge within 1s and complete via queued job); the CI perf suite is green across all critical endpoints; a teacher SSO login sees exactly My Timetable + My Classes and nothing else (scope negative tests green); every §9 trigger fires end-to-end; blocker messages and drop-rejections read as natural English with the LLM enabled and degrade to template text without it.

---

## Phase 6 — OR-Tools CP-SAT Optimization (optional, 3 weeks)

**Objective:** Soft-optimization mode — "nice" timetables, not just valid ones (§5.6).
**Dependencies:** Phase 2 (can run any time after; independent of 3–5, 7).

| # | Task | Detail |
|---|------|--------|
| 6.1 | Model translation | Map the existing variable/constraint model to CP-SAT (Python microservice or Node bindings) behind the same solver-job interface |
| 6.2 | Soft objectives | Minimize teacher gaps, balance daily load, minimize room changes for junior classes — weighted objective config UI |
| 6.3 | Mode selector + parity tests | "Fast (feasibility)" vs. "Optimized" generation choice; CP-SAT output must pass the identical `ConstraintChecker` + DB constraints |

**Exit criteria:** optimized mode produces measurably fewer teacher gaps on the benchmark school with zero hard-constraint regressions.

---

## Phase 7 — AI Assistant (4 weeks)

**Objective:** Role-gated conversational layer: chat over timetable data, AI-triggered reports, provider configuration (§13).
**Dependencies:** Phase 5 (tool layer = 5.1's query service; provider abstraction = 5.6; roles from 0.3/0.4).

| # | Task | Detail |
|---|------|--------|
| 7.1 | AI schema + RBAC wiring | `ai_settings`, `ai_chat_log` (§13.2); `ai.chat` / `ai.reports` / `ai.configure` permissions enforced by guard middleware on REST + Socket.IO chat namespace (§13.3); nav items role-rendered |
| 7.2 | Tool registry | Wrap 5.1's query functions as the §13.1 whitelisted tools (`getTeacherTimetable`, `getFreeTeachers`, `getRoomUtilization`, `getReadinessStatus`, `generateReport`, …) with JSON schemas; server-side scope injection (`school_id`, permitted configs) on every execution |
| 7.3 | AI Gateway + chat loop | NestJS module: conversation state, Anthropic tool-use loop (streaming, adaptive thinking), grounded-answers-only system prompt, per-message audit logging with token counts, budget cutoff |
| 7.4 | Ask AI screen | Per mockup: streaming bubbles, collapsible tool-trace chips, inline mini-tables, report cards with PDF/Excel download, suggestion chips, scope selector, read-only notice, access rail |
| 7.5 | AI Settings screen | Per mockup: provider/model select, masked write-only key + Test Connection (1-token ping), AES-256-GCM key storage, feature toggles, usage meter from `ai_chat_log` aggregates, monthly budget, role access matrix editor |
| 7.6 | Report generation from chat | `generateReport` tool → 5.2 renderer → download link returned into the conversation; gated on `ai.reports` |
| 7.7 | Safety & adversarial tests | Prompt-injection attempts cannot escape tool scope or reach other schools' data; a user without `ai.chat` is rejected at the socket layer even with a hand-crafted request; key never appears in logs/responses; budget cutoff banner works |
| 7.8 | Evaluation pass | Question bank (~50 real admin questions) scored for groundedness — every numeric claim traceable to a tool result shown in the trace |

**Exit criteria:** a Timetable Admin can ask load/availability/utilization questions and get correct, traceable, streamed answers; can export a report from chat; a Teacher without permission sees nothing and is server-side blocked; Super Admin rotates the API key and adjusts the role matrix without a deploy.

---

## Cross-phase workstreams (continuous)

- **Performance budget (§14, hard NFR):** every transactional page and on-screen report ≤ 1s at p95 — this is a release gate in *every* phase, not just tasks 2.11/5.8. Every new query ships `EXPLAIN`-checked against seeded full-scale data; every new screen/endpoint states its measured latency in the PR; the k6 CI suite grows with each phase and a budget regression fails the pipeline. Sanctioned exceptions only: solver runs, file exports, notification fan-out, AI answer totals — all queued/streamed with ≤ 1s acknowledgment.
- **Testing discipline:** the feasibility fixture library (1.14) and `ConstraintChecker` (2.4) are the system's contract — every phase adds cases, none may weaken them.
- **Design system:** all screens derive from `timetable-ui-mockup.html` tokens/components; extract into a shared component library during Phase 1.
- **Documentation:** spec deviations update `AI-Timetable-System-Architecture.md` in the same PR (per CLAUDE.md convention).
- **Pilot feedback loop:** put Phase 1 in front of a real school's timetable-in-charge before Phase 2 begins — master-data UX findings are cheapest to fix then.
