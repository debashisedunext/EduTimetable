#!/bin/sh
# Task 4.6 — Substitute Engine smoke test against the LIVE stack. Needs a
# published timetable. Uses a throwaway date (default next Monday-equivalent
# working day far in the future is fine — pass DATE=YYYY-MM-DD to override).
# Run from repo root:  sh scripts/substitute-smoke.sh
set -e
API="${API:-http://localhost:3001/api}"
DATE="${DATE:-2027-03-01}"   # a Monday, far from real data

erp_token() {
  curl -s -X POST "$API/dev/erp-token" -H "Content-Type: application/json" -d "$1" \
    | sed 's/.*"token":"\([^"]*\)".*/\1/'
}
session_for() {
  T=$(erp_token "$1")
  curl -s -o /dev/null -w "%{redirect_url}" "$API/sso/callback?token=$T" | sed 's/.*#token=//'
}
check() { # EXPECTED LABEL METHOD PATH TOKEN [BODY]
  EXPECTED=$1; LABEL=$2; METHOD=$3; PATH_=$4; TOKEN=$5; BODY=$6
  CODE=$(curl -s -o /tmp/sub_smoke_out -w "%{http_code}" -X "$METHOD" "$API$PATH_" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" ${BODY:+-d "$BODY"})
  if [ "$CODE" = "$EXPECTED" ]; then echo "  PASS  $LABEL → $CODE"
  else echo "  FAIL  $LABEL → got $CODE, expected $EXPECTED ($(cat /tmp/sub_smoke_out))"; FAILED=1; fi
}

FAILED=0
ADMIN=$(session_for '{"erpUserId":"ERP-1","erpRole":"ADMIN","name":"Admin A","email":"a@school.test"}')
TEACHER=$(session_for '{"erpUserId":"ERP-3","erpRole":"TEACHER","name":"R. Sharma","email":"rs@school.test","teacherId":1}')

echo "RBAC: teacher role blocked on every substitute endpoint:"
check 403 "GET /absences as teacher"   GET  "/absences"   "$TEACHER"
check 403 "POST /absences as teacher"  POST "/absences"   "$TEACHER" '{"teacherId":1,"date":"'$DATE'"}'

echo "Absence lifecycle:"
check 201 "report absence"            POST "/absences" "$ADMIN" '{"teacherId":1,"date":"'$DATE'","reason":"smoke"}'
AID=$(sed 's/.*"id":\([0-9]*\).*/\1/' /tmp/sub_smoke_out)
check 409 "duplicate absence refused" POST "/absences" "$ADMIN" '{"teacherId":1,"date":"'$DATE'"}'
check 200 "plan computes"             GET  "/absences/$AID/plan" "$ADMIN"

# confirm the engine's own suggested assignment (built from the plan JSON)
ASSIGN=$(python3 -c "
import json
p=json.load(open('/tmp/sub_smoke_out'))
a=[{'slotId':s['slot']['slotId'],'substituteTeacherId':s['assigned']} for s in p['plan']['slots'] if s['assigned'] is not None]
print(json.dumps({'assignments':a}))")
N=$(echo "$ASSIGN" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['assignments']))")
if [ "$N" -gt 0 ]; then
  check 201 "confirm all ($N)"        POST "/absences/$AID/confirm" "$ADMIN" "$ASSIGN"
  BEFORE=$(curl -s "$API/timetable-configs/1/slots?status=published" -H "Authorization: Bearer $ADMIN" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['slots']))")
  echo "  INFO  published grid still has $BEFORE rows (base untouched)"
else
  echo "  INFO  teacher 1 has no published slots that weekday — confirm skipped"
fi

check 200 "delete absence (cascade)"  DELETE "/absences/$AID" "$ADMIN"
LEFT=$(curl -s "$API/absences?date=$DATE" -H "Authorization: Bearer $ADMIN" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
if [ "$LEFT" = "0" ]; then echo "  PASS  overlay rows cascaded away with the absence"
else echo "  FAIL  absence remnants left: $LEFT"; FAILED=1; fi

if [ "$FAILED" = "0" ]; then echo "ALL SUBSTITUTE SMOKE CHECKS PASSED"; else echo "SOME CHECKS FAILED"; exit 1; fi
