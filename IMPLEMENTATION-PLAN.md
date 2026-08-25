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

> **Status: ✅ complete** (branch `phase4/substitute-engine`). Pure matching engine in `packages/shared/src/substitute` (eligibility → §6.1 scoring → greedy + depth-1 augmenting matching, 11 tests incl. fairness spread, same-day multi-absence, absent-substitute edge); `teacher_absences` + `substitution_log` with `uq_slot_substitution_date`; overlay lives in `substitution_log` only (see §6.2 implementation note — no timetable_slots rows, base grid untouchable by construction); Substitute Center screen with absence banner, per-slot dropdown + rationale, Confirm All; Matrix date picker overlays substitutions (accent ↺ cells); `scripts/substitute-smoke.sh`. Note: rationale text is rule-generated for now — the LLM-polished phrasing arrives with Phase 5's explanation layer.

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

> **Status: ✅ complete** (branch `phase4/substitute-engine`). Report query service = the future §13.1 tool layer (`reports.service.ts`: classSectionTimetable / teacherTimetable / roomUtilization / teacherLoadSummary, scope-injected, Redis-cached under the slots:* sweep, ?date= substitution overlay); Reports screen with filters + Print + CSV; notifications table + Socket.IO delivery + topbar bell, triggers wired: publish (teachers+admins), solver-completed (queue listener), absence, substitute-assigned, substitute-gap; Notification Center; LLM layer: AnthropicProvider abstraction (`@anthropic-ai/sdk`, claude-opus-5, adaptive thinking; key via env until §13.2) + /ai/explain-readiness with template degradation; ScopeService real section lookup; My Timetable / My Classes teacher views, scope negatives verified live (403s). Deferred: 5.7 NL data entry (needs §13.2 toggle → Phase 7), queued PDF/Excel pipeline (CSV + print-PDF ship now), k6 CI perf suite, email/push channel (ERP provider hook stubbed), overload-banner + stale-draft reminder triggers.

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

> **Status: ✅ complete** (branch `phase6/cpsat-optimization`). `optimizer` compose service (Python 3.12 + ortools 9.15, stdlib HTTP) behind the same solver-job interface; TS owns §4.7 pruning + room assignment, CP-SAT owns search + the three §5.6 objectives (teacher gaps, peak daily load, lab-cluster room changes) with per-run weight sliders on the Generate screen; task 6.3 parity gate = every CP-SAT answer replayed through the real `SolverState.check()` and adopted only if it verifies AND scores better, so Optimized can never be worse or unsafe than Fast. Fallbacks proven live: optimizer unreachable, INFEASIBLE, partial cover, checker rejection → keep the fast result. Benchmark (`scripts/optimize-benchmark.cjs`): **teacher gaps 171 → 0**, room changes 54 → 21, zero hard-constraint regressions. Deviation from the task sketch: Python service rather than Node bindings (OR-Tools has no official Node binding) — recorded in §5.6.

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

> **Status: ✅ complete** (branch `phase7/ai-assistant`). `ai_settings` + `ai_chat_log`; AES-256-GCM key custody (write-only in the UI, ciphertext in the DB, masked hint only); 11-tool read-only registry wrapping the §10 query layer with scope injected server-side; AI Gateway with the Anthropic tool-use loop (streaming, adaptive thinking, `claude-opus-5`), per-turn audit logging with token counts and a monthly budget cutoff; `/ai` Socket.IO namespace refusing any client without `ai.chat` at handshake; Ask AI screen (streaming bubbles, collapsible tool traces, report cards, suggestion chips, scope selector, read-only pill) and AI Settings screen (provider/model, Test Connection 1-token ping, feature toggles, usage meter, role access matrix). Verified: 16 unit tests (key custody + adversarial scope), `scripts/ai-smoke.sh` (RBAC 403s, key never echoed, DB holds ciphertext only), `scripts/ai-socket-check.cjs` (teacher and forged tokens refused, admin connects). **Not verified end-to-end: live LLM answers** — no `ANTHROPIC_API_KEY` was available in this environment, so the chat loop was exercised only to its "no provider key configured" error path. Deferred: 7.8 groundedness evaluation pass (needs a live key), 5.7 NL data entry (toggle ships off).

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

