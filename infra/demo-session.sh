#!/usr/bin/env bash
# Sets up a recording session of the Live ledger on BitSafe LocalNet.
#
#   bash infra/demo-session.sh start   start the backend and seed a scenario
#   bash infra/demo-session.sh stop    stop the backend and delete the demo accounts
#
# start:
#   - Runs Alluvren's backend on this machine's loopback port 8787 with writes
#     enabled, using Node 20+ if installed, otherwise node:22-alpine (Linux).
#     Browsers reach it through the frontend dev server's proxy, e.g. through an
#     SSH tunnel to port 8787 plus `npm run dev` on the laptop.
#   - Withdraws the operator's leftover proposals and archives open batches
#     and books from earlier sessions, and allocates two fresh investors, so
#     the recording starts from a clean screen.
#   - Creates one account per role with a random password. The passwords are
#     written only to $DEMO_DIR/credentials.txt (default ~/.alluvren-demo),
#     readable by this user alone, and never printed.
#   - Seeds a governed fund policy (Northstar: Treasury and COO always,
#     Compliance when a batch is under 50% funded), a 40%-funded batch that
#     needs Compliance, and a sealed batch whose rows sit in the operator's
#     private allocation book.
# Needs infra/setup-localnet.sh to have run on this LocalNet.
set -Eeuo pipefail
. "$(cd "$(dirname "$0")" && pwd)/localnet-env.sh"

DEMO_DIR=${DEMO_DIR:-$HOME/.alluvren-demo}
CONTAINER=alluvren-demo
APP_DIR=$REPO_DIR/backend
T='#alluvren-v1:Alluvren.Redemption'
TS='#alluvren-v1:Alluvren.Sealed'
FUND_ID=northstar

stop_backend() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  if [[ -f $DEMO_DIR/backend.pid ]]; then kill "$(cat "$DEMO_DIR/backend.pid")" >/dev/null 2>&1 || true; fi
}

if [[ ${1:-} == stop ]]; then
  stop_backend
  rm -rf "$DEMO_DIR"
  echo "Demo backend stopped and demo accounts deleted. Seeded contracts stay on the ledger."
  exit 0
fi
[[ ${1:-} == start ]] || { echo "usage: bash infra/demo-session.sh start|stop" >&2; exit 2; }

# --- ledger and DecMan helpers -----------------------------------------------
ledger_submit() {
  local body
  body=$(jq -cn --arg id "demo-$1-$(uid)" --argjson actors "$2" --argjson commands "$3" \
    '{commands:{userId:"ledger-api-user",commandId:$id,actAs:$actors,commands:$commands}}')
  curl -fsS "$JSON_API/v2/commands/submit-and-wait-for-transaction" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$body"
}
created() { jq -r --arg t "$1" '.transaction.events[] | (.CreatedEvent // empty) | select(.templateId | endswith($t)) | .contractId'; }
active() {
  local offset
  offset=$(curl -fsS "$JSON_API/v2/state/ledger-end" -H "Authorization: Bearer $TOKEN" | jq -r '.offset')
  curl -fsS "$JSON_API/v2/state/active-contracts" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "$(jq -cn --arg p "$1" --argjson off "$offset" '{filter:{filtersByParty:{($p):{cumulative:[{identifierFilter:{WildcardFilter:{value:{includeCreatedEventBlob:false}}}}]}}},verbose:false,activeAtOffset:$off}')" \
    | jq -c '.. | objects | select(has("createdEvent")) | .createdEvent'
}
dm_post() { curl -sS -w '\nHTTP=%{http_code}\n' -X POST "$BASE:$1$2" -H 'Content-Type: application/json' -d "$3"; }
governed() {
  local cid=$1 cids
  for port in 8081 8082; do
    dm_post "$port" /governance/confirm "$(jq -cn --arg p "$GOV" --arg r "$RULES" --arg c "$cid" \
      '{party_id:$p,rules_contract_id:$r,action:{type:"governance_set_threshold",new_threshold:0},governance_type:"core_domain",proposal_cid:$c}')" \
      | grep -q 'HTTP=200' || fail "DecMan confirm on $port failed"
    sleep 1
  done
  cids=$(curl -fsS "$BASE:8083/governance/confirmations?party_id=$GOV" | jq -c --arg c "$cid" 'first(.domain_actions[] | select(.proposal_cid==$c)) | [.confirmations[].contract_id]')
  dm_post 8083 /governance/execute "$(jq -cn --arg p "$GOV" --arg r "$RULES" --arg c "$cid" --argjson cids "$cids" \
    '{party_id:$p,rules_contract_id:$r,action:{type:"governance_set_threshold",new_threshold:0},confirmation_cids:$cids,disclosed_contracts:[],governance_type:"core_domain",proposal_cid:$c}')" \
    | grep -q 'HTTP=200' || fail 'governed execution failed'
}
sha256_hex() { (sha256sum 2>/dev/null || shasum -a 256) | awk '{print $1}'; }
# Canonical text of Alluvren.Sealed.sealedRowsText (see test-sealed-localnet.sh).
sealed_text() {
  local salt=$1; shift
  printf '%s' "$salt"
  printf '%s\n' "$@" | LC_ALL=C sort | while IFS= read -r line; do printf '\n%s' "$line"; done
}

