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
ALLUVREN_DAR="$REPO_DIR/artifacts/alluvren-v1-0.3.0.dar"
ALLUVREN_PACKAGE_ID=b2dcd98664024d1d872a6ec027e685400bfb568c0a6df35cf7322a333494a72d
# Business parties: role -> party ID hint on node 2.
ALLUVREN_HINTS="OP=alluvren-operator TREAS=alluvren-treasury COO=alluvren-coo COMP=alluvren-compliance INV_A=alluvren-investor-a INV_B=alluvren-investor-b"

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

load_business_parties() {
  local pair var hint id missing=""
  for pair in $ALLUVREN_HINTS; do
    var=${pair%%=*}; hint=${pair#*=}; id="$hint::$NODE2_NS"
    if party_exists "$id"; then printf -v "$var" '%s' "$id"; else missing="$missing $hint"; fi
  done
  [[ -z $missing ]] || return 1
  FUND=$COO; INV=$INV_A
}

if [[ ${ALLUVREN_SETUP:-0} != 1 ]]; then
  load_business_parties || fail 'Alluvren parties not found on node 2; run infra/setup-localnet.sh first'
  for n in 1 2 3; do
    curl -fsS "$BASE:$(node_port "$n")/packages/vetted" | grep -q "$ALLUVREN_PACKAGE_ID" \
      || fail "alluvren-v1 0.3.0 is not vetted on node $n; run infra/setup-localnet.sh first"
  done
fi