> **Provider abstraction (post-Phase-7, §13.2): ✅ Google Gemini wired.** The chat gateway spoke Anthropic's message shape directly, which made "choose your provider" a dropdown that could only really pick one thing. `apps/api/src/ai/providers/` now defines a vendor-neutral contract (system prompt, turn history, whitelisted tools, streamed text, token counts) that the gateway drives, with an adapter per vendor. **Anthropic and Google are both wired**; OpenAI and Azure are catalogued but say plainly they are not.
>
> Gemini talks the Generative Language REST API directly (`fetch` + SSE) rather than through an SDK — the needed surface is four stable things, and it avoids a second SDK's major versions to track. Two differences the adapter absorbs: Gemini has **no tool-call ids** (it correlates by function name, so ids are synthesised), and it takes a **stricter schema dialect** — `minimum`/`maximum`/`additionalProperties` are rejected outright, and one of them fails the *whole* request, taking the entire tool registry down rather than one tool. §13.1's definitions use some of those, so they are translated (a numeric range moves into the description, which is what steers the model anyway) and unit-tested against the real registry.
>
> Also: keys and env-var fallbacks are per provider (`GEMINI_API_KEY` / `GOOGLE_API_KEY` alongside `ANTHROPIC_API_KEY`), switching provider resets the model to that provider's default (a Claude model against Gemini fails confusingly), the readiness-explanation path (§5.7) routes through the same abstraction so it works on Gemini too, and the env-only `ai/provider.ts` is retired.
>
> **Follow-up: the model list is no longer hardcoded.** The catalogue shipped from a stale snapshot — it offered Gemini 2.5 months after the 3.x line was current, which is the failure mode of any list a human maintains by hand. `GET /ai/settings/models` now asks the provider what the school's key can actually use (Gemini's `models` endpoint filtered to `generateContent`; Anthropic's `models.list`), with a **Refresh from provider** control on the screen; the static catalogue is the labelled fallback for when there is no key. Gemini's list is now the current 3.x lineup with `gemini-3.5-flash-lite` present and `gemini-3.7-flash` — "built for complex coding, agentic workflows" — as the default. Pricing moved from per-provider to **per model**, because flash-lite ($0.30/$2.50 per M) against 3.5-flash ($1.50/$9.00) is a fivefold spread that a single figure would misreport on the usage meter.
>
> Verified: `scripts/ai-providers-smoke.cjs` (22 live checks) — the decisive one stores an invalid Gemini key and asserts the error that comes back is **Google's own** ("API key not valid"), proving the request really went to `generativelanguage.googleapis.com` and not quietly to Anthropic. Plus 12 unit tests pinning the schema and message translation (**75 api / 111 shared passing**), every prior suite green, lint clean, web build passing.

**Exit criteria:** a Timetable Admin can ask load/availability/utilization questions and get correct, traceable, streamed answers; can export a report from chat; a Teacher without permission sees nothing and is server-side blocked; Super Admin rotates the API key and adjusts the role matrix without a deploy.

---

## Cross-phase workstreams (continuous)

- **Performance budget (§14, hard NFR):** every transactional page and on-screen report ≤ 1s at p95 — this is a release gate in *every* phase, not just tasks 2.11/5.8. Every new query ships `EXPLAIN`-checked against seeded full-scale data; every new screen/endpoint states its measured latency in the PR; the k6 CI suite grows with each phase and a budget regression fails the pipeline. Sanctioned exceptions only: solver runs, file exports, notification fan-out, AI answer totals — all queued/streamed with ≤ 1s acknowledgment.
- **Testing discipline:** the feasibility fixture library (1.14) and `ConstraintChecker` (2.4) are the system's contract — every phase adds cases, none may weaken them.
- **Design system:** all screens derive from `timetable-ui-mockup.html` tokens/components; extract into a shared component library during Phase 1.
- **Documentation:** spec deviations update `AI-Timetable-System-Architecture.md` in the same PR (per CLAUDE.md convention).
- **Pilot feedback loop:** put Phase 1 in front of a real school's timetable-in-charge before Phase 2 begins — master-data UX findings are cheapest to fix then.

