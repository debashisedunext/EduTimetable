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
| 9.9 ✅ | **Ops + noisy neighbour** | Every log line and metric tagged with `tenantId`; connection-pool saturation alarm. The solver worker runs `concurrency: 1` today, so one long job would block every school — needs per-tenant job grouping or fair scheduling |
| 9.10 ✅ | **Isolation test suite** | Two-school fixture where School B hits every REST endpoint, socket event, report, AI tool and import route with School A's ids and must get 404/403; assertions that Redis keys and socket emissions never cross; a dedicated-mode integration test against a second real MySQL database added to the dev compose stack (a change that only works outside Docker is broken) |

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

> **9.9 status: ✅ complete.** Two halves: tagging, and fairness.
>
> **Every log line names its school**, without any call site knowing about it. A `TenantAwareLogger` set at `NestFactory.create` prefixes each line with the ambient school read from the same AsyncLocalStorage the request, socket message or queue job already runs inside — `[school 1 · tenant 7] R. Ahuja signed in as ADMIN`. Tagging by hand would have meant editing hundreds of call sites and getting the next one wrong, the same trap 9.1 avoided for scoping. Lines with no school (boot, health, the control plane) gain nothing rather than a misleading placeholder. The AsyncLocalStorage moved to module level to make this possible, which also fixed a latent bug: `TenantContextService` created a *new* storage per instance, so the worker's instance and the API's would not have seen each other's contexts.
>
> **One school can no longer monopolise the worker.** `concurrency: 1` was right for one school but is a head-of-line block for many. Fixed by two changes that only work together: concurrency above one (`SOLVER_CONCURRENCY`, default 3) — even on one core, timesharing beats queueing for fairness — plus a **per-school cap of one running job**, because concurrency alone is not fairness (one school queueing four jobs would take all four slots). A capped job is **deferred, not failed** (`moveToDelayed` + `DelayedError`: no retry consumed, no failure recorded). The slot is a Redis key with a TTL so a dead worker cannot lock a school out permanently, and it is released only by the job holding it — releasing unconditionally would let an expired job free the *next* job's slot and run two of that school's jobs at once.
>
> Saturation and fairness are now reported rather than inferred: `connections.saturated` plus the solver's waiting / active / delayed counts and **which schools are running**, on `/health` and the Platform Console.
>
> Verified: `scripts/fair-scheduling-smoke.cjs` (9 live checks) measures it with real jobs — school B's short job finished at **1,025ms while school A's 6,129ms job was still running**, where the old behaviour could not have finished it before ~6,700ms; school A's three queued jobs ran ~3s apart rather than together; school B got through in the middle; nothing failed while waiting. Plus 12 unit tests on the lock edge cases and the logger (**116 api / 111 shared passing**), every prior suite green, lint clean, web build passing.

