# Sourced by the Alluvren LocalNet scripts. Every ID is discovered from the
# running BitSafe LocalNet (DecMan `hackathon` kit after up.sh and seed.sh) and
# from `setup-localnet.sh`; nothing is specific to one machine.
#
# Topology fixed by the kit:
#   node 1  DecMan :8081  participant app-provider  JSON Ledger API :3975
#   node 2  DecMan :8082  participant app-user      JSON Ledger API :2975
#   node 3  DecMan :8083  participant sv            JSON Ledger API :4975
# Alluvren's business parties (operator, reviewers, investors) are allocated
# on node 2, and the scripts submit through node 2's JSON Ledger API.
#
# Environment overrides:
#   DECMAN_DIR    DecMan checkout (for the LocalNet dev token); default: a
#                 `decentralization-manager` folder next to or inside this repo
#   LEDGER_TOKEN  token for the JSON Ledger API instead of reading it from DECMAN_DIR
#   PARTY_PREFIX  decentralized party prefix used with seed.sh (default demo-party)

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$INFRA_DIR/.." && pwd)"
BASE=${LOCALNET_BASE:-http://127.0.0.1}
JSON_API=$BASE:2975
PARTY_PREFIX=${PARTY_PREFIX:-demo-party}
ALLUVREN_DAR="$REPO_DIR/artifacts/alluvren-v1-0.4.0.dar"
ALLUVREN_PACKAGE_ID=564cef4f541a96c6616b1ec99ecc49177ef91d0de690ae23bcd354e20f7d1315
# Institutional business parties: variable -> party ID hint on node 2.
ALLUVREN_HINTS="OP=alluvren-operator TREAS=alluvren-treasury COO=alluvren-coo COMP=alluvren-compliance"
# Investors are pseudonymous: random party IDs (inv-<random hex>) that say
# nothing about who they are. The only link to a label is an annotation in
# node 2's local party metadata, which Canton keeps on that participant and
# never shares with other nodes (in production, the transfer agent's register).
# Variable -> label.
ALLUVREN_INVESTORS="INV_A=investor-a INV_B=investor-b"
INVESTOR_LABEL_KEY=alluvren.dev/investor

fail() { echo "FAIL: $*" >&2; exit 1; }
say() { printf '\n== %s ==\n' "$*"; }
uid() { printf '%s%s%s' "$(date +%s)" "$RANDOM" "$RANDOM"; }
# ISO-8601 UTC time N minutes from now (GNU and BSD date).
iso_in() { date -u -d "+$1 minutes" +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || date -u -v+"$1"M +%Y-%m-%dT%H:%M:%S.000Z; }

for tool in curl jq docker; do command -v "$tool" >/dev/null 2>&1 || fail "missing required tool: $tool"; done

if [[ -z ${LEDGER_TOKEN:-} ]]; then
  for dir in "${DECMAN_DIR:-}" "$REPO_DIR/../decentralization-manager" "$REPO_DIR/decentralization-manager"; do
    [[ -n $dir && -f $dir/hackathon/localnet.sh ]] || continue
    LEDGER_TOKEN=$(sed -n 's/^LOCALNET_CANTON_TOKEN="\(.*\)"$/\1/p' "$dir/hackathon/localnet.sh")
    break
  done
fi
[[ -n ${LEDGER_TOKEN:-} ]] || fail 'LocalNet token not found: set DECMAN_DIR to your decentralization-manager checkout (or LEDGER_TOKEN)'
TOKEN=$LEDGER_TOKEN

node_port() { echo $((8080 + $1)); }
json_port() { case $1 in 1) echo 3975 ;; 2) echo 2975 ;; 3) echo 4975 ;; esac; }
namespace() { printf '%s' "${1##*::}"; }

# --- discovery ---------------------------------------------------------------
for n in 1 2 3; do
  curl -fsS -m 10 "$BASE:$(node_port "$n")/healthz" >/dev/null 2>&1 \
    || fail "DecMan node $n is not answering on $(node_port "$n"); start LocalNet with the kit's up.sh"
done
GOV=$(curl -fsS "$BASE:8081/decentralized-parties" \
  | jq -r --arg p "$PARTY_PREFIX" 'first(.parties[]? | select(.party_id | startswith($p + "::")) | .party_id) // empty')
[[ -n $GOV ]] || fail "no decentralized party with prefix $PARTY_PREFIX; run the kit's seed.sh"
GOV_STATE=$(curl -fsS "$BASE:8081/governance/state?party_id=$GOV")
RULES=$(jq -r '.state.contract_id // empty' <<<"$GOV_STATE")
[[ -n $RULES ]] || fail 'GovernanceRules not deployed; run the kit seed.sh'
for n in 1 2 3; do
  pid=$(curl -fsS "$BASE:$(node_port "$n")/node-config" | jq -r '.node.participant_id')
  member=$(jq -r --arg ns "$(namespace "$pid")" 'first(.state.members[] | select(endswith("::" + $ns))) // empty' <<<"$GOV_STATE")
  [[ -n $member ]] || fail "no governance member hosted on node $n ($pid)"
  printf -v "PARTICIPANT_$n" '%s' "$pid"
  printf -v "MEMBER_$n" '%s' "$member"
