#!/bin/sh
# Task 1.16 — RBAC negative smoke test against the LIVE stack (§15.3).
# A Teacher-role session must be rejected (403) on every masters/admin/readiness
# endpoint, and unauthenticated requests must get 401. Run from repo root:
#   sh scripts/rbac-smoke.sh
set -e
API="${API:-http://localhost:3001/api}"

erp_token() {
  curl -s -X POST "$API/dev/erp-token" -H "Content-Type: application/json" -d "$1" \
    | sed 's/.*"token":"\([^"]*\)".*/\1/'
}
session_for() {
  T=$(erp_token "$1")
  curl -s -o /dev/null -w "%{redirect_url}" "$API/sso/callback?token=$T" | sed 's/.*#token=//'
}
expect() { # method path token expected_status label
  CODE=$(curl -s -o /dev/null -w "%{http_code}" -X "$1" "$API$2" \
    ${3:+-H "Authorization: Bearer $3"} -H "Content-Type: application/json" ${6:+-d "$6"})
  if [ "$CODE" = "$4" ]; then
    echo "  PASS  $5 → $CODE"
  else
    echo "  FAIL  $5 → got $CODE, expected $4"; FAILED=1
  fi
}

FAILED=0
TEACHER=$(session_for '{"erpUserId":"ERP-3","erpRole":"TEACHER","name":"R. Sharma","email":"rs@school.test","teacherId":1}')
ADMIN=$(session_for '{"erpUserId":"ERP-1","erpRole":"ADMIN","name":"R. Ahuja","email":"admin@school.test"}')

echo "Teacher role must be blocked (403) on management endpoints:"
expect GET  "/teachers"                      "$TEACHER" 403 "GET /teachers"
expect POST "/subjects"                      "$TEACHER" 403 "POST /subjects" '{"name":"Hack"}'
expect GET  "/timetable-configs"             "$TEACHER" 403 "GET /timetable-configs"
expect GET  "/timetable-configs/1/readiness" "$TEACHER" 403 "GET readiness"
expect GET  "/admin/overview"                "$TEACHER" 403 "GET /admin/overview"
expect PUT  "/admin/users/1"                 "$TEACHER" 403 "PUT /admin/users/1" '{"roleId":1}'
expect PUT  "/class-sections/1/class-teacher" "$TEACHER" 403 "PUT class-teacher" '{"teacherId":1}'

echo "Teacher role keeps what it IS granted:"
expect GET "/me" "$TEACHER" 200 "GET /me"

echo "No token at all → 401 everywhere:"
expect GET "/me"       ""  401 "GET /me (anonymous)"
expect GET "/teachers" ""  401 "GET /teachers (anonymous)"

echo "Admin keeps full access (sanity):"
expect GET "/teachers"       "$ADMIN" 200 "GET /teachers"
expect GET "/admin/overview" "$ADMIN" 200 "GET /admin/overview"

[ "$FAILED" = "0" ] && echo "RBAC smoke: ALL PASS" || { echo "RBAC smoke: FAILURES"; exit 1; }