# --- demo accounts and the backend ------------------------------------------
say 'Session investors'
# Two fresh pseudonymous investors per session (node 2, labelled for this
# session only), so investor pages show only this session's records.
STAMP=$(date -u +%m%d%H%M%S)
alloc_investor() {
  local label="session-$STAMP-$1" hint body id
  hint="inv-$(od -An -N8 -tx1 /dev/urandom | tr -dc '0-9a-f')"
  body=$(jq -cn --arg h "$hint" --arg k "$INVESTOR_LABEL_KEY" --arg l "$label" \
    '{partyIdHint:$h, identityProviderId:"", localMetadata:{resourceVersion:"", annotations:{($k):$l}}}')
  curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "$JSON_API/v2/parties" -d "$body" >/dev/null
  id=$(investor_party "$label")
  [[ -n $id ]] || fail "could not allocate the session investor $1"
  grant_rights 2 "$id"
  printf '%s' "$id"
}
INV_A=$(alloc_investor a)
INV_B=$(alloc_investor b)
echo "investor-a and investor-b are new pseudonymous parties for this session"

say 'Demo accounts and backend'
stop_backend
rm -rf "$DEMO_DIR"; mkdir -p "$DEMO_DIR"; chmod 700 "$DEMO_DIR"
if command -v node >/dev/null 2>&1 && [[ $(node -p 'process.versions.node.split(".")[0]') -ge 20 ]]; then NODE_MODE=host; else NODE_MODE=docker; fi
run_node() {
  if [[ $NODE_MODE == host ]]; then
    APP=$APP_DIR WORKD=$DEMO_DIR node "$@"
  else
    docker run --rm --user "$(id -u):$(id -g)" -v "$APP_DIR:/app:ro" -v "$DEMO_DIR:/work" -e APP=/app -e WORKD=/work node:22-alpine node "$@"
  fi
}
jq -cn --arg op "$OP" --arg t "$TREAS" --arg coo "$COO" --arg comp "$COMP" --arg m1 "$MEMBER_1" --arg m2 "$MEMBER_2" --arg a "$INV_A" --arg b "$INV_B" '
  [{username:"operator",party:$op,roles:["Operator"]},
   {username:"treasury",party:$t,roles:["TreasuryReviewer"]},
   {username:"coo",party:$coo,roles:["FinalSignoff"]},
   {username:"compliance",party:$comp,roles:["ComplianceReviewer"]},
   {username:"member-1",party:$m1,roles:["GovernanceMember"],decmanNode:"p1"},
   {username:"member-2",party:$m2,roles:["GovernanceMember"],decmanNode:"p2"},
   {username:"investor-a",party:$a,roles:["Investor"]},
   {username:"investor-b",party:$b,roles:["Investor"]}]' > "$DEMO_DIR/people.json"
