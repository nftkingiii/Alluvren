#!/usr/bin/env bash
set -Eeuo pipefail

BASE=http://127.0.0.1
JSON_API=$BASE:2975
PACKAGE='#alluvren-v1:Alluvren.Redemption'
GOV='demo-party::1220ebce9d2445fcdc8f78c1f9993b9d4d1be362e32939eb6d6ab62f6c54048accea'
P1='party-2db40dfe-79ad-4858-aa97-2daf52f8893e::12201127dbbfdce012505c59bc8c05c9250187c0cceabd8e8c41fdf5ff169da291a8'
P2='party-39699690-05f3-49be-9279-942d59092179::12208876893b8cc00304d1aeee9cd6fffdbe5444c96837dea659999c257006ea7b45'
P3='party-effd301f-97b6-4fac-80f5-11ae4af20db5::1220acd5e1461b1f326effb800029964017f636426a2f9de7e3cc3e299e8662d054e'
OP='party-abc34a43-8b10-4fb5-8749-9c09c4b5151a::12201127dbbfdce012505c59bc8c05c9250187c0cceabd8e8c41fdf5ff169da291a8'
FUND='party-b33cd1e3-df3d-4c97-aa25-cf0c64a5f94e::12201127dbbfdce012505c59bc8c05c9250187c0cceabd8e8c41fdf5ff169da291a8'
TREAS='party-16f22a76-5c1f-4400-9ec1-9887b09c5db3::12201127dbbfdce012505c59bc8c05c9250187c0cceabd8e8c41fdf5ff169da291a8'
TOKEN=$(sed -n 's/^LOCALNET_CANTON_TOKEN="\(.*\)"$/\1/p' /home/chineduanimalu/decentralization-manager/hackathon/localnet.sh)
[[ -n $TOKEN ]]

fail() { echo "FAIL: $*" >&2; exit 1; }
say() { printf '\n== %s ==\n' "$*"; }
new_id() { printf 'gate6-%s-%s' "$1" "$(date +%s%N)"; }
ledger_submit() {
  local cmdid=$1 actors=$2 commands=$3 body
  body=$(jq -cn --arg id "$cmdid" --argjson actors "$actors" --argjson commands "$commands" \
    '{commands:{userId:"ledger-api-user",commandId:$id,actAs:$actors,commands:$commands}}')
  curl -fsS "$JSON_API/v2/commands/submit-and-wait-for-transaction" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$body"
}
dm_post() {
  local port=$1 path=$2 body=$3
  curl -sS -w '\nHTTP=%{http_code}\n' -X POST "$BASE:$port$path" \
    -H 'Content-Type: application/json' -d "$body"
}
confirm() {
  local port=$1 member=$2 proposal=$3 body response
  body=$(jq -cn --arg party "$GOV" --arg rules "$RULES" --arg cid "$proposal" \
    '{party_id:$party,rules_contract_id:$rules,action:{type:"governance_set_threshold",new_threshold:0},governance_type:"core_domain",proposal_cid:$cid}')
  response=$(dm_post "$port" /governance/confirm "$body")
  echo "$response" | grep -q 'HTTP=200' || fail "confirmation on node $port failed: $response"
  sleep 1
}
confirmations() {
  curl -fsS "$BASE:$1/governance/confirmations?party_id=$GOV" \
    | jq -c --arg cid "$2" 'first(.domain_actions[] | select(.proposal_cid==$cid))'
}
execute() {
  local port=$1 proposal=$2 cids=$3 body
  body=$(jq -cn --arg party "$GOV" --arg rules "$RULES" --arg cid "$proposal" --argjson cids "$cids" \
    '{party_id:$party,rules_contract_id:$rules,action:{type:"governance_set_threshold",new_threshold:0},confirmation_cids:$cids,disclosed_contracts:[],governance_type:"core_domain",proposal_cid:$cid}')
  dm_post "$port" /governance/execute "$body"
}

