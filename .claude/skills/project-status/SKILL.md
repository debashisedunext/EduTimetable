---
name: project-status
description: Report the current status of the EduTimetable project — which implementation phase/tasks are done, in progress, or pending, plus repo health (git, tests, blockers). Use when the user asks "where are we", "project status", "what's done", or "what's next".
---

# Project Status Report

Produce a concise, accurate status report of the EduTimetable project by comparing what actually exists in the repo against `IMPLEMENTATION-PLAN.md`. Never guess completion — verify by looking at files.

## Steps

1. **Establish what exists.** Check the repo root and (if present) `apps/`, `packages/` for real code:
   - No `apps/`/`package.json` at all → project is still in the **specification stage** (Phase 0 not started).
   - If code exists, map directories/modules to plan tasks (e.g., a feasibility module in `packages/shared` → Phase 1C; `timetable_slots` migration + solver worker → Phase 2).
2. **Check git state** (if a repo): current branch, uncommitted changes, recent commit subjects (`git log --oneline -15`) — recent commits are the best signal of what was worked on last.
3. **Check test health** (if code exists): run the test suite (or the fastest relevant subset) **inside the Docker stack** (`docker compose exec api pnpm test` — this project is Docker-only, never host commands) and note pass/fail counts. Also verify the stack itself boots (`docker compose ps` / `docker compose up -d`). A red suite or a non-booting stack is always reported as a blocker, never smoothed over.
4. **Compare against the plan.** Walk `IMPLEMENTATION-PLAN.md` phase by phase (0 → 7). For each phase, classify: ✅ done (exit criteria demonstrably met), 🔨 in progress (some tasks landed), ⬜ not started. Within the active phase, list task-level status (e.g., "1.1–1.5 done, 1.6 in progress, 1.7–1.14 pending").
5. **Identify blockers and next actions.** Blockers = failing tests, unmet exit criteria, missing dependencies for the next task. Next actions = the next 2–3 tasks in plan order.

## Output format

Lead with a one-line verdict ("Phase 1 in progress — 5 of 14 tasks done, tests green"). Then:

- **Phase progress table** (phase, status, evidence — cite actual files/dirs as proof)
- **Active phase detail** — task-level checklist
- **Blockers** (or "none")
- **Next up** — the immediate next tasks from the plan

Keep it under a screen. Evidence over optimism: if you can't verify something is done, say "not verified" rather than assuming.

## Project context

- `IMPLEMENTATION-PLAN.md` — the phase/task source of truth (Phases 0–7, sequential).
- `AI-Timetable-System-Architecture.md` — the spec (§ references used in the plan).
- `CLAUDE.md` — invariants and conventions; a phase isn't "done" if it violates these.
