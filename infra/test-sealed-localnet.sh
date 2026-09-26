#!/usr/bin/env bash
# Sealed batches on BitSafe LocalNet (alluvren-v1 0.4.0): governance approves a
# redemption without its nodes ever seeing who gets what.
#   1. The operator keeps the per-investor rows in a private AllocationBook and
#      proposes a sealed batch carrying only totals, the row count, the largest
#      allocation and a salted SHA-256 commitment to the rows.
#   2. Through Alluvren's backend, reviewers approve, the operator proposes and
#      two BitSafe members confirm and execute: governance signs a
#      SealedFinalization.
#   3. Node 3, which hosts only the governance party, holds that finalization
#      and nothing that names an investor or a per-investor amount.
#   4. A book whose rows differ from the commitment is rejected by the ledger.
#   5. The operator opens the real book through the backend; each investor sees
#      only their own private record and acknowledges it once.
# Needs infra/setup-localnet.sh first.
set -Eeuo pipefail
. "$(cd "$(dirname "$0")" && pwd)/localnet-env.sh"
. "$INFRA_DIR/backend-harness.sh"

NODE3_JSON=$BASE:4975
RUN=sealed-$(date +%s)
FUND_ID=$RUN
BATCH_ID=$RUN-b1
T='#alluvren-v1:Alluvren.Redemption'
TS='#alluvren-v1:Alluvren.Sealed'
trap backend_stop EXIT