> **9.10 status: ✅ complete.** The suite is one gate — `pnpm test:isolation` (`scripts/isolation-suite.sh`) — with one exit code, so "is tenancy still sound?" has a single answer rather than nine scripts somebody has to remember to run.
>
> **The sweep contains no list of endpoints, on purpose.** A hand-written list answers the question only on the day it is written: the next controller added is untested, nothing says so, and the suite keeps passing — reporting a safety it never checked, which is worse than no suite at all. `scripts/isolation-sweep.cjs` instead asks the running application for its route table (dev-only `GET /dev/routes`, built from Nest's own metadata via `DiscoveryService`) and requires **every** route to be either swept or explicitly classified with a recorded reason. A new endpoint fails the build until someone decides which it is.
>
> **Each route is a controlled experiment, not a one-sided probe.** Same URL, same body, once as each school, only the caller differing. "B got 404" proves nothing alone — a dead or mis-permissioned route refuses everyone and passes an isolation check while thoroughly broken. So B must be refused *and* A must get a different answer; a 400 for A is a fine control (the request reached A's row and failed on its merits). Where both sessions get the same answer the run says so and **fails**, rather than counting it as a pass. Getting there meant giving the board its real payload shapes and running it in lifecycle order — out of order, half of it refuses both callers for reasons that have nothing to do with who is asking.
>
> Both schools are built by the script and deleted after: the sweep includes DELETE and publish, and a suite that mutates live data to make its point can only be run once. The seeded school is a witness that nothing strayed, asserted byte-identical.
>
> **Four real defects, all the same shape.** Writing the sweep found `POST /notifications/:id/read`, `PUT /teachers/:id/unavailability`, `GET /timetable-configs/:id/generate/latest` and `PUT /ai/settings/roles/:id` answering **success for another school's id**. None leaked data — row scoping held every time — but each did a scoped no-op and reported `{ok:true}` / `{state:"none"}` / 200. Wrong contract: someone else's id is *not found*, and "fine" is indistinguishable from the outside from a real write — and would become one the moment a refactor replaced `updateMany` with `update`. All four now 404. Two test-side flaws surfaced with them: `platform-console-smoke` picked its victim by `localSchoolId`, which stops being unique the moment a second dedicated school also has local id 1 (it now matches on tenant id, the actual routing key), and the AI-tool seam had to mirror `AiChatGateway` exactly — resolving the config through the scoped client and catching tool errors the way the chat loop does — or it would have been testing a code path the assistant does not have.
>
> **A fifth defect, found by running the gate rather than by reading it.** Under the suite's load the worker started logging `Missing lock for job N`. BullMQ renews a running job's 30-second lock on a timer, which never fires while a *synchronous* CSP solve blocks the event loop — so the lock expires under a healthy job, BullMQ calls it stalled, and may hand it to a second worker while the first is still solving. 9.9's `concurrency: 3` made it more likely, not less. `WORKER_LOCK_DURATION_MS` (5 min) now covers a 30s solve plus a 120s CP-SAT pass under contention, and sits below the 15-minute per-school slot TTL so a job always loses the BullMQ lock before it loses its school's slot. The fair-scheduling test also now reports the job's *state* on a timeout — "undefined ms" sends you reading the scheduling logic when the answer is the job's own status.
>
> **A second real MySQL server, not a second database.** `docker compose up` now starts `mysql-b` with its own host *and its own credentials*, and `scripts/dedicated-db-smoke.cjs` provisions a school onto it. On one server, code that ignored the registry's stored URL and fell back to the default connection would still find a database of the right name and every assertion would pass while routing did nothing; a user that exists only on `mysql-b` cannot open a socket to the default server, so "the registry URL is actually used" becomes something the suite can fail on — and the test asserts that asymmetry outright instead of relying on it silently. `migrate:all` covers it too, which is §17.3 reaching off-server.
>
> Verified: 108 routes classified, 49 discriminating by session, 26 collections disjoint, 7 body-smuggling attempts refused, 11 AI tools clean, Redis prefixes intact — plus every prior suite green under the one gate. Deliberately unglamorous detail: the sweep purges its fixtures at *both* ends, because a run that dies half-way must not make the next run fail on a unique key and read as a broken suite. **116 api / 111 shared tests passing**, lint clean, typechecks clean, web build passing.

---

## Phase 10 — Split electives (§4.9)

The three `elective_*` tables were migrated in Phase 1 and specced in detail at §4.9. Nothing was ever built on them: no solver handling, no API, no importer, no UI. A real requirement — "students pick one of French, Sanskrit or German, all taught in the same period, and go to their own room" — cannot be expressed without them, and cannot be faked: `uq_class_slot` makes three parallel lessons for one section impossible as ordinary rows, and the tempting workaround (pseudo class-sections) would let the solver schedule a section's Maths opposite its own language period, emitting timetables that put students in two places at once.

| Task | What |
|---|---|
| 10.1 ✅ | **Storage.** `class_section_id` nullable + `elective_block_id` / `elective_option_id`, `max_periods_per_day` on the block |
| 10.2 ✅ | **Feasibility.** Seven checks, block periods in capacity and teacher load |
| 10.3 ✅ | **Solver.** Block as a macro-variable over several sections *and* several teachers |
| 10.4 ✅ | **Writer.** Member rows + option rows, atomically |
| 10.5 ✅ | **API.** `/elective-blocks` CRUD with the mistakes refused at entry |
| 10.6 ✅ | **Importer.** `Electives` sheet, one row per option, plus round-trip export |
| 10.7 ✅ | **UI.** Matrix cell with its options on hover; board reserves the cell |
| 10.8 ✅ | **Tests.** 3 solver + 8 feasibility + 3 board unit tests, and a live smoke |

> **Status: ✅ complete.**
>
> **The storage decision is the load-bearing one.** An occurrence is one *member row per attending section* — carrying the block and no subject, teacher or room — plus one *option row per parallel lesson* with `class_section_id = NULL`. That NULL is deliberate: MySQL unique indexes ignore NULLs, so option rows drop out of `uq_class_slot` while every member section keeps exactly one guarded cell, and `uq_teacher_slot` / `uq_room_slot` still refuse a double-booked language teacher or room. It is the same device merged groups already use for `teacher_occupancy_key`, and it means invariant 1 keeps its teeth and it stays one table (invariant 3). Rejected: a side table for option placements (moves the double-booking guard off `timetable_slots`, which invariant 1 forbids) and a non-null discriminator in `uq_class_slot` (widens the hottest unique key and weakens the guard for ordinary rows).
>
> **Nullable `class_section_id` rippled to 18 sites in 5 files**, and every one was a real decision rather than a cast: does this code mean *a cell* or *a lesson*? The board, the publish diff, the matrix payload and locked-slot loading filter option rows out. The teacher's own timetable and the substitute plan keep them — a language teacher's absence still needs cover — labelled by their block, because "5-A" would be wrong (the students come from every member section) and blank would leave the cover teacher with no idea what they are walking into. `AffectedSlot.classSectionId` became nullable in the substitute engine, so the two section-derived signals (grade-band eligibility, the continuity bonus) simply abstain; the subject match still applies and is the stronger signal anyway.
>
> **The domain is an intersection over teachers, not just sections.** A block can only run where every option teacher can, so one alternate-day language teacher narrows the whole thing — the check that is genuinely hard to see by eye, and `ELECTIVE_DAY_INTERSECTION` now names the teacher and the days. Per-day caps count against the block, not each option: a student takes one language period a day, not one of French and one of German.
>
> **CP-SAT skips a config that has blocks** rather than optimising around them. A payload that cannot express several simultaneous teachers would propose placements colliding with the blocks and fail the §5.6 replay gate — burning the whole budget to be rejected. The fast result is already valid, so this is the same graceful degradation as the optimizer being down. Reinstating it means modelling multi-teacher variables in the Python service; deferred, and the outcome string says so rather than going quiet.
>
> **The board reserves block cells.** They are not entries — a block is not a draggable card, and half of one is not a card at all — but without telling the client they are taken, it would cheerfully offer a drop the server then refuses, which is the exact split invariant 7 exists to prevent. Moving a block by dragging it is not implemented; the refusal says so ("an elective block moves as a whole, not card by card").
>
> **The 9.10 gate did its job unprompted:** the three new `/elective-blocks` routes failed the isolation sweep as unclassified until they were swept, which is what a self-maintaining suite is for.
>
> Verified: `scripts/electives-smoke.cjs` builds a school with no slack — 20 curriculum periods and a 5-period block filling a 25-slot week exactly — and asserts the API refuses a one-option block, a repeated teacher and an over-long block; readiness reaches 100% *with the block counted* (and drops to two `SLOT_UNDERFLOW` warnings when a period is freed, proving it is counted); the worker places it on five different days; 10 member rows and 15 option rows land with the right columns; the DB still refuses a double-booked option teacher; and the language teacher's own timetable shows the lesson named by its block. **125 shared / 116 api tests**, lint and typechecks clean, web build passing.

---

## Phase 11 — Teaching scope, engagement and extra classes (§18)

Three gaps, all of the same kind: something the data *described* but could not *constrain*.

| Task | What |
|---|---|
| 11.1 ✅ | **Schema.** `teacher_class_eligibility`, `employment_type`, the config's extra window, `is_extra` on periods, `extra` on `SlotSource`, `extra_classes` |
| 11.2 ✅ | **One rule, every call site.** `teacher-scope.util.ts` called by mappings, merged groups, elective options, class-teacher, importer |
| 11.3 ✅ | **Feasibility Check 8.** `TEACHER_NOT_ELIGIBLE`, `GUEST_IN_CURRICULUM`, aggregated `TEACHER_SCOPE_UNSET` |
| 11.4 ✅ | **Substitution.** Scope is a hard gate, guests excluded, permanent +1 |
| 11.5 ✅ | **Extra classes.** Window in the structure builder, `/extra-classes` API, slots that survive regeneration and publish |
| 11.6 ✅ | **Importer.** Teaching Scope and Engagement columns, plus round-trip export |
| 11.7 ✅ | **UI.** Scope picker with presets, engagement field, the extra-window field in Timetable Configuration, Extra & Guest Classes screen, extra band on the Matrix |
| 11.8 ✅ | **Tests.** 9 unit tests, a live smoke, sweep classification, School 2 regenerated |

> **Status: ✅ complete.**
>
> **The gap was that grade band was derived, not declared.** `substitutes.service.ts` built a teacher's `classIds` from the mappings they already had — which describes the data and therefore cannot constrain it. Nothing stopped a Nursery teacher being mapped to Class 12; my own School 2 generator enforced bands in the *script*, which is exactly the kind of rule that exists nowhere the app can see. Eligibility is now a **set** of classes (a range cannot express the PE teacher who covers Nursery and Class 12), with presets in the UI so the ordinary case stays two clicks.
>
> **Check 8 is not redundant with the endpoint refusals.** The endpoints cannot see rows that predate the rule, and cannot see a scope *narrowed after* the mappings were made — the mistake a person is most likely to make and least likely to notice. The unstated-scope warning is aggregated to one line for the whole school on purpose: a school that has never filled it in has every teacher unscoped, and a hundred identical rows would drown a dashboard whose value is that each line names a fix.
>
> **Engagement does two things and deliberately not a third.** A guest cannot be mapped into the regular curriculum, and guests are never offered as cover while permanent staff take a +1 tie-break. Load caps are *not* derived from the type — a default that silently overrides what an admin typed is worse than no default.
>
> **Extra classes needed time the solver could not reach**, because School 2's grid is 40/40 and an extra class taking a regular period would displace a lesson Phase A had proved must exist. The window is appended after the teaching day and is free space *by construction*: the solver's domain is `1..periodsPerDay`. `daySegmentsFromRows` had to exclude it too, or the last teaching run would silently lengthen and a double period could be told it may span into an extra class.
>
> Storing them as `source='extra'` slots meant teaching **three** existing paths to leave them alone: regeneration (which wipes non-locked draft rows), publish (which deletes published and promotes draft), and draft-from-published (which would otherwise see them and refuse to make a draft at all, permanently). Each was a real bug found by asking "what happens next time someone presses Generate?"
>
> **The first version shipped a dead end.** The Extra & Guest Classes screen existed and correctly refused to show a form until the timetable had an extra window — pointing the reader at Setup → Timetable Configuration, where the field did not exist, because it had only ever been wired into the API. The window is now editable there, with the computed extra end-time beside the end of the school day, so the path the empty state describes is one a person can actually walk.
>
> Verified: `scripts/teacher-scope-smoke.cjs` (24 live checks) proves a primary teacher is refused Class 12 by every route, a guest is refused the curriculum and pointed at the right screen, Check 8 catches a scope narrowed after the fact, an extra class is refused a teaching period and accepted in the window, lands as slots in both statuses guarded by `uq_teacher_slot`, and survives both a regeneration and a publish; and that neither the guest nor the out-of-scope teacher appears among cover candidates. The 9.10 gate flagged both new routes as unclassified until swept — including one that addresses its resource by query string, which the sweep now handles as its own bucket. School 2 regenerated with **573 teaching-scope rows** and still reaches 100% readiness with 0 warnings. **134 shared / 116 api tests**, lint and typechecks clean, web build passing.

---

## Phase 12 — Fixed room assignment (§19)

Two facts were recordable and changed nothing.

| Task | What |
|---|---|
| 12.1 ✅ | **Schema.** `room_subjects`, plus a narrow name-matching backfill for labs |
| 12.2 ✅ | **Solver.** Claim the class-section's home room; draw labs from the subject's own |
| 12.3 ✅ | **Feasibility Check 9.** `HOME_ROOM_SHARED`, `HOME_ROOM_UNSET`, `LAB_SUBJECT_UNSERVED`, `LAB_SUBJECT_OVERFLOW` |
| 12.4 ✅ | **API.** Rooms accepts `homeForIds` and `subjectIds`, and reports both back |
| 12.5 ✅ | **Importer.** `Home Room For` and `Lab For Subjects` columns, plus round-trip export |
| 12.6 ✅ | **UI.** Rooms form sets both; the list shows which class sits where |
| 12.7 ✅ | **Tests.** 8 unit tests, a live smoke, School 2 regenerated |

> **Status: ✅ complete.**
>
> **`homeRoomId` had existed since Phase 1 and the solver never read it.** Every ordinary lesson was written with `room_id = NULL`. School 2 had 56 carefully recorded home rooms and 1,960 lessons that mentioned none of them. The solver now claims the room, which also puts `uq_room_slot` to work on physical rooms rather than only labs — and turns a room assigned to two class-sections from a paper mistake into a real collision, which is why `HOME_ROOM_SHARED` had to become a blocker in the same change.
>
> **Labs were interchangeable** — `findFreeLab` took the first free room of type `lab`, so a biology period could be held in the physics lab because it was empty. The subject's own labs are used now, with one deliberate escape hatch: **a lab with no subjects listed is general and still serves everything**. That is what every school had before, so nothing breaks until someone chooses to be specific, and the migration's backfill (`%biology%` → Biology) is narrow for the same reason — anything it misses stays general rather than being guessed at.
>
> Check 5 asks whether there are enough lab periods in total; Check 9 asks whether the *right* labs exist, which is the question a school with one Bio lab and one Physics lab actually has.
>
> The mapping is settable from **either side**: `class_sections.home_room_id` remains the single source of truth, and the Rooms screen writes it too, because "which room is this class in" and "which class is in this room" are the same fact.
>
> Verified: `scripts/room-assignment-smoke.cjs` (14 live checks) builds a school with a Bio Lab and a Physics Lab where "any free lab" and "the right lab" give different answers — and asserts all 40 ordinary lessons land in their own section's room, all 10 Biology periods in the Bio Lab and never the Physics Lab, the two sections never sharing the lab in one period, a second home-room assignment refused at the endpoint, both Check 9 blockers firing, and the pre-§19 general-lab arrangement still feasible. School 2 regenerated: **1,960 of 1,960 ordinary lessons now carry a room** (all were null before), all 144 Computer periods across the 5 computer labs, 2,110 room-periods claimed with zero collisions. **142 shared / 116 api tests**, lint and typechecks clean.

---

## School 2 — a full school as test data (§16)

A generated, importable school for Second Branch (`SCHOOL-2`): 14 classes (Pre-Nursery to Class 12) x 4 sections, Mon–Fri, 8 periods of 37 minutes from 08:00 to 14:01 with breaks after periods 3, 5 (lunch, 45 min) and 7.

Nothing is typed out. `scripts/school2-model.cjs` holds the curricula; the demand follows from them, the staffing follows from the demand, and the mappings follow from the staffing — so changing one period in one curriculum re-balances the staff list on the next run, and the arithmetic that produced the file is the arithmetic the Feasibility Engine then checks.

| | |
|---|---|
| **Sections** | 56, each with exactly 40 periods — a section with spare slots is a `SLOT_UNDERFLOW` warning, and 56 of them would bury the dashboard |
| **Teachers** | 122, sized to the work (English 18, Mathematics 18, Hindi 15 … History 3) with the brief's floor of 3 per subject applied per subject. Average load 17.3/week, heaviest 26 — under the 90% at which tightness is warned |
| **Demand** | 2,110 teacher-periods/week; a uniform "3 per subject" would have supplied 1,440 and been an immediate `TEACHER_OVERLOAD` |
| **Third language** | 8 §4.9 blocks (classes 5–12), 5 periods/week, four sections held open while French, Sanskrit and German run in parallel |
| **Merged science** | Physics, Chemistry and Biology in classes 11 and 12 — one lesson, four sections, one teacher |
| **Rooms** | 56 home classrooms, 5 computer labs (Computer is the only lab subject: 144 periods against 200 slots is 72%, under the 80% warning line), 2 halls for the merged senior sciences |

The language options meet in three of their own class's rooms. Those rooms are free by construction — the students in them come from those very sections — so no separate language rooms and no room contention. Marking the three sciences as lab subjects too would have needed twelve labs, partly because check 5 counts a merged lesson once per section.

> **Result: 100% readiness, 0 blockers, 0 warnings.** Generation placed all 2,030 variables — 2,360 slot rows, since a block writes four member rows plus three option rows per occurrence — with **0 unplaced in 22.6s**, inside the 30s budget though not by much at this scale.
>
> Independently verified against the database rather than the solver's own report: every one of the 56 sections has exactly 40 filled periods; no section, teacher (by occupancy key) or room is in two places at once; all 8 language blocks land on 5 different days with 4 member rows and 3 option rows per cell; all 6 merged groups are one lesson across four sections with a single row carrying the teacher's occupancy.
>
> Read latency at this scale is comfortable: slots 6ms, readiness 3ms, teachers 15ms, mappings 33ms — against the §14 budget of 300ms.
>
> **A real importer bug surfaced on the first run and is fixed.** `validateWorkbook` returns the rows the committer writes in a `keep` map, but the plan's totals fell back to a *different* map when a sheet had no validation block — so the new Electives sheet reported "24 new" and then imported nothing, silently, and readiness sat at 36% with 32 unexplained `SLOT_UNDERFLOW` warnings. The Electives block was added, and the fallback now **throws**: a contract sheet with no validation block is a programming error, and it should never again be possible to count rows that are then dropped.

**Exit criteria:** one deployment concurrently serves a single school, a trust group sharing a database, and a school on its own database with its own credentials; a user with access to two schools switches between them in the top bar and gets the correct role in each; the isolation suite passes with zero cross-school reads, writes, cache hits or socket events; per-tenant p95 still meets the §14 budget; and onboarding a new school is one command.

**Risks:** the `school_id` backfill on `timetable_slots` (largest table — one transaction, unique keys verified after), and the extension's `findUnique`→`findFirst` rewrite changing return-type nullability at ~20 call sites — the two-school IDOR suite is its proof.

## Phase 13 — Minimum Periods per Day (§20)

**Gap reported:** some teachers were given a single period on a day — a whole commute for one lesson. `max_periods_per_day` guarded the top of a teacher's day; nothing guarded the bottom, and the solver's value ordering actively preferred the emptiest day.

| Task | Deliverable |
|---|---|
| 13.1 | `teachers.min_periods_per_day` (default **3**, backfilled onto existing rows) — migration `20260826150000_phase13_min_periods_per_day`, Prisma model, teachers controller (with a min ≤ max guard), import workbook column, AI teacher tool, Setup → Teachers form and directory |
| 13.2 | `packages/shared/src/feasibility/min-day.ts` — the single owner of the arithmetic: weekly load, **daily reach**, `minDayPlan()`, `effectiveMinByTeacher()` |
| 13.3 | Feasibility **Check 10** — `MIN_DAY_IMPOSSIBLE` (blocker) and aggregated `MIN_DAY_RELAXED` (warning naming which bound binds) |
| 13.4 | Solver enforcement as a shortfall-vs-budget forward check in `SolverState`, plus day-building value ordering; `shortDays()` / `totalShortfall()` audits |
| 13.5 | Completeness ladder in `solveTimetable`: enforced pass (40% budget) → exact pre-§20 pass (full budget) → `consolidateShortDays()` swap-based repair; `stats.shortTeacherDays` / `stats.consolidatedDays` surfaced on the Generate screen and in the worker log |
| 13.6 | CP-SAT parity — reified `works[t][d]` in `apps/optimizer/server.py`, `teacherDayMin`/`teacherDayForced` in the payload, and `verifyAssignment` rejecting any answer with a short day |
| 13.7 | Board warning (never a refusal) on a move that thins a teacher's day |

**Status — shipped.** 155 shared / 116 api tests; isolation suite green.

Measured on School 2 (2,030 variables, every section 100% full), regenerated with the rule off and then on:

| | rule off | rule on |
|---|---|---|
| unplaced lessons | 0 | 0 |
| one-period teacher-days | 55 | 27–36 |
| teacher-days ≥ 3 periods | 425 | 430 |

**Deliberately not done:** School 2 is a near-critical fixture — 2,110 teacher-periods over 122 teachers × 5 days averages 3.46 against a minimum of 3, so almost every teacher must work almost every day at 3–4 periods and the shape is over-determined. Schools with ordinary slack reach zero short days (the `cleanSchool` solver test asserts it). The fixture's own fix is fewer, fuller teachers — a change to `scripts/school2-model.cjs`'s `TARGET_LOAD`, not to the engine — and it is left alone because it is the user's test data.

### Phase 13 follow-up — report caches outliving a publish (§14)

Reported from the Reports screen: after publishing, some Pre-Nursery and Class 1 sections showed a week of "Free". The published rows were all present in the database — the report was being served from a cache warmed before the publish, because `publish` dropped the `slots:*` keys and nothing else. Only sections somebody had opened early were affected, which is what made it look arbitrary.

- `CacheKeysService.invalidateTimetable(configId?)` — one invalidation for everything derived from the published timetable, used by publish, extra classes and the substitute engine.
- Fixed en route: the substitute engine's `redis.keys("slots:*")` (blocking `KEYS`, a silent no-op since the §17 school prefix, and cross-school if it had matched).
- `apps/api/src/redis/cache-keys.spec.ts` (5 tests) pins what is dropped and what is not; `scripts/report-cache-smoke.cjs` is isolation-suite step 13 and was verified to fail with the fix reverted.

## Phase 14.1 — Auto-resolve: complete & redistribute (§21)

**Asked for:** a one-press resolver on the issue list, applying each recommendation, marking what got fixed green, with per-issue consent and a "do not ask again".

**Correction made first:** the Allocation Matrix has no issue list — it shows the grid and a fill percentage. The issues and their recommendations live on the **Readiness Dashboard**, which is where this landed.

| Task | Deliverable |
|---|---|
| 14.1.1 | `Remedy` / `RemedyChange` on `FeasibilityIssue`, plus stable issue `key`s assigned centrally in `finalize()` so no future check can forget one |
| 14.1.2 | `packages/shared/src/feasibility/remedy.ts` — the choosers (teacher with capacity, free room, lab for a subject, alternating days) and `applyToSnapshot`, the pure preview |
| 14.1.3 | Remedies attached at 14 issue sites; snapshot gains `rooms` (type/capacity), which `roomNames` could not supply |
| 14.1.4 | `AutoFixService` — engine-proposed changes only, `WRITABLE` allow-list, compare-and-set, verify-by-re-run; `auto_fix_runs` + undo |
| 14.1.5 | Readiness Dashboard review drawer, per-issue consent, "do not ask again" (localStorage, per timetable), green resolved rows, undo |
| 14.1.6 | `scripts/auto-fix-smoke.cjs` as isolation-suite step 14 |

**Status — shipped.** 191 shared / 121 api tests; isolation suite green (14 steps).

Fourteen codes carry a remedy: `CT_UNASSIGNED`, `CT_RULE_INERT`, `ALT_DAY_UNSET`, `HOME_ROOM_UNSET`, `HOME_ROOM_SHARED`, `LAB_SUBJECT_UNSERVED`, `TEACHER_SCOPE_UNSET`, `TEACHER_NOT_ELIGIBLE`, `UNDER_MAPPED` (complete); `TEACHER_OVERLOAD`, `GUEST_IN_CURRICULUM`, `BLOCK_TEACHER_PATTERN`, `ELECTIVE_TEACHER_CLASH`, `ELECTIVE_ROOM_CLASH` (redistribute).

**Deferred deliberately:**
- The 11 `relax` codes → **14.2**, with the grouped review card.
- `ELECTIVE_SUBJECT_DOUBLE_COUNTED` — its remedy is a row *deletion*, and undo would have to reconstruct every field of a curriculum row. 14.1's op vocabulary is `set` / `link` / `create`, all trivially reversible.
- `OVER_MAPPED` — reducing mapped periods is a staffing decision, not a data repair.

**Note for whoever adds a remedy next:** `packages/shared/tsconfig.json` excludes `*.spec.ts`, so a snapshot built inside a test is not typechecked by `tsc --noEmit`. Adding `rooms` to `FeasibilitySnapshot` compiled clean and then failed at runtime in the solver benchmark for exactly that reason.

## Phase 14.2 — Auto-resolve: the limit changes (§21)

The eleven `relax` codes — the half of auto-resolve that loosens a rule.

| Task | Deliverable |
|---|---|
| 14.2.1 | Remedies for `DAILY_PIGEONHOLE`, `DAILY_DISTRIBUTION` (both sites raise it), `BLOCK_EXCEEDS_DAILY_MAX`, `BLOCK_MATH_INVALID`, `BLOCK_FRAGMENTED`, `MIN_DAY_IMPOSSIBLE`, `MIN_DAY_RELAXED`, `ELECTIVE_DAILY_PIGEONHOLE`, `SAME_PERIOD_IMPOSSIBLE`, `CT_P1_DEADLOCK`, `OVER_MAPPED` |
| 14.2.2 | `largestFeasibleMin()` — the minimum a load can actually keep, searched not guessed |
| 14.2.3 | `electiveBlock` as a remedy entity; `WRITABLE` widened to the five limit fields |
| 14.2.4 | Grouped review card, unticked by default, "Accept all of these"; `kind` recorded on every outcome |
| 14.2.5 | "Do not ask again" now skips the drawer entirely for the safe fixes and opens it only for limit changes, with an "Ask me again" link |
| 14.2.6 | Smoke extended: a relax remedy is priced, is **not** applied by a run that did not name it, applies when named, and undoes |

**Status — shipped.** 191 shared (50 in `remedy.spec.ts`) / 121 api tests; isolation suite green (14 steps).

Bounds that stop a remedy being offered rather than offering a useless one: a cap raise above `periodsPerDay`, above an alternate-period teacher's every-other-period ceiling, a block count below 1, or an `OVER_MAPPED` trim that would empty a mapping.

**Still deliberately without a remedy** (12 codes): `SLOT_OVERFLOW`, `SLOT_UNDERFLOW`, `LAB_NONE`, `LAB_OVERFLOW`, `LAB_TIGHT`, `LAB_SUBJECT_OVERFLOW`, `TEACHER_TIGHT`, `ELECTIVE_NO_MEMBERS`, `ELECTIVE_TOO_FEW_OPTIONS`, `ELECTIVE_DAY_INTERSECTION`, `SAME_PERIOD_PICK_DAYS`, `NO_DATA` — plus `ELECTIVE_SUBJECT_DOUBLE_COUNTED`, which needs a row deletion undo cannot reconstruct.

**Gotcha worth remembering:** the API serves `packages/shared/dist`, so an engine change needs `pnpm build` in shared *and* an api restart before a live smoke sees it — and Redis still holds the previous readiness until something invalidates it. Both bit during this phase.

## Phase 15 — Split Electives: the screen, the display, and when they run (§4.9)

The third-language problem: Class 5-A, 5-B and 5-C take their language period at the same time, and inside it Sanskrit, French and German run under three teachers in three rooms.

That is exactly the §4.9 split elective, which has had a schema, a synchronized macro-variable and six feasibility checks since Phase 10. Three things were missing, and only one of them was a feature.

| Task | Deliverable |
|---|---|
| 15.1 | **`ReportsService.classSectionTimetable` joins the block's option rows.** A member row carries no subject, teacher or room (invariant 9), so the class's own week rendered the language period as an empty cell — on the report, on My Classes, in the printed week and to the AI assistant, which share the function. Now returns `blockName` + `electiveOptions[]`, read from the written option *rows* so a covered option shows its substitute. |
| 15.2 | `WeekGrid` renders every option on its own line; the CSV export carries them; the Allocation Matrix cell names the subjects (`Fre / San / Ger`) instead of counting them. |
| 15.3 | **`/electives` screen + wizard step 9.** Block → member sections → N options (subject/teacher/room) → when it runs. Every rule the endpoints enforce is shown while typing. Before this the only way in was the Excel importer. |
| 15.4 | `elective_blocks.placement` (`solver` \| `same_period` \| `fixed`) + `fixed_slots` JSON. `same_period` reuses the existing `samePeriodKey`; `fixed` prunes occurrence *i*'s domain to its pinned cell. Domain pruning, never scoring (invariant 2). |
| 15.5 | **Check 7b** — six new codes naming every way a pin can be wrong, each with a §21 remedy that hands the block back to the solver. `placement` added to auto-fix `WRITABLE`; `fixedSlots` deliberately not. |
| 15.6 | `packages/shared/src/electives/pins.ts` — one owner of what "Mon P4" means, shared by the screen, the API and the importer. Malformed pins are dropped on read (surfacing as `ELECTIVE_PIN_COUNT`), never guessed. |
| 15.7 | Importer parity: `When` / `Fixed Slots` columns, validated at dry-run so a bad slot list refuses the file rather than silently downgrading to `solver`. Export round-trips. |
| 15.8 | Smoke extended (steps 7 and 8): the class grid names three subjects, three teachers and three rooms; every member section shows the same slots; a pinned block lands on exactly the cells named; an impossible pin is a Readiness row with a remedy, not a failed generation. |

**Status — shipped.** 222 shared / 121 api tests; `electives-smoke.cjs` green end to end; lint, web typecheck and build clean.

**The judgement in 15.5.** All six remedies are `relax` and all six do the same thing: set `placement` back to `solver`. None moves a pin. Moving a block to a different day is choosing when a whole grade changes rooms — a decision the school makes, not a resolver. That is why `fixedSlots` is absent from `WRITABLE` even though `placement` is on it.

**Two behaviours worth keeping.** `parsePins` drops a malformed pin rather than guessing, because a guessed pin silently moves a lesson while a dropped one becomes a named Readiness row. And `placementFromLabel` falls back to `solver` — the default that changes nothing — never to a stricter rule, so a typo in the workbook's `When` column can never pin a block.

**Not done, deliberately.** The Draft Board still shows an elective cell as a reserved block name rather than a draggable unit: a block is not one card, and dragging it means moving every option and every member section at once. That is its own piece of work, not a display fix.

### Phase 15 follow-up — elective-only teachers were invisible

Reported as "no timetable is showing for Pranav Banerjee, maybe there are more such teachers". There were nine, all language teachers whose only work is a split-elective option: 130 lessons absent from the Allocation Matrix's By Teacher grid and the Draft Board's By Teacher view.

**Cause.** `GET /timetable-configs/:id/slots` filtered `classSectionId !== null` server-side. Correct for a section grid, wrong for the teacher grid — and both read that one payload.

**Fix.** The payload carries option rows; each consumer filters for the meaning it wants (`bySection` skips them, `byTeacher` keeps them, the fill-rate stat counts section rows only). The Board's `BoardEngine` stays section-only — an option row is never a draggable card — and its read-only By Teacher view renders those lessons through a separate index. In a teacher's row the cell shows **that teacher's own option**, not the block's whole menu, or it would credit them with two colleagues' lessons.

**Regression check.** `electives-smoke.cjs` step 5b, asserted at the payload where the data was lost, using the fixture's three language teachers who already had no ordinary mapping. It runs **before** the publish in step 6 — publishing turns every draft row into a published one, so `?status=draft` afterwards is empty and the check would pass or fail for an unrelated reason.

**Two traps worth remembering.** `[].every(...)` is `true`, so the shape assertion had to require the rows exist or it passed for exactly the bug it was written to catch. And the `slots:*` Redis payload is cached for an hour, so a deploy that changes its shape serves the old shape until it expires or a write invalidates it.

## Phase 16 — Multiple named drafts & the Draft Board stats (§22)

Depends on: Phases 2–3 (solver, board, publish), 9.1 (scoping), 11 (extras). Spec: §22.

- [ ] 16.1 Migration: `timetable_drafts` registry (+ `school_id`, per-config `draft_no`, stats columns), `timetable_slots.draft_id` + generated `draft_scope`, rebuild the three unique keys with `draft_scope` after `status`. Backfill: one Draft #1 per config with existing draft rows; published rows keep provenance `draft_id`.
- [ ] 16.2 Draft service + routes: list/create (cap 5 live, copy-from-draft/published)/rename/discard/archive, `?draftId=` on `GET /timetable-configs/:id/slots` and every draft-reading consumer, defaulting to the latest live draft. New routes swept/classified by `pnpm test:isolation` (§17.8).
- [ ] 16.3 Generation targets the selected draft: solver job carries `draftId`; `writeDraftSlots` deletes/rewrites only that draft's rows (extras excluded, locks honoured). Draft-from-published creates a named draft.
- [ ] 16.4 Stats recompute module: one function stamping required/placed/pct/errors/warnings onto the registry row, reusing Check 1's requirement arithmetic and `SolverState.check()`; triggered on generation complete, board edit batch confirm, import, and `POST /drafts/:id/recompute`. Board reads the row, never counts slots (§14).
- [ ] 16.5 Publish per draft: one transaction — supersede published set, flip selected draft's rows, stamp registry, other drafts untouched; §19a cache invalidation; Publish Confirmation shows "publishing Draft #N (label)" and provenance of the outgoing set.
- [ ] 16.6 Draft Board UI: Draft ▾ selector + New draft + Compare in the filter row; five `.stat-box` cards below (Generation %, Total allocation, Actual allocation, Errors red>0, Warnings amber>0); status pill per draft; Compare = side-by-side stats of live drafts, best-per-column highlighted, Publish per row; archived drafts open read-only.
- [ ] 16.7 Tests: unique-key property tests (two drafts may share a teacher-slot; two published sets impossible; extras collapse to scope 0), stats correctness against a seeded school2 generation, publish-supersede transaction, RBAC negatives (`timetable.generate` for CRUD, `timetable.publish` to publish), isolation sweep green.

Exit: school2 holds three drafts with differing stats; Compare shows them; publishing one leaves the other two intact and the published grid correct; `pnpm test:isolation` passes.

## Phase 16 — The Draft Board moves a split elective as one card (§4.9, §7.3)

Deferred at the end of Phase 15 with the note "a block is not one card, and dragging it means moving every option and every member section at once — that is its own piece of work". This is that work.

| Task | Deliverable |
|---|---|
| 16.1 | `BoardEntry` gains `electiveBlockId` + `options[]`; `subjectId`/`teacherId` become nullable (a block has neither). `SlotRow` carries the elective columns; `entryKeyOf` → `B{id}@d:p`; `rowsToEntries` folds a cell's member **and** option rows into one card. |
| 16.2 | **`varOf` emits the real §4.9 macro-variable.** It previously hard-coded `electiveBlockId: null, options: []`. `SolverState` already validated elective variables — this is what makes drag legality *the same check the solver made*, rather than a second implementation. |
| 16.3 | `domainCheck` intersects **every** option teacher (one out on Thursday takes the whole block off Thursday); `minDayWarning` reports each stranded option teacher; `explain`/`describeBlocker` name the block and the option actually in the way. |
| 16.4 | **`checkSwapGroup`** — the N-way transactional swap: lift the card and every distinct entry at the target across its member sections, check each in its new home, restore exactly. `legalDestinations` routes to it whenever either side is multi-section. The `reserved` mechanism is deleted. |
| 16.5 | **Merged groups can swap.** Same machinery; the "merged cards swap only with… nothing for now" comment is gone. |
| 16.6 | Server: `CellRef` accepts `electiveBlockId`; `rowsOfEntry` finds a block by its id; `assertFresh` compares the **option-id set**; `move` keeps each option's own room; new `POST board/swap-group`. |
| 16.7 | UI: block cards drag from any member section; dashed elective styling; teacher view shows *that teacher's* option; drag overlay names the block. The Phase 15 follow-up's separate `electiveByTeacherCell` index is deleted — blocks are engine entries now. |
| 16.8 | Tests: 11 new engine tests (fold, move, per-section refusal, option-teacher refusal, block daily cap, group swap, refusal when a displaced lesson cannot live at the source, transactional apply, no-op refusal, merged swap) + smoke step 5c against the live DB. |

**Status — shipped.** 231 shared / 121 api tests; electives smoke green; lint, web typecheck and build clean.

**Why the group swap was not optional.** A card holding N sections can only *move* to a cell free in all N. School 2 is 100% full, so a move-only implementation would have refused every drag and read as broken. Measured on School 2 after the change: **41 legal swap destinations across the 40 block cards, 0 legal moves.** Every usable destination is a swap.

**The bug the real data found.** The first working version reported 4 legal destinations for Class 5 Third Language — and all four were the block swapping with *another occurrence of itself*, which changes nothing. A green cell that does nothing when clicked is worse than a red one. `checkSwapGroup` now refuses a swap whose occupant shares the dragged card's `electiveBlockId` or `mergedGroupId`.

**Deliberately absent from the block card.** No 📌: `lockedSlots` is built filtered to rows with a section, a subject and a teacher, so a block's rows never reach the solver as locks and a pin would be silently ignored by the next Generate (invariant 13). Phase 15's `placement: fixed` is the tool that actually holds a block's time. No ✕: the unplaced tray is per-section *mapping* demand, and a block is not a mapping, so a removed block could not get back.

**Traps hit again, worth a third mention.** `packages/shared/tsconfig.json` excludes `*.spec.ts`, so two `checkPlace` call sites in the spec compiled clean and failed at runtime when `BoardEntry` grew a required field — fixed by normalising the probe at the engine boundary, which is the only entry the engine does not build itself. And a live board check must run **before** the publish step: publishing turns every draft row into a published one, and there is no draft left to drag.

## Phase 17 — Multiple named drafts (§22)

A school keeps several drafts of one timetable and publishes the best. §22 had been written in the architecture doc but never built; the linked UI mockup carries the matching screen.

**Step 1 — the backend, as an invisible refactor.** A school with one draft behaves exactly as before, everywhere.

| Task | Deliverable |
|---|---|
| 17.1 | `timetable_drafts` registry + `draft_id` on slots + the generated `draft_scope`, which joins all three §3 unique keys. Backfill: every config with draft rows gets Draft #1. |
| 17.2 | `DraftsService` — CRUD, the 5-live cap, copy-from, and one owner of the §22.3 stats. Required comes from Feasibility Check 1's own function; violations from `BoardEngine.violations()`, the one rules engine's fourth call site. |
| 17.3 | `?draftId=` on `GET /slots`, board context and publish preview, **defaulting to the config's current draft** so nothing that never heard of drafts changes. |
| 17.4 | `writeDraftSlots` scoped to one draft; the BullMQ job carries `draftId`; **Generate creates a new draft by default**; publish promotes the selected draft, archives the previously published one and leaves the rest alone. |

**Status — Step 1 shipped.** 231 shared / 121 api tests; electives smoke green; lint and typecheck clean. Verified on School 2: two complete 2,240-cell drafts coexisting, both at 100%, with the config's single extra class belonging to neither.

**Why the schema, not the screen.** `uq_class_slot` was `(config, status, class_section, day, period)`. Two drafts both placing 5-A Monday P1 collide, so **a second draft could not physically exist**. `draft_scope` collapses to `0` for published and `source='extra'` rows and carries the draft id otherwise — the guarantee stays global exactly where it must (one published set per config, extras once per config) and relaxes exactly where alternatives are the point.

**Three defects found in the written spec, all of which would have shipped:**
1. `draft_scope INT NOT NULL AS (...) STORED` — MySQL requires `NOT NULL` *after* the generation clause. Fails at migrate time.
2. `ON DELETE SET NULL` on `draft_id` — MySQL refuses it on the base column of a stored generated column, and is right to: orphaned rows would collapse to scope 0 and collide with the published set. Discard therefore deletes slots explicitly, in one transaction.
3. §22.3 defined *actual allocation* as "section rows + option rows". Against a required figure that counts a §4.9 block once per member section, School 2 reads **2,360 / 2,240 = 105.4%**. Both sides must count grid cells. Spec corrected.

**Two traps only the live run could find:**
- Prisma applies `@default(0)` **client-side** and sends the column in the INSERT, which MySQL rejects outright for a generated column. `@default(dbgenerated())` is the annotation that tells Prisma the database owns it.
- The board's `swap`, `swapGroup` and `place` rebuild rows field by field, and none carried `draft_id` — a hand-placed or swapped card silently **escaped its draft into scope 0**, where it was guarded against the published set instead of its own siblings. Caught by `electives-smoke.cjs`, not by any typecheck.

**Ordering that the §17.8 gate depends on.** The `:draftId` routes resolve and ownership-check the **config** before parsing the draft id. The sweep substitutes only the first path param, so a route that parsed the second one first would answer both sessions an identical 400 and be reported as proving nothing.

**A fourth defect, found by the isolation gate, and it predates Phase 17.** `draftFromPublished` copied published rows field by field and **omitted `elective_block_id` / `elective_option_id`** — so restoring a draft from the published week silently lost every §4.9 split elective. It also carried the single-draft assumption as a rule (*"A draft already exists — edit or publish it first"*). Both gone: it now delegates to `DraftsService.create({copyPublished: true})`, which stamps the draft id, excludes extras and carries the elective columns.

**And a fixture that had stopped telling the truth.** The isolation sweep inserted draft slots directly with a NULL `draft_id`. That was harmless while one draft existed; once `generate` creates a registry row those slots fall outside the draft the board reads, and `board/remove` went back to refusing *both* sessions — which the gate correctly reports as proving nothing rather than passing. The fixture now builds a real draft row and a published row, because that is how every write path in the app builds a slot.

**Three more single-draft assumptions the gate's second run flushed out:**

- **Locked cells were collected across every draft.** `buildSolverInput` read `status:'draft' AND is_locked` unscoped, so generating Draft #4 would treat Draft #2's pinned cells as fixed — invariant 13 applied across a boundary it was never meant to cross. It now takes a `draftId`, resolved in the worker *before* the input is built.
- **The board `context` cache was shared across drafts.** It carries the locked cells the client engine treats as immovable, under one `ctx` key — so Draft #4's board would have been handed Draft #2's pins. Keyed by draft now.
- **`invalidateTimetable(configId)` deleted three exact keys.** §22 made the suffix open-ended (`slots:119:draft:d7`), so every per-draft payload survived a board edit as a stale copy. It sweeps the config's prefix now (`configSlotsKeyPattern`).

**And a UX consequence found by a failing gate check, not by looking.** `currentId` returned the newest editable draft — but Generate creates its draft immediately and the worker fills it seconds later, so the board would switch to the empty new draft the moment the button was pressed and show a blank week until the solver finished. `currentId` now prefers the newest draft **that has rows**; an empty one becomes current exactly when it is worth looking at.

### Step 2 — the screens

Built against the UI mockup's §22.5 design.

| Task | Deliverable |
|---|---|
| 17.5 | **Draft picker** on the Draft Board, left of everything else because it scopes everything else: `Draft #2 — Labs freed Friday · 98.4%`. Passes `?draftId=` to both `/slots` and `/board/context`. |
| 17.6 | **Five stat cards** — Generation %, Total allocation, Actual allocation, Errors (red > 0), Warnings (amber > 0) — read off the registry row, never counted per render (§14). |
| 17.7 | **Compare panel** — every live draft side by side, best value per column highlighted, `Publish this →` per row, plus discard (the 5-cap needs an escape or a school gets stuck). |
| 17.8 | **Status-aware pill** (`DRAFT #2 — not published` / `ARCHIVED` / `PUBLISHED`), `＋ New draft` forking the draft on screen, and `Publish Draft #N…` carrying the id. |
| 17.9 | `publish/preview?draftId=` and `POST board/publish {draftId}`; the Publish screen reads `?draftId=` so a Compare row publishes the draft it names. |
| 17.10 | **`scripts/drafts-smoke.cjs`** — isolation-suite step 15. |

**Status — shipped.** All 33 checks of the new smoke passed on the first run.

**Two judgement calls the mockup did not settle.**
- **`＋ New draft` forks the draft on screen** rather than creating an empty one. An empty draft is 2,000 cells of nothing to drag; "try something on a copy of this" is what the button is actually for, and it matches the mockup's own `Draft #3 — Manual edits on 6–8 wing`.
- **A column where every draft ties is not highlighted.** Marking all three as the winner tells a reader nothing, and the panel exists to answer "which one is looking good".

**What the smoke pins that no unit test could.** Two complete weeks holding *all twenty* of the same cells at once — `uq_class_slot` would have refused that before §22 — an edit leaving the other draft byte-identical, the cap refusing the sixth with a reason and then letting one through after a discard, and publishing #2 while #1 stays a complete editable week. Plus the two things §18 and §22 have to agree on: an extra class carries **no draft id**, collapses to scope 0, is never copied by a fork, and survives the publish.

## Phase 18 — Print / PDF that looks like a document (§10.4)

Reported as: *"Print/PDF is taking the complete page screen, whereas it should only print the timetable. The PDF should be presentable with all important details like Class, Teacher etc. The heading should be proper with School Logo, School Name. There should be an option to generate PDF for all the classes at one shot."*

Four separate things, one of which was a plain omission: **there was no `@media print` stylesheet in the app at all.**

| Task | Deliverable |
|---|---|
| 18.1 | Print stylesheet: A4 **landscape** (a 5–7 column week in portrait squeezes teacher names to three lines), `print-color-adjust: exact` so break shading / elective tint / substitute highlight survive, page-break rules, and cards flattened to plain sections on paper. |
| 18.2 | `.screen-only` / `.print-root` inversion — hide everything, reveal the sheets. **Not** an enumerated hide-list, which is a list somebody forgets to extend. |
| 18.3 | `PrintSheet.tsx` — masthead with school logo (initials fallback when the ERP supplied no `logoUrl`), school name, timetable name; then class/teacher, class teacher or weekly load, days, periods/day, cells filled, and whether it is the standing timetable or a dated view with substitutions. |
| 18.4 | **Print all** — one sheet per class-section or per teacher, each on its own page, from the same `GridPayload` the screen renders. |

**Status — shipped.** Lint, web typecheck and build clean. Measured on School 2: 56 class-sections / 122 teachers available; 8 sheets fetched in 95 ms, so a full run is well under a second.

**Three things that are not obvious and would each have produced a silent bug:**
- `window.print()` in the same tick as the state update prints the **previous** render — a blank page. Two `requestAnimationFrame`s are the cheap, reliable fix.
- Sheets render **into the page**, not a popup: a popup inherits none of the app's stylesheet and is blocked about half the time.
- Sheets are fetched **four at a time**. They are Redis-cached (§14), but sixty parallel requests is how a report screen becomes an outage.

**Not done:** My Timetable / My Classes still print the old way — they render the same `WeekGrid` and could reuse `PrintSheet`, but the report was about Reports and widening it was not asked for.

## Phase 19 — Clone a timetable into a new session (§3.11, §3.12)

Reported as: *"In Timetables page, I want an option to clone an existing timetable, so that I don't need to create a new timetable which is having same entries. For the session 25-26 I generated one timetable, now I want the same entry point for session 26-27 — then I should clone it and do necessary changes and then generate the fresh one. This will save a lot of user time to do the data entry."*

Cloning Second Branch's timetable would carry **~630 rows** a person would otherwise re-type: 11 periods, 56 class-sections with their home rooms and class teachers, **376 subject mappings**, 6 merged groups, 8 elective blocks with 32 members and 24 options, and 100 curriculum rows.

Two steps, because investigating the first turned up work that has to land before a clone can be correct.

### Step 1 — Year-scope the curriculum (§3.11) ✅

`class_subjects` had **no year dimension at all**: one row per (class, subject) served every session at once. That is invisible in a one-year school — which is every school shipped so far — and becomes wrong the moment a clone makes two live years normal.

| Task | Deliverable |
|---|---|
| 19.1 | Migration: `academic_year_id` added, backfilled per school (active year, else earliest by start date), then `NOT NULL` + FK; unique key `(class_id, subject_id)` → `(class_id, subject_id, academic_year_id)`. |
| 19.2 | `buildFeasibilitySnapshot` filters curriculum by the config's year. |
| 19.3 | **Cross-config teacher load is same-year only** — the bug below. |
| 19.4 | `capacityForClass` takes the year. |
| 19.5 | `POST /class-subjects` requires the year; `GET` takes it as an optional filter; `PUT` cannot move a row between sessions. |
| 19.6 | Importer: Curriculum sheet gains a required **Academic Year** column, matching Class Sections; duplicate key and `capacityByClassSection` both carry the year. |
| 19.7 | Curriculum screen reads the year from the timetable already selected — no second selector. |
| 19.8 | `scripts/year-scope-smoke.cjs`, wired into the isolation suite as step 19.1. |

**Status — shipped.** All 122 existing curriculum rows backfilled, zero nulls, zero cross-school year assignments. 235 shared + 121 api tests, import smoke, and the full isolation suite (including the new step) all pass. Lint, typechecks and web build clean. Second Branch still reads 100% readiness.

**The bug this uncovered, which would have made the clone feature ship broken.** `buildFeasibilitySnapshot` summed a teacher's load from every *other* config with **no academic-year condition** — so rolling a school into a new session counted every teacher twice, Check 2 failed across the entire staff, and a freshly cloned timetable read as hopelessly overloaded on the first screen the admin sees. Nobody had hit it because no school had two years. The smoke pins both halves: last session's periods count **0**, while another wing of the *same* session still counts (§3.10).

**Why the shared package needed no changes.** The engines never query the database — they read the snapshot, keyed `classId:subjectId`. One filter in the snapshot builder was enough. Had it been missed, `new Map()` in `solver/variables.ts` would have collapsed two sessions' rows to whichever loaded last and timetabled the wrong syllabus silently.

**Two decisions worth keeping.** The year is **required on write, never defaulted to the active year** — a row filed against the wrong session is invisible until the timetable comes out wrong, and the importer loads hundreds at once. But it is **optional on read**: a `GET` that 400s for everybody tells the §17.8 sweep nothing.

**A trap for whoever works on the importer next.** `packages/shared/src/import/validate.ts` contains literal control characters (the deliberate strip-regex), so `grep` treats it as **binary and silently reports no matches**. Use `grep -a`. Searching it normally suggests the validator handles nothing at all.

**Also added to the isolation suite**: a check that a school cannot file a curriculum row against *another* school's academic year. A new foreign key is a new way to point into someone else's data, so it gets its own case rather than riding on the `classId` one.

### Step 2 — The clone itself (§3.12) ✅

| Task | Deliverable |
|---|---|
| 19.9 | `clone.service.ts` — `plan()` and `commit()`. One `oldSectionId → newSectionId` map; every dependent table is a straight re-point. |
| 19.10 | `POST /timetable-configs/:id/clone/preview` (writes nothing, not even the target year) and `POST /timetable-configs/:id/clone`, both `masters.manage`. |
| 19.11 | Refusals with reasons: same session, taken name, no target, a class-section already claimed by another timetable. |
| 19.12 | Staffing notes — inactive and `guest` teachers dropped and named; §18 eligibility breaches warned but kept. |
| 19.13 | `CloneTimetable.tsx` + a **⧉ Clone** button per card on the Timetables screen. Preview first, always. |
| 19.14 | Year filters on `GET /mappings` and `GET /elective-blocks`, wired to the chosen timetable — without these the clone breaks the screens it feeds. |
| 19.15 | `scripts/clone-smoke.cjs` (47 checks), isolation-suite step 19.2. |

**Status — shipped.** All 47 clone checks pass, plus the full isolation suite. On the real reference school the preview computes **637 rows in 152 ms**: 11 periods, 56 class-sections, 56 class teachers, 100 curriculum rows, 376 mappings, 6 merged groups, 8 elective blocks with 24 options — no blockers, no warnings.

**What the smoke pins that no unit test could.** A fixture holding one of everything: a home room, two class teachers, a merged group across two sections, a §4.9 split elective with two options in two rooms under two teachers, a published slot, an §18 extra class, and one teacher who has left. After the clone: every member and option re-pointed at the *new* sections, `placement: same_period` preserved, and **zero** slots, drafts, publications or extra classes. The departed teacher's Maths mapping is absent while the curriculum still asks for its 6 periods — so Readiness names the gap rather than the timetable failing at Generate.

**Two things the sweep proved that a one-sided probe could not.** Both new routes discriminate rather than merely refuse: `A 201 · B 404 on the same config`. A route that 404s for everybody would have sailed through a weaker check.

**The decision that shaped the feature.** Copy the inputs, never the outputs. It is what makes the clone safe (it never touches the §22 `draft_scope` unique keys), what makes it honest (the admin adjusts and presses Generate, as they were going to), and what makes the not-copied list explicable rather than arbitrary.

**A consequence worth naming.** Cloning is what makes duplicate-looking rows normal, so three list screens needed a year filter or they would show two sessions at once with nothing to tell them apart — "Class 5-A · English · Mrs Rao" twice on Teacher Mapping, "Class 5 Third Language" twice on Electives. A feature that breaks the screens it feeds is not finished, so those went in here rather than being left as a follow-up.

**Not done:** the preview reports the *source's* current readiness rather than simulating the clone's. Projecting a readiness score for rows that do not exist yet means building a synthetic snapshot, and the source's number is both truthful and the one that matters — the clone reproduces its structure. The commit response returns the new timetable's **actual** score.

## Phase 20 — Subject and class colour code (§10.5)

Reported as: *"Now we have to give decent colour codes to Subject and Classes, so that wherever Subject and Classes are showing then that cell should be shown with that colour, and font colour with the same colour in dark."*

| Task | Deliverable |
|---|---|
| 20.1 | `packages/shared/src/colors/palette.ts` — 32 swatches (16 hues × 2 tones), FNV-1a hashing, and the **set-aware** `assignSwatches`. The only place a colour is chosen. |
| 20.2 | `palette.spec.ts` — recomputes every WCAG ratio and hue gap from the hex values; proves the 20 real subjects come out distinct. |
| 20.3 | `GET /me/colors` — names and ids, session only, so every role gets the *same* scheme. |
| 20.4 | `ColorProvider` at the app root; one request, one assignment, shared by every screen. |
| 20.5 | Applied to WeekGrid (Reports, My Timetable, My Classes, the printed PDF), the Allocation Matrix, and the Board's cards and tray. |
| 20.6 | `print-color-adjust: exact` on `*`, not just the root. |

**Status — shipped.** 248 shared tests (13 new), lint, api + web typecheck, web build, and the full isolation suite. On the reference school: **20 of 20 subjects and 14 of 14 classes get distinct colours**, worst contrast in actual use **5.50:1** (AA is 4.5:1), `/me/colors` in 20 ms.

**Why the assignment is set-aware, which is the whole design.** A bare `hash(name) % 32` leaves about five of twenty subjects sharing a colour with another — and widening the palette does not fix it, because that is the birthday problem, not a palette that is too small. Going past 16 hues makes the hues themselves indistinguishable. So a name hashes to a *preferred* slot and probes forward if taken, processed in sorted order so the result depends on the set and never on the order it arrived in. Two screens fetching the same subjects in different orders must not disagree.

**One module, or it is worse than nothing.** If each grid derived its own colours, Maths would be green on the Board and blue on the Matrix — and a reader would have *learned something untrue*, which is worse than an uncoloured grid. Same rule as the constraint engine.

**Nothing was painted over.** Substitution keeps its cyan (on a cover sheet "what changed today" outranks which subject it is); a pinned card keeps the grey locked fill; a §4.9 block keeps its dashed steel tint in a *class* row because it is several subjects at once — but takes its option's real colour in a *teacher* row, where it is one lesson; merged keeps its double border and 🔗; breaks keep their hatching.

**Three details that would each have been a silent bug.**
- The Matrix abbreviates names for the 50×40 grid, so the cell carries a separate `colorKey` with the full name — looking up "Mat" would have matched nothing and silently produced an uncoloured matrix.
- `classOfLabel` splits on the **last** hyphen: "Pre-Nursery-A" must become "Pre-Nursery", not "Pre".
- `print-color-adjust` does not inherit reliably to descendants; on `html, body` alone, Safari drops every `<td>` background and the printed timetable comes out grey.

**A permission finding.** `/subjects` and `/classes` are `masters.manage`, so a teacher cannot read them — and a teacher falling back to a different scheme would see Maths in a different colour from the admin looking at the same timetable. Hence `GET /me/colors`, session-only, names and ids. Returning **ids** rather than bare names was deliberate: it gives the §17.8 sweep something real to compare, and it duly reports `A 8 id(s) · B 2 · none in common` instead of shrugging at a payload with nothing to check.

**Not done:** colours are assigned automatically and cannot be overridden. Adding a `color` column plus a swatch picker on the Subjects and Classes screens is a small, self-contained follow-up if a school wants to insist Maths is blue.

## Phase 21 — Generate into a chosen draft (§22.2)

Reported as: *"While generating timetable it's giving this error because there are 5 drafts: `This timetable already has 5 drafts… Discard one first.` We should provide a dropdown to list all draft timetables. Which one to update will be decided on this."*

The five-draft cap (§22.2) is about legibility — a Compare table nobody can read is not a comparison — and it stays. What was wrong is that **the only way past it was to throw work away.** The server already accepted `draftId` on `POST …/generate`; the Generate screen simply never sent one, so a school at the cap could not press Generate at all.

| Task | Deliverable |
|---|---|
| 21.1 | **Write into** picker on the Generate screen: "＋ A new draft" (default, disabled at the cap) plus every live draft, each showing its number, label, status and fill %. |
| 21.2 | An inline line saying exactly what the chosen option does — including the published case, where the working copy is replaced and the live timetable is not. |
| 21.3 | At the cap the Generate button is **disabled until a target is chosen**: there is nothing safe to default to when every option overwrites a week. |
| 21.4 | `DraftsService.assertWritable` — a *discarded* draft is refused, since generating into one produces a timetable no screen shows. |
| 21.5 | The cap message names both ways out instead of only "discard one first". |
| 21.6 | Eight new checks in `drafts-smoke.cjs`. |

**Status — shipped.** Verified against the reported situation itself: config 119 (Second Branch) was genuinely at five drafts. The old call reproduced the reported 400; targeting Draft #6 was accepted, and the worker's run wrote **2,360 rows into that draft alone** — its `generated_at` freshly stamped, every other draft's stamp and row count unchanged, the published set and the §18 extra classes untouched.

**Why nothing else needed to change.** `writeDraftSlots` already scopes its delete to `status='draft' AND draft_id = <this draft>`, keeps 🔒 pinned cells, and skips `source='extra'`. And `buildSolverInput` already resolves locked cells per draft, so regenerating Draft #4 respects Draft #4's pins and not Draft #2's. Phase 17 built the targeting; only the way to ask for it was missing.

**The published-draft case, which is the one worth knowing.** Publishing flips a draft's rows in place to `status='published'`, so a published draft has **no draft rows left** — which is why the Board shows it blank. Generating into it therefore refills its working copy without touching the published timetable at all. That is a real workflow ("revise what we published"), so it is allowed rather than blocked, and the picker says so in as many words instead of leaving the admin to guess.

**Not done:** the cap itself is unchanged at five, and there is still no "discard" control on the Generate screen — the Board owns that, and the message now points there.

### 21.7 — the same picker on the Allocation Matrix

Reported as: *"Allocation Matrix should also have the Draft dropdown to see the timetable."*

The Matrix read `GET /slots` with no `draftId`, so it always showed whichever draft the server resolved as current — a school with five of them could compare nothing. It now carries the **same** picker as the Board, in the same place (first in the filter row, because it scopes everything after it) with the same label format, and the status chip says `draft #6` rather than a bare `draft`.

Two judgement calls. The picker is **hidden on the Published view**: there is exactly one published set per config however many drafts it was promoted from (§22.2), so offering a choice there would ask a question with no answer — and the server duly returns `draftId: null` for it. And the initial selection comes from **the server's own answer** (`data.draftId`), not from a client guess at "the newest": `DraftsService.currentId` prefers the newest draft *that has rows*, so a guess would have labelled the dropdown with a different draft from the one on screen.

**Status — shipped.** Verified on the reference school's five real drafts: each `draftId` is answered by that draft (`served draftId` matches every time), the five return **four distinct week-hashes** — #1 and #3 match because §22.5's `＋ New draft` forks the draft on screen — and `status=published&draftId=…` correctly answers `draftId: null`. All within budget at 7–145 ms.

**A gap this closed.** `GET /slots?draftId=` — which every grid in the app rides on — had **no smoke coverage at all**. Four checks now pin it, including that two drafts return genuinely different weeks rather than one cached copy served twice, which is the failure that would have made the picker change its label and nothing else: the worst kind of broken, because it looks like it worked.

### 21.8 — the Publish Confirmation screen names its draft

Reported as: *"Publish Confirmation page is not linked with Draft, which Draft to publish."*

The server was never the problem: `preview` and `publish` both take a `draftId` and both already call `assertOwned`. The screen read one from the URL — so arriving from the Draft Board's Compare row worked — but **had no picker of its own and never named the draft anywhere on the page.** Reaching Publish from the sidebar showed a version number and a diff for a draft it did not identify, and a school with five of them had no way to tell which was about to go live, nor to change it without going back to the Board.

| Task | Deliverable |
|---|---|
| 21.8a | A **Publish ▾** picker, same convention as the Board and the Matrix, listing the drafts that can actually be published. |
| 21.8b | The draft is named in the card (`Draft #6 → v3`), the confirm dialog, the button, and the success screen. |
| 21.8c | The picker writes `?draftId=` back to the URL, so refresh and shared links keep meaning the same draft and the Board's deep-link still works. |
| 21.8d | Publish posts the draft **on screen**, not only one that arrived in the URL. |
| 21.8e | Four new checks in `drafts-smoke.cjs`. |

**Status — shipped.** Verified on the reference school's five drafts: each `draftId` produces its own diff against the live timetable — **0, 922, 10, 916 and 916 changed cells** — so the preview demonstrably follows the draft it is asked about rather than the server's current one. An unknown draft is a **404**, not an empty diff.

**The bug inside the bug.** `publish()` posted `draftId` from the URL. With a picker added but that line left alone, choosing a draft would have redrawn the whole diff for it and then published a *different* one — the version that looks like it works. It posts `shownDraftId` instead.

**Two things the screen now admits.** A draft that is already published, or was archived by a later publish, has **no draft rows left** — §22.4 flips them in place — so it would publish nothing; the picker lists only editable drafts and explains the case rather than leaving a mysteriously disabled button. And the success line used to read *"the draft board is now empty until you start the next revision"*, which stopped being true the moment a config could hold five: it now says the other drafts are untouched, which is what §22.4 actually does.

**A gap this closed.** The smoke asked the publish preview about one draft only, so a preview that ignored the parameter entirely would have passed. It now asks about the *other* draft first, which is the ordering that can fail.

## Phase 22 — ERP master-data sync (§23)

Reported as: *"This timetable application will be linked with our existing ERP, the SSO will be done through the ERP. Now I need a sync option where I can sync the existing data of all our masters — school details, class-section, subject, teacher information."*

**Decisions taken:** direct read of the ERP database; **ERP wins on its own fields** (field-level, never wholesale); scope is the five core-identity masters — academic years, classes, class-sections with strength, subjects, teachers.

| Task | Deliverable |
|---|---|
| 22.1 | `packages/shared/src/sync/contract.ts` — the **field-ownership table**. The ERP's fields per sheet; everything else is the timetable's and is never written on an existing row. |
| 22.2 | `sync/reconcile.ts` — pure new/update/unchanged, comparing only ERP-owned fields, forgiving about how two systems spell a value (case, whitespace, DATE vs DATETIME, TINYINT vs boolean, `30` vs `"30"`). |
| 22.3 | `reconcile.spec.ts` — 15 tests, including a guard on the ownership table itself. |
| 22.4 | `apps/api/src/sync/erp-map.ts` — one visible SELECT per master, `ERP_QUERY_FILE` override, and `assertReadOnly`. |
| 22.5 | `erp-source.service.ts` — the read-only connection and `probe()`. |
| 22.6 | `sync.service.ts` + three `masters.manage` endpoints: probe, preview, apply. |
| 22.7 | `SyncErp.tsx` at `/sync`, under **Build** beside Import from Excel. |
| 22.8 | `scripts/erp-sync-smoke.cjs` — 27 checks against a **fixture ERP database** the dev stack now provides; isolation-suite step 22. |

**Status — shipped.** 263 shared + 121 api tests, lint, typechecks, web build, and the full isolation suite (22 steps) all pass.

**Why so little of this is new.** `validateWorkbook` takes plain rows, not Excel, so the sync inherits the entire §16 pipeline by producing the same shape. What a sync genuinely adds is *update*, which an importer never does.

**The property everything turns on, and how it is proved.** The smoke sets a teacher's `maxPeriodsPerDay`, `minPeriodsPerDay`, `maxPeriodsPerWeek`, `periodPattern`, `alternateDaySet`, `classTeacherPeriodRule` and `employmentType` by hand, and a subject's lab flags; then the fixture ERP renames her and re-counts a section. After the sync: **the name changed and every one of those scheduling fields is byte-identical.** A sync that reset them would change the next Generate's output with nothing on any screen saying why — the most expensive kind of silent bug this system can have.

**A fixture ERP, because the alternative is untestable.** `docker compose up` now sets `ERP_DATABASE_URL` to a dev-only `erp_fixture` schema; the smoke creates it, shapes it like the shipped queries, drives the real endpoints against it, and drops it. Without it the sync could only be tested against somebody's production ERP, which is not a thing you can run twice.

**A bug the smoke caught in my own code.** `probe()` reported a failed query's reason as `e.message.split("\n")[0]` — and a **Prisma error message begins with a newline**, so the probe returned an *empty error string*. A probe that says a query failed and will not say why is precisely the failure the endpoint exists to prevent. Now it finds the driver's own line (`Unknown column 'code' in 'field list'`).

**Earning the §17.8 exemption rather than asserting it.** The sync routes carry no id, so the sweep failed the build demanding a decision. The exemption is backed by a real check: two schools, one ERP database, each syncing — B's preview shows B's rows and none of A's, B's writes land only in B, and A's teachers are untouched.

**Not done, and deliberately.** Teacher→subject→section allocation, class teachers and rooms are out of scope for this step (you chose core identity). Scheduling is unattended-ready but not yet scheduled — the BullMQ nightly job is a small follow-up, and the fair-scheduling cap (§17.7) already exists to carry it. And the shipped SQL is a guess at your schema: run `GET /sync/erp/probe` first, and correct `erp-map.ts` where it names a missing column.

### 22.9 — the fixture ERP had to survive its own test

Reported as: *"giving this error — Invalid `prisma.$queryRawUnsafe()` invocation: Database `erp_fixture` does not exist"*

My fault, twice over.

**The dev stack pointed at a database that only existed during a test.** `erp-sync-smoke.cjs` created `erp_fixture` at the start and **dropped it at the end** — so anyone who ran the suite and then opened the Sync screen found it permanently broken. A test that breaks the thing it tests.

Fixed by splitting the seed from the test: `scripts/seed-erp-fixture.cjs` creates the stand-in ERP (2 schools, 5 classes × 2 sections, 6 subjects, 6 teachers each, keyed on the seeded `SCHOOL-1`/`SCHOOL-2` codes so the screen works out of the box). The dev stack runs it at startup, and the smoke now builds **from that same seed** and hands the fixture back seeded rather than deleting it — with two checks asserting exactly that, so the regression cannot come back quietly.

**And the error said nothing about what to do.** `Database erp_fixture does not exist` is accurate and useless: a symptom with no remedy, which is precisely what the §4 message contract exists to rule out. `explainConnection` now translates the four failures an operator actually meets when first pointing this at an ERP:

| Driver says | Operator reads |
|---|---|
| `Database X does not exist` | which database is missing, on which host, and the command that creates the dev one |
| `Access denied` | the credentials were refused — the sync needs a **read-only** user |
| `ECONNREFUSED` / can't reach | check host and port, and that the container can see the ERP's network |
| `Unknown column` | the ERP's schema differs from `erp-map.ts` — correct it, or override with `ERP_QUERY_FILE` |

**Worth knowing when you try it.** The fixture ERP is *demo* data keyed to the same school codes as the seed, so previewing against Second Branch reports real-looking changes (5 classes, 10 section strengths). That is the sync working correctly against fixture data — do not apply it to a school whose masters you care about until `erp-map.ts` points at the real ERP.

### 22.10 — the REST-API source (§23.6)

Reported as: *"How should the API of the existing ERP be integrated, what do I have to do to use the existing REST API? The newly built page doesn't talk about the API integration."* — and then: *"provide both the options, connect with DB or through API."*

A fair catch: Phase 22 shipped the database adapter that was chosen and never opened the REST path, so the screen only ever offered one way in.

| Task | Deliverable |
|---|---|
| 22.10a | `packages/shared/src/sync/json-map.ts` — dotted-path `pick`, `pickList`, `mapRecord`, `fillTemplate`. Pure; 13 tests. |
| 22.10b | `erp-reader.ts` — the four-method source seam. |
| 22.10c | `erp-db.reader.ts` — the existing SQL source, moved behind it unchanged. |
| 22.10d | `erp-http.reader.ts` — the REST source: declared endpoints, dotted field paths, pagination, bearer or header-key auth, GET-only. |
| 22.10e | `ErpSourceService` picks on `ERP_SOURCE`, and `explainConnection` grew an HTTP arm (401/403 → which setting; 404 → which path; shape mismatch → `ERP_API_FILE`). |
| 22.10f | The screen shows **which** source answered and, when a mapping fails, the ERP's own record beside the failure. When nothing is configured it now documents **both** routes rather than only the database one. |
| 22.10g | Six new smoke checks against a stand-in ERP **API**. |

**Status — shipped.** 276 shared + 121 api tests, lint, typechecks, web build, isolation suite (22 steps), and `erp-sync-smoke` at 34/34.

**How the seam is actually proved rather than asserted.** The stand-in ERP API wraps the *same fixture database* the SQL source reads, so the two must agree row for row — if they disagreed, the seam would be a lie. Its `/sections` endpoint returns **nested** JSON (`class.name`, `session.name`) the way a REST API returns what SQL would join, which is what the dotted paths exist for; and `/staff` pages **one record per page**, so pagination is exercised rather than assumed.

**Driven through `ErpHttpReader` directly, not by flipping the running server's `ERP_SOURCE`.** A dev endpoint that rewrites `process.env` on a live API is a poor trade for test convenience, and everything above the reader is already proved by the database path.

**Two of my own test expectations were wrong, not the code.** Page size 2 with only 2 teachers left (step 5 deletes one) fits on one page and proves nothing — now one row per page. And an earlier run mis-stated the row count as 10 when the five masters sum to 13.

**Which to choose.** *(Superseded by 22.11 — the database source has since been removed.)* Direct DB needed no ERP development and was fastest to working, at the cost of coupling to their schema. The REST route survives their schema changes and needs no database credentials or network path, at the cost of endpoints being exposed.

### 22.11 — REST only, per-master buttons, and deletion that is counted first (§23.3–23.4)

Reported as: *"Remove the DB integration part. The sync process will be simple — it should get synced through API only. Just provide the option in backend where I or you can add the APIs which I will provide later for each master... For each master provide one button, on click it should sync the data successfully. While sync, if there is any existing data exists then ask to remove them all with its dependencies and insert the fresh data always. But before deleting, give the proper alert message. It should provide the logs of each sync."*

**What I flagged before building, and what I built.** "Delete all and re-insert" is one sentence and about fifteen tables, and the schema decides the cost: `timetable_slots` has **no foreign keys to the masters**, so deleting a teacher raises nothing, warns nothing, and leaves every published timetable pointing at a teacher that no longer exists. Same for `users.teacher_id` and both teacher columns on `substitution_log`. So I built the destructive mode as asked, and added a key-preserving one beside it that reaches the *same data* without re-minting ids — defaulted to that, and made the alert say what actually goes.

| Task | Deliverable |
|---|---|
| 22.11a | The database source deleted: `erp-db.reader.ts`, `erp-map.ts`, `ERP_SOURCE`, `ERP_QUERY_FILE`, `ERP_DATABASE_URL` from the app. `ErpReader` stays as the test seam. |
| 22.11b | `SyncMode` + `SYNC_DEPENDS_ON` in the contract; `reconcileSheet` gains removals and a `replace` mode, carrying our row id on every matched verdict. |
| 22.11c | `apps/api/src/sync/dependencies.ts` — the cascade, each step declaring its **count and its delete in one object**. |
| 22.11d | `erp_sync_runs` + migration `20260901090000` — one row per master per run, `ok` / `failed` / `blocked` alike. |
| 22.11e | Per-master endpoints: `status`, `probe`, `preview`, `apply`, `reload`, `logs`. Confirmation by typed school name, bound to the shown impact by `fingerprint`. |
| 22.11f | No built-in endpoint guesses; per-master "not configured"; `scripts/erp-api.example.json` as the template. |
| 22.11g | `SyncErp.tsx` rebuilt: five cards, Sync + Replace all per card, the itemised alert, and a sync-history panel. |
| 22.11h | `scripts/fake-erp-api.cjs` + the dev-only `erp-fake` compose service — the app now reaches its ERP over HTTP from another container, with a token, as production would. |
| 22.11i | `erp-sync-smoke.cjs` rewritten: **67 checks**, 13 steps. |

**Status — shipped.** 278 shared + 121 api tests, lint, both typechecks, web build, `migrate:all` across all 3 databases, the full isolation suite (19 steps incl. the exhaustive sweep), and `erp-sync-smoke` at 67/67.

**A bug my own code had, of exactly the kind this feature exists to prevent.** `countImpact` counted published slots with `{ classSection: { classId: { in: ids } } }` — a nested relation filter on a relation that **does not exist**, which is the entire premise of the file it was written in. Prisma rejected it outright, which is at least honest; a laxer ORM would have counted zero and the confirmation would have under-reported a destructive write. Now it resolves section ids first and filters on a plain id list.

**Two things the smoke proves that a reading could not.** After a confirmed removal: the teacher's mappings, her *published* timetable rows, her class-teacher assignment and her **user login's `teacher_id`** are all gone or cleared — nothing is left aimed at an id that will be reused — while the `timetable_config` itself survives. And `replace` on three subjects that all still exist in the ERP produces **three entirely new ids**, which is the property that makes it the wrong default.

**A test that encoded a rescinded decision.** `reconcile.spec.ts` asserted *"does not report a row missing from the ERP — a sync adds and updates, it does not delete"*. That was the old rule, not a bug; the spec now asserts the new behaviour in both modes, and a sibling test keeps the distinction that still holds — **inactive is not absent**.

**What is deliberately refused.** Replacing an academic session that a timetable belongs to: the sync names the timetable and stops. A masters button is not consent to delete a school's period structure, drafts and publication history.

**Not done.** The nightly BullMQ job is still unbuilt (the §17.7 fair-scheduling cap already exists to carry it), and teacher→subject→section allocation, class teachers and rooms remain out of sync scope. The shipped endpoint paths in `erp-api.example.json` are a template, not your API — fill in `ERP_API_FILE`, then `POST /sync/erp/reload` and read the probe.

### 22.12 — the ERP's API is secured (§23.8)

Reported as: *"ERP API's are secured and it should be done through SSO token, let me know how it will be done."*

**The literal thing cannot be done, and I said so before building.** The ERP's SSO token is single-use (`AuthService` burns its `jti`), short-lived, and discarded at `/sso/callback` in favour of our own session JWT — which the ERP has no reason to trust. By the time an admin presses Sync it is long gone, and a scheduled sync never had one. What survives is the part worth having: **who asked**.

**Decision taken:** OAuth2 client credentials.

| Task | Deliverable |
|---|---|
| 22.12a | `apps/api/src/sync/erp-auth.ts` — `oauth2` / `bearer` / `none` behind one `headers(actingUser)` call. Token cache with a shared in-flight grant, refresh-before-expiry, and a bounded lifetime when the ERP omits `expires_in`. |
| 22.12b | A 401 refreshes the token and retries **exactly once**; `ErpReader` threads `actingUser` as a parameter, never as reader state. |
| 22.12c | `auth` block in `ERP_API_FILE`; the secret lives in the env var the block *names*. `unconfiguredReason()` reports a missing secret once, by name. |
| 22.12d | `actingUserHeader` carries the SSO identity of whoever pressed Sync; absent on an unattended run. |
| 22.12e | The stand-in ERP is now secured: `/oauth/token`, 401 on expired or revoked tokens, plus `_test/stats` and `_test/revoke` so the auth path is observable rather than assumed. |
| 22.12f | `erp-auth.spec.ts` — 18 tests. `erp-sync-smoke.cjs` — **74 checks**. |

**Status — shipped.** 278 shared + 139 api tests, lint, both typechecks, web build, `erp-sync-smoke` 74/74, full isolation suite.

**What the smoke proves that a reading could not.** The whole 13-step suite now runs on OAuth2 — **108 reads on 5 tokens**, so caching is measured rather than claimed. The ERP records `X-ERP-Acting-User: ZZERP-1`, so the admin's identity demonstrably arrives. And revoking every token behind the app's back produces `+1 token, +1 401`: the 401 really happened and the sync still succeeded, which is the retry path rather than a cached success.

**Two of my own mistakes, both in tests rather than code.** A "refreshes before expiry" test asserted a 40s token would be refused on the second call — but 40s minus the 30s margin still leaves 10s of usable life, so the code was right; rewritten with fake timers to assert the real property (a 3600s token refreshes at 3580s, *while the ERP would still accept it*). And the 401-retry check first reported `+0 401`, because step 11's mapping reload rebuilds the reader and drops its cached token — the next call minted a fresh one and never met a 401. Fixed by warming the cache after the reload, not by weakening the assertion.

**The one thing with a blast radius beyond this feature** is a secret in an error message: these are rendered on screen and written to `erp_sync_runs.error`. Two tests assert it never happens, and messages name the *variable* instead.

**If you later want identity-based auth rather than a client secret**, the seam is ready: a `jwt_assertion` mode would sign a 60-second RS256 assertion with our key, which the ERP verifies against our public key exactly as we verify its SSO tokens — the same trust relationship, reversed. Not built, because you have OAuth2.

## Phase 23 — Teacher availability (§4.7a)

Reported as: *"now we have to built teacher availibility option, where admin can mark the teacher availbility as per the teacher preference... Teacher is not available every Monday & Friday from 1st to 4th period... not available 2nd half daily... comes to school after 10 AM."*

`teacher_unavailability` already existed (one row per blocked cell, `period_number = NULL` meaning the whole day) and had no screen — Phase 1 deferred it. This is the screen, plus the four call sites that had to agree with it.

| Task | Deliverable |
|---|---|
| 23a | `apps/web/src/pages/Availability.tsx` — week grid per teacher, click to block, quick patterns compiled to cells. |
| 23b | Quick patterns: arrives-after, leaves-by, second-half, whole-day. **Entry shortcuts, never a second rule model** — they resolve against the config's real period times and write ordinary cells. |
| 23c | A day with every period blocked collapses to one `period_number = NULL` row, so it survives the timetable gaining a period. |
| 23d | Four consumers agree: solver domain pruning *before search*, board drop refusal, Check 2's weekly capacity, and the substitute engine dropping the teacher from the candidate list rather than scoring them down. |

**Status — shipped.** Route `/availability` under Build.

**Not done:** dated one-off absences ("Meera is out 12–14 Oct") are a different thing from a recurring pattern and still live only in the Substitute Center's absence flow.

## Phase 24 — Natural-language master-data entry (§13.5)

Reported as: *"AI should be capable of adding Classes, Section, Subject, Teacher, Curriculum, Teacher Mapping. User can just write the prompt and it should insert the data with all validation... Also provide one floating icon of AI on bottom right."*

The §12 roadmap always listed this, and always with the words *"with confirmation screen"* — which is not a nicety in that sentence, it is the mechanism. **The model proposes; a person disposes; the existing validated committer does the writing.**

### 24.A — adding

| Task | Deliverable |
|---|---|
| 24a | `packages/shared/src/ai/data-entry.ts` — the adapter. `RawSheet` cells are keyed by header text, which a model reproduces unreliably and fails at *silently*; this accepts either the header or the field key, in any casing, and **reports a key it cannot place**. Its column guide is generated from the import contract, so it cannot drift. |
| 24b | `draftMasterData` — one tool, several sheets per call, because the validator is cross-sheet. |
| 24c | `AiDataEntryService` — school-keyed Redis stash, 30-minute TTL, single-use. **Apply takes a proposal id, never rows**, and re-validates at the moment of the write. |
| 24d | `ProposalCard.tsx` + `AiDock.tsx` — the confirmation screen, and the floating assistant. |
| 24e | `COMMON_SUBJECTS` catalogue + multi-select picker; `masters.manage` enforced in the tool list, in the handler and on the endpoint. |

### 24.B — changing what exists

| Task | Deliverable |
|---|---|
| 24f | `data-entry.update.ts` — `UPDATABLE`, the whole of the assistant's authority over existing rows. Every sheet's natural key is absent by design. |
| 24g | `mentioned` on `toRawSheets` — **a field the draft did not mention is not a change.** |
| 24h | `data-entry.store.ts` — current values per sheet, one query per sheet; the field-level `old → new` diff on the card. |

**A bug in my own first implementation, of exactly the kind this feature exists to prevent.** `validateWorkbook` returns a *fully populated* row — every column, defaults filled in — so the first diff reported **nine** changed fields to change one, and applied would have nulled every untouched optional column. `mentioned` is the fix.

### 24.C — the sheet where one row is not one row

| Task | Deliverable |
|---|---|
| 24i | `ValidatedRow.existingParts` — the already-mapped sections the validator strips out of `classSections`. The Excel path never needed them; an assistant that may *change* a mapping does. |
| 24j | `data-entry.mapping.ts` — expansion into units (one per class-section, or one per merged group), then a diff per unit. |
| 24k | `MERGED_UPDATABLE` — a merged group's teacher and members are part of its identity, so a draft that moves them is **refused by name** rather than creating a second group over the same children. |
| 24l | §18 and weekly-capacity guards at plan time *and* at apply, reusing `assertCanTeach` / `assertCanOwnClass` / `assertWithinWeek`. |
| 24m | `Class Teachers` as a seventh draftable master; `listSubjectMappings` as the read that makes a mapping change draftable at all. |
| 24n | Readiness invalidated after an update-only batch; `SHEET_MISSING` warnings dropped from a drafted proposal. |

**Status — shipped.** `ai-data-entry-smoke` at **74/74** (10 steps), 303 shared + 154 api tests, lint, both typechecks, web build, and the full isolation suite including the 13-tool census.

**Two things the smoke proves that a reading could not.** One drafted mapping row became **two** database rows and a later draft changed **one** of them, leaving the other alone — which is the expansion actually behaving as the importer's. And moving a merged group's teacher was refused with the existing group named, after which there was **still exactly one** merged group over those sections.

**Deliberately not done.** The assistant cannot delete anything, cannot change a natural key, cannot move a merged group's teacher or members, and cannot touch a slot, a publication, a role, an academic year, a room or an elective block. `homeRoom` and `timetable` on `Class Sections` are shown in a diff and reported as skipped rather than written — a stated gap, not a silent one.

---

# Phase 25 — Guided onboarding, self-serve accounts and teacher logins

> **Status: 25.0–25.4 built.** Design and mockups: `onboarding-mockup.html`.
> This is the first phase whose scope changes a *stated invariant* (§15's "no local login"), so
> 25.0 carries risk the rest of the plan does not. Read §0 before starting anything.
>
> **Note on numbering.** The task rows below say "§15.3" for the guided setup, written before it had
> a home in the spec. It is now **§24 of `AI-Timetable-System-Architecture.md`** — the doc's own §15.3
> is view scoping, and has nothing to do with it. Prefer §24 in anything new.

## §0 — The two customers, and the rules that follow

| | Bought the **ERP** | Bought the **Timetable module** |
|---|---|---|
| Arrives by | SSO from the ERP menu | Home page → Create account → Sign in |
| Who creates the school | The ERP. **Not creatable here.** | The admin, on *My Schools*. Several allowed. |
| Who creates users | The ERP, on first login, via `erp_role_mappings` | The admin, on *Users & Access* |
| School name | Read-only; refreshed from the token every login | Editable |
| Teachers sign in | Through the ERP | By invitation, from a generated login |

**One mechanism, not three.** School identity, the school list and the user list all need to be
read-only for ERP customers and editable for self-serve ones. `schools.origin` decides all three, and
any screen added later inherits the answer for free. Three screens each deciding it separately is
three chances to get it wrong.

**Two authority rules, enforced in two different places, because they are two different questions.**

- **Only an admin creates a school.** `accounts.kind` = `owner` | `member`. An owner registered
  themselves from the home page; a member was invited into a school and may never create one.
  Teachers are always members. `POST /schools` refuses a member **in the server** — hiding the tile
  is cosmetic (§15).
- **A teacher only looks.** The existing `Teacher` role, unchanged: `timetable.view.own`,
  `timetable.view.class`, `reports.view`, `notifications.view`. **Four permissions, none of which
  writes.** No generate, no board, no publish, no masters, no roles. The view levels are row-level
  scope filters injected server-side into every query, so the short menu is not the protection — the
  query is.

> **One open question.** An earlier brief said teachers could do *"substitution entry if any"*; the
> latest says *"no changes they can be able to do"*. Substitution entry is a write, so the two
> disagree. **The stricter reading is taken:** the default `Teacher` role is view-only and no
> "Teacher + Substitutions" role ships. If some teachers should record cover, it needs **no new
> permission and no new build** — `substitute.manage` exists and the Roles & Responsibility screen
> already lets an admin tick it onto a role.

## §0.1 — Decisions taken before any code

| # | Tension | Resolution |
|---|---|---|
| 1 | §15 says *"SSO-only entry… there is no local login"*, and `users` has no password column | Credentials live **once, in the control plane** — `accounts`, beside `platform_users`, never inside a tenant database. Password login issues **exactly** the JWT the SSO callback issues, so every downstream guard, scope and audit path is untouched. Invariant 16 is rewritten in the same change (25.0h). |
| 2 | §17.3 says provisioning *"is an operator command, never something a login triggers"*, and `Tenant.erp_instance_id` is NOT NULL | A self-serve school is a **row in the shared tenant group** — `schools` plus a `tenants` entry with `mode = shared`. A **dedicated database** stays an operator command, unreachable from a form. The rule becomes *"creating a database is an operator command"*, which is the part that mattered. `erp_instance_id` becomes nullable. |
| 3 | A teacher login must not be able to create schools | `accounts.kind`; see §0. |
| 4 | `users` is unique on `(school_id, erp_user_id)` and that column is NOT NULL; a locally-created user has no ERP id | Write a synthetic stable value `local:{account_id}` and add a nullable `users.account_id`. Unique key, session token and every scope filter untouched. Renaming the column to `external_user_id` is cleaner but touches auth, SSO, platform admin and the isolation sweep — **a separate change, not this phase**. |
| 5 | An ERP school's name is overwritten every login; a self-serve one must be editable | `schools.origin` drives read-only vs editable on Step 1, School Profile, My Schools and Users. |
| 6 | "Popup on every login" becomes something people dismiss unread | Auto-opens only while the school has no `timetable_config`; afterwards a permanent button. |
| 7 | A single class slider cannot describe a Secondary wing (9–12) | Two-handle range over a fixed ordered ladder. The Primary case never moves the left handle. |
| 8 | Option 3's steps 1–8 need academic years, timetable configs and rooms — all deliberately absent from `AI_ENTRY_SHEETS` (§13.5) | The assistant is an **interviewer, not a second writer**: it fills the same wizard state Option 2 fills and the commit is identical. Zero new authority, one commit path. |

**The constraint that governs every sub-phase: no second write path.** Every step commits through
endpoints that already exist (`POST /classes`, `/classes/:id/sections`, `/rooms`,
`/timetable-configs`) or through the §16 `validateWorkbook` pipeline the Excel importer, the ERP sync
and the AI assistant already share. A wizard with its own committer would be the **fourth** way rows
enter this database, and it would drift from the other three exactly as documented for each of them.
**The wizard is a face, never a back door.**

---

## Phase 25.0 — Public site, accounts and sign-in

**Goal:** a stranger can register, verify, sign in and hold a session — with no school yet.
**Depends on:** nothing. **This is the critical path** and the only sub-phase carrying real security
risk; it is the part not to compress.

| Task | Deliverable |
|---|---|
| 25.0a | `accounts` in the **control plane**: email (unique), `password_hash`, `email_verified_at`, name, phone, organisation, country, job role, `kind`, status. Never in a tenant database. |
| 25.0b | `account_tokens`: account, purpose (`verify` / `reset` / `invite`), token **hash**, expires-at, used-at. One table for all three purposes. |
| 25.0c | `POST /auth/register` · `/verify` · `/login` · `/forgot` · `/reset`. Issues the **same session JWT** the SSO callback issues. |
| 25.0d | Argon2id (~100 ms on the api container), parameters stored beside the hash so they can be raised later without forcing a reset. |
| 25.0e | Email delivery for verification, reset and invitation — single-use, expiring, invalidated on use *and* on any password change. |
| 25.0f | Rate limiting per address **and** per source IP; identical body and identical timing for unknown-email and wrong-password. |
| 25.0g | Public routes outside the authenticated shell: `/`, `/signup`, `/login`, `/verify`, `/reset`, `/invite/:token`. Home page is a **scaffold** — real nav, hero, proof strip, the two entry routes; the full marketing design is separate work. |
| 25.0h | Rewrite invariant 16 in `CLAUDE.md`: two entry paths, one session token, credentials only in the control plane. Leaving it saying *"there is no local login"* would make the document lie. |
| 25.0i | Classify every new public route in the §17.8 sweep as deliberately unauthenticated — a new controller fails the build until somebody decides, which is the point. |

**Exit criteria:** register → verify → sign in → hold a valid session, in the live stack. Unknown
email and wrong password are indistinguishable in body **and** in timing. A reset token works once
and is dead after a password change. The existing SSO suite passes untouched. `pnpm test:isolation`
passes with the new routes classified.

> **Status — shipped.** `auth-smoke` **47/47** (11 sections), 167 api + 303 shared tests, lint, both
> typechecks, web build, and the full isolation suite with the route census at 147.
>
> **A refinement discovered while building, worth recording.** The plan promised *"password login
> issues exactly the JWT the SSO callback issues"*. That holds for anyone **inside a school** — and
> cannot hold before then, because `SessionTokenPayload` requires `schoolId`, `roleId` and a tenant,
> and a freshly-registered admin has none of the three. So there are two credentials:
> `AccountTokenPayload` (`typ: "account"`, carrying only an account id) reaches `/auth/account` and
> — from 25.1 — the school list; entering a school exchanges it for the unchanged
> `SessionTokenPayload`. **`JwtAuthGuard` must refuse an account token**, and that check sits
> *outside* its try/catch or the catch rewrites the reason. Both directions are asserted.
>
> **Three of my own test bugs, all found by the suite rather than by reading.** Editing the
> parameters inside an encoded argon2 hash (`m=65536,t=3` → `m=19456,t=2`) does **not** produce a
> weak hash — the digest was computed with the real parameters, so the doctored string simply fails
> to verify. That broke the rehash-on-login check *and*, because the cheap parameters made the
> wrong-password path fast, skewed the timing check two sections later into a false positive for an
> enumeration leak. And the suite's own ~30 deliberate failures tripped the per-IP budget, after
> which a **correct** password was refused — the throttle working exactly as designed, and a hidden
> precondition making a later check fail for the wrong reason. The suite now clears the budget
> between sections and tests it deliberately in §11.
>
> **A real defect in my own code, found by a unit test.** `safeEqualHex("zz","zz")` returned
> **true**: `Buffer.from("zz","hex")` does not throw, it stops at the first invalid character and
> returns an empty buffer, so two pieces of garbage decode to two empty buffers of equal length and
> `timingSafeEqual` reports them equal. Now hex-validated first.
>
> **A gap in the isolation gate, closed while passing through it.** A `@Public()` route was
> auto-bucketed and exempt from every scoping check, so a data endpoint marked public by mistake
> would have passed the sweep in silence — the one thing that file exists not to allow. There is now
> an explicit allow-list naming all 13 public routes and why each is safe to serve a stranger, plus
> the reverse check that no entry is stale.
>
> **Not done in 25.0, deliberately.** `MAIL_TRANSPORT` has only a `log` transport — which provider
> sends production mail is an operational choice nobody has made, and guessing one means a
> dependency and credentials nobody asked for. The seam is one function in `email.service.ts`.
> Captured messages are readable through `GET /dev/mail` (dev-gated), which is what makes the
> registration and reset flows testable at all.

---

## Phase 25.1 — Schools an account owns

**Goal:** an owner can create and switch between schools; a member never can.
**Depends on:** 25.0.

| Task | Deliverable |
|---|---|
| 25.1a | `schools.origin` (`erp` / `self_serve`, default `erp`) and `schools.created_by_account_id`; `tenants.erp_instance_id` becomes nullable. |
| 25.1b | `POST /schools` — creates the `schools` row, the shared-mode `tenants` entry, the §15.2 permission registry, a Super Admin role and the creator's `users` row, **in one transaction**. Never a database. Verified email required; per-account cap (default 10, operator-raisable). **Refused for `kind = member`.** |
| 25.1c | *My Schools* — one card per school with its readiness and its resume point. Creator tile for owners; **switcher only** for ERP users, whose `schools[]` comes from the token. |
| 25.1d | Step 1 and School Profile read `origin`: read-only with a padlock and "managed by your ERP", or editable. |

**Exit criteria:** an owner creates two schools and each is fully isolated from the other under
`pnpm test:isolation`. A member is refused `POST /schools` by the server. An ERP school's name is
still overwritten from the token on every login. The cap actually caps.

> **Status — shipped.** `schools-smoke` **45/45** (9 sections), 167 api + 303 shared tests, lint,
> both typechecks, web build, and the full isolation suite (9 steps, 150 routes).
>
> **`erp_instance_id` did NOT become nullable — the plan was wrong about it.** `tenants` is unique
> on `(erp_instance_id, school_code)`, and **MySQL allows any number of NULLs in a unique index**, so
> a null instance would leave self-serve schools with no uniqueness at all: two accounts could
> register the same code, `resolveByCode` would find two rows, return null, and route the school to
> the default connection — a silent, data-losing failure. One clearly-named sentinel
> `erp_instances` row keeps the existing key working exactly as it does for the ERP. The ERP path's
> "first instance by id" lookup now excludes it by name, or a deployment whose first school was
> self-serve would file real ERP schools under the sentinel.
>
> **`users.account_id` moved up from 25.6.** 25.1b has to create the creator's user row, so the
> identity work could not wait. `erp_user_id` holds `local:{accountId}`.
>
> **My own refusal was too broad, and the existing suite caught it.** Blocking a rename whenever
> `origin = 'erp'` broke a workflow Phase 9.2 documents in its own migration: that migration
> back-fills **placeholder** names ("School 1") for schools predating school claims, and says an
> admin fixes them on the Masters screen. Those schools receive no name from the ERP, so an edit is
> never overwritten — refusing it would strand them called "School 1" forever. The refusal is now
> keyed on a new `schools.erp_name_synced_at`, written by `syncSchool` whenever the ERP actually
> sends a name. Null means "the ERP has never named this", which is the only honest test.
>
> **A session's grants come from the signed token, not the database — asserted, because it looks
> like a bug.** A session minted before a second school existed cannot switch to it; the account
> token is the source of truth for the school list, and the web re-enters through
> `POST /schools/:id/enter`. `switchLocalSchool` is kept separate from the ERP path because the two
> resolve a role in genuinely different ways: the ERP maps `erpRole` through `erp_role_mappings` on
> every switch, while a local account's role is whatever its `users` row already says — there is no
> external authority to consult, and inventing a mapping would be inventing an answer.
>
> **The isolation gate caught the three new routes**, which is what 25.0i added the public
> allow-list for. `@Public()` on `/schools` means "not a SCHOOL session", not "unauthenticated" —
> `AccountAuthGuard` requires an account token and each endpoint then scopes to that account.
>
> **Two pre-existing faults surfaced and were fixed.** (1) The app database had **no
> `_prisma_migrations` table**, so `prisma migrate deploy` — which the compose startup runs and
> which `migrate:all` depends on — had never actually worked; the history is now baselined and
> deploy works as documented. (2) `pnpm seed` assumed school 1 already existed: Phase 9.2's
> migration **back-fills** `schools` from rows that already carry a `school_id`, which does nothing
> on an empty database, so a genuinely fresh volume failed on a foreign key naming `roles` rather
> than the real gap. The seed now upserts the school first, through the unscoped client.
>
> **A mistake of mine worth recording.** Trying to generate the migration I ran
> `prisma migrate dev --create-only`; it detected the pre-existing drift between the hand-written
> migration files and the schema, warned it "may reset", and — non-interactively — **wiped the dev
> database**. Everything was restored from scripts (`pnpm seed`, `dev/sample-data`,
> `seed-school2.cjs` → Second Branch back at 98%), which is exactly why this repo generates its test
> data rather than storing it. **Never run `migrate dev` against this project**: the migration files
> are hand-written and their index and FK names differ from Prisma's generated ones, so drift is
> permanent and `migrate dev` will always want a reset. Write the SQL by hand and apply it with
> `migrate deploy`.

---

## Phase 25.2 — Welcome screen and the wizard shell

**Goal:** the three doors appear for a new school, and an eleven-step wizard can be started, left and
resumed. **Depends on:** 25.1.

| Task | Deliverable |
|---|---|
| 25.2a | `GET /me/onboarding` → `{ isNew, hasConfig, hasClasses, hasPublished, dismissedAt }`, from counts, cached per school. |
| 25.2b | `WelcomeModal.tsx` — three doors, each stating what it is *best for* and roughly how long it takes. Auto-opens only when `isNew`; permanent entry point afterwards. |
| 25.2c | `users.onboarding_dismissed_at` — per user, so one admin's "later" does not hide it from a colleague. |
| 25.2d | `onboarding_sessions`: school, user, current step, answers JSON, mode (`wizard` / `ai`), completed-at. **An 11-step wizard will be abandoned halfway; losing 20 minutes to a refresh is the failure that would sink the feature.** |
| 25.2e | `OnboardingWizard.tsx` — modal shell, step rail, Back / Save & close / Next, per-step validation before advancing. Steps 1–2, both Step 1 variants. |

**Exit criteria:** abandon at step 2, sign in again, every answer returns and **no partial rows were
written**. The modal does not appear for a school that already has a timetable.

> **Status — shipped.** `onboarding-smoke` **24/24** (8 sections), 167 api + 303 shared tests, lint,
> both typechecks, web build, and the full isolation suite (9 steps, 153 routes).
>
> **`GET /me/onboarding` is deliberately NOT cached**, against the plan. Three indexed counts
> measure **~5 ms end to end including HTTP** — so a cache would buy nothing against the §14 budget
> and would cost the one bug anybody would actually notice: an admin creates their first timetable
> and the app keeps offering to set the school up, because a 60-second entry still says it is empty.
> Measured before deciding, not assumed.
>
> **A latent bug fixed before it could exist.** `shouldPrompt` was `isNew && (…)`. Step 5 of the
> wizard creates the timetable config, so from 25.3 onward a draft past step 5 means `isNew` is
> **false** while the setup is unfinished — and the prompt would stop offering to resume at exactly
> the point somebody has most to lose. Now `draft !== null || (isNew && dismissedAt === null)`, with
> a smoke check that gives a school a config while a draft is open, so it cannot regress silently the
> day step 5 lands.
>
> **A save MERGES, it does not replace.** A step sends only its own keys; the service merges them
> into what is stored. A client sending the whole object would blank a step it never rendered, which
> is exactly how a Back button loses the answers in front of it.
>
> **The test that was asserting a bug.** `control-plane-smoke` had claimed for several phases that
> "an admin can fix the placeholder name". That session arrives through SSO **with a school claim**,
> so the ERP has named the school — and `syncSchool` rewrites the name from the token on every
> login. The rename appeared to work and reverted invisibly; the test never checked it survived a
> login, so it passed while the behaviour was broken. **Demonstrated rather than argued:** forcing a
> rename past the guard and signing in again wipes it, and that demonstration is now part of the
> suite, beside a sibling check that a school the ERP has *never* named stays renameable.
>
> **The isolation gate caught all three new routes** and required a decision on each, which is what
> the 25.0i census exists for.
>
> **Not verified in a browser this round.** The decision logic all lives on the server and is covered
> by the 24 live checks; `WelcomeModal`, `OnboardingWizard` and `Onboarding` are covered by
> typecheck and build only. Steps 3–11 render an explicit "not built yet" panel rather than a blank
> frame, and Save & close keeps everything.

---

## Phase 25.3 — Structure: wings, classes, the week

**Goal:** a school has its wings, its classes and sections, and a defined week.
**Depends on:** 25.2. **No schema change** — a wing *is* a `timetable_config`.

| Task | Deliverable |
|---|---|
| 25.3a | Step 3 Wings → one `timetable_config` each. |
| 25.3b | Step 4 class ladder — two-handle range over a fixed ordered vocabulary (Pre-Nur → 12), section count → auto-lettering (A…Z, then AA), live grid with per-row edit and delete. Sets `classes.sequence` from the ladder position, which is what makes every later screen sort in school order rather than alphabetically. |
| 25.3c | Step 5 per-wing week: working days, periods/day, start time, duration, zero period, breaks → `timetable_config` plus `periods` rows with `is_break`. Shows the resulting **weekly capacity**, because it caps every periods/week entry after it. |

**Exit criteria:** 3 wings × the reference class set produce the right `timetable_config`, `classes`,
`sections`, `class_sections` and `periods` rows, created through the existing endpoints. The weekly
capacity shown matches `capacityForClassSections`.

> **Status — shipped.** `onboarding-smoke` **39/39** (9 sections), 325 shared (+22) + 167 api tests,
> lint, both typechecks, web build, the full isolation suite (157 routes), and every other live suite
> unchanged.
>
> **The wizard is the FOURTH producer into the §16 pipeline, not a fourth committer.**
> `packages/shared/src/onboarding/wizard.ts` turns answers into the same `RawSheet[]` an uploaded
> workbook produces, and `POST /onboarding/commit/:step` hands them to `commitSheets`. That was not
> tidiness — it buys three things outright:
>   - identical validation, with no rule rewritten for this path;
>   - **idempotency for free**, because the importer skips rows that already exist by natural key, so
>     pressing Next twice, resuming a draft or going Back-and-Next creates nothing extra. Without it
>     the wizard would need its own "have I already made these?" bookkeeping, and that bookkeeping is
>     exactly where duplicate classes come from;
>   - the `Class Sections` sheet's own `Timetable` column does the wing attachment, so there is no
>     attach step to write or to get wrong.
>
> Wings and the week are the deliberate exception: §16 is masters only, so they go through
> `POST /timetable-configs` and `PUT /:id/structure`, which have always owned period structure.
> `PUT /structure` rewrites the period rows wholesale, so it is idempotent by construction too.
>
> **From step 3 the wizard writes real rows, and that is a change in character worth stating.** Steps
> 1–2 hold answers only; everything after step 3 depends on rows existing (a class-section cannot
> attach to a wing that is not there). So the 25.2 property "an abandoned wizard leaves nothing" holds
> up to step 2 and not beyond — what replaces it is that every commit is idempotent and everything
> created is visible and deletable in the ordinary Masters screens.
>
> **A test of mine that passed for the wrong reason.** The capacity check asked for 41 periods against
> a 40-period week — but the Curriculum sheet's own bound is 1–20, so it was refused by the *field*
> before the capacity guard was ever reached. It now uses a 3×5 = 15 week and asks for 16: legal as a
> field value, illegal as a load, so the rule actually under test is the one that fires.
>
> **A latent hazard introduced in 25.1 and fixed here.** `schools-smoke`'s cleanup deleted every
> `origin: self_serve` school — a rule about a *category* rather than about ownership, which would
> happily remove a real customer's school. Now scoped to the `zz-` codes the suite itself mints,
> which is the rule the 9.10 sweep states in its own header: nothing may delete a row it did not
> create.
>
> **A category the isolation census lacked.** `:step` is a wizard step number, not a row id, so the
> census's "every `:param` addresses a resource" assumption reported it unclassified. Giving it a
> fake resource mapping would have had the sweep call it with a class-section id and prove nothing,
> so there is now an explicit `PARAM_NOT_AN_ID` table — the honest way to say "this parameter cannot
> reach another school because it is not an id at all".
>
> **Not verified in a browser.** The expansion rules are 22 unit tests, the commit path is 17 live
> checks; the three step components are covered by typecheck and build only.

---

## Phase 25.4 — People, places, syllabus

**Goal:** subjects, teachers, rooms, curriculum, mappings and settings — reaching Readiness.
**Depends on:** 25.3.

| Task | Deliverable |
|---|---|
| 25.4a | **Migration:** `teachers.gender`, `teachers.initials`, `teachers.max_consecutive_periods_per_day`, `teachers.can_substitute`, `teachers.email`. |
| 25.4b | **Solver enforcement** of `max_consecutive_periods_per_day` as **domain pruning**, and `can_substitute = false` **removing** a teacher from the substitute candidate list — a refusal, not a low score, the same treatment §4.7a availability gets. *Without this the two columns are decoration, and a field that lies is worse than a field that is missing.* |
| 25.4c | Steps 6–7 grids (Subjects, Teachers): keyboard-first, paste-a-column-from-Excel, defaults rendered as editable italics. Initials proposed from first + last name with **visible collision handling** — AY, then AY2 — because a school with an Anil Yadav and an Ajay Yadav is not unusual. |
| 25.4d | Step 8 **room suggester**: a home room per class-section, one lab per lab subject **with its `room_subjects` mapping attached**, activity rooms from Art/Music/PE, a shared Library. Bulk create, then an editable grid. *A lab with no subjects listed is general and serves everything (§19) — so the suggester must attach subjects, or it quietly turns every proposed lab into a general-purpose room.* |
| 25.4e | Step 9 **curriculum matrix**: class × subject on one screen, proposed from a per-band template **scaled to the wing's real weekly capacity** (never a fixed table, or an 8-period week gets a 40-period curriculum), with a live per-class total against that capacity. |
| 25.4f | Step 10 mapping — class teacher per section and subject mapping, pre-filled from teacher subjects, filtered by wing unless inter-wing teaching is on. |
| 25.4g | Step 11 settings — `class_teacher_gets_first_period`, `allow_consecutive_periods`, inter-wing teaching (expressed as `teacher_class_eligibility`, an existing already-enforced mechanism rather than a new flag), min periods/day. Then straight to Readiness. |

> **Status — 25.4a, 25.4b and the suggesters have landed; 25.4c–g (the step screens) are NOT yet
> built.** 350 shared tests (+25), 167 api, lint, both typechecks, the full isolation suite, and every
> live suite including the importer's export→import round-trip.
>
> **The two columns that had to be enforced, are.** `max_consecutive_periods_per_day` is checked in
> `SolverState.check()` — the single rules engine — so the solver, the drag-and-drop board and the
> legal-destination highlighting all honour it from one place. It is a per-placement veto rather than
> §20's budget, because a *maximum* can be decided from the board as it stands. The subtle half is
> that it counts the whole resulting **run**: checking only the neighbouring cells calls
> `P1,P2 _ P4,P5` plus P3 legal, seeing one neighbour on each side, when it is a run of five.
> Asserted both ways — a full solve where every run is re-derived from the RESULT, and the join case
> directly. `can_substitute = false` **removes** a teacher from the candidate list rather than
> scoring them down: a penalty still puts them on screen, at the bottom, where somebody assigns them
> anyway on a bad morning.
>
> **A defect the unit test caught in my own suggester.** Nine subjects at a minimum of one period
> each cannot fit an eight-period week — arithmetic, not tuning — and my trim loop correctly refused
> to go below one period and then simply exceeded the capacity. A curriculum that exceeds its week
> looks like an answer and can never generate. It now drops the **least-weighted** subjects and
> **names them**, so nothing is silently lost and nothing impossible is proposed.
>
> **The lab trap, avoided by construction.** A lab with no subjects listed is *general* and serves
> everything (§19), so proposing "Science Lab" without attaching Science creates a second
> general-purpose room with a misleading name that the solver will put Hindi in. Every proposed lab
> carries its subjects, asserted directly.
>
> **Two self-inflicted breakages worth recording.** A patch script matched the tail of
> `export const YES_NO` and stole its `export` keyword, which took the api container down until the
> compile error was read rather than guessed at; and the same script declared `GENDERS` twice. Both
> found by running, both cheap — but a reminder that a regex patch over a source file needs its
> anchor checked, not assumed.
>
> **Server side of 25.4c–g has landed; the six step SCREENS are still to build.**
> `POST /onboarding/commit/{2,4,6,7,8,9,10}` and `/onboarding/finish` all commit through the §16
> pipeline; `scripts/guided-setup-smoke.cjs` drives a stranger → account → school → steps 1–11.
>
> **Four real defects in my own suggesters, every one found by the Feasibility Engine refusing a
> school the wizard had just proposed.** This is the two-phase architecture working exactly as
> designed — Phase A caught all of them before a solver ever ran:
>   1. *"24 periods/week need at least 6 working days"* — `suggestMappings` checked only
>      `maxPeriodsPerWeek`. A teacher's real ceiling is their **daily reach** (Σ of their subjects'
>      per-day caps) × working days. Now enforced, with three distinct "uncovered" reasons, because
>      "hire somebody" is unhelpful when the real fix is a longer week.
>   2. The deeper root cause: `suggestCurriculum` set `maxPerDay: 1` for a 6-period subject, which
>      needs SIX days. Impossible in a five-day week however many teachers exist. Floor is now
>      `ceil(periods / days)`.
>   3. §20's default `minPeriodsPerDay: 3` was inherited silently, making 13 periods/week with a
>      floor *and* ceiling of 3 unsatisfiable. The guided setup now writes **0** — the app's default
>      is right for a school that chose it and hostile as a silent imposition. Step 11 offers it.
>   4. *"84 lab periods/week required but 2 lab rooms supply only 80"* — one lab per lab subject is
>      the obvious guess and wrong at ten sections. Labs are now sized to demand.
>
> **A test of mine that encoded the wrong theory.** It asserted the curriculum "leaves a little slack
> rather than filling every period", on the reasoning that a full week gives the solver nowhere to
> move. Readiness disagreed and was right: a free period is not slack, it is unallocated teaching
> time, and every one is warned about — which is what held a fully-configured school below 100%.
> Flipped, with the reason recorded.
>
> **The Primary-wing gap, run down — and it was not a code defect.** The note here previously said
> `suggestMappings` had reported no `uncovered` entry for Class 5-B Mathematics. Probed directly, it
> had: the suggester named the gap correctly and the school genuinely could not be staffed. A
> 7-period subject against a 26-period cap is `floor(26/7) = 3` sections per teacher however
> cleverly the work is shared out, because a section's periods cannot be split between two people —
> so three Mathematics teachers reach nine of the wing's ten sections and the tenth is unstaffable.
> The fixture was describing an impossible school and the wizard was right to refuse it. Four
> teachers per subject per wing, with the arithmetic recorded beside the number.
>
> **Two more defects, both found the same way.**
>   5. **Rounding was one-directional.** `suggestCurriculum` could trim a week that came out over
>      capacity and had no way to top up one that came out under, so eight subjects each rounded
>      down by a fraction left Class 5, 9 and 10 with 38 periods in a 40-period week — two
>      unallocated slots per class, and the warning that held a fully-configured school at 88%. The
>      old test passed because it checked one Class 1, which happened to round well; the new one
>      sweeps every band against six capacities.
>   6. **`WEIGHTS` is scanned with `find`, and the generic science row sat above the specific ones**
>      — so "Computer Science" and "Social Science" were both weighted as laboratory science, and a
>      3-period computing course was proposed as a 6-period one, consuming staff and lab rooms it
>      had no claim on. Specific patterns now sit above general, with the ordering rule stated.
>
> **The §19 breach the smoke could not see.** Every proposed home room was created and then linked
> to nothing: `class_sections.home_room_id` stayed NULL, so every ordinary lesson would have shown
> no room at all. Generation still succeeded — a room is not required to place a lesson — which is
> exactly why nothing caught it; Readiness reported it as a warning ("10 class-sections have no home
> room") on a school that had just had ten home rooms made for it. The importer already owned the
> `Home Room For` column; `roomSheets` simply was not filling it in. Invariant 5 says rooms are
> **assigned**, not left blank, and now both a unit test and the smoke assert it.
>
> **Where it stands: the exit criterion is met.** A stranger on the home page reaches a
> conflict-free timetable with nothing typed by hand — both wings at **100% Readiness, 0 blockers**,
> **560 periods placed, nothing unplaced.**

> **Status — 25.4c–g have landed: all eleven steps are built.** `steps/People.tsx` (subjects and
> teachers), `steps/Syllabus.tsx` (rooms, curriculum, mapping, settings) and `steps/ui.tsx`.
>
> **Paste a column.** Every school already keeps its subject and staff lists in a spreadsheet, and
> retyping two hundred names is why people abandon a setup wizard halfway. One paste handler fills
> the column down, extending the list rather than overwriting what follows. Without it the honest
> advice for any real school would have been "use the Excel importer instead", which would make the
> guided setup a toy.
>
> **Defaults are in the box, in italics.** A blank max-periods field that silently becomes 6 is a
> field that lies. The number is shown, typing over it is the whole interaction, and the italic says
> which numbers nobody has decided yet. The same rule gives initials their treatment: proposed
> against a set built across the whole list (uniqueness is a property of the list, not the row),
> editable, and marked amber when the proposal had to disambiguate — so a school with an Anil Yadav
> and an Ajay Yadav sees AY and AY2 in front of somebody who can choose better, rather than
> discovering it when a unique index refuses the import.
>
> **The correction has to win, and one bug here was mine.** Steps 8–10 are proposals; the screen
> stores edits under their own answers key and the server reads that key if it is there, re-proposing
> if it is not — so going back to step 7 to add a teacher changes the proposal, while an edit made
> here survives. My first version treated `mappings` and `classTeachers` as one edited object, so
> reassigning a single lesson would have wiped **every class teacher in the school**. They are edited
> in two separate tables on the screen and now fall back independently. Both halves are asserted in
> the smoke: an edited curriculum row and an edited assignment are what reach the database, and the
> class teachers survive an edit to the assignments alone.
>
> **Coverage is stated once.** `coverageGaps` is the function the mapping screen shows live *and* the
> commit uses to build its issue list — because `suggestMappings`' own `uncovered` list describes a
> plan that stops existing the moment somebody edits a row, and two copies of the rule would
> eventually disagree in the direction of "the screen said it was fine". Load and capacity are
> deliberately **not** re-checked in the browser: the §16 importer runs `assertWithinWeek` on every
> row it writes, and a second opinion the server then contradicts is worse than none.
>
> **Inter-wing teaching is not a flag.** Step 11's toggle clears the `teacher_class_eligibility` rows
> step 7 wrote, because an empty scope means "not stated" rather than "no classes" (invariant 7) —
> an existing, already-enforced mechanism instead of a new setting nothing reads.

**Exit criteria:** an empty school driven through steps 1–11 reaches **100% Readiness** and generates
a conflict-free timetable. Unit tests: no proposed curriculum ever exceeds capacity, including the
8-period-week case; every proposed lab carries its subject mapping. A teacher with
`max_consecutive = 2` is never placed in three consecutive periods; a teacher with
`can_substitute = false` never appears in a substitute suggestion.

---

## Phase 25.5 — The assistant as interviewer ✅

**Goal:** Option 3 — the same questions, in conversation. **Depends on:** 25.2d and 25.4e.
Small *because* of decision 8: it reuses 25.2–25.4 rather than duplicating it.

| Task | Deliverable |
|---|---|
| 25.5a | `OnboardingChat.tsx` — full-screen conversation writing into the **same** `onboarding_sessions` row, with a live "collected so far" panel and a switch-to-wizard button that keeps everything. |
| 25.5b | A **structured-output** interview tool: the model returns the next question plus the fields it just learned. It calls **no write tool** and gains no new authority. |
| 25.5c | At step 9 it hands over to Setup Wizard → Curriculum, with everything already saved. |

**Exit criteria:** a scripted conversation covering steps 1–8 produces exactly the same
`onboarding_sessions` answers as the wizard, and the same commit. `AI_ENTRY_SHEETS` is unchanged.

> **Status — 25.5 landed.** Spec: **§24.6**. 186 api tests (+19), lint, both typechecks, web build,
> the isolation gate, and `scripts/interview-smoke.cjs` — a scripted eight-turn conversation whose
> draft commits to a school at **100% Readiness in both wings**. `AI_ENTRY_SHEETS` untouched.
>
> **One tool, and it writes a draft.** The model is offered `recordSetupAnswers` and none of the
> §13.1 registry — it cannot read the school, draft master data or place a slot. What it writes is
> the same JSON a person produces by typing, which becomes rows only when somebody presses Next and
> the §16 importer validates it again. So `interview.answers.ts` is not the safety net; it is what
> keeps the draft coherent, and it says what it refused rather than dropping it, because a silently
> ignored field becomes an assistant confirming something that never happened.
>
> **Classes are named, never indexed.** Asking a model for `fromIndex: 4` is asking it to
> hallucinate an integer. It says "Class 1" — or "class 5", "Grade 5", "std 5", "LKG" — and an
> unrecognised name is refused *with the vocabulary attached*, because a guess is a wing quietly
> covering the wrong classes.
>
> **A defect my own exit-criterion test found, before any of it ran.** The draft merges per
> top-level key, which is exactly right for a wizard screen that holds a whole list and sends it
> complete — and catastrophic for a conversation. "And we also have three part-time teachers" would
> have **deleted every teacher named before it**, and a second wing's week would have erased the
> first's. The setup would have shrunk as the conversation went on: the worst possible failure here,
> because it looks like progress. Collections now accumulate by identity (employee code, else name),
> restating one is a correction rather than a duplicate, and `replace: ["subjects"]` is the only way
> to remove something — the model declaring a list complete, since a merge can add and change but
> never subtract.
>
> **Testing it needs no provider key.** `POST /dev/interview-turn` is the same dev-gated seam as
> `/dev/ai-tool` (§17.8), for the same reason: whether a model's report becomes the draft the wizard
> would have produced is not a property of the model, and a test that needed a key is a test nobody
> runs. The isolation gate caught `POST /onboarding/interview` unclassified, exactly as it caught
> `/onboarding/finish` in 25.4.
>
> **Deviation from 25.5c, recorded.** The plan said the handover goes to "Setup Wizard → Curriculum".
> That was written before 25.4e gave the *guided* wizard its own curriculum matrix, which is the
> better destination — so the conversation hands over to step 8 of the same wizard, on the same
> draft, rather than to the older screen.
>
> **Also fixed here:** the third door on the welcome screen said "Arrives with the AI interviewer
> (25.5)" and was disabled. It is now the door it always described.

---

## Phase 25.6 — Users and teacher logins

**Goal:** an admin creates users and generates teacher logins; a teacher signs in and looks, and can
do nothing else. **Depends on:** 25.1 (for `origin`) and 25.4c (for the teacher list the bulk invite
reads).

| Task | Deliverable |
|---|---|
| 25.6a | `users.account_id` nullable; `erp_user_id` written as `local:{account_id}` for locally-created users, so the unique key, the session token and every scope filter keep working untouched. |
| 25.6b | `POST /users/invite` · `/users/:id/resend` · `/users/:id/deactivate` · `PUT /users/:id` (role, teacher link). Guarded by `roles.manage` — the authority to decide who signs in is the one the Roles screen already requires. **Refused outright when `schools.origin = 'erp'`.** An invited account is always `kind = member`. |
| 25.6c | *Users & Access* screen — list, add, edit role, link to a teacher, resend, deactivate. **Deactivate, never delete**: a user named in the audit log must stay resolvable. Read-only with a banner for ERP schools. |
| 25.6d | **Bulk teacher invite** from the teacher master: filter by wing, role defaults to the view-only `Teacher`, optional email pattern for blanks. **Skips** teachers who already have a login and says so; **excludes `guest` teachers** (§18 keeps them out of the regular timetable, so there is nothing for them to see); **reports** teachers with no email rather than dropping them from the count. |
| 25.6e | Invitation acceptance at `/invite/:token` — identity fixed and shown but not editable, password chosen, single-use, 7-day expiry, reusing 25.0b rather than a second token table. |
| 25.6f | A prompt to invite teachers on the post-publish screen — the first moment there is anything for them to look at. |

**Exit criteria:** invite a teacher, accept, sign in, and get **their own grid and their linked
sections only** — the existing §15 scope negatives, re-run against a locally-created user rather than
an SSO one. The same account is refused `POST /schools`, and refused every write endpoint
(`/solver/generate`, `/board/*`, `/publish`, `/classes`, `/roles`) with a 403 from the server. The
invite token is dead on second use. With `origin = 'erp'`, `POST /users/invite` is refused.

---

## Phase 25 — verification as a whole

`scripts/onboarding-smoke.cjs`, in the live stack:

1. Register an account, verify it, sign in.
2. Create a school. Assert a second, `member` account cannot.
3. Drive all eleven steps through the API.
4. Assert **100% Readiness** and a conflict-free generated timetable — *from a stranger on the home
   page to a working timetable, without one row typed by hand.* If that path cannot produce a
   solvable school, the phase has not worked however good it looks.
5. Publish, invite two teachers, accept one.
6. Assert the accepted teacher sees only their own grid, and is refused every write.
7. Assert an ERP-origin school refuses `POST /schools` and `POST /users/invite`.

Plus: `pnpm test:isolation` (two accounts, two schools, every new route swept or classified), the
existing SSO suite unchanged, and the auth negatives from 25.0.

## Phase 25 — deliberately out of scope

- **The full marketing home page.** Scaffolded only; screenshots, pricing, testimonials and footer
  are separate design work.
- **Billing and plans.** The school cap is a number an operator can raise, not a subscription.
- **Social sign-in** (Google / Microsoft). The `accounts` table leaves room for it.
- **Self-registration by staff.** A teacher is invited, always — otherwise anyone who guesses a
  school code is inside it.
- **Changing a user's email.** It is their sign-in; that is an account operation with its own
  verification round-trip, not a dropdown on an admin's grid.
- **Split electives in the wizard.** They have their own screen (§4.9); a twelfth step would make the
  common path pay for the rare one.
- **Editing an existing school through the wizard.** This is a first-run path; pointing it at a
  published timetable needs a diff-and-merge story of its own.
- **Changing the Setup Wizard.** Option 1 is the current process, untouched — which is what makes it
  a safe fallback from either of the other two.

## Phase 25 — sequencing note

25.0 → 25.1 → 25.2 → 25.3 → 25.4 is the spine and must run in order. **25.5 and 25.6 are both
optional cuts:** 25.5 loses a door, not a foundation; 25.6 can ship after the first schools are live,
since an admin can run a school alone until staff need logins. 25.4a/b — the teacher columns and
their solver enforcement — is the only work touching the solver, and can be lifted out and shipped on
its own if the wizard slips.