run_node --input-type=module -e '
  import { readFileSync, writeFileSync } from "node:fs";
  import { randomBytes } from "node:crypto";
  import { join } from "node:path";
  import { pathToFileURL } from "node:url";
  const { hashPassword } = await import(pathToFileURL(join(process.env.APP, "src/auth.mjs")).href);
  const work = process.env.WORKD;
  const people = JSON.parse(readFileSync(join(work, "people.json"), "utf8"));
  const users = []; const lines = [];
  for (const p of people) {
    const pw = randomBytes(9).toString("base64url");
    users.push({ ...p, passwordHash: await hashPassword(pw) });
    lines.push(`${p.username.padEnd(12)} ${pw}   ${p.roles.join(", ")}`);
  }
  writeFileSync(join(work, "accounts.json"), JSON.stringify({ users }), { mode: 0o600 });
  writeFileSync(join(work, "credentials.txt"), ["Alluvren demo accounts (LocalNet only; deleted by demo-session.sh stop)", "", ...lines, ""].join("\n"), { mode: 0o600 });
'
(umask 077; cat > "$DEMO_DIR/backend.env" <<ENV
PORT=8787
ALLOWED_ORIGINS=http://127.0.0.1:5173,http://localhost:5173
DEC_MAN_URLS=p1=http://127.0.0.1:8081,p2=http://127.0.0.1:8082,p3=http://127.0.0.1:8083
GOVERNANCE_PARTY_ID=$GOV
RULES_CONTRACT_ID=$RULES
ALLUVREN_PACKAGE_REF=#alluvren-v1
ENVIRONMENT=LocalNet
LEDGER_JSON_API_URL=http://127.0.0.1:2975,http://127.0.0.1:3975
LEDGER_TOKEN=$TOKEN
WRITES_ENABLED=true
# Every browser request arrives through one tunnel, from one address.
RATE_LIMIT_PER_MINUTE=600
ENV
)
if [[ $NODE_MODE == host ]]; then
  (set -a; . "$DEMO_DIR/backend.env"; ACCOUNTS_FILE=$DEMO_DIR/accounts.json; exec node "$APP_DIR/src/server.mjs") > "$DEMO_DIR/backend.log" 2>&1 &
  echo $! > "$DEMO_DIR/backend.pid"
else
  docker run -d --name "$CONTAINER" --network host --user "$(id -u):$(id -g)" -v "$APP_DIR:/app:ro" -v "$DEMO_DIR:/work:ro" \
    --env-file "$DEMO_DIR/backend.env" -e ACCOUNTS_FILE=/work/accounts.json node:22-alpine node /app/src/server.mjs >/dev/null
fi
for _ in $(seq 1 30); do curl -fsS "$BASE:8787/healthz" >/dev/null 2>&1 && break; sleep 1; done
[[ $(curl -fsS "$BASE:8787/healthz" | jq -r '.writesEnabled') == true ]] || fail 'backend did not start with writes enabled'
echo "backend on 127.0.0.1:8787 (writes enabled); 8 accounts; passwords in $DEMO_DIR/credentials.txt"

# --- scenario -----------------------------------------------------------------
say 'Clean slate'
# Withdraw the operator's open proposals (members cancel their confirmations on
# their own nodes, then the operator archives the proposal) and archive open
# batches and allocation books left from earlier sessions.
withdrawn=0
while IFS=$'\t' read -r cid label; do
  [[ -n $cid ]] || continue
  while IFS=$'\t' read -r conf party; do
    [[ -n $conf ]] || continue
    port=$(member_port "$party") || continue
    dm_post "$port" /governance/cancel "$(jq -cn --arg p "$GOV" --arg c "$conf" '{party_id:$p,confirmation_cid:$c,governance_type:"core_domain"}')" >/dev/null
  done < <(curl -fsS "$BASE:8083/governance/confirmations?party_id=$GOV" | jq -r --arg c "$cid" 'first(.domain_actions[] | select(.proposal_cid==$c)) | (.confirmations // [])[] | [.contract_id, .confirming_party] | @tsv')
  ledger_submit withdraw "[\"$OP\"]" "$(jq -cn --arg c "$cid" --arg t "$T:$label" '[{ExerciseCommand:{templateId:$t,contractId:$c,choice:"Archive",choiceArgument:{}}}]')" >/dev/null \
    && withdrawn=$((withdrawn + 1))
