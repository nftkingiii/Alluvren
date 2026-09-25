#!/usr/bin/env bash
# Distributed hosting on BitSafe LocalNet: what happens to Alluvren when a
# hosting node goes offline.
#
# The governance party (demo-party) is hosted with confirmation rights on three
# participants and governed by three members, threshold 2 of 3:
#   node 1  decman-1 :8081  participant app-provider (admin 3902, JSON 3975)  member P2
#   node 2  decman-2 :8082  participant app-user     (admin 2902, JSON 2975)  member P1
#   node 3  decman-3 :8083  participant sv           (admin 4902, JSON 4975)  member P3
# The Alluvren business parties (operator, reviewers, investor) live on node 2.
#
#   1. Node 1 offline (participant disconnected from the synchronizer and its
#      DecMan stopped): a governed policy and a governed finalization still
#      complete with nodes 2 and 3; node 1's ledger view is frozen.
#   2. Nodes 1 and 3 unavailable to governance (node 3's DecMan stopped too):
#      a finalization gets one confirmation and cannot execute.
#   3. Recovery: node 1 reconnects and catches up on everything it missed; its
#      member confirms the waiting proposal and executes it.
# The EXIT trap always reconnects node 1 and restarts both DecMan nodes.
# Needs infra/setup-localnet.sh first. On LocalNet all three nodes belong to one developer:
# this shows hosting and threshold mechanics, not organizational independence.
set -Eeuo pipefail
. "$(cd "$(dirname "$0")" && pwd)/localnet-env.sh"

NODE1_JSON=$BASE:3975

RUN=outage-$(date +%s)
FUND_ID=$RUN
T_REDEMPTION='#alluvren-v1:Alluvren.Redemption'
T_CLAIMS='#alluvren-v1:Alluvren.Claims'
stamp() { date -u +%H:%M:%SZ; }
new_id() { printf '%s-%s-%s' "$RUN" "$1" "$(uid)"; }

# --- Canton console against node 1's participant (admin API only) ----------
console() {
  docker exec canton sh -c 'mkdir -p /tmp/outage && printf "%s\n" "canton.remote-participants.node1 { admin-api { address = \"127.0.0.1\", port = 3902 }, ledger-api { address = \"127.0.0.1\", port = 3901 } }" > /tmp/outage/remote.conf'
  printf '%s\n' "$1" | docker exec -i canton sh -c 'cat > /tmp/outage/cmd.sc'
  docker exec canton /app/bin/canton run /tmp/outage/cmd.sc -c /tmp/outage/remote.conf 2>&1 | grep -E '^RESULT' || true
}
node1_connected() { console 'println("RESULT " + node1.synchronizers.list_connected().size)' | awk '{print $2}'; }
node1_down() { docker stop decman-1 >/dev/null; console 'node1.synchronizers.disconnect_all(); println("RESULT done")' >/dev/null; }
node1_up() { console 'node1.synchronizers.reconnect_all(); println("RESULT done")' >/dev/null; docker start decman-1 >/dev/null; }
restore() {
  local code=$?
  if [[ ${RESTORED:-0} != 1 ]]; then
    echo "Restoring nodes (exit $code)"
    docker start decman-3 >/dev/null 2>&1 || true
    node1_up || true
  fi
  docker exec canton rm -rf /tmp/outage >/dev/null 2>&1 || true
}
trap restore EXIT

