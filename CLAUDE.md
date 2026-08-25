# CLAUDE.md — EduTimetable (AI-Powered School Timetable System)

## What this project is

An AI-powered school timetable generation system for the **Edunext School ERP platform**. It guarantees **100% conflict-free auto-generation** by splitting the problem into two hard phases:

- **Phase A — Feasibility Engine:** pure arithmetic/graph checks that run *before* any slot is placed, proving a complete solution can exist (or naming the exact master-data row to fix). Surfaced as a live "Readiness Score" that updates on every master-data edit.
- **Phase B — Constraint Solver:** a CSP solver (backtracking + MRV/LCV/degree heuristics + forward checking + conflict-directed backjumping, with a min-conflicts local-search fallback) that only runs once Phase A has proved feasibility — so it cannot fail.

This two-phase split is the load-bearing architectural decision. Everything else is built around it.

## Repository status

**All phases (0–8) are implemented; Phase 9.1 (school scoping), 9.2 (the control plane) and 9.4 (connection routing) and 9.5/9.6 (ERP-driven school identity and switching, §17) have landed** (pnpm monorepo: `apps/api` NestJS + Prisma, `apps/web` React/Vite, `packages/shared` feasibility + solver + board + substitute + objective engines; `apps/optimizer` Python CP-SAT service; AI assistant with a tool-gated read-only registry; Docker compose stack) — see the per-phase status notes in `IMPLEMENTATION-PLAN.md`. The specification artifacts remain authoritative:

| File | Role |
|---|---|
| `AI-Timetable-System-Architecture.md` | **Source of truth.** Complete architecture, SQL schema, feasibility checks, solver formulation, substitute engine, screen list, roadmap. Read this before designing or implementing anything. |
| `timetable-ui-mockup.html` | High-fidelity static UI prototype (all 12 screens, vanilla JS screen-switching). Defines the visual design system and interaction patterns to replicate. |
| `AI-Timetable-System-Deck.pptx` | 13-slide stakeholder deck summarizing the architecture doc (no unique content). |
| `IMPLEMENTATION-PLAN.md` | Sequential task-level build plan for all phases (0–7) with dependencies, deliverables, and exit criteria. Work through it in order; check tasks off as they land. |

The phased roadmap in §12 (summarized below) is complete, plus Phase 8 (Excel master-data import, §16); per-phase status notes in `IMPLEMENTATION-PLAN.md` record what shipped and what was deliberately deferred.

## Docker-only development (hard rule)

The application is developed, tested, and run **exclusively inside Docker** — never on the host:

- The Docker Compose stack (`docker-compose.yml` + `docker-compose.override.yml` dev overrides, auto-loaded) defines every service: `api` (NestJS), `web` (React/Vite), `worker` (solver, BullMQ consumer), `optimizer` (Python CP-SAT, §5.6 soft optimization), `mysql` (MySQL 8), `redis`. `docker compose up` is the only supported way to start the app (production: `docker compose -f docker-compose.yml up`). Host ports: api **3001**, web **5174** — 3000/5173 are occupied by an unrelated SSH tunnel on the primary dev machine; inside the network it's always `api:3000`.
- **Never install or run Node, MySQL, or Redis on the host, and never suggest doing so.** All commands — dependency install, migrations, seeds, tests, lint, one-off scripts — run inside containers: `docker compose exec api pnpm test`, `docker compose exec api pnpm migrate`, etc. If the stack isn't running, use `docker compose run --rm <service> <cmd>`.
- Dev and production share the same multi-stage Dockerfiles; dev overrides add bind mounts and hot reload. CI builds and tests the same images. A change that only works outside Docker is broken by definition.
- **`PrismaService` is a pointer, not a connection** (§17.5): a proxy that resolves the current request's database from the tenant context. Never construct a `PrismaClient` in feature code — inject `PrismaService`. A dedicated school's `school_id` is usually 1, the same as the shared school's, so **tenant id is the routing key**; anything that writes outside a request (worker, queue listeners) must resolve its own connection from the job's `tenantId`. Connections are bounded by `TENANT_MAX_CLIENTS × TENANT_POOL_LIMIT`; `GET /health` reports the budget. `pnpm tenant:create` provisions a dedicated school — creating a database is an operator command, never something a login triggers.
- **A migration is not deployed until every school's database has it** (§17.3). `pnpm --filter @edutimetable/api migrate:all` walks the tenant registry (add `--dry-run` to report only); the shared database is migrated once however many schools live in it. A database behind this build is **refused on connect** with a message naming the fix — never served, because serving it produces `Unknown column …` on a random screen instead.
- **Two Prisma schemas, two migration histories.** `prisma/schema.prisma` is the application (one database per shared tenant group); `prisma/control/schema.prisma` is the §17.3 tenant registry, in its own database on the same server with its own generated client (`prisma/generated/control-client`, git-ignored). App: `prisma migrate deploy` / `pnpm seed`. Control: `pnpm migrate:control` / `pnpm generate:control` / `pnpm seed:control`. They are separate because a dedicated tenant's connection details cannot live inside a tenant database, and because Prisma cannot host two histories in one schema.
- Connection config comes from compose environment variables (service names as hosts: `mysql`, `redis`) — never `localhost` hardcoded in app code.
- **Watcher caveat:** bind-mount file events don't reach the containers on macOS; Vite polls (reliable), but Nest's tsc watcher can still miss edits — after changing api code, if behavior looks stale, `docker compose restart api` (30s) is the fix. Never debug "my change has no effect" without first ruling this out.