---

## Phase 8 — Master Data Import from Excel (2 weeks)

> **Status: ✅ complete** (branch `phase8/excel-import`). One-file import of every master with a validation engine in front of it. Verified by `scripts/import-smoke.cjs` (26 live checks): RBAC 403s, a dirty workbook rejected with every planted error named while the database stays **byte-identical**, a clean workbook creating exactly what the preview predicted, and re-upload proving idempotent.

**Objective:** Onboard a school from an existing spreadsheet instead of hand-typing hundreds of master rows — without letting one wrong, duplicate, or garbage row into the database (§16).
**Dependencies:** Phase 1 (masters + feasibility engine).

| # | Task | Detail |
|---|------|--------|
| 8.1 | Workbook contract | `packages/shared/src/import/contract.ts` — one declarative definition of every sheet, column, type, enum, limit and natural key, driving the generator, parser, validator and docs |
| 8.2 | Template + export | exceljs writer: Instructions sheet, locked styled headers with per-column notes, dropdowns on every enum, tinted required columns, greyed `e.g.` samples, and a Reference sheet of existing names. Same writer produces **Export current masters** (round-trip backup / bulk edit) |
| 8.3 | Pure validator | `validate.ts` — structural, cell (incl. Excel dates, numbers-as-text, booleans, VarChar limits), within-file and against-DB duplicates, cross-sheet references with "did you mean", and business rules reusing §4.8 / capacity / merged-group / class-teacher rules. Reports **all** independent problems per row |
| 8.4 | Dry-run API | `POST /import/dry-run` — never writes; returns per-sheet counts, every issue with `Sheet!C7` reference, and the current readiness score |
| 8.5 | Commit API | `POST /import/commit` — re-validates the uploaded bytes (never trusts a client plan), writes in one transaction in dependency order, skips anything that already exists, invalidates readiness once |
| 8.6 | Annotated error file | `POST /import/annotate` — the uploaded workbook back with an `Import Errors` column per sheet and offending cells tinted, so users fix in place |
| 8.7 | Import screen | `/import` (Build → Import from Excel) + entry points on Timetables and the Setup Wizard; template/export buttons, upload, preview table, grouped issue list, confirm |
| 8.8 | Tests | 27 validator unit tests (one per rule) + the live smoke script |

**Exit criteria:** an admin can take a school from empty to ready-to-generate by downloading the template, filling it, and uploading once; no invalid, duplicate or garbage row can enter; every rejection names the sheet, row, cell, value and the fix.

---

## Phase 9 — Multi-School / Multi-Tenancy (5 weeks)

> **Status: planned.** Decisions taken with the product owner: trust groups share one database and are separated by `school_id`; **one API deployment serves both shared-DB and dedicated-DB schools simultaneously** (mode is a per-school property of the registry, resolved at runtime); a user may hold access to several schools in one session and switch in-app.

**Objective:** Serve many schools from one deployment — whether each school has its own database and credentials, a trust group shares one database, or there is a single school — without a second code path and without a single row, cache entry or socket event ever crossing a school boundary (§17).
**Dependencies:** Phases 0–8 (the whole app is being retro-fitted).

### The model

Three deployment shapes, **two physical modes**, one registry:

| Shape | Mode | Mechanism |
|---|---|---|
| Each school its own DB + credentials | `dedicated` | registry holds an encrypted connection URL per school; requests route to it |
| One trust, several schools | `shared` | one DB, many `school_id`s, in-app school switcher |
| Single school | `shared`, one tenant | today's behaviour, zero configuration |

A trust wanting isolation within one MySQL server (a database + MySQL user per school) is `dedicated` with different URLs — not a third code path.

### Starting position (audited 2026-08-25)