DEADLINE_SOURCE=$(date -u -d '+3 minutes' +%Y-%m-%dT%H:%M:%S.%3NZ)
DEADLINE_TARGET=$(date -u -d '+8 minutes' +%Y-%m-%dT%H:%M:%S.%3NZ)
EXPIRES=$(date -u -d '+8 minutes' +%Y-%m-%dT%H:%M:%S.%3NZ)
say 'Create short-lived source and target batches'
BATCHES=$(jq -cn --arg gov "$GOV" --arg prop "$P1" --arg op "$OP" --arg fund "$FUND" --arg treas "$TREAS" \
  --arg ds "$DEADLINE_SOURCE" --arg dt "$DEADLINE_TARGET" '
  def batch($id;$deadline): {CreateCommand:{templateId:"#alluvren-v1:Alluvren.Redemption:RedemptionBatch",createArguments:{governanceParty:$gov,proposer:$prop,operator:$op,fundReviewer:$fund,treasuryReviewer:$treas,policyVersion:"gate6-live-v1",batchId:$id,rows:[{requestId:"request-1",investor:$op,requestedUnits:"100",allocatedUnits:"50"}],totalRequested:"100",totalAllocated:"50",recoveryDeadline:$deadline}}};
  [batch("gate6-source";$ds),batch("gate6-target";$dt)]')
TX=$(ledger_submit "$(new_id batches)" "[\"$P1\"]" "$BATCHES")
SOURCE=$(echo "$TX" | jq -r '.transaction.events[].CreatedEvent | select(.templateId|contains(":RedemptionBatch")) | select(.createArgument.batchId=="gate6-source") | .contractId')
TARGET=$(echo "$TX" | jq -r '.transaction.events[].CreatedEvent | select(.templateId|contains(":RedemptionBatch")) | select(.createArgument.batchId=="gate6-target") | .contractId')
[[ -n $SOURCE && -n $TARGET && $SOURCE != $TARGET ]]
echo "source=$SOURCE target=$TARGET"

say 'Create source-bound, tampered-reviewer, and target-bound approvals'
APPROVALS=$(jq -cn --arg gov "$GOV" --arg fund "$FUND" --arg treas "$TREAS" --arg op "$OP" \
  --arg source "$SOURCE" --arg target "$TARGET" --arg exp "$EXPIRES" '
  def approval($reviewer;$role;$cid;$batch): {CreateCommand:{templateId:"#alluvren-v1:Alluvren.Redemption:RoleApproval",createArguments:{governanceParty:$gov,reviewer:$reviewer,role:$role,target:{batchCid:$cid,batchId:$batch,policyVersion:"gate6-live-v1"},expiresAt:$exp}}};
  [approval($fund;"FundReviewer";$source;"gate6-source"),
   approval($treas;"TreasuryReviewer";$source;"gate6-source"),
   approval($op;"FundReviewer";$target;"gate6-target"),
   approval($fund;"FundReviewer";$target;"gate6-target"),
   approval($treas;"TreasuryReviewer";$target;"gate6-target")]')
TX=$(ledger_submit "$(new_id approvals)" "[\"$FUND\",\"$TREAS\",\"$OP\"]" "$APPROVALS")
mapfile -t A < <(echo "$TX" | jq -r '.transaction.events[].CreatedEvent | select(.templateId|contains(":RoleApproval")) | .contractId')
[[ ${#A[@]} -eq 5 ]] || fail "expected five approvals, got ${#A[@]}"

say 'Create stale, tampered-reviewer, and valid governed proposals'
PROPOSALS=$(jq -cn --arg gov "$GOV" --arg prop "$P1" --arg batch "$TARGET" \
  --arg staleF "${A[0]}" --arg staleT "${A[1]}" --arg tamperF "${A[2]}" --arg validF "${A[3]}" --arg validT "${A[4]}" '
  def proposal($f;$t;$desc): {CreateCommand:{templateId:"#alluvren-v1:Alluvren.Redemption:FinalizeRedemption",createArguments:{governanceParty:$gov,proposer:$prop,batchCid:$batch,fundApprovalCid:$f,treasuryApprovalCid:$t,description:$desc}}};
  [proposal($staleF;$staleT;"Gate6 stale batch binding test"),
   proposal($tamperF;$validT;"Gate6 reviewer identity tamper test"),
   proposal($validF;$validT;"Gate6 successful execution and replay test")]')
TX=$(ledger_submit "$(new_id proposals)" "[\"$P1\"]" "$PROPOSALS")
mapfile -t Q < <(echo "$TX" | jq -r '.transaction.events[].CreatedEvent | select(.templateId|contains(":FinalizeRedemption")) | .contractId')
[[ ${#Q[@]} -eq 3 ]] || fail "expected three proposals, got ${#Q[@]}"
STALE=${Q[0]}; TAMPER=${Q[1]}; VALID=${Q[2]}
RULES=$(curl -fsS "$BASE:8081/governance/state?party_id=$GOV" | jq -r '.state.contract_id')
[[ -n $RULES && $RULES != null ]]

say 'Threshold gate: one member cannot execute stale proposal'
confirm 8081 "$P1" "$STALE"
ONE=$(confirmations 8081 "$STALE")
[[ $(echo "$ONE" | jq '.confirmation_count') -eq 1 ]]
ONECID=$(echo "$ONE" | jq -c '[.confirmations[].contract_id]')
UNDER=$(execute 8081 "$STALE" "$ONECID")
echo "$UNDER" | grep -q 'HTTP=500' || echo "$UNDER" | grep -q 'HTTP=400' || fail "below-threshold attempt unexpectedly passed: $UNDER"
echo "$UNDER" | grep -qi 'Enough confirmations' || fail "unexpected below-threshold response: $UNDER"
echo 'PASS: one confirmation rejected by GovernanceRules'

say 'Threshold met: stale batch CID rejected by Alluvren'
confirm 8082 "$P2" "$STALE"
STALE_STATE=$(confirmations 8083 "$STALE")
[[ $(echo "$STALE_STATE" | jq '.can_execute') == true ]]
STALE_CIDS=$(echo "$STALE_STATE" | jq -c '[.confirmations[].contract_id]')
STALE_RESULT=$(execute 8083 "$STALE" "$STALE_CIDS")
echo "$STALE_RESULT" | grep -qi 'Fund approval targets the wrong batch' || fail "stale batch did not fail as expected: $STALE_RESULT"
echo 'PASS: threshold reached, then mismatched batch CID rejected atomically'

say 'Tampered reviewer identity rejected after threshold'
confirm 8081 "$P1" "$TAMPER"
confirm 8082 "$P2" "$TAMPER"
TAMPER_STATE=$(confirmations 8083 "$TAMPER")
TAMPER_CIDS=$(echo "$TAMPER_STATE" | jq -c '[.confirmations[].contract_id]')
TAMPER_RESULT=$(execute 8083 "$TAMPER" "$TAMPER_CIDS")
echo "$TAMPER_RESULT" | grep -qi 'Fund reviewer approval is not from the configured reviewer' || fail "tampered reviewer did not fail as expected: $TAMPER_RESULT"
echo 'PASS: threshold reached, altered reviewer identity rejected'

say 'Valid target execution and replay rejection'
confirm 8081 "$P1" "$VALID"
confirm 8082 "$P2" "$VALID"
VALID_STATE=$(confirmations 8083 "$VALID")
[[ $(echo "$VALID_STATE" | jq '.can_execute') == true ]]
VALID_CIDS=$(echo "$VALID_STATE" | jq -c '[.confirmations[].contract_id]')
SUCCESS=$(execute 8083 "$VALID" "$VALID_CIDS")
echo "$SUCCESS" | grep -q 'HTTP=200' || fail "valid execution failed: $SUCCESS"
echo "$SUCCESS" | grep -q 'Action executed successfully' || fail "unexpected successful execution response: $SUCCESS"
REPLAY=$(execute 8083 "$VALID" "$VALID_CIDS")
echo "$REPLAY" | grep -Eq 'HTTP=(400|500)' || fail "replay unexpectedly passed: $REPLAY"
echo 'PASS: valid governed finalization executed once; replay was rejected'
echo "source=$SOURCE target=$TARGET stale_proposal=$STALE tamper_proposal=$TAMPER valid_proposal=$VALID"
echo "stale_approval_fund=${A[0]} stale_approval_treasury=${A[1]} tampered_reviewer_approval=${A[2]}"

say 'Cleanup failed proposals, their confirmations, and unused approvals'
for spec in "$STALE:$STALE_STATE" "$TAMPER:$TAMPER_STATE"; do
  cid=${spec%%:*}; state=${spec#*:}
  while IFS=$'\t' read -r conf party; do
    case "$party" in
      "$P1") port=8082 ;;
      "$P2") port=8081 ;;
      *) fail "no DecMan node mapping for confirming party $party" ;;
    esac
    cancel=$(jq -cn --arg party "$GOV" --arg cid "$conf" '{party_id:$party,confirmation_cid:$cid,governance_type:"core_domain"}')
    dm_post "$port" /governance/cancel "$cancel" | grep -q 'HTTP=200' || fail "could not cancel confirmation $conf"
  done < <(echo "$state" | jq -r '.confirmations[] | [.contract_id,.confirming_party] | @tsv')
  cancelp=$(jq -cn --arg party "$GOV" --arg cid "$cid" '{party_id:$party,proposal_cid:$cid}')
  dm_post 8082 /governance/cancel-proposal "$cancelp" | grep -q 'HTTP=200' || fail "could not cancel failed proposal $cid"
done

REVOKES=$(jq -cn --arg f "${A[0]}" --arg t "${A[1]}" --arg bad "${A[2]}" '
  [{ExerciseCommand:{templateId:"#alluvren-v1:Alluvren.Redemption:RoleApproval",contractId:$f,choice:"RoleApproval_Revoke",choiceArgument:{}}},
   {ExerciseCommand:{templateId:"#alluvren-v1:Alluvren.Redemption:RoleApproval",contractId:$t,choice:"RoleApproval_Revoke",choiceArgument:{}}},
   {ExerciseCommand:{templateId:"#alluvren-v1:Alluvren.Redemption:RoleApproval",contractId:$bad,choice:"RoleApproval_Revoke",choiceArgument:{}}}]')
ledger_submit "$(new_id revoke)" "[\"$FUND\",\"$TREAS\",\"$OP\"]" "$REVOKES" >/dev/null

say 'Wait for the source batch recovery deadline, then clean it up'
sleep 180
RECOVER=$(jq -cn --arg cid "$SOURCE" '[{ExerciseCommand:{templateId:"#alluvren-v1:Alluvren.Redemption:RedemptionBatch",contractId:$cid,choice:"RedemptionBatch_RecoverExpired",choiceArgument:{}}}]')
ledger_submit "$(new_id recover)" "[\"$OP\"]" "$RECOVER" >/dev/null

say 'Verify no active test batches, approvals, or proposals remain'
query_count() {
  local party=$1 entity=$2 response count
  response=$(curl -fsS "$BASE:8082/contracts/query?party_id=$party&package_id=%23alluvren-v1&module_name=Alluvren.Redemption&entity_name=$entity&interface=false")
  count=$(echo "$response" | jq -er '.contracts | length')
  [[ $count -eq 0 ]] || fail "$count active $entity contract(s) remain for $party"
}
query_count "$OP" RedemptionBatch
query_count "$FUND" RoleApproval
query_count "$TREAS" RoleApproval
query_count "$OP" RoleApproval
query_count "$P1" FinalizeRedemption
echo 'PASS: all test batches, approvals, and proposals are absent from the active contract set'
echo "Alluvren Gate 6 tests passed. Source=$SOURCE Target=$TARGET StaleProposal=$STALE TamperProposal=$TAMPER ValidProposal=$VALID"
