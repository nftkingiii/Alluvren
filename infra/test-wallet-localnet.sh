#!/usr/bin/env bash
# Wallet investor on BitSafe LocalNet: a governed payout to an investor whose
# only credential is a Canton Wallet Gateway (CIP-0103) wallet. Staff act
# through the real backend as in gate 8; the investor reads and acknowledges
# through the gateway, and the acknowledgment is signed by the wallet's own key.
# Needs infra/setup-localnet.sh and `bash infra/wallet-gateway.sh start`.
set -Eeuo pipefail
. "$(cd "$(dirname "$0")" && pwd)/localnet-env.sh"
. "$INFRA_DIR/backend-harness.sh"

RUN=wallet-$(date +%s)
FUND_ID=$RUN
T='#alluvren-v1:Alluvren.Redemption'
trap backend_stop EXIT
wallet() { local cmd=$1; shift; node "$INFRA_DIR/wallet-gateway.mjs" "$cmd" "$WALLET_NAME" "$@"; }
WALLET_NAME=wallet-test-investor

# --- operator runbook (direct ledger + DecMan), used only for setup --------
ledger_submit() {
  local body
  body=$(jq -cn --arg id "$RUN-$1-$(uid)" --argjson actors "$2" --argjson commands "$3" \
    '{commands:{userId:"ledger-api-user",commandId:$id,actAs:$actors,commands:$commands}}')
  curl -fsS "$JSON_API/v2/commands/submit-and-wait-for-transaction" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$body"
}
created() { jq -r --arg t "$1" '.transaction.events[] | (.CreatedEvent // empty) | select(.templateId | endswith($t)) | .contractId'; }
dm_post() { curl -sS -w '\nHTTP=%{http_code}\n' -X POST "$BASE:$1$2" -H 'Content-Type: application/json' -d "$3"; }
RULES=$(curl -fsS "$BASE:8081/governance/state?party_id=$GOV" | jq -r '.state.contract_id')
[[ -n $RULES && $RULES != null ]]
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

