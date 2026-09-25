#!/usr/bin/env bash
# Gate 7 on BitSafe LocalNet: a BitSafe-governed FinalizeRedemption on
# alluvren-v1 0.2.0 creates investor-private entitlement and outstanding
# records; investors acknowledge/withdraw once; other parties cannot see or
# act on them. Runs on the LocalNet VM as root (reads the harness token like
# test-gate6-localnet.sh).
#
# Visibility is checked by per-party active-contract queries through the
# participant's JSON Ledger API. This proves the ledger's per-party projection;
# it uses the shared harness user, so it is NOT a separate-credential test.
set -Eeuo pipefail
. "$(cd "$(dirname "$0")" && pwd)/localnet-env.sh"

PKG='#alluvren-v1'

RUN=gate7-$(date +%s)
new_id() { printf '%s-%s-%s' "$RUN" "$1" "$(uid)"; }
ledger_submit() {
  local cmdid=$1 actors=$2 commands=$3 body
  body=$(jq -cn --arg id "$cmdid" --argjson actors "$actors" --argjson commands "$commands" \
    '{commands:{userId:"ledger-api-user",commandId:$id,actAs:$actors,commands:$commands}}')
  curl -fsS "$JSON_API/v2/commands/submit-and-wait-for-transaction" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$body"
}
# Same as ledger_submit but returns the HTTP status instead of failing.
ledger_try() {
  local cmdid=$1 actors=$2 commands=$3 body
  body=$(jq -cn --arg id "$cmdid" --argjson actors "$actors" --argjson commands "$commands" \
    '{commands:{userId:"ledger-api-user",commandId:$id,actAs:$actors,commands:$commands}}')
  curl -sS -o "${TMPDIR:-/tmp}/$RUN-last.json" -w '%{http_code}' "$JSON_API/v2/commands/submit-and-wait-for-transaction" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$body"
}
dm_post() {
  curl -sS -w '\nHTTP=%{http_code}\n' -X POST "$BASE:$1$2" -H 'Content-Type: application/json' -d "$3"
}
confirm() {
  local port=$1 proposal=$2 body response
  body=$(jq -cn --arg party "$GOV" --arg rules "$RULES" --arg cid "$proposal" \
    '{party_id:$party,rules_contract_id:$rules,action:{type:"governance_set_threshold",new_threshold:0},governance_type:"core_domain",proposal_cid:$cid}')
  response=$(dm_post "$port" /governance/confirm "$body")
  echo "$response" | grep -q 'HTTP=200' || fail "confirmation on node $port failed: $response"
  sleep 1
}
# Active Alluvren.Claims contracts visible to exactly one party, as
# "<entity> <contractId> <investor> <units>" lines.
visible_claims() {
  local party=$1 offset body
  offset=$(curl -fsS "$JSON_API/v2/state/ledger-end" -H "Authorization: Bearer $TOKEN" | jq -r '.offset')
  body=$(jq -cn --arg p "$party" --argjson off "$offset" \
    '{filter:{filtersByParty:{($p):{cumulative:[{identifierFilter:{WildcardFilter:{value:{includeCreatedEventBlob:false}}}}]}}},verbose:false,activeAtOffset:$off}')
  curl -fsS "$JSON_API/v2/state/active-contracts" -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' -d "$body" \
    | jq -r '.. | objects | select(has("createdEvent")) | .createdEvent
        | select(.templateId | test(":Alluvren\\.Claims:"))
        | "\(.templateId | split(":") | last) \(.contractId) \(.createArgument.investor) \(.createArgument.units) \(.createArgument.batchId)"' \
    | grep " $RUN" || true
}

ack() { jq -cn --arg c "$1" '[{ExerciseCommand:{templateId:"#alluvren-v1:Alluvren.Claims:ClaimEntitlement",contractId:$c,choice:"ClaimEntitlement_Acknowledge",choiceArgument:{}}}]'; }
wd()  { jq -cn --arg c "$1" '[{ExerciseCommand:{templateId:"#alluvren-v1:Alluvren.Claims:OutstandingRedemption",contractId:$c,choice:"OutstandingRedemption_Withdraw",choiceArgument:{}}}]'; }

# cleanup <run-id>: consume a previous run's open investor records through
# each investor's own choices (for interrupted runs).
if [[ ${1-} == cleanup ]]; then
  RUN=${2:?usage: test-gate7-localnet.sh cleanup <run-id>}
  say "Cleanup open investor records for $RUN"
  for party in "$INV_A" "$INV_B"; do
    while read -r entity cid _; do
      [[ -n ${cid-} ]] || continue
      case $entity in
        ClaimEntitlement) ledger_submit "$(new_id cleanup-ack)" "[\"$party\"]" "$(ack "$cid")" >/dev/null ;;
        OutstandingRedemption) ledger_submit "$(new_id cleanup-wd)" "[\"$party\"]" "$(wd "$cid")" >/dev/null ;;
        *) continue ;;
      esac
      echo "consumed $entity $cid"
    done < <(visible_claims "$party")
    left=$(visible_claims "$party" | grep -E '^(ClaimEntitlement|OutstandingRedemption) ' || true)
    [[ -z $left ]] || fail "open records remain for $party: $left"
  done
  echo "PASS: no open investor records remain for $RUN"
  exit 0
