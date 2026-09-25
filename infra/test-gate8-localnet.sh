#!/usr/bin/env bash
# Gate 8 on BitSafe LocalNet: drive the real backend (backend/src) over HTTP as
# signed-in users, the same calls the Live ledger UI makes.
#   - Throwaway accounts with random passwords are generated here, hashed, and
#     never printed; they are deleted at the end.
#   - The backend (backend/src from this repo) listens on loopback port 8787
#     with writes enabled, using Node 20+ if installed, otherwise the
#     node:22-alpine image with host networking (Linux). The ledger token
#     stays in a private temp file.
# Needs infra/setup-localnet.sh to have run on this LocalNet.
set -Eeuo pipefail
. "$(cd "$(dirname "$0")" && pwd)/localnet-env.sh"

API=$BASE:8787
ORIGIN=http://alluvren.gate8
APP_DIR=$REPO_DIR/backend
WORK=$(mktemp -d)
chmod 700 "$WORK"
BACKEND_PID=""
if command -v node >/dev/null 2>&1 && [[ $(node -p 'process.versions.node.split(".")[0]') -ge 20 ]]; then
  NODE_MODE=host
else
  NODE_MODE=docker
fi
# Runs node with APP and WORKD pointing at the backend and the private work dir.
run_node() {
  if [[ $NODE_MODE == host ]]; then
    APP=$APP_DIR WORKD=$WORK node "$@"
  else
    docker run --rm -v "$APP_DIR:/app:ro" -v "$WORK:/work" -e APP=/app -e WORKD=/work node:22-alpine node "$@"
  fi
}

RUN=g8-$(date +%s)
FUND_ID=$RUN
T='#alluvren-v1:Alluvren.Redemption'
pass() { echo "PASS: $*"; }
cleanup() {
  [[ -n $BACKEND_PID ]] && kill "$BACKEND_PID" >/dev/null 2>&1 || true
  docker rm -f alluvren-gate8 >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

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
cancel_proposal() {
  local state
  state=$(curl -fsS "$BASE:8083/governance/confirmations?party_id=$GOV" | jq -c --arg c "$1" 'first(.domain_actions[] | select(.proposal_cid==$c)) // {}')
  while IFS=$'\t' read -r conf party; do
    [[ -n $conf ]] || continue
    case "$party" in "$P1") port=8082 ;; "$P2") port=8081 ;; *) fail "no node mapping for $party" ;; esac
    dm_post "$port" /governance/cancel "$(jq -cn --arg p "$GOV" --arg c "$conf" '{party_id:$p,confirmation_cid:$c,governance_type:"core_domain"}')" | grep -q 'HTTP=200' || fail "cancel confirmation $conf"
  done < <(echo "$state" | jq -r '(.confirmations // [])[] | [.contract_id,.confirming_party] | @tsv')
  dm_post 8082 /governance/cancel-proposal "$(jq -cn --arg p "$GOV" --arg c "$1" '{party_id:$p,proposal_cid:$c}')" | grep -q 'HTTP=200' || fail "cancel proposal $1"
}