## Tech stack (as specified — do not substitute without discussion)

- **Frontend:** React + TypeScript, `@dnd-kit` for drag-and-drop (not react-beautiful-dnd), Zustand/Redux for the in-memory timetable grid, TailwindCSS, virtualized grid (`react-window` / AG Grid) for the 50×40 allocation matrix.
- **Backend:** Node.js (NestJS recommended), MySQL 8 (or Postgres), Redis + BullMQ for the solver job queue, Socket.IO for solver progress streaming and live conflict alerts.
- **Solver:** pure Node/TypeScript custom CSP engine owns feasibility. Google OR-Tools CP-SAT (Phase 6, `optimizer` compose service — Python, since OR-Tools has no official Node bindings) adds *soft* optimization only: it receives the already-pruned domains, and its answer is replayed through the same `SolverState.check()` and adopted only if it verifies AND scores better (§5.6). Optimizer down = fast-mode fallback, never a failed generation.
- **Background jobs are scheduled fairly across schools** (§17.7): the worker runs `SOLVER_CONCURRENCY` (default 3) jobs at once with a **per-school cap of one**, so a long generation in one school cannot block every other school and no school can take every slot. A capped job is deferred (`moveToDelayed` + `DelayedError`), never failed. Never set the worker back to `concurrency: 1`, and never release a school's slot without checking you still hold it.
- **Every log line is tagged with its school automatically** by `TenantAwareLogger` — never hand-add a school id to a log message; just log, and the ambient context supplies it.
- **Platform administration is not a school permission** (§17.6): it lives in the control plane's `platform_users`, keyed by ERP identity, because a school's own Super Admin must not be able to grant themselves authority over the registry. Never add a `platform.*` entry to the §15.2 permission registry. It is re-checked per request (not carried in the session token, which would keep saying yes for 8 hours after a revocation), and granted by `pnpm --filter @edutimetable/api platform:admin -- --grant <ERP-USER-ID>`.
- **Socket.IO handlers must open their own tenant context** (§17): a socket message never passes through the HTTP middleware, so nothing has scoped it. `AiChatGateway` opens one from the signed session token before touching the database; any new gateway must do the same or its queries run unscoped — and, for a school with its own database, against the wrong one.
- **LLM providers sit behind one neutral contract** (`apps/api/src/ai/providers/`, §13.2): the chat gateway never speaks a vendor's message shape. **Anthropic (Claude) and Google (Gemini) are both wired**; `providers/index.ts` is the single catalogue of providers, models, env-var fallbacks and prices, served to the UI so the screen cannot drift from the gateway. Adding a provider = an adapter + one catalogue entry, never a change to the chat loop or the §13.1 tool registry.
- **LLM usage is deliberately narrow:** never for slot placement (it can hallucinate invalid placements). Only for plain-English explanation of constraint failures, natural-language bulk data entry (with confirmation screen), and substitute-suggestion rationale text.

## Non-negotiable invariants

