#!/usr/bin/env sh
#
# Phase 9.10 (§17.8) — the multi-school isolation gate.
#
#   docker compose exec api sh /app/scripts/isolation-suite.sh
#
# One command, one exit code. Everything that asserts a school cannot reach
# another school's data runs here, so "is tenancy still sound?" has a single
# answer instead of nine scripts somebody has to remember to run. CI fails on
# this the way it fails on a failing unit test.
#
# It runs against the live dev stack on purpose. Row scoping (9.1), connection
# routing (9.4), cache keys, socket rooms and queue jobs are properties of the
# running system — a mocked version of any of them would be asserting that the
# mock behaves, which is not the question.
#
# Order matters: the cheap structural checks run first, so a broken build fails
# in seconds rather than after the four-minute suite.
set -u

# `pnpm --filter` needs to run from inside the workspace, and this script is
# invoked from wherever the caller happened to be.
cd /app || exit 1
API_DIR=/app
GREEN='\033[0;32m'; RED='\033[0;31m'; DIM='\033[2m'; OFF='\033[0m'
failed=0
skipped=""

run() {
  name="$1"; shift
  printf "\n${DIM}────────────────────────────────────────────────────────${OFF}\n"
  printf "▶ %s\n" "$name"
  if "$@"; then
    printf "${GREEN}✓ %s${OFF}\n" "$name"
  else
    printf "${RED}✗ %s${OFF}\n" "$name"
    failed=1
  fi
}

# 1. Scoping unit tests — the extension's own rules, no stack required.
run "unit: scoping and fair scheduling" \
  pnpm --filter @edutimetable/api test

# 2. The mechanism, on a sample of endpoints, with the oracle reading raw rows.
run "9.1  row scoping, cache and worker isolation" \
  node "$API_DIR/scripts/tenant-isolation.cjs"

# 3. Socket.IO: events are addressed to a school's room, never broadcast.
run "9.1  socket events do not cross schools" \
  node "$API_DIR/scripts/tenant-socket-check.cjs"

# 4. The registry itself, and school provisioning from an SSO token.
run "9.2  tenant registry and control plane" \
  node "$API_DIR/scripts/control-plane-smoke.cjs"
run "9.5  ERP school identity, switching and grants" \
  node "$API_DIR/scripts/sso-schools-smoke.cjs"

# 5. Connection routing: a school with its own database on the same server...
#    Provision it first. `tenant:create` is idempotent, and a suite with a
#    hidden setup step is a suite that fails for the wrong reason on a fresh
#    stack — the failure everyone learns to ignore.
printf "\n${DIM}preparing the same-server dedicated tenant…${OFF}\n"
pnpm --filter @edutimetable/api tenant:create \
  --code ZZDED-1 --name "ZZ Dedicated Academy" >/dev/null 2>&1 \
  || printf "${RED}could not provision ZZDED-1${OFF}\n"
run "9.4  dedicated database (same server)" \
  node "$API_DIR/scripts/dedicated-tenant-smoke.cjs"

# ...and one on a genuinely separate server with its own credentials. Needs the
# dev stack's second MySQL; skipped rather than failed elsewhere, and said so.
if [ -n "${TENANT_B_DATABASE_URL:-}" ]; then
  run "9.10 dedicated database (separate server, own credentials)" \
    node "$API_DIR/scripts/dedicated-db-smoke.cjs"
else
  skipped="${skipped}\n  - dedicated-db-smoke (TENANT_B_DATABASE_URL unset; start the dev stack's mysql-b)"
fi

# 6. Platform access sits above schools and is not grantable from inside one.
run "9.8  platform console access" \
  node "$API_DIR/scripts/platform-console-smoke.cjs"

# 7. Fairness: one school cannot monopolise the worker.
run "9.9  fair scheduling across schools" \
  node "$API_DIR/scripts/fair-scheduling-smoke.cjs"

# 8. The exhaustive sweep, last: it is the slowest, and the most likely to be
#    the thing you are iterating on.
run "9.10 exhaustive route / list / body / tool sweep" \
  node "$API_DIR/scripts/isolation-sweep.cjs"

printf "\n${DIM}════════════════════════════════════════════════════════${OFF}\n"
if [ -n "$skipped" ]; then
  printf "Skipped:${skipped}\n\n"
fi
if [ "$failed" -eq 0 ]; then
  printf "${GREEN}ISOLATION SUITE PASSED${OFF} — no school can reach another's data.\n"
else
  printf "${RED}ISOLATION SUITE FAILED${OFF} — see the ✗ lines above.\n"
fi
exit "$failed"