# --- ledger and DecMan helpers (as in the P-10 harness) --------------------
ledger_submit() {
  local body
  body=$(jq -cn --arg id "$1" --argjson actors "$2" --argjson commands "$3" \
    '{commands:{userId:"ledger-api-user",commandId:$id,actAs:$actors,commands:$commands}}')
  curl -fsS "$JSON_API/v2/commands/submit-and-wait-for-transaction" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$body"
}
created() { jq -r --arg t "$1" '.transaction.events[] | (.CreatedEvent // empty) | select(.templateId | endswith($t)) | .contractId'; }
active_on() {
  local api=$1 party=$2 offset body
  offset=$(curl -fsS "$api/v2/state/ledger-end" -H "Authorization: Bearer $TOKEN" | jq -r '.offset')
  body=$(jq -cn --arg p "$party" --argjson off "$offset" \
    '{filter:{filtersByParty:{($p):{cumulative:[{identifierFilter:{WildcardFilter:{value:{includeCreatedEventBlob:false}}}}]}}},verbose:false,activeAtOffset:$off}')
  curl -fsS "$api/v2/state/active-contracts" -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' -d "$body" | jq -c '.. | objects | select(has("createdEvent")) | .createdEvent'
}
active() { active_on "$JSON_API" "$1"; }
ledger_end() { curl -fsS "$1/v2/state/ledger-end" -H "Authorization: Bearer $TOKEN" | jq -r '.offset'; }
dm_post() { curl -sS -m 60 -w '\nHTTP=%{http_code}\n' -X POST "$BASE:$1$2" -H 'Content-Type: application/json' -d "$3"; }
RULES=$(curl -fsS "$BASE:8081/governance/state?party_id=$GOV" | jq -r '.state.contract_id')
[[ -n $RULES && $RULES != null ]]
confirm() {
  local response
  response=$(dm_post "$1" /governance/confirm "$(jq -cn --arg p "$GOV" --arg r "$RULES" --arg c "$2" \
    '{party_id:$p,rules_contract_id:$r,action:{type:"governance_set_threshold",new_threshold:0},governance_type:"core_domain",proposal_cid:$c}')")
  echo "$response" | grep -q 'HTTP=200' || fail "confirmation on $1 failed: $response"
  sleep 1
}
confirm_state() { curl -fsS "$BASE:$1/governance/confirmations?party_id=$GOV" | jq -c --arg c "$2" 'first(.domain_actions[] | select(.proposal_cid==$c))'; }
execute() {
  local cids
  cids=$(confirm_state "$1" "$2" | jq -c '[.confirmations[].contract_id]')
  dm_post "$1" /governance/execute "$(jq -cn --arg p "$GOV" --arg r "$RULES" --arg c "$2" --argjson cids "$cids" \
    '{party_id:$p,rules_contract_id:$r,action:{type:"governance_set_threshold",new_threshold:0},confirmation_cids:$cids,disclosed_contracts:[],governance_type:"core_domain",proposal_cid:$c}')"
}
policy_cmd() {
  jq -cn --arg gov "$GOV" --arg op "$OP" --arg f "$FUND_ID" --arg t "$TREAS" --arg coo "$COO" --arg comp "$COMP" --arg prop "$P1" --arg d "$RUN policy v1" --arg tpl "$T_REDEMPTION:UpdateFundPolicy" '
    [{CreateCommand:{templateId:$tpl,createArguments:{governanceParty:$gov,proposer:$prop,currentPolicyCid:null,description:$d,
      newPolicy:{governanceParty:$gov,operator:$op,fundId:$f,version:"1",
        base:[{role:"TreasuryReviewer",members:[$t],quorum:"1"},{role:"FinalSignoff",members:[$coo],quorum:"1"}],
        conditional:[{trigger:{tag:"FundedBelowBps",value:"5000"},requirement:{role:"ComplianceReviewer",members:[$comp],quorum:"1"}}]}}}}]'
}
make_batch() {
  local id=$1 dl
  dl=$(iso_in 30)
  ledger_submit "$(new_id batch)" "[\"$P1\"]" "$(jq -cn --arg gov "$GOV" --arg prop "$P1" --arg op "$OP" --arg coo "$COO" --arg t "$TREAS" --arg comp "$COMP" \
    --arg inv "$INV" --arg id "$id" --arg pv "$FUND_ID@v1" --arg pol "$POLICY" --arg dl "$dl" --arg tpl "$T_REDEMPTION:RedemptionBatch" '
    [{CreateCommand:{templateId:$tpl,createArguments:{governanceParty:$gov,proposer:$prop,operator:$op,fundReviewer:$coo,treasuryReviewer:$t,
      policyVersion:$pv,batchId:$id,rows:[{requestId:($id+"-r1"),investor:$inv,requestedUnits:"1000",allocatedUnits:"400"}],
      totalRequested:"1000",totalAllocated:"400",recoveryDeadline:$dl,policyCid:$pol,policyMembers:[$t,$coo,$comp],exceptions:null}}}]')" | created ':RedemptionBatch'
}
approve() {
  local exp
  exp=$(iso_in 30)
  ledger_submit "$(new_id approve)" "[\"$3\"]" "$(jq -cn --arg gov "$GOV" --arg r "$3" --arg role "$4" --arg b "$1" --arg id "$2" --arg pv "$FUND_ID@v1" --arg exp "$exp" --arg tpl "$T_REDEMPTION:RoleApproval" \
    '[{CreateCommand:{templateId:$tpl,createArguments:{governanceParty:$gov,reviewer:$r,role:$role,target:{batchCid:$b,batchId:$id,policyVersion:$pv},expiresAt:$exp}}}]')" | created ':RoleApproval'
}
approved_batch() {
  local id=$1 b a_t a_f a_c
  b=$(make_batch "$id"); [[ -n $b ]] || fail "batch $id not created"
  a_t=$(approve "$b" "$id" "$TREAS" TreasuryReviewer)
  a_f=$(approve "$b" "$id" "$COO" FinalSignoff)
  a_c=$(approve "$b" "$id" "$COMP" ComplianceReviewer)
  ledger_submit "$(new_id finalize)" "[\"$P1\"]" "$(jq -cn --arg gov "$GOV" --arg prop "$P1" --arg b "$b" --arg a "$a_t" --arg f "$a_f" --arg c "$a_c" --arg d "$RUN finalize $id" --arg tpl "$T_REDEMPTION:FinalizePolicyRedemption" \
    '[{CreateCommand:{templateId:$tpl,createArguments:{governanceParty:$gov,proposer:$prop,batchCid:$b,approvalCids:[$a,$f,$c],description:$d}}}]')" | created ':FinalizePolicyRedemption'
}
records() { active "$INV" | jq -r --arg id "$1" 'select(.createArgument.batchId? == $id) | "\(.templateId | split(":") | last) \(.contractId) \(.createArgument.units)"'; }
gov_has() { active_on "$1" "$GOV" | jq -r --arg c "$2" 'select(.contractId==$c) | .contractId' | head -1; }

