#!/usr/bin/env bash
# Node 2 outage on BitSafe LocalNet: the node that normally hosts Alluvren's
# business parties (operator, reviewers, investors) goes offline.
#
# setup-localnet.sh hosts every business party on node 2 and, as a backup, on
# node 1 (submission permission, confirmation threshold 1). With node 2's
# participant disconnected and its DecMan stopped:
#   1. Node 2 refuses new commands.
#   2. The operator runbook creates a fund policy and a batch through node 1;
#      members 1 and 3 confirm the policy and it executes.
#   3. Alluvren's backend, configured with node 2 then node 1, fails over:
#      signed-in reviewers approve, the operator proposes, members 1 and 3
#      confirm and execute, and the investor acknowledges and withdraws.
#   4. Node 2 reconnects and catches up on everything it missed.
# The EXIT trap always reconnects node 2, restarts its DecMan and stops the backend.
# Needs infra/setup-localnet.sh first, on a LocalNet where the business parties
# were allocated fresh (see REPRODUCE.md).
set -Eeuo pipefail
. "$(cd "$(dirname "$0")" && pwd)/localnet-env.sh"
. "$INFRA_DIR/backend-harness.sh"

NODE1_JSON=$BASE:3975
NODE2_JSON=$BASE:2975
RUN=outage2-$(date +%s)
FUND_ID=$RUN
T='#alluvren-v1:Alluvren.Redemption'
stamp() { date -u +%H:%M:%SZ; }
new_id() { printf '%s-%s-%s' "$RUN" "$1" "$(uid)"; }

node2_connected() { canton_console 'println("RESULT " + node2.synchronizers.list_connected().size)' | awk '/^RESULT/{print $2}'; }
node2_down() { docker stop decman-2 >/dev/null; canton_console 'node2.synchronizers.disconnect_all(); println("RESULT done")' >/dev/null; }
node2_up() { canton_console 'node2.synchronizers.reconnect_all(); println("RESULT done")' >/dev/null; docker start decman-2 >/dev/null; }
restore() {
  local code=$?
  if [[ ${RESTORED:-0} != 1 ]]; then echo "Restoring node 2 (exit $code)"; node2_up || true; fi
  backend_stop
}
trap restore EXIT

# --- operator runbook through node 1 ----------------------------------------
submit_on() {
  local api=$1 body
  body=$(jq -cn --arg id "$(new_id "$2")" --argjson actors "$3" --argjson commands "$4" \
    '{commands:{userId:"ledger-api-user",commandId:$id,actAs:$actors,commands:$commands}}')
  curl -sS -w '\nHTTP=%{http_code}' "$api/v2/commands/submit-and-wait-for-transaction" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$body"
}
created() { sed '$d' | jq -r --arg t "$1" '.transaction.events[] | (.CreatedEvent // empty) | select(.templateId | endswith($t)) | .contractId'; }
active_on() {
  local api=$1 offset
  offset=$(curl -fsS "$api/v2/state/ledger-end" -H "Authorization: Bearer $TOKEN" | jq -r '.offset')
  curl -fsS "$api/v2/state/active-contracts" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "$(jq -cn --arg p "$2" --argjson off "$offset" '{filter:{filtersByParty:{($p):{cumulative:[{identifierFilter:{WildcardFilter:{value:{includeCreatedEventBlob:false}}}}]}}},verbose:false,activeAtOffset:$off}')" \
    | jq -c '.. | objects | select(has("createdEvent")) | .createdEvent'
}
ledger_end() { curl -fsS "$1/v2/state/ledger-end" -H "Authorization: Bearer $TOKEN" | jq -r '.offset'; }
dm_post() { curl -sS -m 60 -w '\nHTTP=%{http_code}\n' -X POST "$BASE:$1$2" -H 'Content-Type: application/json' -d "$3"; }
confirm() {
  dm_post "$1" /governance/confirm "$(jq -cn --arg p "$GOV" --arg r "$RULES" --arg c "$2" \
    '{party_id:$p,rules_contract_id:$r,action:{type:"governance_set_threshold",new_threshold:0},governance_type:"core_domain",proposal_cid:$c}')" \
    | grep -q 'HTTP=200' || fail "confirmation on $1 failed"
  sleep 1
}
execute() {
  local cids
  cids=$(curl -fsS "$BASE:$1/governance/confirmations?party_id=$GOV" | jq -c --arg c "$2" 'first(.domain_actions[] | select(.proposal_cid==$c)) | [.confirmations[].contract_id]')
  dm_post "$1" /governance/execute "$(jq -cn --arg p "$GOV" --arg r "$RULES" --arg c "$2" --argjson cids "$cids" \
    '{party_id:$p,rules_contract_id:$r,action:{type:"governance_set_threshold",new_threshold:0},confirmation_cids:$cids,disclosed_contracts:[],governance_type:"core_domain",proposal_cid:$c}')"
}

