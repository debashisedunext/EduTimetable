# CLAUDE.md — EduTimetable (AI-Powered School Timetable System)

## What this project is

An AI-powered school timetable generation system for the **Edunext School ERP platform**. It guarantees **100% conflict-free auto-generation** by splitting the problem into two hard phases:

- **Phase A — Feasibility Engine:** pure arithmetic/graph checks that run *before* any slot is placed, proving a complete solution can exist (or naming the exact master-data row to fix). Surfaced as a live "Readiness Score" that updates on every master-data edit.
- **Phase B — Constraint Solver:** a CSP solver (backtracking + MRV/LCV/degree heuristics + forward checking + conflict-directed backjumping, with a min-conflicts local-search fallback) that only runs once Phase A has proved feasibility — so it cannot fail.

This two-phase split is the load-bearing architectural decision. Everything else is built around it.

## Repository status

**No application code exists yet.** The repo currently contains only the specification artifacts:

| File | Role |
|---|---|
| `AI-Timetable-System-Architecture.md` | **Source of truth.** Complete architecture, SQL schema, feasibility checks, solver formulation, substitute engine, screen list, roadmap. Read this before designing or implementing anything. |
| `timetable-ui-mockup.html` | High-fidelity static UI prototype (all 12 screens, vanilla JS screen-switching). Defines the visual design system and interaction patterns to replicate. |
| `AI-Timetable-System-Deck.pptx` | 13-slide stakeholder deck summarizing the architecture doc (no unique content). |
| `IMPLEMENTATION-PLAN.md` | Sequential task-level build plan for all phases (0–7) with dependencies, deliverables, and exit criteria. Work through it in order; check tasks off as they land. |

When implementation starts, follow the phased roadmap in §12 of the architecture doc (summarized below).

## Docker-only development (hard rule)

The application is developed, tested, and run **exclusively inside Docker** — never on the host:

- The Docker Compose stack (`docker-compose.yml` + `docker-compose.dev.yml`) defines every service: `api` (NestJS), `web` (React/Vite), `worker` (solver, BullMQ consumer), `mysql` (MySQL 8), `redis`. `docker compose up` is the only supported way to start the app.
- **Never install or run Node, MySQL, or Redis on the host, and never suggest doing so.** All commands — dependency install, migrations, seeds, tests, lint, one-off scripts — run inside containers: `docker compose exec api pnpm test`, `docker compose exec api pnpm migrate`, etc. If the stack isn't running, use `docker compose run --rm <service> <cmd>`.
- Dev and production share the same multi-stage Dockerfiles; dev overrides add bind mounts and hot reload. CI builds and tests the same images. A change that only works outside Docker is broken by definition.
- Connection config comes from compose environment variables (service names as hosts: `mysql`, `redis`) — never `localhost` hardcoded in app code.

## Tech stack (as specified — do not substitute without discussion)

- **Frontend:** React + TypeScript, `@dnd-kit` for drag-and-drop (not react-beautiful-dnd), Zustand/Redux for the in-memory timetable grid, TailwindCSS, virtualized grid (`react-window` / AG Grid) for the 50×40 allocation matrix.
- **Backend:** Node.js (NestJS recommended), MySQL 8 (or Postgres), Redis + BullMQ for the solver job queue, Socket.IO for solver progress streaming and live conflict alerts.
- **Solver:** pure Node/TypeScript custom CSP engine for v1. Google OR-Tools CP-SAT is a *v2* option only, for soft-optimization goals (workload balancing, gap minimization).
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
12. **AI access is role-based and server-enforced:** `ai.chat`, `ai.reports`, `ai.configure` permissions checked by middleware on every AI endpoint (REST + Socket.IO chat namespace) — hiding nav items is cosmetic, the guard lives on the server. API keys are AES-encrypted at rest, write-only in the UI, and every conversation is audit-logged (`ai_chat_log`) with token usage counted against a monthly budget.

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
- **Palette (CSS variables):** forest-green theme — `--forest:#1B4332`, `--forest-deep:#0C211A`, `--sage:#52796F`, `--sage-pale:#E7EFEC`, `--offwhite:#F4F7F5`, error `--signal:#C2372F`, warn `--amber:#B9791A`, success `--mint:#2D6A4F`.
- **Layout:** dark forest sidebar (236px) + top bar with a timetable-config selector; screens: Timetables (landing), Setup Wizard (stepper: Academic Year → Classes/Sections/Rooms → Subjects → Curriculum → Teachers → Teacher Mapping → Timetable Config), Readiness Dashboard, Generate (live progress log), Allocation Matrix (sticky headers/first column), Drag-Drop Board, Publish Confirmation, Substitute Center, Reports, Masters, Notifications, (role-gated, under an "Intelligence" nav group) Ask AI chat + AI Settings, and (Admin-only) Roles & Access. Teacher-role users get scoped My Timetable / My Classes views instead of the admin screens.
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