1. **DB-level uniqueness is the final guard against double-booking** — three unique keys on `timetable_slots`: `uq_class_slot`, `uq_teacher_slot` (via generated `teacher_occupancy_key`, which collapses merged-group placements into one occupancy event), and `uq_room_slot`. App-level checks are additional, never a replacement.
2. **Teacher placement rules are HARD constraints, never soft preferences.** `class_teacher_period_rule` (`always_first_period`), `period_pattern` (`alternate_period`, `alternate_day`) are enforced by **domain pruning before search starts**, not penalty scoring. The solver must never be able to even consider an illegal slot.
3. **Draft vs. published lives in one table** (`timetable_slots.status` enum), not two tables — so unique constraints, solver, and drag-drop UI all work against one schema. Publish is a single transaction.
4. **Substitutions are date-specific overlays** (`source='substitute'`, logged in `substitution_log`), never mutations of the base published timetable.
5. **Multi-block placements are macro-variables:** double periods (`consecutive_block_size`), merged teaching groups (one teacher, multiple sections at once), and split electives (synchronized parallel options) each place atomically — fully placed or fully backtracked, never half-placed.
6. **A class-section belongs to exactly one `timetable_config`** (a school runs multiple independent timetables per wing), but teacher load checks sum **across all configs** a teacher appears in — cross-wing overload must never slip through.
7. **Drag-and-drop is validated twice:** client-side instantly (in-memory matrix copy), then server-side on drop-confirm (guards against stale/concurrent edits). Illegal drops show the *specific* reason. Picking up a card highlights every legal destination.
8. **Manually placed cells can be locked** (`is_locked`) — solver re-runs must treat them as fixed.
9. **The AI Assistant is read-only and tool-gated** (§13): the LLM answers only through whitelisted query tools that wrap the Reports module's service functions — never raw SQL, never table dumps, never slot placement. School/timetable scope is injected server-side into every tool call.
10. **Performance budget — every transactional page and on-screen report ≤ 1s at p95** (§14): API ≤ 300ms (DB query ≤ 100ms), client render-to-usable ≤ 600ms, at realistic scale (50 sections, 2,000 slots, ~40 concurrent users). Achieved by: heavy work off the request path (BullMQ), mandatory indexes (`EXPLAIN`-checked, no full scans on `timetable_slots`), Redis caching with event-driven invalidation for computed views (readiness, published matrix, report aggregates), virtualized grids, paginated compact payloads (no N+1, no nested ORM graphs), client-first drag-drop legality. The only sanctioned exception: PDF/Excel *file generation* and AI chat totals may exceed 1s but must acknowledge/start within 1s (queued job + progress). CI load tests assert the budgets — a perf regression fails the pipeline like a failing test.
11. **SSO-only entry, app-wide RBAC, query-layer view scoping** (§15): there is no local login — users arrive from the Edunext ERP menu via a short-lived signed SSO token (verified, nonce-replay-protected, sync-on-login provisioning). One permission registry (`roles`/`role_permissions`) covers the entire app; the Admin manages it on the dedicated Roles & Responsibility page (`roles.manage`). The three view levels (`timetable.view.own` / `.class` / `.all`) are **row-level scope filters injected server-side into every query** (REST, Socket.IO, reports, AI tools — one scoping module) — a teacher gets only their own grid and their linked class-sections' grids; UI hiding is cosmetic, the server is the authority.
12. **The ERP owns school identity — never hardcode or invent a school name** (§15.1, §17.4). The SSO token carries `school` (`code` + `name`), optionally `trust` and `schools[]`; the app provisions unknown schools on the spot (row + permission registry + ERP role mappings + registry entry) and refreshes names on every login. `code` is the stable key across databases — a numeric id is not. School switching is authorised by the signed session token's `schoolIds`, never by a permission, and the school always comes from the session, never from a request body.
13. **Row ownership is scoped in one place, and `school_id` is on every table** (§17, Phase 9.1). All 30 tables carry `school_id` — denormalized onto child tables so scoping is always a direct indexed predicate, never a join. One Prisma client extension (`apps/api/src/prisma/school-scope.ts`) applies the ambient school from an `AsyncLocalStorage` tenant context to **every** query: filters reads, stamps creates (recursively through nested relation writes), refuses updates/deletes of another school's rows, and rejects writes that *reference* another school's ids. Never hand-add a `schoolId` filter at a call site as the mechanism — a query is scoped by the context it runs in. Never use Nest request-scoped providers for tenancy (it cascades through ~40 injecting classes and breaks the §14 budget). Redis keys are `s{schoolId}:…`, Socket.IO emits go to a `school:{id}` room — never `server.emit` — and every BullMQ job carries its `schoolId`. `PrismaBaseService` and `TenantContextService.runUnscoped()` are the only sanctioned ways out, for genuinely cross-school work (health probe, migrations, SSO provisioning). Since 9.2 every `school_id` also has a real **foreign key** to `schools`, and `schools` itself is the tenant *root* — scoped by its own `id`, never stamped, never created or deleted from inside a school's session (that is provisioning, §17.3).
14. **AI access is role-based and server-enforced:** `ai.chat`, `ai.reports`, `ai.configure` permissions checked by middleware on every AI endpoint (REST + Socket.IO chat namespace) — hiding nav items is cosmetic, the guard lives on the server. API keys are AES-encrypted at rest, write-only in the UI, and every conversation is audit-logged (`ai_chat_log`) with token usage counted against a monthly budget.

## Feasibility Engine — the six checks (§4 of the architecture doc)

