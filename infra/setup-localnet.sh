#!/usr/bin/env bash
# One-time Alluvren setup on a BitSafe LocalNet started with the DecMan
# `hackathon` kit (up.sh, then seed.sh). Safe to re-run.
#   1. Checks the Alluvren DAR against artifacts/SHA256SUMS.txt.
#   2. Distributes it through DecMan to all three participants (skipped if vetted).
#   3. Allocates the business parties on node 2 and lets the kit's
#      ledger-api-user act for them. Institutional roles get readable IDs
#      (alluvren-operator, ...); investors get random IDs (inv-<hex>), with
#      their label kept only in node 2's local party metadata.
#   4. Adds node 1 as a backup host for each business party (submission
#      permission, confirmation threshold 1), so Alluvren keeps working when
#      node 2 is offline. This is done while the parties have no contracts;
#      a party that already has contracts is left on node 2 only, since moving
#      its history would need Canton's party replication (reset LocalNet instead).
#   5. Adds the operator to GovernanceRules' additional proposers (a governed
#      action confirmed by 2 of 3 members), so it can propose but not vote.
set -Eeuo pipefail
ALLUVREN_SETUP=1 . "$(cd "$(dirname "$0")" && pwd)/localnet-env.sh"

say 'LocalNet'
echo "governance party  $GOV"
echo "rules contract    $RULES"
for n in 1 2 3; do echo "node $n member     $(eval echo "\$MEMBER_$n")  (participant $(eval echo "\$PARTICIPANT_$n"))"; done

say 'Alluvren DAR'
expected=$(tr -d '\r' < "$REPO_DIR/artifacts/SHA256SUMS.txt" | awk -v f="$(basename "$ALLUVREN_DAR")" '$2==f{print tolower($1)}')
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
  grant_rights 2 "$id"
