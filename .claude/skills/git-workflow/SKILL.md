---
name: git-workflow
description: Commit, push, and merge EduTimetable code safely — branch naming, quality gates before push, PR creation, and merge rules. Use when the user asks to "push", "commit", "create a PR", "merge", or "ship" changes.
---

# Git Push & Merge Workflow

Ship the current changes through the project's git flow: branch → quality gate → commit → push → PR → merge. Never skip the quality gate, and never merge without an explicit go-ahead from the user in this session.

## Step 0 — Preflight

1. **Is this a git repo?** If not (`git status` fails), offer to `git init`, create a `.gitignore` (node_modules, dist/build, `.env`, MySQL/Redis volume dirs, `.DS_Store`, coverage), and ask the user for the remote URL before any push. Don't invent a remote.
2. **Never work directly on `main`/`master`.** If on the default branch with changes, create a branch first. Naming: `phase<N>/<short-task-desc>` tied to IMPLEMENTATION-PLAN.md (e.g., `phase1/feasibility-check-2`, `phase0/docker-stack`).
3. **Inspect what's being shipped:** `git status` + `git diff` (and `git log` since main). Flag anything that shouldn't ship: secrets or API keys (`.env`, `sk-ant-…`, credentials in compose files), debug leftovers, generated artifacts, unrelated files. Stage deliberately — no blind `git add -A` when the tree contains unrelated changes.

## Step 1 — Quality gate (blocking)

Before any push, inside Docker (this project is Docker-only — never host commands):

- `docker compose exec api pnpm lint && docker compose exec api pnpm typecheck`
- `docker compose exec api pnpm test` (plus `web` tests if the diff touches `apps/web`)
- If the change adds/alters a constraint, check, or permission: confirm a test covers it (see `/test-app`); if the behavior deviates from the spec, confirm `AI-Timetable-System-Architecture.md` is updated in the same change (CLAUDE.md convention).

A red gate stops the flow: report the failure verbatim and fix (or ask) — never push red, never weaken a test to get green. Pre-code (spec-only stage), the gate is just: docs are consistent with each other.

## Step 2 — Commit

- Split unrelated changes into separate logical commits.
- Message format: `<type>(<scope>): <summary> (task <N.M>)` — types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `ci`; scope = module (`feasibility`, `solver`, `board`, `ai`, `docker`, …); reference the plan task where one applies. Example: `feat(feasibility): pattern-aware teacher capacity for check 2 (task 1.10)`.
- Body: the *why* in one or two sentences when the summary isn't enough. Follow any commit-trailer conventions the harness/system specifies.

## Step 3 — Push & PR

1. `git push -u origin <branch>` (plain push; `--force-with-lease` only on your own unshared branch, and say so).
2. Create the PR with `gh pr create`. PR body must contain:
   - **What & why** — a short paragraph, referencing plan task(s) and spec §.
   - **Test evidence** — the exact commands run in Step 1 and their results.
   - **Invariant note** — which CLAUDE.md invariants the change touches (or "none").
3. Report the PR URL to the user.

## Step 4 — Merge (only on explicit user confirmation)

Merging is a consequential action — even if the user earlier said "push and merge", re-verify conditions and confirm before the actual merge unless they've explicitly pre-authorized it for this change:

1. **Conditions:** CI green on the PR (`gh pr checks`), no unresolved review threads, branch up to date with main (rebase or merge main in, re-run the gate if there were conflicts).
2. **Merge method:** squash merge by default (`gh pr merge --squash --delete-branch`) so main stays one-commit-per-task; use a merge commit only if the user asks to preserve branch history.
3. **After merge:** switch back to main, `git pull`, confirm the merged commit is present, and mention the next plan task now unblocked.

## Never

- Never push or merge with a red quality gate or failing CI.
- Never force-push a shared branch or rewrite main's history.
- Never commit secrets — if one was committed, stop and tell the user (it needs rotation, not just removal).
- Never merge to resolve "it works on my branch" pressure — the gate is the gate.