say 'Baseline: business parties hosted on node 2 and node 1'
for p in "$OP" "$TREAS" "$COO" "$COMP" "$INV"; do
  hosted_on 2 "$p" && hosted_on 1 "$p" || fail "$p is not hosted on both node 2 and node 1; run infra/setup-localnet.sh on a fresh LocalNet"
done
[[ $(node2_connected) -ge 1 ]] || fail 'node 2 participant not connected at start'
say 'Start the backend with node 2 first and node 1 as backup (passwords never printed)'
backend_start "$(jq -cn --arg op "$OP" --arg m1 "$MEMBER_1" --arg m3 "$MEMBER_3" --arg t "$TREAS" --arg coo "$COO" --arg comp "$COMP" --arg inv "$INV" '
  [{username:"operator",party:$op,roles:["Operator"]},
   {username:"treasury",party:$t,roles:["TreasuryReviewer"]},
   {username:"coo",party:$coo,roles:["FinalSignoff"]},
   {username:"compliance",party:$comp,roles:["ComplianceReviewer"]},
   {username:"member-1",party:$m1,roles:["GovernanceMember"],decmanNode:"p1"},
   {username:"member-3",party:$m3,roles:["GovernanceMember"],decmanNode:"p3"},
   {username:"investor",party:$inv,roles:["Investor"]}]')" "$NODE2_JSON,$NODE1_JSON"
for u in operator treasury coo compliance member-1 member-3 investor; do login "$u"; done
pass "operator, reviewers, investor and members 1 and 3 signed in; business parties hosted on node 2 and node 1"

say "Take node 2 offline ($(stamp))"
node2_down
[[ $(node2_connected) == 0 ]] || fail 'node 2 participant still connected'
curl -fsS -m 5 "$BASE:8082/healthz" >/dev/null 2>&1 && fail 'DecMan 8082 still answering'
NODE2_FROZEN=$(ledger_end "$NODE2_JSON")
pass "node 2 participant disconnected, DecMan 8082 down, node 2 ledger frozen at $NODE2_FROZEN ($(stamp))"