say 'Baseline: three nodes up'
for port in 8081 8082 8083; do curl -fsS "$BASE:$port/healthz" >/dev/null || fail "DecMan $port not healthy"; done
[[ $(node1_connected) -ge 1 ]] || fail 'node 1 participant not connected at start'
echo "PASS: DecMan 8081/8082/8083 healthy; node 1 participant connected; GovernanceRules threshold $(curl -fsS "$BASE:8082/governance/state?party_id=$GOV" | jq -r '.state.threshold') of $(curl -fsS "$BASE:8082/governance/state?party_id=$GOV" | jq -r '.state.members | length')"

say "Take node 1 offline ($(stamp))"
node1_down
[[ $(node1_connected) == 0 ]] || fail 'node 1 participant still connected'
curl -fsS -m 5 "$BASE:8081/healthz" >/dev/null 2>&1 && fail 'DecMan 8081 still answering'
NODE1_FROZEN=$(ledger_end "$NODE1_JSON")
echo "PASS: node 1 participant disconnected from the synchronizer; DecMan 8081 down; node 1 ledger end frozen at $NODE1_FROZEN ($(stamp))"

say 'With node 1 offline, governance still completes on nodes 2 and 3'
UPD=$(ledger_submit "$(new_id policy)" "[\"$P1\"]" "$(policy_cmd)" | created ':UpdateFundPolicy')
[[ -n $UPD ]] || fail 'policy proposal not created'
confirm 8082 "$UPD"; confirm 8083 "$UPD"
R=$(execute 8083 "$UPD"); echo "$R" | grep -q 'HTTP=200' || fail "policy execution with node 1 offline failed: $R"
POLICY=$(active "$COO" | jq -r --arg f "$FUND_ID" 'select(.templateId | endswith(":FundPolicy")) | select(.createArgument.fundId==$f) | .contractId' | head -1)
[[ -n $POLICY ]] || fail 'FundPolicy not visible'
echo "PASS: FundPolicy created behind the threshold with members P1 (node 2) and P3 (node 3) ($(stamp))"
PROP_A=$(approved_batch "$RUN-b1"); [[ -n $PROP_A ]] || fail 'finalization proposal not created'
confirm 8082 "$PROP_A"; confirm 8083 "$PROP_A"
R=$(execute 8083 "$PROP_A"); echo "$R" | grep -q 'HTTP=200' || fail "finalization with node 1 offline failed: $R"
RECS_A=$(records "$RUN-b1"); echo "$RECS_A"
[[ $(grep -c '^ClaimEntitlement .* 400$' <<<"$RECS_A") -eq 1 && $(grep -c '^OutstandingRedemption .* 600$' <<<"$RECS_A") -eq 1 ]] || fail 'investor records missing'
ENT_A=$(awk '$1=="ClaimEntitlement"{print $2}' <<<"$RECS_A")
echo "PASS: governed finalization executed with node 1 offline; investor received 400 allocated / 600 outstanding ($(stamp))"
[[ $(ledger_end "$NODE1_JSON") == "$NODE1_FROZEN" ]] || fail 'node 1 ledger advanced while disconnected'
[[ -n $(gov_has "$BASE:4975" "$ENT_A") ]] || fail 'node 3 does not host the new record'
[[ -z $(gov_has "$NODE1_JSON" "$ENT_A") ]] || fail 'node 1 unexpectedly has the new record'
echo "PASS: node 3 hosts the new governance-party records; node 1's view is frozen at $NODE1_FROZEN and lacks them"

