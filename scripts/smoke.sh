#!/usr/bin/env bash
# End-to-end smoke test against a running instance.
#   Local (mocked auth):  ./scripts/smoke.sh                       (expects `npm run watch` on :4004)
#   Deployed:             BASE_URL=https://… AGENT_TOKEN=… SBPA_TOKEN=… ./scripts/smoke.sh
# Tokens: client-credentials tokens from the optisell-agent-uaa / optisell-sbpa-uaa service keys.
set -euo pipefail
BASE_URL="${BASE_URL:-http://localhost:4004}"
command -v jq >/dev/null || { echo "jq is required"; exit 1; }

if [[ -n "${AGENT_TOKEN:-}" ]]; then AGENT=(-H "Authorization: Bearer $AGENT_TOKEN"); else AGENT=(-u agent:); fi
if [[ -n "${SBPA_TOKEN:-}"  ]]; then SBPA=(-H "Authorization: Bearer $SBPA_TOKEN");   else SBPA=(-u sbpa:);   fi

post () { # post <auth-array-name> <path> <json>
  local -n auth=$1
  curl -sS -w '\n%{http_code}' "${auth[@]}" -H 'Content-Type: application/json' -X POST "$BASE_URL$2" -d "$3"
}
step () { echo; echo "── $*"; }
expect () { # expect <status> <response-with-status-line>
  local status; status=$(tail -n1 <<<"$2"); local body; body=$(sed '$d' <<<"$2")
  echo "$body" | jq -c . 2>/dev/null || echo "$body"
  [[ "$status" == "$1" ]] || { echo "✗ expected HTTP $1, got $status"; exit 1; }
  echo "✓ HTTP $status"
}

step "reset demo data";                 expect 200 "$(post AGENT /admin/reset_demo_data '{}')"
step "get_store_stock";                 expect 200 "$(post AGENT /tools/get_store_stock '{"store_id":"S101"}')"
step "create_proposal MLK-1L/B2301";    R=$(post AGENT /tools/create_proposal '{"store_id":"S101","sku":"MLK-1L","batch":"B2301","old_price":68,"new_price":47.6,"discount_pct":30,"margin_pct":16.0,"margin_breach":false,"at_risk_qty":63,"reason":"Expires in 3 days, 63 units at risk"}')
expect 200 "$R"; IID=$(sed '$d' <<<"$R" | jq -r .sbpa_instance_id)
step "duplicate create_proposal → 409"; expect 409 "$(post AGENT /tools/create_proposal '{"store_id":"S101","sku":"MLK-1L","batch":"B2301","old_price":68,"new_price":50,"discount_pct":26,"margin_pct":20,"margin_breach":false,"at_risk_qty":63,"reason":"dup"}')"
step "get_approval_status P-0003";      expect 200 "$(post AGENT /tools/get_approval_status '{"proposal_id":"P-0003"}')"
step "agent cannot call /sbpa → 403";   expect 403 "$(post AGENT /sbpa/complete_approval "{\"sbpa_instance_id\":\"$IID\",\"decision\":\"approve\",\"decided_by\":\"x\"}")"
step "SBPA approves $IID";              expect 200 "$(post SBPA /sbpa/complete_approval "{\"sbpa_instance_id\":\"$IID\",\"decision\":\"approve\",\"decided_by\":\"store.manager\",\"comment\":\"ok\"}")"
step "price now 47.6";                  R=$(post AGENT /tools/get_store_stock '{"store_id":"S101"}'); expect 200 "$R" >/dev/null
P=$(sed '$d' <<<"$R" | jq '.items[] | select(.batch=="B2301") | .price'); [[ "$P" == "47.6" ]] && echo "✓ B2301 price $P" || { echo "✗ B2301 price $P"; exit 1; }
step "record_outcome";                  expect 200 "$(post AGENT /tools/record_outcome '{"proposal_id":"P-0003","units_sold":110,"units_wasted":10}')"
step "get_markdown_kpis";               expect 200 "$(post AGENT /tools/get_markdown_kpis '{"store_id":"S101"}')"
step "reset demo data";                 expect 200 "$(post AGENT /admin/reset_demo_data '{}')"
echo; echo "smoke test passed against $BASE_URL"