say 'Operator runbook through node 1: governed fund policy and a 40%-funded batch'
POLICY_CMD=$(jq -cn --arg gov "$GOV" --arg op "$OP" --arg f "$FUND_ID" --arg t "$TREAS" --arg coo "$COO" --arg comp "$COMP" --arg d "$RUN policy v1" --arg tpl "$T:UpdateFundPolicy" '
  [{CreateCommand:{templateId:$tpl,createArguments:{governanceParty:$gov,proposer:$op,currentPolicyCid:null,description:$d,
    newPolicy:{governanceParty:$gov,operator:$op,fundId:$f,version:"1",
      base:[{role:"TreasuryReviewer",members:[$t],quorum:"1"},{role:"FinalSignoff",members:[$coo],quorum:"1"}],
      conditional:[{trigger:{tag:"FundedBelowBps",value:"5000"},requirement:{role:"ComplianceReviewer",members:[$comp],quorum:"1"}}]}}}}]')
R=$(submit_on "$NODE2_JSON" probe "[\"$OP\"]" "$POLICY_CMD")
grep -q 'HTTP=200' <<<"$R" && fail 'node 2 accepted a command while disconnected'
echo "node 2 refused a new command: $(sed '$d' <<<"$R" | jq -r '.code // .cause // "error"' 2>/dev/null | head -c 120) ($(tail -n1 <<<"$R"))"
UPD=$(submit_on "$NODE1_JSON" policy "[\"$OP\"]" "$POLICY_CMD" | created ':UpdateFundPolicy')
[[ -n $UPD ]] || fail 'policy proposal not created through node 1'
confirm 8081 "$UPD"; confirm 8083 "$UPD"
R=$(execute 8083 "$UPD"); grep -q 'HTTP=200' <<<"$R" || fail "policy execution failed: $R"
POLICY=""
for _ in $(seq 1 10); do
  POLICY=$(active_on "$NODE1_JSON" "$COO" | jq -r --arg f "$FUND_ID" 'select(.templateId | endswith(":FundPolicy")) | select(.createArgument.fundId==$f) | .contractId' | head -1)
  [[ -n $POLICY ]] && break; sleep 2
done
[[ -n $POLICY ]] || fail 'FundPolicy not visible through node 1'
DL=$(iso_in 30)
BATCH=$(submit_on "$NODE1_JSON" batch "[\"$OP\"]" "$(jq -cn --arg gov "$GOV" --arg op "$OP" --arg coo "$COO" --arg t "$TREAS" --arg comp "$COMP" \
  --arg inv "$INV" --arg id "$RUN-b1" --arg pv "$FUND_ID@v1" --arg pol "$POLICY" --arg dl "$DL" --arg tpl "$T:RedemptionBatch" '
  [{CreateCommand:{templateId:$tpl,createArguments:{governanceParty:$gov,proposer:$op,operator:$op,fundReviewer:$coo,treasuryReviewer:$t,
    policyVersion:$pv,batchId:$id,rows:[{requestId:($id+"-r1"),investor:$inv,requestedUnits:"1000",allocatedUnits:"400"}],
    totalRequested:"1000",totalAllocated:"400",recoveryDeadline:$dl,policyCid:$pol,policyMembers:[$t,$coo,$comp],exceptions:null}}}]')" | created ':RedemptionBatch')
[[ -n $BATCH ]] || fail 'batch not created through node 1'
pass "operator proposed the policy and the batch through node 1; members 1 and 3 executed the policy ($(stamp))"

say 'Signed-in users through the backend, which fails over to node 1'
for pair in "treasury TreasuryReviewer" "coo FinalSignoff" "compliance ComplianceReviewer"; do
  set -- $pair
  R=""
  for _ in $(seq 1 10); do
    R=$(post "$1" /api/approvals "$(jq -cn --arg b "$BATCH" --arg role "$2" '{batchCid:$b,role:$role}')")
    [[ $(code "$R") == 404 ]] || break; sleep 2
  done
  expect "$R" 200 "$1 approval"
  printf -v "A_$1" '%s' "$(body "$R" | jq -r '.approvalCid')"
done
R=$(post operator /api/proposals/finalize "$(jq -cn --arg b "$BATCH" --arg a "$A_treasury" --arg f "$A_coo" --arg c "$A_compliance" '{batchCid:$b,approvalCids:[$a,$f,$c]}')")
expect "$R" 200 'operator proposal'
PROP=$(body "$R" | jq -r '.proposalCid')
for member in member-1 member-3; do
  for _ in $(seq 1 10); do
    R=$(post "$member" /api/governance/confirm "$(jq -cn --arg p "$PROP" '{proposalCid:$p}')")
    [[ $(code "$R") == 404 ]] || break; sleep 2
  done
  expect "$R" 200 "$member confirm"
done
R=$(post member-3 /api/governance/execute "$(jq -cn --arg p "$PROP" '{proposalCid:$p}')"); expect "$R" 200 'execution with node 2 offline'
R=$(get investor /api/me/records); expect "$R" 200 'investor records'
ENT=$(body "$R" | jq -r --arg id "$RUN-b1" '.entitlements[] | select(.batchId==$id) | "\(.contractId) \(.units)"')
OUT=$(body "$R" | jq -r --arg id "$RUN-b1" '.outstanding[] | select(.batchId==$id) | "\(.contractId) \(.units)"')
[[ ${ENT#* } == 400 && ${OUT#* } == 600 ]] || fail "unexpected investor records: $ENT / $OUT"
expect "$(post investor /api/claims/acknowledge "$(jq -cn --arg c "${ENT%% *}" '{entitlementCid:$c}')")" 200 'acknowledge'
expect "$(post investor /api/outstanding/withdraw "$(jq -cn --arg c "${OUT%% *}" '{outstandingCid:$c}')")" 200 'withdraw'
RECEIPT=$(active_on "$NODE1_JSON" "$INV" | jq -r --arg id "$RUN-b1" 'select(.templateId | endswith(":ClaimReceipt")) | select(.createArgument.batchId==$id) | .contractId' | head -1)
[[ -n $RECEIPT ]] || fail 'receipt not visible through node 1'
[[ $(ledger_end "$NODE2_JSON") == "$NODE2_FROZEN" ]] || fail 'node 2 ledger advanced while disconnected'
pass "with node 2 offline: 3 approvals, the operator's proposal, execution by members 1 and 3, and the investor's acknowledgment (400) and withdrawal (600) all went through the backend via node 1 ($(stamp))"

say "Recovery: node 2 back online ($(stamp))"
node2_up
RESTORED=1
[[ $(node2_connected) -ge 1 ]] || fail 'node 2 did not reconnect'
for _ in $(seq 1 36); do curl -fsS -m 5 "$BASE:8082/healthz" >/dev/null 2>&1 && break; sleep 5; done
curl -fsS "$BASE:8082/healthz" >/dev/null || fail 'DecMan 8082 did not come back'
for _ in $(seq 1 24); do
  [[ -n $(active_on "$NODE2_JSON" "$INV" | jq -r --arg c "$RECEIPT" 'select(.contractId==$c) | .contractId') ]] && break; sleep 5
done
[[ -n $(active_on "$NODE2_JSON" "$INV" | jq -r --arg c "$RECEIPT" 'select(.contractId==$c) | .contractId') ]] || fail 'node 2 did not catch up'
pass "node 2 reconnected and caught up: ledger end $NODE2_FROZEN -> $(ledger_end "$NODE2_JSON"); it now has the investor's receipt created while it was offline ($(stamp))"
for p in 8081 8082 8083; do
  echo "DecMan $p mesh: $(curl -fsS "$BASE:$p/participants-status" | jq -c '[.. | strings | select(test("CurrentNode|Connected|Disconnected"))]')"
done
echo
echo "Alluvren node 2 outage LocalNet run passed. run=$RUN policy=$POLICY batch=$BATCH proposal=$PROP receipt=$RECEIPT"