`school_id` already exists on 14 of 30 models and rides in the SSO token and session JWT, but: there is **no `schools` table** (the column is a dangling `Int` with no FK); the other 16 models — including `timetable_slots` — carry no `school_id` at all; **75 `where: { id }` queries do not filter by school** (a live cross-tenant IDOR the moment a second school exists); `readiness.invalidate()` runs `redis.keys("readiness:*")` and flushes **every** school's cache; `EventsGateway` uses `server.emit()` so solver progress **broadcasts to all schools**; the worker holds one global `PrismaClient` and its job data carries no school; and `ERP_PUBLIC_KEY` is a single global env var (one signing key for one ERP installation).

| # | Task | Detail |
|---|------|--------|
| 9.1 ✅ | **Harden the single tenant** | Ships value with one school and is a hard prerequisite. One Prisma client extension (`$allModels.$allOperations`) injects the school filter from AsyncLocalStorage — `findUnique`→`findFirst`, `update`/`delete` guarded via `updateMany` returning 0 → 404 — replacing 75 hand-edits with one module, per invariant 11's "one scoping module". Migration denormalizing `school_id` onto the 16 child tables (`timetable_slots`, `periods`, `class_sections`, `substitution_log`, …) with backfill and leading-position indexes, so scoping is an indexed predicate rather than a join (invariant 10). Redis keys namespaced `t{tenant}:…` with prefix-scoped invalidation. Socket.IO `tenant:{id}` rooms replacing every broadcast. Worker job data carries `{ tenantId, schoolId, configId }` and opens the ALS context before touching Prisma. Existing unique keys are untouched — `config_id` already implies the school |
| 9.2 ✅ | **Control plane** | `schema.control.prisma` + its own client: `trusts`, `tenants` (trust, ERP school code, `mode`, AES-256-GCM-encrypted DB URL reusing `ai/crypto.util.ts`, local school id, `schema_version`, status), `erp_instances` (per-ERP public key + `kid`). Defaults to living in the app database so a single-school install needs no new configuration; `CONTROL_DATABASE_URL` separates it. A real local **`schools`** table inside each tenant DB gives `school_id` its missing FK and carries name/code/logo/timezone |
| 9.3 ✅ | **Provisioning + migrations** | `pnpm tenant:create` and `POST /admin/tenants`: create database, run migrations, seed system roles + permission registry + ERP role mappings. `pnpm migrate:all` iterates the registry and stamps `schema_version`; the API **refuses to serve a tenant whose version ≠ the app's**, failing loudly rather than crashing mid-query |
| 9.4 ✅ | **Tenant context + connection routing** | `TenantContext` on AsyncLocalStorage (**not** Nest request scope — that would cascade through ~40 injecting classes, kill singleton caching and threaten the 300ms p95 budget). `PrismaService` becomes a Proxy typed as `PrismaClient` resolving its client from ALS per access, so **every existing call site compiles and runs unchanged**. Bounded LRU of clients keyed by tenant, small per-tenant pool, idle eviction, hard cap, with `active_tenants × connection_limit ≤ max_connections` documented and alarmed |
| 9.5 ✅ | **SSO carries school identity** | Token gains `erpInstanceId` + `schoolCode` (a bare numeric `schoolId` is meaningless across databases). Public key selected per instance by `kid`/`iss` — the property that stops ERP A minting tokens for ERP B's school. Nonce key becomes `sso:nonce:{erpInstance}:{jti}`. Session JWT gains `tenantId`; the guard rejects suspended tenants |
| 9.6 ✅ | **School switching** | ERP token may carry `schools: [...]`; `POST /auth/switch-school` re-issues the session for another school in that list and **re-resolves the role inside the target school's data** — a user can be Admin in one school and Teacher in another. Sync-on-login semantics preserved per school |
| 9.7 ✅ | **UI** | School name beside the timetable-config selector in the top bar; switcher rendered only when the session grants more than one; per-school display name/logo from the tenant row |
| 9.8 ✅ | **Platform Console** | A level above school Admin: tenant list, connection test, migration/health status, suspend. Gated by a control-plane `platform_users` table — school roles live inside tenants and cannot govern the registry |
| 9.9 | **Ops + noisy neighbour** | Every log line and metric tagged with `tenantId`; connection-pool saturation alarm. The solver worker runs `concurrency: 1` today, so one long job would block every school — needs per-tenant job grouping or fair scheduling |
| 9.10 | **Isolation test suite** | Two-school fixture where School B hits every REST endpoint, socket event, report, AI tool and import route with School A's ids and must get 404/403; assertions that Redis keys and socket emissions never cross; a dedicated-mode integration test against a second real MySQL database added to the dev compose stack (a change that only works outside Docker is broken) |