done < <(curl -fsS "$BASE:8083/governance/confirmations?party_id=$GOV" \
  | jq -r --arg op "$OP" '.domain_actions[] | select(.proposer==$op and (.action_label=="FinalizePolicyRedemption" or .action_label=="UpdateFundPolicy")) | [.proposal_cid, .action_label] | @tsv')
archived=0
while IFS=$'\t' read -r cid tpl; do
  [[ -n $cid ]] || continue
  ledger_submit archive "[\"$OP\"]" "$(jq -cn --arg c "$cid" --arg t "$tpl" '[{ExerciseCommand:{templateId:$t,contractId:$c,choice:"Archive",choiceArgument:{}}}]')" >/dev/null \
    && archived=$((archived + 1))
done < <(active "$OP" | jq -r --arg op "$OP" --arg tr "$T:RedemptionBatch" --arg tb "$TS:AllocationBook" '
  select((.templateId | endswith(":RedemptionBatch")) and .createArgument.proposer == $op) // select((.templateId | endswith(":AllocationBook")) and .createArgument.operator == $op)
  | [.contractId, (if (.templateId | endswith(":RedemptionBatch")) then $tr else $tb end)] | @tsv')
echo "withdrew $withdrawn open proposal(s); archived $archived open batch(es) and book(s)"

say 'Northstar fund policy'
POLICY_CID=$(active "$COO" | jq -r --arg f "$FUND_ID" 'select(.templateId | endswith(":FundPolicy")) | select(.createArgument.fundId==$f) | .contractId' | head -1)
if [[ -n $POLICY_CID ]]; then
  echo "reusing the governed policy $FUND_ID@v1"
else
  POLICY=$(jq -cn --arg gov "$GOV" --arg op "$OP" --arg f "$FUND_ID" --arg t "$TREAS" --arg coo "$COO" --arg comp "$COMP" '
    {governanceParty:$gov,operator:$op,fundId:$f,version:"1",
     base:[{role:"TreasuryReviewer",members:[$t],quorum:"1"},{role:"FinalSignoff",members:[$coo],quorum:"1"}],
     conditional:[{trigger:{tag:"FundedBelowBps",value:"5000"},requirement:{role:"ComplianceReviewer",members:[$comp],quorum:"1"}}]}')
  UPD=$(ledger_submit policy "[\"$OP\"]" "$(jq -cn --arg gov "$GOV" --arg op "$OP" --argjson pol "$POLICY" --arg t "$T:UpdateFundPolicy" \
    '[{CreateCommand:{templateId:$t,createArguments:{governanceParty:$gov,proposer:$op,currentPolicyCid:null,newPolicy:$pol,description:"Northstar redemption policy v1"}}}]')" | created ':UpdateFundPolicy')
  governed "$UPD"
  for _ in $(seq 1 10); do
    POLICY_CID=$(active "$COO" | jq -r --arg f "$FUND_ID" 'select(.templateId | endswith(":FundPolicy")) | select(.createArgument.fundId==$f) | .contractId' | head -1)
    [[ -n $POLICY_CID ]] && break; sleep 2
  done
  [[ -n $POLICY_CID ]] || fail 'policy not visible'
  echo "governed policy $FUND_ID@v1 created (members on nodes 1 and 2 confirmed)"
fi

# The next free batch names: window-12, window-13, ... A name counts as used if
# any record anyone in the demo can see mentions it (receipts outlive batches).
USED=$(for p in "$OP" "$GOV" "$INV_A" "$INV_B"; do active "$p"; done \
  | jq -r '(.createArgument.batchId? // empty), (.createArgument.target.batchId? // empty), ((.createArgument.description? // "") | scan("window-[0-9]+"))' | sort -u)
next_window() {
  local n=$1
  while grep -qxF "window-$n" <<<"$USED"; do n=$((n + 1)); done
  printf 'window-%s' "$n"
}
DL=$(iso_in 180)
PV="$FUND_ID@v1"

say 'A 40%-funded batch (Compliance required)'
B1=$(next_window 12)
BATCH1=$(ledger_submit batch "[\"$OP\"]" "$(jq -cn --arg gov "$GOV" --arg op "$OP" --arg coo "$COO" --arg t "$TREAS" --arg comp "$COMP" \
  --arg a "$INV_A" --arg b "$INV_B" --arg id "$B1" --arg pv "$PV" --arg pol "$POLICY_CID" --arg dl "$DL" --arg tpl "$T:RedemptionBatch" '
  [{CreateCommand:{templateId:$tpl,createArguments:{governanceParty:$gov,proposer:$op,operator:$op,fundReviewer:$coo,treasuryReviewer:$t,
    policyVersion:$pv,batchId:$id,
    rows:[{requestId:($id+"-a"),investor:$a,requestedUnits:"600",allocatedUnits:"240"},{requestId:($id+"-b"),investor:$b,requestedUnits:"400",allocatedUnits:"160"}],
    totalRequested:"1000",totalAllocated:"400",recoveryDeadline:$dl,policyCid:$pol,policyMembers:[$t,$coo,$comp],exceptions:null,sealed:null}}}]')" | created ':RedemptionBatch')
[[ -n $BATCH1 ]] || fail 'batch not created'
echo "$B1: 1,000 requested, 400 available (40%): investor A 240 of 600, investor B 160 of 400"

say 'A sealed batch (rows only in the operator’s book)'
B2=$(next_window $(( ${B1#window-} + 1 )))
SALT=$(od -An -N16 -tx1 /dev/urandom | tr -dc '0-9a-f')
ROW_A="$B2-a|$INV_A|600|300"
ROW_B="$B2-b|$INV_B|400|200"
COMMITMENT=$(sealed_text "$SALT" "$ROW_A" "$ROW_B" | sha256_hex)
ROWS=$(jq -cn --arg a "$INV_A" --arg b "$INV_B" --arg id "$B2" '[
  {requestId:($id+"-a"),investor:$a,requestedUnits:"600",allocatedUnits:"300"},
  {requestId:($id+"-b"),investor:$b,requestedUnits:"400",allocatedUnits:"200"}]')
ledger_submit book "[\"$OP\"]" "$(jq -cn --arg op "$OP" --arg gov "$GOV" --arg id "$B2" --arg pv "$PV" --arg salt "$SALT" --argjson rows "$ROWS" --arg t "$TS:AllocationBook" \
  '[{CreateCommand:{templateId:$t,createArguments:{operator:$op,governanceParty:$gov,batchId:$id,policyVersion:$pv,salt:$salt,rows:$rows}}}]')" | created ':AllocationBook' | grep -q . || fail 'book not created'
BATCH2=$(ledger_submit sealed "[\"$OP\"]" "$(jq -cn --arg gov "$GOV" --arg op "$OP" --arg coo "$COO" --arg t "$TREAS" --arg comp "$COMP" \
  --arg id "$B2" --arg pv "$PV" --arg pol "$POLICY_CID" --arg dl "$DL" --arg c "$COMMITMENT" --arg tpl "$T:RedemptionBatch" '
  [{CreateCommand:{templateId:$tpl,createArguments:{governanceParty:$gov,proposer:$op,operator:$op,fundReviewer:$coo,treasuryReviewer:$t,
    policyVersion:$pv,batchId:$id,rows:[],totalRequested:"1000",totalAllocated:"500",recoveryDeadline:$dl,
    policyCid:$pol,policyMembers:[$t,$coo,$comp],exceptions:null,
    sealed:{commitment:$c,rowCount:"2",maxRowAllocatedUnits:"300"}}}}]')" | created ':RedemptionBatch')
[[ -n $BATCH2 ]] || fail 'sealed batch not created'
echo "$B2: 1,000 requested, 500 available (50%), sealed; commitment ${COMMITMENT:0:12}…"

say 'Ready to record'
cat <<TXT
Backend:      127.0.0.1:8787 on this machine (open a tunnel to it; see the video script)
Accounts:     operator, treasury, coo, compliance, member-1, member-2, investor-a, investor-b
Passwords:    $DEMO_DIR/credentials.txt
Batches:      $B1 (needs Compliance), $B2 (sealed); both open for 3 hours
Approvals:    each approval is valid for 30 minutes once given
When done:    bash infra/demo-session.sh stop
TXT