fi

say "Create batch $RUN (A requests 600, B 300; 450 allocated)"
EXP=$(iso_in 10)
BATCH=$(jq -cn --arg gov "$GOV" --arg prop "$P1" --arg op "$OP" --arg fund "$FUND" --arg treas "$TREAS" \
  --arg a "$INV_A" --arg b "$INV_B" --arg id "$RUN" --arg dl "$EXP" '
  [{CreateCommand:{templateId:"#alluvren-v1:Alluvren.Redemption:RedemptionBatch",createArguments:{
    governanceParty:$gov,proposer:$prop,operator:$op,fundReviewer:$fund,treasuryReviewer:$treas,
    policyVersion:"gate7-live-v1",batchId:$id,
    rows:[{requestId:"gate7-a",investor:$a,requestedUnits:"600",allocatedUnits:"300"},
          {requestId:"gate7-b",investor:$b,requestedUnits:"300",allocatedUnits:"150"}],
    totalRequested:"900",totalAllocated:"450",recoveryDeadline:$dl}}}]')
TX=$(ledger_submit "$(new_id batch)" "[\"$P1\"]" "$BATCH")
BATCH_CID=$(echo "$TX" | jq -r '.transaction.events[].CreatedEvent | select(.templateId|contains(":RedemptionBatch")) | .contractId')
[[ -n $BATCH_CID ]] || fail 'batch not created'
echo "batch=$BATCH_CID"

say 'Reviewer approvals and governed proposal'
APPROVALS=$(jq -cn --arg gov "$GOV" --arg fund "$FUND" --arg treas "$TREAS" --arg cid "$BATCH_CID" --arg id "$RUN" --arg exp "$EXP" '
  def approval($r;$role): {CreateCommand:{templateId:"#alluvren-v1:Alluvren.Redemption:RoleApproval",createArguments:{governanceParty:$gov,reviewer:$r,role:$role,target:{batchCid:$cid,batchId:$id,policyVersion:"gate7-live-v1"},expiresAt:$exp}}};
  [approval($fund;"FundReviewer"), approval($treas;"TreasuryReviewer")]')
TX=$(ledger_submit "$(new_id approvals)" "[\"$FUND\",\"$TREAS\"]" "$APPROVALS")
mapfile -t A < <(echo "$TX" | jq -r '.transaction.events[].CreatedEvent | select(.templateId|contains(":RoleApproval")) | .contractId')
[[ ${#A[@]} -eq 2 ]] || fail "expected two approvals, got ${#A[@]}"
PROPOSAL=$(jq -cn --arg gov "$GOV" --arg prop "$P1" --arg b "$BATCH_CID" --arg f "${A[0]}" --arg t "${A[1]}" --arg id "$RUN" '
  [{CreateCommand:{templateId:"#alluvren-v1:Alluvren.Redemption:FinalizeRedemption",createArguments:{governanceParty:$gov,proposer:$prop,batchCid:$b,fundApprovalCid:$f,treasuryApprovalCid:$t,description:("Gate7 investor outcomes " + $id)}}}]')
TX=$(ledger_submit "$(new_id proposal)" "[\"$P1\"]" "$PROPOSAL")
PROP_CID=$(echo "$TX" | jq -r '.transaction.events[].CreatedEvent | select(.templateId|contains(":FinalizeRedemption")) | .contractId')
[[ -n $PROP_CID ]] || fail 'proposal not created'
RULES=$(curl -fsS "$BASE:8081/governance/state?party_id=$GOV" | jq -r '.state.contract_id')
[[ -n $RULES && $RULES != null ]]

say 'BitSafe threshold and execution'
confirm 8081 "$PROP_CID"
confirm 8082 "$PROP_CID"
STATE=$(curl -fsS "$BASE:8083/governance/confirmations?party_id=$GOV" | jq -c --arg cid "$PROP_CID" 'first(.domain_actions[] | select(.proposal_cid==$cid))')
[[ $(echo "$STATE" | jq '.can_execute') == true ]] || fail "threshold not reached: $STATE"
CIDS=$(echo "$STATE" | jq -c '[.confirmations[].contract_id]')
EXEC_BODY=$(jq -cn --arg party "$GOV" --arg rules "$RULES" --arg cid "$PROP_CID" --argjson cids "$CIDS" \
  '{party_id:$party,rules_contract_id:$rules,action:{type:"governance_set_threshold",new_threshold:0},confirmation_cids:$cids,disclosed_contracts:[],governance_type:"core_domain",proposal_cid:$cid}')
RESULT=$(dm_post 8083 /governance/execute "$EXEC_BODY")
echo "$RESULT" | grep -q 'HTTP=200' && echo "$RESULT" | grep -q 'Action executed successfully' || fail "execution failed: $RESULT"
echo 'PASS: governed FinalizeRedemption executed on 0.2.0'

say 'Per-party ledger visibility'
VA=$(visible_claims "$INV_A"); VB=$(visible_claims "$INV_B")
echo "investor A sees:"; echo "$VA"
echo "investor B sees:"; echo "$VB"
[[ $(echo "$VA" | grep -c '^ClaimEntitlement .* 300 ') -eq 1 ]] || fail 'A must see exactly one 300-unit entitlement'
[[ $(echo "$VA" | grep -c '^OutstandingRedemption .* 300 ') -eq 1 ]] || fail 'A must see exactly one 300-unit outstanding record'
[[ $(echo "$VB" | grep -c '^ClaimEntitlement .* 150 ') -eq 1 ]] || fail 'B must see exactly one 150-unit entitlement'
[[ $(echo "$VB" | grep -c '^OutstandingRedemption .* 150 ') -eq 1 ]] || fail 'B must see exactly one 150-unit outstanding record'
echo "$VA" | grep -q "$INV_B" && fail 'A can see a record belonging to B'
echo "$VB" | grep -q "$INV_A" && fail 'B can see a record belonging to A'
for other in "$OP" "$FUND" "$TREAS" "$P1"; do
  [[ -z $(visible_claims "$other") ]] || fail "role party $other can see investor records"
done
echo 'PASS: each investor sees only its own records; operator, reviewers and proposer see none'
A_ENT=$(echo "$VA" | awk '$1=="ClaimEntitlement"{print $2}')
A_OUT=$(echo "$VA" | awk '$1=="OutstandingRedemption"{print $2}')
B_ENT=$(echo "$VB" | awk '$1=="ClaimEntitlement"{print $2}')
B_OUT=$(echo "$VB" | awk '$1=="OutstandingRedemption"{print $2}')

say 'Wrong-party actions are rejected'
code=$(ledger_try "$(new_id b-acks-a)" "[\"$INV_B\"]" "$(ack "$A_ENT")")
[[ $code != 200 ]] || fail 'B acknowledged A entitlement'
code=$(ledger_try "$(new_id b-withdraws-a)" "[\"$INV_B\"]" "$(wd "$A_OUT")")
[[ $code != 200 ]] || fail 'B withdrew A outstanding units'
echo "PASS: B cannot acknowledge or withdraw A's records (last HTTP $code)"

say 'Acknowledge and withdraw exactly once'
TX=$(ledger_submit "$(new_id a-ack)" "[\"$INV_A\"]" "$(ack "$A_ENT")")
RECEIPT=$(echo "$TX" | jq -r '.transaction.events[] | (.CreatedEvent // empty) | select(.templateId|contains(":ClaimReceipt")) | "\(.contractId) \(.createArgument.units) \(.createArgument.mode)"')
echo "receipt: $RECEIPT"
[[ $RECEIPT == *" 300 DemoAcknowledgment" ]] || fail "unexpected receipt: $RECEIPT"
code=$(ledger_try "$(new_id a-ack-replay)" "[\"$INV_A\"]" "$(ack "$A_ENT")")
[[ $code != 200 ]] || fail 'second acknowledgment succeeded'
TX=$(ledger_submit "$(new_id a-wd)" "[\"$INV_A\"]" "$(wd "$A_OUT")")
RELEASE=$(echo "$TX" | jq -r '.transaction.events[] | (.CreatedEvent // empty) | select(.templateId|contains(":OutstandingReleaseReceipt")) | "\(.contractId) \(.createArgument.units)"')
echo "release: $RELEASE"
[[ $RELEASE == *" 300" ]] || fail "unexpected release receipt: $RELEASE"
code=$(ledger_try "$(new_id a-wd-replay)" "[\"$INV_A\"]" "$(wd "$A_OUT")")
[[ $code != 200 ]] || fail 'second withdrawal succeeded'
echo 'PASS: acknowledgment and withdrawal each succeed once; replays rejected'
[[ -z $(visible_claims "$INV_B" | grep -F "${RECEIPT%% *}") ]] || fail 'B can see A receipt'
echo 'PASS: A receipts are not visible to B'

say 'Cleanup: B consumes its own records'
ledger_submit "$(new_id b-ack)" "[\"$INV_B\"]" "$(ack "$B_ENT")" >/dev/null
ledger_submit "$(new_id b-wd)" "[\"$INV_B\"]" "$(wd "$B_OUT")" >/dev/null
for party in "$INV_A" "$INV_B"; do
  left=$(visible_claims "$party" | grep -E '^(ClaimEntitlement|OutstandingRedemption) ' || true)
  [[ -z $left ]] || fail "open investor records remain for $party: $left"
done
echo 'PASS: no open entitlements or outstanding records remain; demo receipts retained as evidence'

# DecMan /governance/chain-audit on this LocalNet returned only its 16 oldest
# entries (max offset 876) on 2026-09-25 regardless of paging parameters, so it
# is not used as evidence here. Execution is proven by the DecMan execute
# response and the investor records it created on-ledger.
echo "Alluvren Gate 7 LocalNet run passed. run=$RUN batch=$BATCH_CID proposal=$PROP_CID"
rm -f "${TMPDIR:-/tmp}/$RUN-last.json"
