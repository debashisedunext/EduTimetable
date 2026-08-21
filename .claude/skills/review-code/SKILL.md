---
name: review-code
description: Review EduTimetable code changes against the project's non-negotiable invariants (DB-enforced uniqueness, hard-constraint domain pruning, RBAC, read-only AI tools) plus general correctness. Use when the user asks to "review", "check my code", "audit this change", or before merging/publishing work.
---

# Review Code Against Project Invariants

Review the target code (the current diff by default; otherwise the files/module the user names) in two passes: **project-invariant violations first** (these are the highest-severity findings in this codebase), then general correctness. Verify every finding against the actual code before reporting it — no speculative findings.

## Pass 1 — Invariant checklist (from CLAUDE.md / the architecture doc)

Check each item that the diff touches; skip ones it can't affect. A violation here is always severity-critical.

1. **Double-booking guard** — any code writing `timetable_slots` must rely on (not bypass or soften) the three unique keys `uq_class_slot`, `uq_teacher_slot2` (occupancy-key aware), `uq_room_slot`. Red flags: raw upserts with `ON DUPLICATE KEY UPDATE` that swallow conflicts; disabling/renaming the keys; writing slots outside a transaction.
2. **Hard constraints stay hard** (§4.7) — `always_first_period`, `alternate_period`, `alternate_day` must be enforced by domain pruning / hard checks, never converted to penalties, weights, or "soft" scores.
3. **One rules engine, four call sites** — solver placement, drag-drop legality, "suggest legal moves", and AI answers must all call the shared `ConstraintChecker` / report-query services. Red flag: a screen or endpoint reimplementing a constraint or query inline.
4. **Draft/publish in one table** — no second slots table, no row-copying publish; publish must be a single transaction flipping `status`.
5. **Macro-variable atomicity** (§4.8–4.9) — double periods, merged groups, and elective blocks place/fail as a whole; look for code paths that could leave a half-placed block.
6. **Substitutions are overlays** — date-scoped rows with `source='substitute'`; base published rows must never be mutated by substitution code.
7. **Cross-config teacher load** (§3.10) — load/feasibility math must sum a teacher across *all* timetable configs, not per-config.
8. **Locked slots** (`is_locked`) — solver re-runs and auto-fill must treat them as fixed.
9. **Dual validation for edits** — client-side checks are UX only; every mutating endpoint re-validates server-side.
10. **AI layer is read-only and tool-gated** (§13) — the LLM path must only reach whitelisted tools; no SQL from model output, no write tools, scope (`school_id`, permitted configs) injected server-side, never taken from the prompt or client.
11. **SSO-only auth + app-wide RBAC + query-layer scoping** (§15, §13.3) — no local login/password code may exist (entry is the verified, nonce-protected ERP SSO token only). Every permission (full registry incl. `ai.*`) enforced by middleware on REST **and** Socket.IO; UI hiding alone is a violation. The `timetable.view.own/.class/.all` scope filter must be injected by the shared scoping module in the **query layer** — red flags: an endpoint/report/AI tool querying timetable data without the scope module; scope derived from client-supplied params instead of the session user; teacher-linked data resolved from anything but `users.teacher_id` + the mapping tables. API keys encrypted, write-only, never logged.
12. **Solver off the request path** — generation runs as a BullMQ job, never inline in an HTTP handler.
13. **Docker-only** — no code, script, doc, or CI step may depend on host-installed Node/MySQL/Redis or hardcode `localhost` for service hosts (compose service names `mysql`/`redis` via env). New services/deps must be added to the compose files + Dockerfiles in the same change.
14. **Performance budget (§14)** — transactional pages and on-screen reports must hold p95 ≤ 1s (API ≤ 300 ms, DB ≤ 100 ms). Red flags in a diff: a query on `timetable_slots`/report tables without a supporting index or `EXPLAIN` evidence; N+1 patterns (per-row queries in a loop, lazy-loaded relations in list endpoints); returning nested ORM object graphs where a compact array suffices; unpaginated list endpoints; synchronous heavy work (PDF/Excel generation, notification fan-out, any solver call) inside an HTTP handler instead of a queued job with ≤ 1s acknowledgment; a new cached view without event-driven invalidation (stale-forever caches are also findings); a large table/grid rendered without virtualization. A PR adding an endpoint or screen without stated measured latency is itself a finding.

## Pass 2 — General review

- **Correctness:** off-by-one on period/day indices (days are 1=Mon..7), timezone/date handling for substitutions and holidays, transaction boundaries, race conditions between concurrent admins, unhandled solver timeout paths.
- **Tests:** does the change extend the feasibility fixture library / ConstraintChecker tests when it adds a rule? A new constraint without a test case is a finding.
- **Spec drift:** behavior differing from `AI-Timetable-System-Architecture.md` without a same-PR doc update is a finding (CLAUDE.md convention).
- **Simplification/reuse:** duplicated query shapes that belong in the shared report/query service; UI not using the design-system tokens/components.

## Output

Report findings ranked most-severe first. For each: file:line, one-sentence defect statement, the concrete failure scenario (inputs/state → wrong outcome), and which invariant or spec § it violates. If nothing survives verification, say so plainly — do not pad with nitpicks. Do not apply fixes unless the user asked; the deliverable is the review.