> **9.1 status: ✅ complete.** `school_id` is now on **all 30 tables** (migration `20260825035721_phase9_1_school_scope`: add-nullable → backfill by join → `MODIFY NOT NULL`, so an un-attributable orphan aborts the migration under `STRICT_TRANS_TABLES` rather than silently landing in school 0). Scoping lives in one Prisma client extension over `$allModels`, driven by an `AsyncLocalStorage` tenant context — **no call site changed**, because a query is scoped by where it runs, not by how it is written. Redis keys namespaced `s{schoolId}:…` with SCAN-based per-school invalidation; Socket.IO events addressed to `school:{id}` rooms; BullMQ jobs carry their school and the worker opens its own context from it.
>
> Two holes were found and closed *during* the work, neither of which row scoping alone would have covered: (a) a write stamped as School B could still **name** School A's class or class-section id, producing a row B owns that points into A's data — now blocked by a reference check built from Prisma's DMMF, including through nested relation writes; (b) `upsert` on a unique key not containing the school would silently **update** a colliding foreign row — now a plain create, so it collides as a 409 instead.
>
> Compile-time backstop: because `school_id` is NOT NULL everywhere, Prisma's generated types now *require* it on every create, so a new write cannot silently depend on the extension.
>
> Verified: `scripts/tenant-isolation.cjs` (39 live checks across two real schools — IDOR, cross-school references, nested-write laundering, child-table stamping, a full solver generation for School B, and School A byte-identical afterwards), `scripts/tenant-socket-check.cjs` (6 checks: B's socket silent while A acts), 18 new unit tests in `school-scope.spec.ts` (**50 api / 111 shared passing**), all pre-existing smokes green (board, RBAC, AI, import), lint clean, web build passing, and `EXPLAIN` on the scoped `timetable_slots` read still an index lookup (`type: ref`), no full scan.
>
> Deliberately deferred to a later hardening pass: composite foreign keys (`FOREIGN KEY (class_id, school_id) REFERENCES classes(id, school_id)`) would make cross-school references structurally impossible at the DB level, in the spirit of invariant 1 — but Prisma requires every field of an optional relation to be nullable together, which `homeRoomId` + non-null `schoolId` violates. The application-level reference check covers the same ground today.

> **9.2 status: ✅ complete.** Two halves, both landed.
>
> **`school_id` finally has a parent.** The `schools` table holds each school's identity, and all **30** `school_id` columns now carry a real foreign key to it (`ON DELETE RESTRICT`) — migration `20260825045259_phase9_2_schools_table` creates the table, backfills one row per school already present in the data (id preserved, so every existing FK resolves), and only then adds the constraints. A row naming a school that does not exist is now refused by MySQL, not by convention. `GET /me` carries the session's school; `GET`/`PUT /school` reads and renames it, with `code` deliberately not editable from inside the school and no `POST`/`DELETE` at all.
>
> **The registry** (`trusts`, `tenants`, `erp_instances`) lives in `prisma/control/schema.prisma` with its own client, migration history and seed. It is load-bearing rather than decorative: SSO consults it on every login and refuses a suspended school — checked *before* the nonce is burned, so a refused login can be retried once the school is reinstated rather than needing a fresh token. It is also optional: no `CONTROL_DATABASE_URL` means no registry and pre-Phase-9 behaviour, which is what a single-school install has.
>
> **Deviation, recorded in §17.3:** the plan said the control plane would default to living *in* the app database. It cannot — (a) under `dedicated` mode the registry cannot live inside a tenant database, since you need the registry to find that database, and (b) Prisma cannot host two migration histories in one database (both would write `_prisma_migrations` and read each other's rows as drift). It is therefore a separate schema on the *same* MySQL server, created automatically by `docker/mysql-init/`: no new container, no new credentials, no operator action.
>
> The scoping extension learned that `schools` is the tenant *root* — scoped by its own `id`, never stamped, and skipped by the reference check, since its ownership is now a real foreign key.
>
> Verified: `scripts/control-plane-smoke.cjs` (22 live checks, including all 30 FKs present, a row naming a nonexistent school refused by the database, suspension actually blocking a login and reinstatement restoring it, and the control plane unreachable from the application API), 3 new SSO unit tests (**53 api / 111 shared passing**), both 9.1 isolation suites still green against the new FK, all pre-existing smokes green, lint clean, web build passing.
>
> Known follow-ups: the backfilled school is named `School 1` with code `SCHOOL-1` — placeholders, because inventing a school's real name in a migration would be a guess; `PUT /school` fixes it and 9.7 surfaces it in the UI. `TenantRegistryService.byLocalSchoolId()` is unambiguous only while every tenant is `shared` and returns null rather than a guess otherwise; 9.5 replaces it by putting `tenantId` in the session token. `connectionUrlFor()` has no caller until 9.4.

> **9.5 / 9.6 status: ✅ complete (brought forward at the customer's request: "School name will come from existing ERP… should not be hardcoded").**
>
> The ERP now owns school identity. The SSO token carries a `school` claim (`code` + `name`, plus optional short name / logo / timezone / address), an optional `trust`, and an optional `schools[]` of everything the user may work in — the contract is written out in §15.1. Names are refreshed on **every** login, so renaming a school in the ERP renames it here; descriptive fields are only overwritten when the token actually sends them, so a token omitting a logo does not erase one configured here. A school the deployment has not seen is **provisioned on the spot**: `schools` row created, permission registry and ERP role mappings seeded so its users can sign in immediately, and registered in the tenant registry under its trust.
>
> `POST /auth/switch-school` moves a session between the schools the ERP granted. The authority is the signed session token's own `schoolIds`, not a permission — a permission could be granted by an admin of one school and would say nothing about access to another. The user is **re-provisioned in the target school**, since Admin in one and Teacher in another is normal in a trust. A new token is issued rather than the current one mutated, so scoping, sockets and the AI tool layer keep reading the school from one place.
>
> Because the server takes the school from the session and never from a request body, "create a timetable for another school" means *being* in that school: the Timetables screen offers the school beside the name, switches first, then creates. Backward compatible — a legacy numeric `schoolId` still finds an existing school, but cannot provision one, because a number carries no name.
>
> Part of 9.7 landed with it (◐): the top bar names the school from `/me` and shows a switcher only when more than one is granted, and the dev ERP screen lets you type the school code/name the ERP would report plus a trust preset, so the whole flow is exercisable without a real ERP.
>
> Verified: `scripts/sso-schools-smoke.cjs` (26 live checks — ERP-driven naming, rename-not-duplicate, trust provisioning with a usable permission registry, switching into the right school with that school's role and data, an ungranted school refused, a single-school user unable to switch at all, and a timetable created after switching belonging to the new school and invisible from the other), 6 new SSO/switch unit tests (**59 api / 111 shared passing**), every prior suite still green, lint clean, web build passing.
>
> Still open in 9.5: per-ERP-instance key verification (selecting the public key by the token's `kid`) — the `erp_instances` table holds the keys but `ErpKeysService` still verifies against a single configured `ERP_PUBLIC_KEY`. That is the piece that stops one ERP installation minting tokens for another's school, and it lands with 9.4's connection routing.

> **9.4 status: ✅ complete.** One deployment now serves shared-database and dedicated-database schools at the same time, decided per school by the registry.
>
> `PrismaService` became a proxy that resolves its connection from the tenant context on every property access — so **no call site changed again**, exactly as in 9.1. The lookup is a synchronous Map read; the async work (resolve tenant → decrypt URL → open pool) happens once per request in `JwtAuthGuard`, which binds the client to the context.
>
> **Tenant id replaced school id as the routing key.** A dedicated tenant's local `school_id` is usually 1 — and so is everyone else's. `tenant:create` produces exactly that collision, and the smoke test is built around it deliberately, because a routing bug would not throw: every query would succeed against the wrong database and return plausible data. The session token now carries `tenantId`, grants are tenant ids, and `switch-school` refuses a bare `schoolId` as ambiguous whenever the session spans tenants. `byLocalSchoolId()` — flagged in the 9.2 note as a stopgap — is deleted.
>
> **Connections are bounded and reported**: hard cap on open clients (`TENANT_MAX_CLIENTS`, 20), pool size set by the registry rather than by whatever was typed into a URL (`TENANT_POOL_LIMIT`, 5), LRU eviction past the cap, idle close (`TENANT_IDLE_MS`, 10 min), coalesced concurrent opens, and the `TENANT_MAX_CLIENTS × TENANT_POOL_LIMIT` budget exposed on `GET /health` so an alarm can watch it.
>
> **Everything that writes routes**, not only the request path — the solver worker resolves its own connection from the job's `tenantId`, and so does the solver-completed notification listener. A dedicated tenant's generation landing in the shared database would have produced slots nobody could see.
>
> **The 9.5 leftover is closed**: ERP tokens are now verified against the key of the installation that signed them, selected by the JWT header's `kid` (or the `iss` claim). A `kid` that is not registered is **rejected** rather than falling back to the global key — that fallback is precisely how one ERP installation would end up trusted to sign for another's schools.
>
> `pnpm tenant:create --code … --name …` provisions a dedicated school: creates the database, applies migrations, seeds the school row and permission registry, and registers the tenant with its URL encrypted at rest. Deliberately a command, not an API call — creating a database carries credentials and is nothing a login should trigger. A school the ERP mentions that nobody provisioned lands in the shared database, the safe default. (This also covers most of 9.3's provisioning; what remains there is `migrate:all` across every registered tenant and the schema-version gate.)
>
> Verified: `scripts/dedicated-tenant-smoke.cjs` (19 live checks against a real second database — routing, write placement, mutual invisibility despite the shared local id, ungranted-tenant switch refused, connection budget reported), 5 new routing unit tests (**63 api / 111 shared passing**), every prior suite green, lint clean, web build passing.

> **9.3 status: ✅ complete.** Provisioning (`tenant:create`) landed with 9.4; this closes the other half — migrating N databases, and refusing the one you forgot.
>
> The failure this prevents is the quiet kind. Add a migration, miss one school's database, and nothing breaks on deploy: it breaks later, inside a query, as `Unknown column 'trust_code' in 'field list'`, on whichever screen touches the new column first, with nothing pointing at the cause. So the version is checked **at the door** — the app knows the migrations it ships, each database knows what it has (`_prisma_migrations`, asked directly rather than trusting the registry's cached `schema_version`), and a database that is behind is refused on connect with a message naming the school, the gap, the missing migration and the fix. A database that is *ahead* is tolerated and logged, because that is a normal mid-rollout state that resolves itself. The shared database is held to the same rule; `GET /health` is public, bypasses it, and reports `schema: "behind"`.
>
> `pnpm migrate:all` (and `--dry-run`) walks the registry so nothing is forgotten, migrates the shared database **once** however many schools live in it, stamps each tenant's applied version, and does not let one unreachable school block every other school's upgrade — failures are collected and reported with a non-zero exit. Wired into the dev compose boot, so the stack keeps every tenant current.
>
> Also fixed while proving it: `SsoController` swallowed every failure into a bare redirect, so an operational fault (a school behind this build) was indistinguishable from a bad token and "fail loudly" failed quietly. It now logs the reason server-side while still telling the browser nothing.
>
> Verified: `scripts/migrate-all-smoke.cjs` (14 live checks) provisions a real dedicated school, genuinely rolls its database back — dropping the columns, not just the bookkeeping row — and walks behind → refused → repaired → served, confirming the shared database was migrated once rather than once per school. The refusal message was checked in the log: *"…cannot be served: its database is 1 migration behind this build (has …phase9_2_schools_table, needs …phase9_5_school_trust). Missing: … Run `pnpm migrate:all`…"*, and it fired **before** any query touched the missing column. Plus 8 unit tests on the version comparison and the message (**96 api / 111 shared passing**), every prior suite green, lint clean.

> **9.7 status: ✅ complete.** The top bar's school name and switcher landed early with 9.5/9.6; this finishes the rest.
>
> **School Profile** (Administration → School Profile, `masters.manage`) gives `PUT /school` the UI it never had, and its real job is to be honest about an otherwise invisible split: `code` is not editable at all (it is what a sign-in is matched against, so changing it would lock the school's users out); `name` is editable but refreshed from the ERP on every sign-in, and the screen says so; short name, logo, address and timezone are local and only overwritten if the ERP explicitly sends them. Showing an editable name with no warning would be the worst of both worlds — rename, sign in, silently reverts.
>
> **The logo half of the plan line** ("per-school display name/logo from the tenant row") was never rendered: the sidebar now shows the school's own logo in place of the product mark, with its short name beneath, and both it and the top-bar mark hide a URL the browser cannot reach rather than leaving a broken image in the chrome.
>
> Verified: 6 new live checks in `scripts/sso-schools-smoke.cjs` asserting exactly the promise the screen makes — set the local fields, sign in again with a token carrying only code and name, and the ERP's name wins while short name, logo, timezone and address survive untouched, with `/me` carrying the logo and short name the shell renders. (**96 api / 111 shared passing**), every prior suite green, lint clean, web build passing.

> **9.8 status: ✅ complete.** A level above every school — which schools exist, are they reachable, are their databases current, should this one be served right now.
>
> **Platform access is deliberately not a permission**, which is the whole point of the task line. Every permission lives in a school's own `roles`/`role_permissions`, granted by that school's Super Admin — so if this were one of them, the admin who manages their own roles could grant themselves authority over the registry, from inside the thing it governs. It lives in the control plane's `platform_users`, keyed by **ERP identity**, the only identity that survives across schools. It is also **not carried in the session token**: a flag minted at sign-in would keep saying yes for the token's whole 8-hour life, so a revocation would not bite until sign-out. Re-checked per request behind a 30s memo instead.
>
> Granting is a command (`platform:admin -- --grant/--revoke/--list`), because the first platform admin cannot be granted through a console that requires already being one — with `PLATFORM_ADMIN_ERP_USER_IDS` as a documented bootstrap hatch that the listing surfaces so an env grant is never invisible.
>
> The console is narrow on purpose and says so on screen: it cannot create a school (that provisions a database — an operator command), cannot delete one (suspend is the reversible equivalent), never shows a connection URL (credentials — only whether one is stored and whether it works), and cannot grant platform access. What it does: deployment summary with the connection budget and how many schools are behind this build, the school list grouped by trust, an on-demand connection test per school (on demand because a hundred schools would mean a hundred connections to render a table), and suspend/reinstate.
>
> Verified: `scripts/platform-console-smoke.cjs` (25 live checks) — a school Super Admin holding all **15** of that school's permissions gets 403 on every platform route; the CLI grant then admits **the same session token** without a fresh sign-in and revoking refuses it again, which is what proves the check is live rather than minted; a real school is suspended, its users blocked from signing in, and reinstated; and no connection URL or credential appears in any response. Plus 8 unit tests on the access rules (**104 api / 111 shared passing**), every prior suite green, lint clean, web build passing.
>
> One smoke assertion was softened as vacuous: the "dedicated school exposes only `hasStoredUrl`" check ran `every()` over an empty array in a deployment with no dedicated schools, so it could not fail. It now reports INFO and points at `dedicated-tenant-smoke.cjs`, which covers that path with a real one.

**Exit criteria:** one deployment concurrently serves a single school, a trust group sharing a database, and a school on its own database with its own credentials; a user with access to two schools switches between them in the top bar and gets the correct role in each; the isolation suite passes with zero cross-school reads, writes, cache hits or socket events; per-tenant p95 still meets the §14 budget; and onboarding a new school is one command.

**Risks:** the `school_id` backfill on `timetable_slots` (largest table — one transaction, unique keys verified after), and the extension's `findUnique`→`findFirst` rewrite changing return-type nullability at ~20 call sites — the two-school IDOR suite is its proof.
