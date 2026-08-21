#!/bin/sh
# Task 3.8 — Draft Board concurrency & legality smoke test against the LIVE
# stack: two-admin stale drops (409), lock conflicts, RBAC negatives, and the
# publish lifecycle (publish-during-edit → 409). Needs a draft with slots
# (run Generate first, or draft-from-published). Run from repo root:
#   sh scripts/board-smoke.sh
set -e
API="${API:-http://localhost:3001/api}"
CFG="${CFG:-1}"

erp_token() {
  curl -s -X POST "$API/dev/erp-token" -H "Content-Type: application/json" -d "$1" \
    | sed 's/.*"token":"\([^"]*\)".*/\1/'
}
session_for() {
  T=$(erp_token "$1")
  curl -s -o /dev/null -w "%{redirect_url}" "$API/sso/callback?token=$T" | sed 's/.*#token=//'
}
# check EXPECTED LABEL METHOD PATH TOKEN [BODY] — the call happens here, so no
# nested command substitution (escaped quotes inside "$(...)" mis-parse in sh)
check() {
  EXPECTED=$1; LABEL=$2; METHOD=$3; PATH_=$4; TOKEN=$5; BODY=$6
  CODE=$(curl -s -o /tmp/board_smoke_out -w "%{http_code}" -X "$METHOD" "$API$PATH_" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" ${BODY:+-d "$BODY"})
  if [ "$CODE" = "$EXPECTED" ]; then echo "  PASS  $LABEL → $CODE"
  else echo "  FAIL  $LABEL → got $CODE, expected $EXPECTED ($(cat /tmp/board_smoke_out))"; FAILED=1; fi
}

FAILED=0
ADMIN=$(session_for '{"erpUserId":"ERP-1","erpRole":"ADMIN","name":"Admin A","email":"a@school.test"}')
ADMIN2=$(session_for '{"erpUserId":"ERP-9","erpRole":"ADMIN","name":"Admin B","email":"b@school.test"}')
TEACHER=$(session_for '{"erpUserId":"ERP-3","erpRole":"TEACHER","name":"R. Sharma","email":"rs@school.test","teacherId":1}')

# first draft tuple: [cs,day,period,subj,teacher,...]
SLOTS=$(curl -s "$API/timetable-configs/$CFG/slots?status=draft" -H "Authorization: Bearer $ADMIN")
FIRST=$(echo "$SLOTS" | sed 's/.*"slots":\[\[\([^]]*\)\].*/\1/')
CS=$(echo "$FIRST" | cut -d, -f1); DAY=$(echo "$FIRST" | cut -d, -f2)
PER=$(echo "$FIRST" | cut -d, -f3); SUBJ=$(echo "$FIRST" | cut -d, -f4); TEACH=$(echo "$FIRST" | cut -d, -f5)
if [ -z "$CS" ]; then echo "No draft slots for config $CFG — generate first"; exit 1; fi
echo "Using card: section=$CS day=$DAY period=$PER subject=$SUBJ teacher=$TEACH"
FROM='{"classSectionId":'$CS',"day":'$DAY',"period":'$PER'}'
EXPECT='{"subjectId":'$SUBJ',"teacherId":'$TEACH'}'
MOVE_SELF='{"from":'$FROM',"expect":'$EXPECT',"to":{"day":'$DAY',"period":'$PER'}}'
MOVE_OFFGRID='{"from":'$FROM',"expect":'$EXPECT',"to":{"day":'$DAY',"period":99}}'
REMOVE='{"from":'$FROM',"expect":'$EXPECT'}'
PLACE='{"classSectionId":'$CS',"subjectId":'$SUBJ',"teacherId":'$TEACH',"day":'$DAY',"period":'$PER'}'

echo "RBAC: teacher role must be blocked on every board endpoint:"
check 403 "GET board/context as teacher"    GET  "/timetable-configs/$CFG/board/context"          "$TEACHER"
check 403 "POST move as teacher"            POST "/timetable-configs/$CFG/board/move"             "$TEACHER" "$MOVE_OFFGRID"
check 403 "GET publish preview as teacher"  GET  "/timetable-configs/$CFG/board/publish/preview"  "$TEACHER"
check 403 "POST publish as teacher"         POST "/timetable-configs/$CFG/board/publish"          "$TEACHER"

echo "Validation: an illegal drop is rejected with a specific reason (400):"
check 400 "drop outside the grid is refused" POST "/timetable-configs/$CFG/board/move" "$ADMIN" "$MOVE_OFFGRID"

echo "Locking (§7.4):"
check 201 "admin A pins the card"                POST "/timetable-configs/$CFG/board/lock"   "$ADMIN"  '{"from":'$FROM',"locked":true}'
check 400 "admin B cannot move the pinned card"  POST "/timetable-configs/$CFG/board/move"   "$ADMIN2" "$MOVE_OFFGRID"
check 400 "admin B cannot remove the pinned card" POST "/timetable-configs/$CFG/board/remove" "$ADMIN2" "$REMOVE"
check 201 "admin A unpins"                       POST "/timetable-configs/$CFG/board/lock"   "$ADMIN"  '{"from":'$FROM',"locked":false}'

echo "Two admins, one card — stale drop is rejected (409):"
check 201 "admin A removes the card"                     POST "/timetable-configs/$CFG/board/remove" "$ADMIN"  "$REMOVE"
check 409 "admin B's drop of the vanished card → stale"  POST "/timetable-configs/$CFG/board/move"   "$ADMIN2" "$MOVE_SELF"
check 201 "admin A restores it from the tray"            POST "/timetable-configs/$CFG/board/place"  "$ADMIN"  "$PLACE"

echo "Publish lifecycle (§3 one-transaction flip):"
check 200 "publish preview computes"                     GET  "/timetable-configs/$CFG/board/publish/preview"     "$ADMIN"
check 201 "publish flips draft→published"                POST "/timetable-configs/$CFG/board/publish"             "$ADMIN"
check 409 "edit-after-publish → stale (draft is gone)"   POST "/timetable-configs/$CFG/board/move"                "$ADMIN2" "$MOVE_SELF"
check 400 "publishing an empty draft is refused"         POST "/timetable-configs/$CFG/board/publish"             "$ADMIN"
check 201 "new draft from published"                     POST "/timetable-configs/$CFG/board/draft-from-published" "$ADMIN"
check 400 "second draft-from-published refused"          POST "/timetable-configs/$CFG/board/draft-from-published" "$ADMIN"

if [ "$FAILED" = "0" ]; then echo "ALL BOARD SMOKE CHECKS PASSED"; else echo "SOME CHECKS FAILED"; exit 1; fi
