#!/usr/bin/env bash
# One-time Alluvren setup on a BitSafe LocalNet started with the DecMan
# `hackathon` kit (up.sh, then seed.sh). Safe to re-run.
#   1. Checks the Alluvren DAR against artifacts/SHA256SUMS.txt.
#   2. Distributes it through DecMan to all three participants (skipped if vetted).
#   3. Allocates the business parties on node 2 and lets the kit's
#      ledger-api-user act for them.
set -Eeuo pipefail
ALLUVREN_SETUP=1 . "$(cd "$(dirname "$0")" && pwd)/localnet-env.sh"

say 'LocalNet'
echo "governance party  $GOV"
echo "rules contract    $RULES"
for n in 1 2 3; do echo "node $n member     $(eval echo "\$MEMBER_$n")  (participant $(eval echo "\$PARTICIPANT_$n"))"; done

say 'Alluvren DAR'
expected=$(awk '$2=="alluvren-v1-0.3.0.dar"{print tolower($1)}' "$REPO_DIR/artifacts/SHA256SUMS.txt")
actual=$( (sha256sum "$ALLUVREN_DAR" 2>/dev/null || shasum -a 256 "$ALLUVREN_DAR") | awk '{print tolower($1)}')
[[ -n $expected && $actual == "$expected" ]] || fail "checksum mismatch for $ALLUVREN_DAR"
echo "sha256 $actual matches artifacts/SHA256SUMS.txt"
bash "$INFRA_DIR/distribute-dar-localnet.sh" "$ALLUVREN_DAR" "$ALLUVREN_PACKAGE_ID"

say 'Business parties on node 2'
for pair in $ALLUVREN_HINTS; do
  hint=${pair#*=}; id="$hint::$NODE2_NS"
  if party_exists "$id"; then
    echo "exists     $id"
  else
    curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "$JSON_API/v2/parties" \
      -d "$(jq -cn --arg h "$hint" '{partyIdHint:$h, identityProviderId:""}')" >/dev/null
    party_exists "$id" || fail "allocated $hint but $id is not visible"
    echo "allocated  $id"
  fi
  curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "$JSON_API/v2/users/ledger-api-user/rights" \
    -d "$(jq -cn --arg p "$id" '{userId:"ledger-api-user",identityProviderId:"",rights:[{kind:{CanActAs:{value:{party:$p}}}},{kind:{CanReadAs:{value:{party:$p}}}}]}')" >/dev/null
done

unset ALLUVREN_SETUP
load_business_parties || fail 'business parties missing after setup'
say 'Ready'
echo "Alluvren is set up on this LocalNet. Next: bash infra/demo-localnet.sh"