say "Node 3's DecMan also unavailable: one member left ($(stamp))"
docker stop decman-3 >/dev/null
PROP_B=$(approved_batch "$RUN-b2"); [[ -n $PROP_B ]] || fail 'second proposal not created'
confirm 8082 "$PROP_B"
R=$(execute 8082 "$PROP_B")
echo "$R" | grep -Eq 'HTTP=(400|500)' && echo "$R" | grep -qi 'Enough confirmations' || fail "one confirmation unexpectedly executed: $R"
[[ -z $(records "$RUN-b2") ]] || fail 'blocked finalization created investor records'
echo "PASS: with only node 2's member available, the finalization had 1 of 2 confirmations and execution was refused; no investor records ($(stamp))"

say "Recovery: node 1 back online ($(stamp))"
docker start decman-3 >/dev/null
node1_up
RESTORED=1
[[ $(node1_connected) -ge 1 ]] || fail 'node 1 did not reconnect'
for _ in $(seq 1 36); do curl -fsS -m 5 "$BASE:8081/healthz" >/dev/null 2>&1 && curl -fsS -m 5 "$BASE:8083/healthz" >/dev/null 2>&1 && break; sleep 5; done
curl -fsS "$BASE:8081/healthz" >/dev/null || fail 'DecMan 8081 did not come back'
for _ in $(seq 1 24); do [[ -n $(gov_has "$NODE1_JSON" "$ENT_A") ]] && break; sleep 5; done
[[ -n $(gov_has "$NODE1_JSON" "$ENT_A") ]] || fail 'node 1 did not catch up'
echo "PASS: node 1 reconnected and caught up: ledger end $NODE1_FROZEN -> $(ledger_end "$NODE1_JSON"); it now hosts the records created while it was offline ($(stamp))"
for _ in $(seq 1 24); do [[ -n $(confirm_state 8081 "$PROP_B") ]] && break; sleep 5; done
confirm 8081 "$PROP_B"
R=$(execute 8081 "$PROP_B"); echo "$R" | grep -q 'HTTP=200' || fail "waiting finalization failed after recovery: $R"
RECS_B=$(records "$RUN-b2"); echo "$RECS_B"
[[ $(grep -c '^ClaimEntitlement .* 400$' <<<"$RECS_B") -eq 1 ]] || fail 'second batch records missing'
echo "PASS: node 1's member confirmed the waiting proposal and node 1 executed it ($(stamp))"
for p in 8081 8082 8083; do
  echo "DecMan $p mesh: $(curl -fsS "$BASE:$p/participants-status" | jq -c '[.. | strings | select(test("CurrentNode|Connected|Disconnected"))]')"
done

say 'Cleanup: investor closes both batches'
for recs in "$RECS_A" "$RECS_B"; do
  ack=$(awk '$1=="ClaimEntitlement"{print $2}' <<<"$recs"); out=$(awk '$1=="OutstandingRedemption"{print $2}' <<<"$recs")
  ledger_submit "$(new_id ack)" "[\"$INV\"]" "$(jq -cn --arg c "$ack" --arg t "$T_CLAIMS:ClaimEntitlement" '[{ExerciseCommand:{templateId:$t,contractId:$c,choice:"ClaimEntitlement_Acknowledge",choiceArgument:{}}}]')" >/dev/null
  ledger_submit "$(new_id wd)" "[\"$INV\"]" "$(jq -cn --arg c "$out" --arg t "$T_CLAIMS:OutstandingRedemption" '[{ExerciseCommand:{templateId:$t,contractId:$c,choice:"OutstandingRedemption_Withdraw",choiceArgument:{}}}]')" >/dev/null
done
echo 'PASS: investor records acknowledged and withdrawn (FundPolicy and demo receipts remain)'
echo
echo "Alluvren outage LocalNet run passed. run=$RUN policy=$POLICY proposal_node1_offline=$PROP_A proposal_after_recovery=$PROP_B"