1. Slot capacity per class-section (required vs. available slots)
2. Teacher weekly load vs. true capacity (pattern-adjusted for alternate-period/day teachers)
3. Daily distribution feasibility (`periods_per_week` vs `max_periods_per_day`, block-packing-aware)
4. Teacher cross-section daily overlap / tightness score
5. Shared/special room contention
6. Structural constraint conflicts (e.g., class-teacher P1 deadlocks, underspecified same-period-across-week rules)

Every failed check maps to a **specific, actionable message naming the exact row and fix** — this "tell me what to fix" intelligence is a core product requirement, not polish.

## UI design system (from `timetable-ui-mockup.html`)

- **Fonts:** Fraunces (display), Inter (body), JetBrains Mono (code/data) via Google Fonts.
- **Palette (CSS variables):** dynamic-blue theme — primary `--brand:#2563EB` / `--brand-dark:#1E4FC4` / `--brand-deep:#0B1F44` (sidebar navy), muted blue-gray `--steel:#5578A8` / `--steel-light:#B6CBE8` / `--steel-pale:#E7EEFA`, surfaces `--offwhite:#F4F7FC` / `--line:#DBE3F0`, ink `#141B26/#4F5D70/#8695A9`, error `--signal:#C2372F`, warn `--amber:#B9791A`, success/positive `--accent:#0891B2` (cyan). Never reintroduce the retired forest/sage/mint green tokens; new UI must use these variables, not hardcoded colors.
- **Layout:** dark navy sidebar (236px) + top bar with a timetable-config selector; screens: Timetables (landing), Setup Wizard (stepper: Academic Year → Classes/Sections → Rooms → Subjects → Teachers → Timetable Config → Curriculum → Teacher Mapping — capacity-first: the config's weekly period count hard-caps every later periods/week entry), Readiness Dashboard, Generate (live progress log), Allocation Matrix (sticky headers/first column), Drag-Drop Board, Publish Confirmation, Substitute Center, Reports, Masters, Notifications, (role-gated, under an "Intelligence" nav group) Ask AI chat + AI Settings, (Admin-only) School Profile + Roles & Access, and (platform-only) the Platform Console. Teacher-role users get scoped My Timetable / My Classes views instead of the admin screens.
- **Patterns:** master-data screens are **list-first, form-second** (directory table with Edit per row; Add/Edit opens the form). Class-Teacher Assignment (writing `class_sections.class_teacher_id`) is a distinct screen from Subject Mapping. Merged-group cells show a link icon and drag as one unit.

## Build phases (roadmap, §12)

1. Masters + Config + **Feasibility Engine** (live Readiness Score before any solver code)
2. Core CSP Solver + draft generation + Allocation Matrix (read-only first)
3. Drag-and-drop editing + Publish workflow
4. Substitute Teacher Engine (weighted bipartite matching, Hungarian/greedy)
5. Reports + Notifications + LLM explanation layer
6. (Optional) OR-Tools CP-SAT for soft optimization
7. **AI Assistant** (§13): role-gated chat over timetable data (tool-calling, streaming), AI-triggered report generation reusing the §10 pipeline, and the AI Settings screen (provider/model/key config, feature toggles, role access matrix, usage budget). Default provider: Anthropic `claude-opus-5` via the official `@anthropic-ai/sdk` with adaptive thinking and streaming; other providers plug in behind the same tool contract.

## Project skills (`.claude/skills/`)

- `/project-status` — phase/task progress vs. IMPLEMENTATION-PLAN.md, git and test health, blockers, next actions.
- `/explain-code` — plain-English, timetabling-analogy explanations of code/schema/architecture for non-programmers.
- `/review-code` — reviews changes against the invariant checklist above (invariant violations first), then general correctness.
- `/test-app` — runs/extends tests at the right level per module (fixtures, property tests, RBAC negatives, adversarial AI tests) and checks phase exit criteria.
- `/git-workflow` — commit → push → PR → merge flow: phase-based branch naming, blocking in-Docker quality gate, conventional commits referencing plan tasks, squash merge with explicit confirmation.

Prefer invoking these over ad-hoc approaches when a task matches.

## Conventions for working in this repo

- Treat `AI-Timetable-System-Architecture.md` as the spec; if implementation needs to deviate, update the doc in the same change and call the deviation out.
- Solver code must stay CPU-isolated from the API (BullMQ background job with WebSocket progress) — never run generation inline in a request handler.
- Reuse the *same* constraint-check functions for solver placement, drag-drop legality, and the "suggest legal destinations" mode — one rules engine, three call sites.
- Section references like "§4.7" in commits/discussions refer to the architecture doc's numbering.