done
NODE2_NS=$(namespace "$PARTICIPANT_2")
# Names used by the scripts: P1 is node 2's member (it proposes and is hosted
# with the business parties), P2 is node 1's, P3 is node 3's.
P1=$MEMBER_2; P2=$MEMBER_1; P3=$MEMBER_3
# The governance member hosted on a DecMan node's participant cancels there.
member_port() { case $1 in "$MEMBER_1") echo 8081 ;; "$MEMBER_2") echo 8082 ;; "$MEMBER_3") echo 8083 ;; *) return 1 ;; esac; }

ledger_get() { curl -sS -H "Authorization: Bearer $TOKEN" "$JSON_API$1"; }
party_exists() { ledger_get "/v2/parties/$1" | jq -e --arg p "$1" '[.. | objects | select(.party? == $p)] | length > 0' >/dev/null 2>&1; }

# Parties local to node 2 with their local metadata, across result pages.
node2_parties() {
  local token="" page
  while :; do
    page=$(ledger_get "/v2/parties?pageSize=1000${token:+&pageToken=$token}")
    jq -c '.partyDetails[]? | select(.isLocal)' <<<"$page"
    token=$(jq -r '.nextPageToken // empty' <<<"$page")
    [[ -n $token ]] || break
  done
}
# The pseudonymous party node 2 has labelled as this investor, if any.
investor_party() {
  node2_parties | jq -r --arg k "$INVESTOR_LABEL_KEY" --arg l "$1" 'select(.localMetadata.annotations[$k]? == $l) | .party' | head -1
}

load_business_parties() {
  local pair var hint id missing=""
  for pair in $ALLUVREN_HINTS; do
    var=${pair%%=*}; hint=${pair#*=}; id="$hint::$NODE2_NS"
    if party_exists "$id"; then printf -v "$var" '%s' "$id"; else missing="$missing $hint"; fi
  done
  for pair in $ALLUVREN_INVESTORS; do
    var=${pair%%=*}; id=$(investor_party "${pair#*=}")
    if [[ -n $id ]]; then printf -v "$var" '%s' "$id"; else missing="$missing ${pair#*=}"; fi
  done
  [[ -z $missing ]] || return 1
  FUND=$COO; INV=$INV_A
  BUSINESS_PARTIES=("$OP" "$TREAS" "$COO" "$COMP" "$INV_A" "$INV_B")
}

if [[ ${ALLUVREN_SETUP:-0} != 1 ]]; then
  load_business_parties || fail 'Alluvren parties not found on node 2; run infra/setup-localnet.sh first'
  for n in 1 2 3; do
    curl -fsS "$BASE:$(node_port "$n")/packages/vetted" | grep -q "$ALLUVREN_PACKAGE_ID" \
      || fail "alluvren-v1 0.4.0 is not vetted on node $n; run infra/setup-localnet.sh first"
  done
fi

# Runs a Canton console script against the three participants' admin APIs
# (node1/node2/node3) inside the LocalNet `canton` container. Lines the script
# prints starting with RESULT are returned. If it prints none (a compile error
# or an unreachable participant), the console's own errors are shown and it
# returns 1.
canton_console() {
  local out
  docker exec -i canton sh -c 'mkdir -p /tmp/alluvren-console && cat > /tmp/alluvren-console/remote.conf' <<'CONF'
canton.remote-participants {
  node1 { admin-api { address = "127.0.0.1", port = 3902 }, ledger-api { address = "127.0.0.1", port = 3901 } }
  node2 { admin-api { address = "127.0.0.1", port = 2902 }, ledger-api { address = "127.0.0.1", port = 2901 } }
  node3 { admin-api { address = "127.0.0.1", port = 4902 }, ledger-api { address = "127.0.0.1", port = 4901 } }
}
CONF
  printf '%s\n' "$1" | docker exec -i canton sh -c 'cat > /tmp/alluvren-console/cmd.sc'
  # Right after up.sh the console can come back empty; scripts passed here are
  # safe to repeat (reads, connect/disconnect, or changes the caller verifies).
  local attempt
  for attempt in 1 2 3; do
    out=$(docker exec canton /app/bin/canton run /tmp/alluvren-console/cmd.sc -c /tmp/alluvren-console/remote.conf 2>&1 || true)
    if grep -q '^RESULT' <<<"$out"; then
      grep '^RESULT' <<<"$out"
      return 0
    fi
    (( attempt < 3 )) && sleep 15
  done
  echo 'Canton console produced no result after 3 attempts:' >&2
  grep -vE '\|-(INFO|WARN)|^Picked up' <<<"$out" | tail -15 >&2
  return 1
}
# Waits until a node's JSON Ledger API answers (it can lag behind DecMan after up.sh).
wait_json_api() {
  local _
  for _ in $(seq 1 60); do
    curl -fsS -m 5 -H "Authorization: Bearer $TOKEN" "$BASE:$(json_port "$1")/v2/state/ledger-end" >/dev/null 2>&1 && return 0
    sleep 3
  done
  fail "node $1's JSON Ledger API (port $(json_port "$1")) is not answering"
}
# Whether a participant's JSON Ledger API reports the party as hosted there.
hosted_on() { curl -sS -H "Authorization: Bearer $TOKEN" "$BASE:$(json_port "$1")/v2/parties/$2" | jq -e '.partyDetails[0].isLocal == true' >/dev/null 2>&1; }
grant_rights() {
  curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "$BASE:$(json_port "$1")/v2/users/ledger-api-user/rights" \
    -d "$(jq -cn --arg p "$2" '{userId:"ledger-api-user",identityProviderId:"",rights:[{kind:{CanActAs:{value:{party:$p}}}},{kind:{CanReadAs:{value:{party:$p}}}}]}')" >/dev/null
}
