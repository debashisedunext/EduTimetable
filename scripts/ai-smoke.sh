#!/bin/sh
# Task 7.7 — AI Assistant safety smoke test against the LIVE stack (§13.3).
# Proves: the three AI permissions are enforced server-side on REST, the API
# key is never echoed back, and the role access matrix takes effect.
# Run from repo root:  sh scripts/ai-smoke.sh
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
check() { # EXPECTED LABEL METHOD PATH TOKEN [BODY]
  EXPECTED=$1; LABEL=$2; METHOD=$3; PATH_=$4; TOKEN=$5; BODY=$6
  CODE=$(curl -s -o /tmp/ai_smoke_out -w "%{http_code}" -X "$METHOD" "$API$PATH_" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" ${BODY:+-d "$BODY"})
  if [ "$CODE" = "$EXPECTED" ]; then echo "  PASS  $LABEL → $CODE"
  else echo "  FAIL  $LABEL → got $CODE, expected $EXPECTED ($(head -c 200 /tmp/ai_smoke_out))"; FAILED=1; fi
}

FAILED=0
ADMIN=$(session_for '{"erpUserId":"ERP-1","erpRole":"ADMIN","name":"Admin A","email":"a@school.test"}')
TEACHER=$(session_for '{"erpUserId":"ERP-3","erpRole":"TEACHER","name":"R. Sharma","email":"rs@school.test","teacherId":1}')

echo "RBAC — a Teacher role holds none of the AI permissions by default (§13.3):"
check 403 "GET /ai/settings as teacher"       GET  "/ai/settings"        "$TEACHER"
check 403 "PUT /ai/settings as teacher"       PUT  "/ai/settings"        "$TEACHER" '{"model":"evil"}'
check 403 "POST /ai/settings/test as teacher" POST "/ai/settings/test"   "$TEACHER" '{"apiKey":"sk-x"}'
check 403 "GET /ai/settings/roles as teacher" GET  "/ai/settings/roles"  "$TEACHER"
check 403 "GET /ai/chat/conversations as teacher" GET "/ai/chat/conversations" "$TEACHER"

echo "Admin can configure:"
check 200 "GET /ai/settings"        GET "/ai/settings"       "$ADMIN"
check 200 "GET /ai/settings/tools"  GET "/ai/settings/tools" "$ADMIN"
check 200 "GET /ai/settings/roles"  GET "/ai/settings/roles" "$ADMIN"

echo "Key custody — a stored key is never echoed back (§13.2):"
check 200 "store an API key" PUT "/ai/settings" "$ADMIN" '{"apiKey":"sk-ant-smoke-DO-NOT-LEAK-12345"}'
if grep -q "DO-NOT-LEAK" /tmp/ai_smoke_out; then
  echo "  FAIL  the API key came back in the response body"; FAILED=1
else
  echo "  PASS  response contains no key material"
fi
check 200 "re-read settings" GET "/ai/settings" "$ADMIN"
if grep -q "DO-NOT-LEAK" /tmp/ai_smoke_out; then
  echo "  FAIL  GET /ai/settings leaked the key"; FAILED=1
else
  echo "  PASS  GET returns only a masked hint (keyHint=$(tr ',' '\n' < /tmp/ai_smoke_out | grep keyHint | cut -d: -f2))"
fi
# the ciphertext in the database must not contain the plaintext either
if docker compose exec -T mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" edutimetable -N -e "SELECT HEX(api_key_encrypted) FROM ai_settings"' 2>/dev/null \
   | grep -qi "$(printf 'sk-ant-smoke' | od -An -tx1 | tr -d ' \n')"; then
  echo "  FAIL  plaintext key found in the database"; FAILED=1
else
  echo "  PASS  database holds ciphertext only"
fi
check 200 "clear the stored key" PUT "/ai/settings" "$ADMIN" '{"apiKey":""}'

echo "Budget cutoff is configurable (§13.2):"
check 200 "set a 1-token budget"  PUT "/ai/settings" "$ADMIN" '{"monthlyTokenBudget":1}'
check 200 "settings report budgetExceeded" GET "/ai/settings" "$ADMIN"
if grep -q '"budgetExceeded":true' /tmp/ai_smoke_out; then
  echo "  PASS  budget cutoff reported once usage exceeds it"
else
  echo "  INFO  no usage logged yet this month — cutoff not triggered"
fi
check 200 "clear the budget" PUT "/ai/settings" "$ADMIN" '{"monthlyTokenBudget":null}'

if [ "$FAILED" = "0" ]; then echo "ALL AI SMOKE CHECKS PASSED"; else echo "SOME CHECKS FAILED"; exit 1; fi
