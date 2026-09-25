#!/usr/bin/env bash
# P-10: policy-driven role governance on BitSafe LocalNet (alluvren-v1 0.3.0).
#   1. Create a FundPolicy through UpdateFundPolicy behind the BitSafe threshold
#      (one confirmation rejected, two execute).
#   2. A 40%-funded batch is blocked after threshold for missing Compliance,
#      then finalizes once Compliance approves; the investor gets private records.
#   3. A governed policy update blocks a second batch pinned to the old version.
#   4. Cleanup.
# Runs on the LocalNet VM as root. Uses sandbox parties controlled by one
# developer: mechanics, not organizational independence.
set -Eeuo pipefail
. "$(cd "$(dirname "$0")" && pwd)/localnet-env.sh"


RUN=p10-$(date +%s)
FUND_ID=$RUN
T_REDEMPTION='#alluvren-v1:Alluvren.Redemption'
T_CLAIMS='#alluvren-v1:Alluvren.Claims'
new_id() { printf '%s-%s-%s' "$RUN" "$1" "$(uid)"; }
ledger_submit() {
  local body
  body=$(jq -cn --arg id "$1" --argjson actors "$2" --argjson commands "$3" \
    '{commands:{userId:"ledger-api-user",commandId:$id,actAs:$actors,commands:$commands}}')
  curl -fsS "$JSON_API/v2/commands/submit-and-wait-for-transaction" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$body"
}
created() { jq -r --arg t "$1" '.transaction.events[] | (.CreatedEvent // empty) | select(.templateId | endswith($t)) | .contractId'; }
dm_post() { curl -sS -w '\nHTTP=%{http_code}\n' -X POST "$BASE:$1$2" -H 'Content-Type: application/json' -d "$3"; }
RULES=$(curl -fsS "$BASE:8081/governance/state?party_id=$GOV" | jq -r '.state.contract_id')
[[ -n $RULES && $RULES != null ]]
confirm() {
  local body response
  body=$(jq -cn --arg party "$GOV" --arg rules "$RULES" --arg cid "$2" \
    '{party_id:$party,rules_contract_id:$rules,action:{type:"governance_set_threshold",new_threshold:0},governance_type:"core_domain",proposal_cid:$cid}')
  response=$(dm_post "$1" /governance/confirm "$body")
  echo "$response" | grep -q 'HTTP=200' || fail "confirmation on node $1 failed: $response"
  sleep 1
}
confirm_state() {
  curl -fsS "$BASE:8083/governance/confirmations?party_id=$GOV" | jq -c --arg cid "$1" 'first(.domain_actions[] | select(.proposal_cid==$cid))'
}
execute() {
  local state cids body
  state=$(confirm_state "$1")
  cids=$(echo "$state" | jq -c '[.confirmations[].contract_id]')
  body=$(jq -cn --arg party "$GOV" --arg rules "$RULES" --arg cid "$1" --argjson cids "$cids" \
    '{party_id:$party,rules_contract_id:$rules,action:{type:"governance_set_threshold",new_threshold:0},confirmation_cids:$cids,disclosed_contracts:[],governance_type:"core_domain",proposal_cid:$cid}')
  dm_post 8083 /governance/execute "$body"
}
# Cancel a proposal that failed execution, plus its confirmations.
cancel_proposal() {
  local cid=$1 state
  state=$(confirm_state "$cid")
  while IFS=$'\t' read -r conf party; do
    [[ -n $conf ]] || continue
    case "$party" in
      "$P1") port=8082 ;;
      "$P2") port=8081 ;;
      *) fail "no DecMan node mapping for confirming party $party" ;;
    esac
    dm_post "$port" /governance/cancel "$(jq -cn --arg party "$GOV" --arg cid "$conf" '{party_id:$party,confirmation_cid:$cid,governance_type:"core_domain"}')" \
      | grep -q 'HTTP=200' || fail "could not cancel confirmation $conf"
  done < <(echo "$state" | jq -r '(.confirmations // [])[] | [.contract_id,.confirming_party] | @tsv')
  dm_post 8082 /governance/cancel-proposal "$(jq -cn --arg party "$GOV" --arg cid "$cid" '{party_id:$party,proposal_cid:$cid}')" \
    | grep -q 'HTTP=200' || fail "could not cancel proposal $cid"
}
active() {
  local party=$1 offset body
  offset=$(curl -fsS "$JSON_API/v2/state/ledger-end" -H "Authorization: Bearer $TOKEN" | jq -r '.offset')
  body=$(jq -cn --arg p "$party" --argjson off "$offset" \
    '{filter:{filtersByParty:{($p):{cumulative:[{identifierFilter:{WildcardFilter:{value:{includeCreatedEventBlob:false}}}}]}}},verbose:false,activeAtOffset:$off}')
  curl -fsS "$JSON_API/v2/state/active-contracts" -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' -d "$body" | jq -c '.. | objects | select(has("createdEvent")) | .createdEvent'
}
policy_json() {
  jq -cn --arg gov "$GOV" --arg op "$OP" --arg fund "$FUND_ID" --arg v "$1" --arg t "$TREAS" --arg coo "$COO" --arg comp "$COMP" '
    {governanceParty:$gov, operator:$op, fundId:$fund, version:$v,
     base:[{role:"TreasuryReviewer",members:[$t],quorum:"1"},
           {role:"FinalSignoff",members:[$coo],quorum:"1"}],
     conditional:[{trigger:{tag:"FundedBelowBps",value:"5000"},
                   requirement:{role:"ComplianceReviewer",members:[$comp],quorum:"1"}}]}'
}
propose_policy() {
  local current=$1 version=$2 cmd
  cmd=$(jq -cn --arg gov "$GOV" --arg prop "$P1" --argjson cur "$current" --argjson pol "$(policy_json "$version")" --arg d "$RUN policy v$version" --arg t "$T_REDEMPTION:UpdateFundPolicy" \
    '[{CreateCommand:{templateId:$t,createArguments:{governanceParty:$gov,proposer:$prop,currentPolicyCid:$cur,newPolicy:$pol,description:$d}}}]')
  ledger_submit "$(new_id policy-v$version)" "[\"$P1\"]" "$cmd" | created ':UpdateFundPolicy'
}
policy_cid() {
  active "$COO" | jq -r --arg f "$FUND_ID" --arg v "$1" 'select(.templateId | endswith(":FundPolicy")) | select(.createArgument.fundId==$f and (.createArgument.version|tostring)==$v) | .contractId'
}
make_batch() {
  local id=$1 policy=$2 deadline=$3 cmd
  cmd=$(jq -cn --arg gov "$GOV" --arg prop "$P1" --arg op "$OP" --arg coo "$COO" --arg t "$TREAS" --arg comp "$COMP" \
    --arg inv "$INV" --arg id "$id" --arg pv "$FUND_ID@v1" --arg pol "$policy" --arg dl "$deadline" --arg tpl "$T_REDEMPTION:RedemptionBatch" '
    [{CreateCommand:{templateId:$tpl,createArguments:{
      governanceParty:$gov,proposer:$prop,operator:$op,fundReviewer:$coo,treasuryReviewer:$t,
      policyVersion:$pv,batchId:$id,
      rows:[{requestId:($id+"-r1"),investor:$inv,requestedUnits:"1000",allocatedUnits:"400"}],
      totalRequested:"1000",totalAllocated:"400",recoveryDeadline:$dl,
      policyCid:$pol,policyMembers:[$t,$coo,$comp],exceptions:null}}}]')
  ledger_submit "$(new_id batch)" "[\"$P1\"]" "$cmd" | created ':RedemptionBatch'
}
approve() {
  local batch=$1 id=$2 reviewer=$3 role=$4 exp cmd
  exp=$(iso_in 15)
  cmd=$(jq -cn --arg gov "$GOV" --arg r "$reviewer" --arg role "$role" --arg b "$batch" --arg id "$id" --arg pv "$FUND_ID@v1" --arg exp "$exp" --arg tpl "$T_REDEMPTION:RoleApproval" \
    '[{CreateCommand:{templateId:$tpl,createArguments:{governanceParty:$gov,reviewer:$r,role:$role,target:{batchCid:$b,batchId:$id,policyVersion:$pv},expiresAt:$exp}}}]')
  ledger_submit "$(new_id approve)" "[\"$reviewer\"]" "$cmd" | created ':RoleApproval'
}
propose_finalize() {
  local cmd
  cmd=$(jq -cn --arg gov "$GOV" --arg prop "$P1" --arg b "$1" --argjson a "$2" --arg d "$3" --arg tpl "$T_REDEMPTION:FinalizePolicyRedemption" \
    '[{CreateCommand:{templateId:$tpl,createArguments:{governanceParty:$gov,proposer:$prop,batchCid:$b,approvalCids:$a,description:$d}}}]')
  ledger_submit "$(new_id finalize)" "[\"$P1\"]" "$cmd" | created ':FinalizePolicyRedemption'
}

say "Governed policy creation ($FUND_ID v1)"
UPD1=$(propose_policy null 1)
[[ -n $UPD1 ]] || fail 'policy proposal not created'
confirm 8081 "$UPD1"
UNDER=$(execute "$UPD1")
echo "$UNDER" | grep -Eq 'HTTP=(400|500)' && echo "$UNDER" | grep -qi 'Enough confirmations' || fail "one confirmation unexpectedly accepted: $UNDER"
echo 'PASS: policy creation rejected with one BitSafe confirmation'
confirm 8082 "$UPD1"
R=$(execute "$UPD1")
echo "$R" | grep -q 'HTTP=200' || fail "policy creation failed: $R"
POLICY_V1=$(policy_cid 1)
[[ -n $POLICY_V1 ]] || fail 'FundPolicy v1 not visible to its members'
echo "PASS: FundPolicy v1 created behind the BitSafe threshold ($POLICY_V1)"

say 'A 40%-funded batch needs Compliance'
DL=$(iso_in 15)
B1=$(make_batch "$RUN-b1" "$POLICY_V1" "$DL")
[[ -n $B1 ]] || fail 'batch not created'
A_T=$(approve "$B1" "$RUN-b1" "$TREAS" TreasuryReviewer)
A_F=$(approve "$B1" "$RUN-b1" "$COO" FinalSignoff)
PROP_A=$(propose_finalize "$B1" "[\"$A_T\",\"$A_F\"]" "$RUN without Compliance")
confirm 8081 "$PROP_A"; confirm 8082 "$PROP_A"
R=$(execute "$PROP_A")
echo "$R" | grep -qi 'Missing required approvals for role ComplianceReviewer' || fail "missing Compliance not rejected as expected: $R"
echo 'PASS: after the BitSafe threshold, the batch was rejected for missing Compliance'
[[ -z $(active "$INV" | jq -r --arg id "$RUN-b1" 'select(.createArgument.batchId? == $id) | .contractId') ]] || fail 'rejected finalization created investor records'
cancel_proposal "$PROP_A"

A_C=$(approve "$B1" "$RUN-b1" "$COMP" ComplianceReviewer)
PROP_B=$(propose_finalize "$B1" "[\"$A_T\",\"$A_F\",\"$A_C\"]" "$RUN with Compliance")
confirm 8081 "$PROP_B"; confirm 8082 "$PROP_B"
R=$(execute "$PROP_B")
echo "$R" | grep -q 'HTTP=200' && echo "$R" | grep -q 'Action executed successfully' || fail "finalization with Compliance failed: $R"
RECS=$(active "$INV" | jq -r --arg id "$RUN-b1" 'select(.createArgument.batchId? == $id) | "\(.templateId | split(":") | last) \(.contractId) \(.createArgument.units)"')
echo "$RECS"
[[ $(echo "$RECS" | grep -c '^ClaimEntitlement .* 400$') -eq 1 ]] || fail 'expected a 400-unit entitlement'
[[ $(echo "$RECS" | grep -c '^OutstandingRedemption .* 600$') -eq 1 ]] || fail 'expected a 600-unit outstanding record'
echo 'PASS: with Compliance, the governed finalization executed and created the investor records'

say 'A governed policy update blocks a batch pinned to v1'
DL2=$(iso_in 4)
DL2_EPOCH=$(( $(date -u +%s) + 240 ))
B2=$(make_batch "$RUN-b2" "$POLICY_V1" "$DL2")
B2_T=$(approve "$B2" "$RUN-b2" "$TREAS" TreasuryReviewer)
B2_F=$(approve "$B2" "$RUN-b2" "$COO" FinalSignoff)
B2_C=$(approve "$B2" "$RUN-b2" "$COMP" ComplianceReviewer)
UPD2=$(propose_policy "\"$POLICY_V1\"" 2)
confirm 8081 "$UPD2"; confirm 8082 "$UPD2"
R=$(execute "$UPD2")
echo "$R" | grep -q 'HTTP=200' || fail "policy update failed: $R"
[[ -z $(policy_cid 1) && -n $(policy_cid 2) ]] || fail 'expected v1 superseded and v2 active'
echo 'PASS: policy advanced to v2 behind the BitSafe threshold'
PROP_C=$(propose_finalize "$B2" "[\"$B2_T\",\"$B2_F\",\"$B2_C\"]" "$RUN pinned to superseded v1")
confirm 8081 "$PROP_C"; confirm 8082 "$PROP_C"
R=$(execute "$PROP_C")
echo "$R" | grep -Eq 'HTTP=(400|500)' || fail "batch pinned to superseded policy unexpectedly finalized: $R"
echo "PASS: batch pinned to the superseded policy was rejected ($(echo "$R" | grep -oE 'HTTP=[0-9]+'))"
cancel_proposal "$PROP_C"

say 'Cleanup'
ack=$(echo "$RECS" | awk '$1=="ClaimEntitlement"{print $2}')
out=$(echo "$RECS" | awk '$1=="OutstandingRedemption"{print $2}')
ledger_submit "$(new_id ack)" "[\"$INV\"]" "$(jq -cn --arg c "$ack" --arg t "$T_CLAIMS:ClaimEntitlement" '[{ExerciseCommand:{templateId:$t,contractId:$c,choice:"ClaimEntitlement_Acknowledge",choiceArgument:{}}}]')" >/dev/null
ledger_submit "$(new_id wd)" "[\"$INV\"]" "$(jq -cn --arg c "$out" --arg t "$T_CLAIMS:OutstandingRedemption" '[{ExerciseCommand:{templateId:$t,contractId:$c,choice:"OutstandingRedemption_Withdraw",choiceArgument:{}}}]')" >/dev/null
for pair in "$TREAS|$B2_T" "$COO|$B2_F" "$COMP|$B2_C"; do
  party=${pair%%|*}; cid=${pair##*|}
  ledger_submit "$(new_id revoke)" "[\"$party\"]" "$(jq -cn --arg c "$cid" --arg t "$T_REDEMPTION:RoleApproval" '[{ExerciseCommand:{templateId:$t,contractId:$c,choice:"RoleApproval_Revoke",choiceArgument:{}}}]')" >/dev/null
done
echo 'waiting for the blocked batch recovery deadline'
while [[ $(date -u +%s) -le $DL2_EPOCH ]]; do sleep 10; done
sleep 5
ledger_submit "$(new_id recover)" "[\"$OP\"]" "$(jq -cn --arg c "$B2" --arg t "$T_REDEMPTION:RedemptionBatch" '[{ExerciseCommand:{templateId:$t,contractId:$c,choice:"RedemptionBatch_RecoverExpired",choiceArgument:{}}}]')" >/dev/null
LEFT=$(for p in "$INV" "$OP" "$TREAS" "$COO" "$COMP" "$P1"; do active "$p"; done \
  | jq -r --arg run "$RUN" 'select((.createArgument.batchId? // .createArgument.target.batchId? // .createArgument.description? // "") | startswith($run))
      | select(.templateId | test(":(RedemptionBatch|RoleApproval|ClaimEntitlement|OutstandingRedemption|FinalizePolicyRedemption)$")) | .contractId' | sort -u)
[[ -z $LEFT ]] || fail "test contracts remain: $LEFT"
echo "PASS: no open batches, approvals, proposals or investor records remain for $RUN (FundPolicy v2 and demo receipts remain)"
echo "Alluvren P-10 LocalNet run passed. run=$RUN policy_v1=$POLICY_V1 batch1=$B1 batch2=$B2"