say 'The investor is a Wallet Gateway party'
INV=$(wallet setup) || fail 'no wallet: is the gateway running? (bash infra/wallet-gateway.sh start)'
NAMESPACE=${INV#*::}
PARTICIPANT_NS=${P1#*::}
[[ $NAMESPACE != "$PARTICIPANT_NS" ]] || fail 'the wallet party should have its own key namespace, not node 2'"'"'s'
pass "wallet party ${INV:0:40}… has its own key namespace (not the participant's)"

say "Setup: governed FundPolicy $FUND_ID and a 40%-funded batch for the wallet investor"
POLICY=$(jq -cn --arg gov "$GOV" --arg op "$OP" --arg f "$FUND_ID" --arg t "$TREAS" --arg coo "$COO" --arg comp "$COMP" '
  {governanceParty:$gov,operator:$op,fundId:$f,version:"1",
   base:[{role:"TreasuryReviewer",members:[$t],quorum:"1"},{role:"FinalSignoff",members:[$coo],quorum:"1"}],
   conditional:[{trigger:{tag:"FundedBelowBps",value:"5000"},requirement:{role:"ComplianceReviewer",members:[$comp],quorum:"1"}}]}')
UPD=$(ledger_submit policy "[\"$P1\"]" "$(jq -cn --arg gov "$GOV" --arg prop "$P1" --argjson pol "$POLICY" --arg d "$RUN policy v1" \
  --arg t "$T:UpdateFundPolicy" '[{CreateCommand:{templateId:$t,createArguments:{governanceParty:$gov,proposer:$prop,currentPolicyCid:null,newPolicy:$pol,description:$d}}}]')" | created ':UpdateFundPolicy')
dm_confirm 8081 "$UPD"; dm_confirm 8082 "$UPD"
dm_execute "$UPD" | grep -q 'HTTP=200' || fail 'policy creation failed'
POLICY_CID=""
for _ in $(seq 1 10); do
  OFF=$(curl -fsS "$JSON_API/v2/state/ledger-end" -H "Authorization: Bearer $TOKEN" | jq -r '.offset')
  POLICY_CID=$(curl -fsS "$JSON_API/v2/state/active-contracts" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "$(jq -cn --arg p "$COO" --argjson o "$OFF" '{filter:{filtersByParty:{($p):{cumulative:[{identifierFilter:{WildcardFilter:{value:{includeCreatedEventBlob:false}}}}]}}},verbose:false,activeAtOffset:$o}')" \
    | jq -r --arg f "$FUND_ID" '.. | objects | select(has("createdEvent")) | .createdEvent | select(.templateId | endswith(":FundPolicy")) | select(.createArgument.fundId==$f) | .contractId' | head -1)
  [[ -n $POLICY_CID ]] && break; sleep 2
done
[[ -n $POLICY_CID ]] || fail 'FundPolicy not visible'
DL=$(iso_in 20)
BATCH=$(ledger_submit batch "[\"$OP\"]" "$(jq -cn --arg gov "$GOV" --arg prop "$OP" --arg op "$OP" --arg coo "$COO" --arg t "$TREAS" --arg comp "$COMP" \
  --arg inv "$INV" --arg id "$RUN-b1" --arg pv "$FUND_ID@v1" --arg pol "$POLICY_CID" --arg dl "$DL" --arg tpl "$T:RedemptionBatch" '
  [{CreateCommand:{templateId:$tpl,createArguments:{governanceParty:$gov,proposer:$prop,operator:$op,fundReviewer:$coo,treasuryReviewer:$t,
    policyVersion:$pv,batchId:$id,rows:[{requestId:($id+"-r1"),investor:$inv,requestedUnits:"1000",allocatedUnits:"400"}],
    totalRequested:"1000",totalAllocated:"400",recoveryDeadline:$dl,policyCid:$pol,policyMembers:[$t,$coo,$comp],exceptions:null}}}]')" | created ':RedemptionBatch')
[[ -n $BATCH ]] || fail 'batch not created'
pass "batch $RUN-b1 names the wallet party: 1,000 requested, 400 allocated"

say 'Staff run the governed finalization through the backend (no investor account)'
backend_start "$(jq -cn --arg op "$OP" --arg m1 "$MEMBER_1" --arg m2 "$MEMBER_2" --arg t "$TREAS" --arg coo "$COO" --arg comp "$COMP" '
  [{username:"operator",party:$op,roles:["Operator"]},
   {username:"treasury",party:$t,roles:["TreasuryReviewer"]},
   {username:"coo",party:$coo,roles:["FinalSignoff"]},
   {username:"compliance",party:$comp,roles:["ComplianceReviewer"]},
   {username:"member-1",party:$m1,roles:["GovernanceMember"],decmanNode:"p1"},
   {username:"member-2",party:$m2,roles:["GovernanceMember"],decmanNode:"p2"}]')" "http://127.0.0.1:2975,http://127.0.0.1:3975"
for u in operator treasury coo compliance member-1 member-2; do login "$u"; done
for pair in treasury:TreasuryReviewer coo:FinalSignoff compliance:ComplianceReviewer; do
  expect "$(post "${pair%%:*}" /api/approvals "$(jq -cn --arg b "$BATCH" --arg r "${pair#*:}" '{batchCid:$b,role:$r}')")" 200 "${pair%%:*} approval"
done
for _ in $(seq 1 10); do
  [[ $(body "$(get coo /api/workflow)" | jq -r --arg b "$BATCH" '.batchStatus[$b].complete') == true ]] && break; sleep 2
done
R=$(post operator /api/proposals/finalize "$(jq -cn --arg b "$BATCH" '{batchCid:$b}')"); expect "$R" 200 'proposal'
PROP=$(body "$R" | jq -r '.proposalCid')
confirm_as() {
  local r
  for _ in $(seq 1 10); do
    r=$(post "$1" /api/governance/confirm "$(jq -cn --arg p "$2" --arg node p3 '{proposalCid:$p,node:$node}')")
    [[ $(code "$r") == 404 ]] || break; sleep 2
  done
  expect "$r" 200 "$1 confirm"
}
confirm_as member-1 "$PROP"; confirm_as member-2 "$PROP"
expect "$(post member-1 /api/governance/execute "$(jq -cn --arg p "$PROP" '{proposalCid:$p}')")" 200 'execution'
pass 'treasury, COO and compliance approved; the operator proposed; two members confirmed and executed'

say 'The wallet sees its private entitlement through the gateway'
ENT=""
for _ in $(seq 1 10); do
  ENT=$(wallet entitlements | jq -r --arg id "$RUN-b1" '.[] | select(.batchId==$id) | "\(.contractId) \(.units)"')
  [[ -n $ENT ]] && break; sleep 2
done
[[ ${ENT#* } == 400 ]] || fail "wallet should see one 400-unit entitlement for $RUN-b1, got: ${ENT:-none}"
pass "wallet reads its entitlement (400 units) through the gateway's ledgerApi, with no Alluvren account"

say 'The investor acknowledges with the wallet; the wallet key signs'
ACK=$(wallet acknowledge "${ENT%% *}") || fail 'wallet acknowledgment failed'
SIGNER=$(echo "$ACK" | jq -r '.signedBy')
[[ $SIGNER == "$NAMESPACE" ]] || fail "acknowledgment should be signed by the wallet key $NAMESPACE, got $SIGNER"
pass "signed by the wallet key ${SIGNER:0:16}… and executed as update $(echo "$ACK" | jq -r '.updateId' | head -c 16)…"
RCPT=$(wallet receipts | jq -r --arg id "$RUN-b1" '.[] | select(.batchId==$id) | .units')
[[ $RCPT == 400 ]] || fail "wallet should hold a 400-unit receipt for $RUN-b1, got: ${RCPT:-none}"
if wallet acknowledge "${ENT%% *}" >/dev/null 2>&1; then fail 'a second acknowledgment should be refused'; fi
pass 'the wallet holds the receipt; a second acknowledgment of the same entitlement is refused'
