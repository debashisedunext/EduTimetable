---
name: test-app
description: Run and extend EduTimetable's tests — unit, integration, solver property tests, and manual verification of the running app. Use when the user asks to "test", "run tests", "verify this works", "add tests", or check a phase's exit criteria.
---

# Test the Application

Verify EduTimetable behavior at the right level, run what exists, report results faithfully (failures verbatim, never smoothed over), and add missing coverage where the change demands it.

## Step 1 — Discover the current test setup

Check `package.json` scripts in the workspace root and each app/package (`test`, `test:unit`, `test:e2e`, `test:int`). Use the project's own runner and commands — don't invent new tooling. If no code/tests exist yet (spec stage), say so and offer the per-phase test checklist below as the plan.

**Docker-only rule:** this project runs exclusively in Docker. Execute every test command inside the containers — `docker compose exec api pnpm test`, `docker compose exec web pnpm test`, or `docker compose run --rm <service> <cmd>` if the stack is down (`docker compose up -d` first when integration tests need MySQL/Redis). Never run pnpm/node against the host, and never start a host MySQL/Redis for tests. "Run the app" always means the compose stack.

## Step 2 — Choose the right level for what's being tested

| Target | How to test |
|---|---|
| Feasibility Engine (§4) | Pure unit tests in `packages/shared` against the **fixture library** (task 1.14): overloaded teacher, impossible daily spread, alternate-period capacity math, class-teacher P1 deadlock, merged-group empty intersection, cross-wing overload. Every check must assert the exact blocker message + entity ref. |
| ConstraintChecker (§5.1) | Unit tests per constraint (all 10), including occupancy-key collapse for merged groups and block atomicity. |
| Solver (§5) | Deterministic-seed unit runs + the **property test**: any fixture that passes feasibility must solve to 100% within budget. A property-test failure is a feasibility gap — file it as such, don't weaken the assertion. Benchmark: 2,000-slot school ≤ 30s. |
| DB uniqueness (§3) | Integration test proving MySQL itself rejects a duplicate class/teacher/room slot insert — app logic bypassed deliberately. |
| API endpoints | Integration tests incl. **negative RBAC cases**: every mutating and AI endpoint rejects a user lacking the permission (server-side, not just hidden UI). |
| SSO & view scoping (§15) | SSO callback: expired token, bad signature, and replayed nonce all rejected; provisioning respects Admin role overrides on re-login. Scoping: a teacher-role session requesting another teacher's grid, an unlinked class-section, or draft data gets 403/empty — via hand-crafted REST *and* Socket.IO calls; a `view.class` user gets exactly the sections they teach or class-teach, no more. |
| Drag-drop / publish (§7) | Server revalidation tests: stale-state drop rejected, illegal swap rejected with specific reason, publish transaction atomic, locked slots untouched by auto-fill. Concurrency: two admins editing the same draft. |
| Substitute engine (§6) | Matching fairness (load spread), no-candidate flagging, overlay never mutates base rows, multi-absence days. |
| AI Assistant (§13) | Adversarial: prompt-injection cannot escape tool scope or reach another school; no-permission user blocked at socket layer; key absent from logs/responses; budget cutoff. Groundedness spot-check: answers cite tool results. |
| Performance (§14) | k6/autocannon load tests against the seeded 50-section / 2,000-slot school at ~40 concurrent users, asserting **p95 ≤ 1s** (API ≤ 300 ms) on every critical endpoint: matrix load, each report, readiness, board fetch, substitute matching, masters lists. Heavy exports must *acknowledge* ≤ 1s (job queued) even though completion may take longer. A budget regression is a failing test — report it as red, never as "a bit slow". Check the slow-query log (>100 ms) after runs. |
| UI / full flow | Run the app (backend + web), walk the real flow: enter masters → readiness blockers appear live → fix → generate → drag an illegal move (expect red + specific reason) → publish → mark absence → confirm substitutes. Note perceived page-load times against the 1s budget. Screenshot or describe what was actually observed. |

## Step 3 — Run, then report

- Run the narrowest suite that covers the change first, then the full suite before declaring done.
- Report: exact command, pass/fail counts, and full output for every failure. "Tests pass" is only claimable after actually running them in this session.
- If a test is flaky, rerun to confirm and report it as flaky — never delete or skip it to get green.

## Step 4 — Add coverage where it's missing

When a change adds or alters a rule, constraint, check, or permission and no test covers it, write the test in the same style/location as neighboring tests. New feasibility rules extend the fixture library; new constraints extend ConstraintChecker tests. Do not rewrite passing tests to match buggy code — if expected behavior is ambiguous, surface the conflict to the user.

## Phase exit criteria

A phase is "tested" only when its exit criteria in `IMPLEMENTATION-PLAN.md` are demonstrably met — check them off explicitly in your report.