done
for pair in $ALLUVREN_INVESTORS; do
  label=${pair#*=}
  id=$(investor_party "$label")
  if [[ -n $id ]]; then
    echo "exists     $id ($label, label known to node 2 only)"
  else
    hint="inv-$(od -An -N8 -tx1 /dev/urandom | tr -dc '0-9a-f')"
    body=$(jq -cn --arg h "$hint" --arg k "$INVESTOR_LABEL_KEY" --arg l "$label" \
      '{partyIdHint:$h, identityProviderId:"", localMetadata:{resourceVersion:"", annotations:{($k):$l}}}')
    curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "$JSON_API/v2/parties" -d "$body" >/dev/null
    id=$(investor_party "$label")
    [[ -n $id ]] || fail "allocated a party for $label but node 2 does not list it with its label"
    echo "allocated  $id ($label, label known to node 2 only)"
  fi
  grant_rights 2 "$id"
done
load_business_parties || fail 'business parties missing after allocation'

say 'Backup hosting on node 1'
wait_json_api 1; wait_json_api 2
# Contracts visible to a party on node 2.
contract_count() {
  local offset
  offset=$(curl -fsS -H "Authorization: Bearer $TOKEN" "$JSON_API/v2/state/ledger-end" | jq -r '.offset')
  curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "$JSON_API/v2/state/active-contracts" \
    -d "$(jq -cn --arg p "$1" --argjson off "$offset" '{filter:{filtersByParty:{($p):{cumulative:[{identifierFilter:{WildcardFilter:{value:{includeCreatedEventBlob:false}}}}]}}},verbose:false,activeAtOffset:$off}')" \
    | jq '[.. | objects | select(has("createdEvent"))] | length'
}
pending=()
for id in "${BUSINESS_PARTIES[@]}"; do
  if hosted_on 1 "$id"; then
    echo "hosted     $id"
  elif [[ $(contract_count "$id") -gt 0 ]]; then
    echo "WARNING: $id already has contracts; it stays on node 2 only (reset LocalNet to run the node 2 outage demo)" >&2
  else
    pending+=("$id")
  fi
done
if (( ${#pending[@]} )); then
  list=$(printf '"%s",' "${pending[@]}")
  canton_console "val sync = node2.synchronizers.list_connected().head.synchronizerId
val parties = Seq(${list%,}).map(PartyId.tryFromProtoPrimitive)
parties.foreach { party =>
  node2.topology.party_to_participant_mappings.propose_delta(party, adds = Seq(node1.id -> ParticipantPermission.Submission), store = sync)
  node1.topology.party_to_participant_mappings.propose_delta(party, adds = Seq(node1.id -> ParticipantPermission.Submission), store = sync)
}
println(\"RESULT proposed \" + parties.size)" \
    || echo 'The console did not confirm the change; checking the hosting state directly' >&2
  for id in "${pending[@]}"; do
    for _ in $(seq 1 60); do hosted_on 1 "$id" && break; sleep 2; done
    hosted_on 1 "$id" || fail "node 1 does not host $id after the topology change"
    echo "added      $id"
  done
fi
for id in "${BUSINESS_PARTIES[@]}"; do
  if hosted_on 1 "$id"; then grant_rights 1 "$id"; fi
done

say 'Operator as an additional proposer'
# GovernanceRules only accepts proposals from members or its additionalProposers
# allowlist. The operator may propose (policies, finalizations) but never
# confirm or execute; adding it is itself a governed action (2 of 3 members).
rules_contract() {
  local offset
  offset=$(curl -fsS -H "Authorization: Bearer $TOKEN" "$JSON_API/v2/state/ledger-end" | jq -r '.offset')
  curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "$JSON_API/v2/state/active-contracts" \
    -d "$(jq -cn --arg p "$GOV" --argjson off "$offset" '{filter:{filtersByParty:{($p):{cumulative:[{identifierFilter:{WildcardFilter:{value:{includeCreatedEventBlob:false}}}}]}}},verbose:false,activeAtOffset:$off}')" \
    | jq -c '.. | objects | select(has("createdEvent")) | .createdEvent | select(.templateId | endswith(":GovernanceRules"))'
}
if rules_contract | jq -e --arg op "$OP" '[.createArgument.additionalProposers | .. | strings] | index($op)' >/dev/null; then
  echo "registered $OP"
else
  action=$(jq -cn --arg op "$OP" '{type:"governance_add_additional_proposer", additional_proposer:$op}')
  for port in 8082 8083; do
    r=$(curl -sS -w '\nHTTP=%{http_code}' -X POST "$BASE:$port/governance/confirm" -H 'Content-Type: application/json' \
      -d "$(jq -cn --arg p "$GOV" --arg r "$RULES" --argjson a "$action" '{party_id:$p,rules_contract_id:$r,action:$a,governance_type:"core_self"}')")
    grep -q 'HTTP=200' <<<"$r" || fail "member on $port could not confirm adding the operator as proposer: $r"
    sleep 1
  done
  cids=""
  for _ in $(seq 1 15); do
    cids=$(curl -fsS "$BASE:8083/governance/confirmations?party_id=$GOV" \
      | jq -c --arg op "$OP" 'first(.actions[]? | select(tostring | contains($op)) | [.confirmations[]?.contract_id]) // empty')
    [[ $(jq 'length' <<<"${cids:-[]}") -ge 2 ]] && break; sleep 2
  done
  [[ $(jq 'length' <<<"${cids:-[]}") -ge 2 ]] || fail "confirmations for adding the operator did not appear: $(curl -fsS "$BASE:8083/governance/confirmations?party_id=$GOV" | jq -c '.actions')"
  r=$(curl -sS -w '\nHTTP=%{http_code}' -X POST "$BASE:8083/governance/execute" -H 'Content-Type: application/json' \
    -d "$(jq -cn --arg p "$GOV" --arg r "$RULES" --argjson a "$action" --argjson c "$cids" '{party_id:$p,rules_contract_id:$r,action:$a,confirmation_cids:$c,governance_type:"core_self"}')")
  grep -q 'HTTP=200' <<<"$r" || fail "adding the operator as proposer failed: $r"
  for _ in $(seq 1 15); do
    rules_contract | jq -e --arg op "$OP" '[.createArgument.additionalProposers | .. | strings] | index($op)' >/dev/null && break; sleep 2
  done
  rules_contract | jq -e --arg op "$OP" '[.createArgument.additionalProposers | .. | strings] | index($op)' >/dev/null \
    || fail 'GovernanceRules does not list the operator after execution'
  echo "added      $OP (confirmed by members on nodes 2 and 3)"
fi

unset ALLUVREN_SETUP
load_business_parties || fail 'business parties missing after setup'
say 'Ready'
echo "Alluvren is set up on this LocalNet. Next: bash infra/demo-localnet.sh"