say "Setup: governed FundPolicy $FUND_ID and a 40%-funded batch (operator runbook)"
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
BATCH=$(ledger_submit batch "[\"$P1\"]" "$(jq -cn --arg gov "$GOV" --arg prop "$P1" --arg op "$OP" --arg coo "$COO" --arg t "$TREAS" --arg comp "$COMP" \
  --arg inv "$INV" --arg id "$RUN-b1" --arg pv "$FUND_ID@v1" --arg pol "$POLICY_CID" --arg dl "$DL" --arg tpl "$T:RedemptionBatch" '
  [{CreateCommand:{templateId:$tpl,createArguments:{governanceParty:$gov,proposer:$prop,operator:$op,fundReviewer:$coo,treasuryReviewer:$t,
    policyVersion:$pv,batchId:$id,rows:[{requestId:($id+"-r1"),investor:$inv,requestedUnits:"1000",allocatedUnits:"400"}],
    totalRequested:"1000",totalAllocated:"400",recoveryDeadline:$dl,policyCid:$pol,policyMembers:[$t,$coo,$comp],exceptions:null}}}]')" | created ':RedemptionBatch')
[[ -n $BATCH ]] || fail 'batch not created'
echo "policy=$POLICY_CID batch=$BATCH"

# --- throwaway accounts and the real backend ------------------------------
say 'Start the backend with throwaway accounts (passwords never printed)'
# The operator account acts as the batch proposer (node 2's member); each
# governance account is bound to the member hosted on its DecMan node.
jq -cn --arg p1 "$P1" --arg m1 "$MEMBER_1" --arg m2 "$MEMBER_2" --arg t "$TREAS" --arg coo "$COO" --arg comp "$COMP" --arg inv "$INV" '
  [{username:"operator",party:$p1,roles:["Operator"]},
   {username:"treasury",party:$t,roles:["TreasuryReviewer"]},
   {username:"coo",party:$coo,roles:["FinalSignoff"]},
   {username:"compliance",party:$comp,roles:["ComplianceReviewer"]},
   {username:"member-1",party:$m1,roles:["GovernanceMember"],decmanNode:"p1"},
   {username:"member-2",party:$m2,roles:["GovernanceMember"],decmanNode:"p2"},
   {username:"investor",party:$inv,roles:["Investor"]}]' > "$WORK/people.json"
run_node --input-type=module -e '
  import { readFileSync, writeFileSync } from "node:fs";
  import { randomBytes } from "node:crypto";
  import { join } from "node:path";
  import { pathToFileURL } from "node:url";
  const { hashPassword } = await import(pathToFileURL(join(process.env.APP, "src/auth.mjs")).href);
  const work = process.env.WORKD;
  const people = JSON.parse(readFileSync(join(work, "people.json"), "utf8"));
  const passwords = {}; const users = [];
  for (const p of people) {
    const pw = randomBytes(24).toString("base64url");
    passwords[p.username] = pw;
    users.push({ ...p, passwordHash: await hashPassword(pw) });
  }
  writeFileSync(join(work, "accounts.json"), JSON.stringify({ users }), { mode: 0o600 });
  writeFileSync(join(work, "passwords.json"), JSON.stringify(passwords), { mode: 0o600 });
'
umask 077
cat > "$WORK/backend.env" <<ENV
PORT=8787
ALLOWED_ORIGINS=$ORIGIN
DEC_MAN_URLS=p1=http://127.0.0.1:8081,p2=http://127.0.0.1:8082,p3=http://127.0.0.1:8083
GOVERNANCE_PARTY_ID=$GOV
RULES_CONTRACT_ID=$RULES
ALLUVREN_PACKAGE_REF=#alluvren-v1
ENVIRONMENT=LocalNet
LEDGER_JSON_API_URL=http://127.0.0.1:2975
LEDGER_TOKEN=$TOKEN
WRITES_ENABLED=true
RATE_LIMIT_PER_MINUTE=1000
ENV
if [[ $NODE_MODE == host ]]; then
  (set -a; . "$WORK/backend.env"; ACCOUNTS_FILE=$WORK/accounts.json; exec node "$APP_DIR/src/server.mjs") > "$WORK/backend.log" 2>&1 &
  BACKEND_PID=$!
else
  docker run -d --name alluvren-gate8 --network host -v "$APP_DIR:/app:ro" -v "$WORK:/work:ro" --env-file "$WORK/backend.env" \
    -e ACCOUNTS_FILE=/work/accounts.json node:22-alpine node /app/src/server.mjs >/dev/null
fi
for _ in $(seq 1 30); do curl -fsS "$API/healthz" >/dev/null 2>&1 && break; sleep 1; done
HEALTH=$(curl -fsS "$API/healthz")
[[ $(echo "$HEALTH" | jq -r '.writesEnabled') == true ]] || fail "backend not healthy with writes enabled: $HEALTH"
pass "backend healthy on loopback, writes enabled, nodes: $(echo "$HEALTH" | jq -c '[.nodes[].ok]')"

# --- HTTP client as each user ----------------------------------------------
declare -A CSRF
login() {
  local user=$1 body response
  body=$(jq -cn --arg u "$user" --slurpfile pw "$WORK/passwords.json" '{username:$u,password:$pw[0][$u]}')
  response=$(printf '%s' "$body" | curl -sS -c "$WORK/$user.jar" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d @- "$API/api/auth/login")
  CSRF[$user]=$(echo "$response" | jq -r '.csrfToken // empty')
  [[ -n ${CSRF[$user]} ]] || fail "login $user failed: $(echo "$response" | jq -c '.error')"
}
get() { curl -sS -b "$WORK/$1.jar" -w '\n%{http_code}' "$API$2"; }
post() { curl -sS -b "$WORK/$1.jar" -H "Origin: $ORIGIN" -H "x-alluvren-csrf: ${CSRF[$1]}" -H 'Content-Type: application/json' -w '\n%{http_code}' -d "$3" "$API$2"; }
code() { tail -n1 <<<"$1"; }
body() { sed '$d' <<<"$1"; }
expect() { [[ $(code "$1") == "$2" ]] || fail "$3: expected HTTP $2, got $(code "$1") $(body "$1" | head -c 300)"; }

say 'Sign in as every role'
for u in operator treasury coo compliance member-1 member-2 investor; do login "$u"; done
BAD=$(printf '%s' '{"username":"treasury","password":"not-the-password"}' | curl -sS -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -w '\n%{http_code}' -d @- "$API/api/auth/login")
expect "$BAD" 401 'wrong password'
pass 'all seven accounts signed in; wrong password refused'

say 'Requirements shown to staff; investors refused the batch list'
R=$(get treasury /api/workflow); expect "$R" 200 'treasury workflow'
STATUS=$(body "$R" | jq -c --arg b "$BATCH" '.batchStatus[$b]')
echo "$STATUS" | jq -c '{fundedBps, fundingThresholdBps, roles: [.roles[] | {role, met, conditional}]}'
[[ $(echo "$STATUS" | jq -r '[.roles[] | select(.role=="ComplianceReviewer" and .conditional and (.met|not))] | length') == 1 ]] || fail 'Compliance should be required and unmet'
expect "$(get investor /api/workflow)" 403 'investor workflow'
pass 'batch status computed from the live policy: Compliance required because funded 40%'

say 'Reviewers approve as themselves; wrong role and missing CSRF refused'
expect "$(post treasury /api/approvals "$(jq -cn --arg b "$BATCH" '{batchCid:$b,role:"FinalSignoff"}')")" 403 'treasury approving as COO'
NOCSRF=$(curl -sS -b "$WORK/treasury.jar" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -w '\n%{http_code}' -d "{\"batchCid\":\"$BATCH\",\"role\":\"TreasuryReviewer\"}" "$API/api/approvals")
expect "$NOCSRF" 403 'approval without CSRF'
R=$(post treasury /api/approvals "$(jq -cn --arg b "$BATCH" --arg forged "$COMP" '{batchCid:$b,role:"TreasuryReviewer",actAs:[$forged],reviewer:$forged}')"); expect "$R" 200 'treasury approval'
A_T=$(body "$R" | jq -r '.approvalCid')
R=$(post coo /api/approvals "$(jq -cn --arg b "$BATCH" '{batchCid:$b,role:"FinalSignoff"}')"); expect "$R" 200 'coo approval'
A_F=$(body "$R" | jq -r '.approvalCid')
MINE=$(body "$(get treasury /api/me/records)" | jq -r --arg a "$A_T" '[.approvals[] | select(.contractId==$a)] | length')
[[ $MINE == 1 ]] || fail 'treasury approval not recorded as its own (forged reviewer ignored?)'
pass "approvals created on-ledger as the signed-in reviewers ($A_T, $A_F); forged actAs ignored"

say 'Operator proposes without Compliance; members confirm; execution rejected with the Daml reason'
R=$(post operator /api/proposals/finalize "$(jq -cn --arg b "$BATCH" --arg a "$A_T" --arg f "$A_F" '{batchCid:$b,approvalCids:[$a,$f]}')"); expect "$R" 200 'first proposal'
PROP_A=$(body "$R" | jq -r '.proposalCid')
confirm_as() {
  local r
  for _ in $(seq 1 10); do
    r=$(post "$1" /api/governance/confirm "$(jq -cn --arg p "$2" --arg node p3 '{proposalCid:$p,node:$node}')")
    [[ $(code "$r") == 404 ]] || break; sleep 2
  done
  expect "$r" 200 "$1 confirm"
}
confirm_as member-1 "$PROP_A"; confirm_as member-2 "$PROP_A"
R=$(post member-1 /api/governance/execute "$(jq -cn --arg p "$PROP_A" '{proposalCid:$p}')")
expect "$R" 409 'execution without Compliance'
[[ $(body "$R" | jq -r '.error') == 'Missing required approvals for role ComplianceReviewer' ]] || fail "unexpected reason: $(body "$R")"
[[ $(body "$(get investor /api/me/records)" | jq '.entitlements | length') == 0 ]] || fail 'rejected finalization created investor records'
pass 'BitSafe threshold reached, then the ledger rejected it: "Missing required approvals for role ComplianceReviewer"'
cancel_proposal "$PROP_A"

say 'Compliance approves; governed finalization succeeds through the backend'
R=$(post compliance /api/approvals "$(jq -cn --arg b "$BATCH" '{batchCid:$b,role:"ComplianceReviewer"}')"); expect "$R" 200 'compliance approval'
A_C=$(body "$R" | jq -r '.approvalCid')
for _ in $(seq 1 10); do
  STATUS=$(body "$(get coo /api/workflow)" | jq -c --arg b "$BATCH" '.batchStatus[$b]')
  [[ $(echo "$STATUS" | jq -r '.complete') == true ]] && break; sleep 2
done
[[ $(echo "$STATUS" | jq -r '.complete') == true ]] || fail "batch should now be complete: $(echo "$STATUS" | jq -c '[.roles[] | {role, met, approvals}]')"
R=$(post operator /api/proposals/finalize "$(jq -cn --arg b "$BATCH" --arg a "$A_T" --arg f "$A_F" --arg c "$A_C" '{batchCid:$b,approvalCids:[$a,$f,$c]}')"); expect "$R" 200 'second proposal'
PROP_B=$(body "$R" | jq -r '.proposalCid')
confirm_as member-1 "$PROP_B"
expect "$(post member-1 /api/governance/execute "$(jq -cn --arg p "$PROP_B" '{proposalCid:$p}')")" 409 'execute below threshold'
confirm_as member-2 "$PROP_B"
R=$(post member-1 /api/governance/execute "$(jq -cn --arg p "$PROP_B" '{proposalCid:$p}')"); expect "$R" 200 'execution with Compliance'
pass 'below-threshold execute refused; after two confirmations the finalization executed'

say 'Investor sees only their records and acts once'
R=$(get investor /api/me/records); expect "$R" 200 'investor records'
ENT=$(body "$R" | jq -r --arg id "$RUN-b1" '.entitlements[] | select(.batchId==$id) | "\(.contractId) \(.units)"')
OUT=$(body "$R" | jq -r --arg id "$RUN-b1" '.outstanding[] | select(.batchId==$id) | "\(.contractId) \(.units)"')
[[ ${ENT#* } == 400 && ${OUT#* } == 600 ]] || fail "unexpected records: $ENT / $OUT"
expect "$(post treasury /api/claims/acknowledge "$(jq -cn --arg c "${ENT%% *}" '{entitlementCid:$c}')")" 403 'staff acknowledging for the investor'
expect "$(post investor /api/claims/acknowledge "$(jq -cn --arg c "${ENT%% *}" '{entitlementCid:$c}')")" 200 'acknowledge'
expect "$(post investor /api/claims/acknowledge "$(jq -cn --arg c "${ENT%% *}" '{entitlementCid:$c}')")" 404 'second acknowledge'
expect "$(post investor /api/outstanding/withdraw "$(jq -cn --arg c "${OUT%% *}" '{outstandingCid:$c}')")" 200 'withdraw'
pass "investor acknowledged 400 and withdrew 600 units once; repeat and staff attempts refused"

say 'Sign-out ends the session'
expect "$(post investor /api/auth/logout '{}')" 200 'logout'
expect "$(get investor /api/auth/me)" 401 'after logout'
pass 'session invalidated'

echo
echo "Alluvren Gate 8 LocalNet run passed. run=$RUN policy=$POLICY_CID batch=$BATCH rejected_proposal=$PROP_A executed_proposal=$PROP_B"