ledger_submit() {
  local body
  body=$(jq -cn --arg id "$RUN-$1-$(uid)" --argjson actors "$2" --argjson commands "$3" \
    '{commands:{userId:"ledger-api-user",commandId:$id,actAs:$actors,commands:$commands}}')
  curl -sS -w '\nHTTP=%{http_code}' "$JSON_API/v2/commands/submit-and-wait-for-transaction" \
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
dm_post() { curl -sS -w '\nHTTP=%{http_code}\n' -X POST "$BASE:$1$2" -H 'Content-Type: application/json' -d "$3"; }
dm_confirm() {
  dm_post "$1" /governance/confirm "$(jq -cn --arg p "$GOV" --arg r "$RULES" --arg c "$2" \
    '{party_id:$p,rules_contract_id:$r,action:{type:"governance_set_threshold",new_threshold:0},governance_type:"core_domain",proposal_cid:$c}')" \
    | grep -q 'HTTP=200' || fail "DecMan confirm on $1 failed"
  sleep 1
}
dm_execute() {
  local cids
  cids=$(curl -fsS "$BASE:8083/governance/confirmations?party_id=$GOV" | jq -c --arg c "$1" 'first(.domain_actions[] | select(.proposal_cid==$c)) | [.confirmations[].contract_id]')
  dm_post 8083 /governance/execute "$(jq -cn --arg p "$GOV" --arg r "$RULES" --arg c "$1" --argjson cids "$cids" \
    '{party_id:$p,rules_contract_id:$r,action:{type:"governance_set_threshold",new_threshold:0},confirmation_cids:$cids,disclosed_contracts:[],governance_type:"core_domain",proposal_cid:$c}')"
}
sha256_hex() { (sha256sum 2>/dev/null || shasum -a 256) | awk '{print $1}'; }
# Canonical text of Alluvren.Sealed.sealedRowsText: the salt, then one line per
# row sorted by request ID: requestId|investor|requested|allocated.
sealed_text() {
  local salt=$1; shift
  printf '%s' "$salt"
  printf '%s\n' "$@" | LC_ALL=C sort | while IFS= read -r line; do printf '\n%s' "$line"; done
}

say "Operator runbook: governed fund policy $FUND_ID (the operator proposes as an additional proposer)"
POLICY=$(jq -cn --arg gov "$GOV" --arg op "$OP" --arg f "$FUND_ID" --arg t "$TREAS" --arg coo "$COO" --arg comp "$COMP" '
  {governanceParty:$gov,operator:$op,fundId:$f,version:"1",
   base:[{role:"TreasuryReviewer",members:[$t],quorum:"1"},{role:"FinalSignoff",members:[$coo],quorum:"1"}],
   conditional:[{trigger:{tag:"FundedBelowBps",value:"5000"},requirement:{role:"ComplianceReviewer",members:[$comp],quorum:"1"}}]}')
UPD=$(ledger_submit policy "[\"$OP\"]" "$(jq -cn --arg gov "$GOV" --arg op "$OP" --argjson pol "$POLICY" --arg d "$RUN policy v1" --arg t "$T:UpdateFundPolicy" \
  '[{CreateCommand:{templateId:$t,createArguments:{governanceParty:$gov,proposer:$op,currentPolicyCid:null,newPolicy:$pol,description:$d}}}]')" | created ':UpdateFundPolicy')
[[ -n $UPD ]] || fail 'policy proposal not created'
dm_confirm 8081 "$UPD"; dm_confirm 8082 "$UPD"
dm_execute "$UPD" | grep -q 'HTTP=200' || fail 'policy creation failed'
POLICY_CID=""
for _ in $(seq 1 10); do
  POLICY_CID=$(active_on "$JSON_API" "$COO" | jq -r --arg f "$FUND_ID" 'select(.templateId | endswith(":FundPolicy")) | select(.createArgument.fundId==$f) | .contractId' | head -1)
  [[ -n $POLICY_CID ]] && break; sleep 2
done
[[ -n $POLICY_CID ]] || fail 'FundPolicy not visible'

say 'Operator runbook: private allocation book and a sealed batch'
SALT=$(od -An -N16 -tx1 /dev/urandom | tr -dc '0-9a-f')
ROW_A="$BATCH_ID-r1|$INV_A|600|300"
ROW_B="$BATCH_ID-r2|$INV_B|400|200"
COMMITMENT=$(sealed_text "$SALT" "$ROW_A" "$ROW_B" | sha256_hex)
PV="$FUND_ID@v1"
ROWS_JSON=$(jq -cn --arg a "$INV_A" --arg b "$INV_B" --arg id "$BATCH_ID" '[
  {requestId:($id+"-r1"),investor:$a,requestedUnits:"600",allocatedUnits:"300"},
  {requestId:($id+"-r2"),investor:$b,requestedUnits:"400",allocatedUnits:"200"}]')
book() {
  ledger_submit book "[\"$OP\"]" "$(jq -cn --arg op "$OP" --arg gov "$GOV" --arg id "$BATCH_ID" --arg pv "$PV" --arg salt "$1" --argjson rows "$2" --arg t "$TS:AllocationBook" \
    '[{CreateCommand:{templateId:$t,createArguments:{operator:$op,governanceParty:$gov,batchId:$id,policyVersion:$pv,salt:$salt,rows:$rows}}}]')" | created ':AllocationBook'
}
BOOK=$(book "$SALT" "$ROWS_JSON")
[[ -n $BOOK ]] || fail 'allocation book not created'
DL=$(iso_in 30)
BATCH=$(ledger_submit batch "[\"$OP\"]" "$(jq -cn --arg gov "$GOV" --arg op "$OP" --arg coo "$COO" --arg t "$TREAS" --arg comp "$COMP" \
  --arg id "$BATCH_ID" --arg pv "$PV" --arg pol "$POLICY_CID" --arg dl "$DL" --arg c "$COMMITMENT" --arg tpl "$T:RedemptionBatch" '
  [{CreateCommand:{templateId:$tpl,createArguments:{governanceParty:$gov,proposer:$op,operator:$op,fundReviewer:$coo,treasuryReviewer:$t,
    policyVersion:$pv,batchId:$id,rows:[],totalRequested:"1000",totalAllocated:"500",recoveryDeadline:$dl,
    policyCid:$pol,policyMembers:[$t,$coo,$comp],exceptions:null,
    sealed:{commitment:$c,rowCount:"2",maxRowAllocatedUnits:"300"}}}}]')" | created ':RedemptionBatch')
[[ -n $BATCH ]] || fail 'sealed batch not created'
pass "sealed batch $BATCH_ID: 1,000 requested, 500 allocated, 2 rows, commitment ${COMMITMENT:0:12}…; rows held only in the operator's book"

say 'Signed-in users through the backend: approve, propose, confirm, execute'
backend_start "$(jq -cn --arg op "$OP" --arg m1 "$MEMBER_1" --arg m2 "$MEMBER_2" --arg t "$TREAS" --arg coo "$COO" --arg a "$INV_A" --arg b "$INV_B" '
  [{username:"operator",party:$op,roles:["Operator"]},
   {username:"treasury",party:$t,roles:["TreasuryReviewer"]},
   {username:"coo",party:$coo,roles:["FinalSignoff"]},
   {username:"member-1",party:$m1,roles:["GovernanceMember"],decmanNode:"p1"},
   {username:"member-2",party:$m2,roles:["GovernanceMember"],decmanNode:"p2"},
   {username:"investor-a",party:$a,roles:["Investor"]},
   {username:"investor-b",party:$b,roles:["Investor"]}]')" "http://127.0.0.1:2975,http://127.0.0.1:3975"
for u in operator treasury coo member-1 member-2 investor-a investor-b; do login "$u"; done
R=$(get treasury /api/workflow); expect "$R" 200 'treasury workflow'
[[ $(body "$R" | jq -r --arg b "$BATCH" '.activeContracts.redemptionBatches[] | select(.contractId==$b) | .data.sealed.rowCount') == 2 ]] || fail 'sealed summary not shown to staff'
[[ $(body "$R" | jq -r --arg b "$BATCH" '[.activeContracts.redemptionBatches[] | select(.contractId==$b) | .data.rows[]] | length') == 0 ]] || fail 'staff view shows rows of a sealed batch'
R=$(post treasury /api/approvals "$(jq -cn --arg b "$BATCH" '{batchCid:$b,role:"TreasuryReviewer"}')"); expect "$R" 200 'treasury approval'
A_T=$(body "$R" | jq -r '.approvalCid')
R=$(post coo /api/approvals "$(jq -cn --arg b "$BATCH" '{batchCid:$b,role:"FinalSignoff"}')"); expect "$R" 200 'coo approval'
A_F=$(body "$R" | jq -r '.approvalCid')
R=$(post operator /api/proposals/finalize "$(jq -cn --arg b "$BATCH" '{batchCid:$b}')"); expect "$R" 200 'operator proposal'
PROP=$(body "$R" | jq -r '.proposalCid')
for member in member-1 member-2; do
  for _ in $(seq 1 10); do
    R=$(post "$member" /api/governance/confirm "$(jq -cn --arg p "$PROP" '{proposalCid:$p}')")
    [[ $(code "$R") == 404 ]] || break; sleep 2
  done
  expect "$R" 200 "$member confirm"
done
R=$(post member-1 /api/governance/execute "$(jq -cn --arg p "$PROP" '{proposalCid:$p}')"); expect "$R" 200 'execution'
FIN=""
for _ in $(seq 1 10); do
  FIN=$(body "$(get operator /api/workflow)" | jq -r --arg id "$BATCH_ID" '.activeContracts.sealedFinalizations[] | select(.data.batchId==$id) | .contractId' | head -1)
  [[ -n $FIN ]] && break; sleep 2
done
[[ -n $FIN ]] || fail 'sealed finalization not visible'
[[ $(body "$(get investor-a /api/me/records)" | jq '[.entitlements[] | select(.batchId=="'"$BATCH_ID"'")] | length') == 0 ]] || fail 'records exist before distribution'
pass "governed finalization executed from the backend; governance signed a SealedFinalization ($FIN) and no investor records yet"

say 'What node 3 (governance only) holds for this batch'
GOV_ON_NODE3=$(active_on "$NODE3_JSON" "$GOV" | jq -c --arg id "$BATCH_ID" --arg c "$COMMITMENT" 'select((.createArgument.batchId? // .createArgument.target.batchId? // "") == $id or (tostring | contains($c)))')
echo "$GOV_ON_NODE3" | jq -r '.templateId | split(":") | .[-1]' | sort | uniq -c | sed 's/^/    /'
[[ $(echo "$GOV_ON_NODE3" | jq -r 'select(.templateId | endswith(":SealedFinalization")) | .contractId') == "$FIN" ]] || fail 'node 3 does not hold the finalization'
for secret in "$INV_A" "$INV_B" "$SALT" "$BATCH_ID-r1" "$BATCH_ID-r2"; do
  grep -qF "$secret" <<<"$GOV_ON_NODE3" && fail "node 3 can see $secret"
done
echo "$GOV_ON_NODE3" | jq -e 'select(.templateId | test(":(AllocationBook|PrivateEntitlement|PrivateOutstanding|ClaimEntitlement)$"))' >/dev/null && fail 'node 3 holds per-investor contracts'
pass 'node 3 holds the finalization (totals, row count, largest allocation, commitment) and no investor party, request, salt or per-investor amount'

say 'A book that does not match the commitment is rejected'
FORGED=$(book "$(od -An -N16 -tx1 /dev/urandom | tr -dc '0-9a-f')" "$ROWS_JSON")
R=$(ledger_submit forged "[\"$OP\"]" "$(jq -cn --arg b "$FORGED" --arg f "$FIN" --arg t "$TS:AllocationBook" \
  '[{ExerciseCommand:{templateId:$t,contractId:$b,choice:"AllocationBook_Distribute",choiceArgument:{finalizationCid:$f}}}]')")
grep -q 'HTTP=200' <<<"$R" && fail 'a book with a different salt was accepted'
grep -q 'Rows do not match the commitment governance approved' <<<"$R" || fail "unexpected rejection: $(head -c 300 <<<"$R")"
ledger_submit archive "[\"$OP\"]" "$(jq -cn --arg b "$FORGED" --arg t "$TS:AllocationBook" '[{ExerciseCommand:{templateId:$t,contractId:$b,choice:"Archive",choiceArgument:{}}}]')" | grep -q 'HTTP=200' || fail 'could not archive the forged book'
pass 'ledger rejected it: "Rows do not match the commitment governance approved"'

say 'The operator opens the real book; investors act on private records'
R=$(post treasury /api/sealed/distribute "$(jq -cn --arg f "$FIN" '{finalizationCid:$f}')"); expect "$R" 403 'reviewer distributing'
R=$(post operator /api/sealed/distribute "$(jq -cn --arg f "$FIN" '{finalizationCid:$f}')"); expect "$R" 200 'distribution'
[[ $(body "$R" | jq -c '[.entitlements,.outstanding]') == '[2,2]' ]] || fail "unexpected distribution: $(body "$R")"
R=$(post operator /api/sealed/distribute "$(jq -cn --arg f "$FIN" '{finalizationCid:$f}')"); expect "$R" 404 'second distribution'
RA=$(body "$(get investor-a /api/me/records)"); RB=$(body "$(get investor-b /api/me/records)")
ENT_A=$(jq -r --arg id "$BATCH_ID" '.entitlements[] | select(.batchId==$id) | "\(.contractId) \(.units) \(.sealed)"' <<<"$RA")
ENT_B=$(jq -r --arg id "$BATCH_ID" '.entitlements[] | select(.batchId==$id) | "\(.contractId) \(.units) \(.sealed)"' <<<"$RB")
[[ $(cut -d' ' -f2- <<<"$ENT_A") == "300 true" && $(cut -d' ' -f2- <<<"$ENT_B") == "200 true" ]] || fail "unexpected private records: A=$ENT_A B=$ENT_B"
grep -qF "${ENT_B%% *}" <<<"$RA" && fail "investor A can see investor B's record"
expect "$(post investor-b /api/claims/acknowledge "$(jq -cn --arg c "${ENT_A%% *}" '{entitlementCid:$c}')")" 404 "B acknowledging A's record"
expect "$(post investor-a /api/claims/acknowledge "$(jq -cn --arg c "${ENT_A%% *}" '{entitlementCid:$c}')")" 200 'A acknowledges'
expect "$(post investor-a /api/claims/acknowledge "$(jq -cn --arg c "${ENT_A%% *}" '{entitlementCid:$c}')")" 404 'A acknowledges again'
[[ -z $(active_on "$NODE3_JSON" "$GOV" | jq -r 'select(.templateId | test(":Private"))' ) ]] || fail 'node 3 holds private records'
pass 'operator distributed once (a second attempt 404s); A sees only 300, B only 200; A acknowledged once; node 3 holds no private records'
echo
echo "Alluvren sealed batch LocalNet run passed. run=$RUN batch=$BATCH finalization=$FIN commitment=$COMMITMENT"
