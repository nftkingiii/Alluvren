#!/usr/bin/env bash
# Distribute an Alluvren DAR to all three BitSafe LocalNet participants through
# DecMan's /dars/distribute workflow, then read back the vetted package on each.
# Runs on the LocalNet VM. Usage: distribute-dar-localnet.sh <dar-path> <expected-package-id>
set -Eeuo pipefail

DAR=$1
EXPECTED=$2
BASE=http://127.0.0.1
[[ -f $DAR ]] || { echo "missing DAR: $DAR" >&2; exit 1; }

fail() { echo "FAIL: $*" >&2; exit 1; }
say() { printf '\n== %s ==\n' "$*"; }

say 'Check whether the package is already vetted everywhere'
already=0
for port in 8081 8082 8083; do
  if curl -fsS "$BASE:$port/packages/vetted" | grep -q "$EXPECTED"; then
    already=$((already + 1))
  fi
done
if [[ $already -eq 3 ]]; then
  echo "Package $EXPECTED already vetted on all three participants; nothing to do."
  exit 0
fi

PID_2=$(curl -fsS "$BASE:8082/node-config" | jq -r '.node.participant_id')
PID_3=$(curl -fsS "$BASE:8083/node-config" | jq -r '.node.participant_id')
[[ -n $PID_2 && $PID_2 != null && -n $PID_3 && $PID_3 != null ]] || fail 'could not read peer participant IDs'

say 'Start distribution from participant 1'
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
base64 < "$DAR" | tr -d '\n' > "$work/b64"
jq -n --arg filename "$(basename "$DAR")" --rawfile data "$work/b64" \
  --arg p2 "$PID_2" --arg p3 "$PID_3" \
  '{dar_files: [{filename: $filename, data: $data}], peer_ids: [$p2, $p3]}' > "$work/payload.json"
response=$(curl -sS -w '\nHTTP=%{http_code}' -X POST "$BASE:8081/dars/distribute" \
  -H 'Content-Type: application/json' -d "@$work/payload.json")
echo "$response" | tail -1
echo "$response" | grep -q 'HTTP=2' || fail "distribution request rejected: $response"

accept() {
  local port=$1 attempt id
  for attempt in $(seq 1 120); do
    id=$(curl -fsS "$BASE:$port/invitations" | jq -r 'first(.invitations[]? | select(.invitation_type == "Dars") | .id) // empty')
    if [[ -n $id ]]; then
      curl -fsS -X POST "$BASE:$port/invitations/accept" -H 'Content-Type: application/json' \
        -d "$(jq -n --arg id "$id" '{id: $id}')" >/dev/null
      echo "participant on $port accepted Dars invitation $id"
      return 0
    fi
    sleep 2
  done
  fail "no Dars invitation arrived on $port"
}
accept 8082
accept 8083

say 'Wait for the distribution workflow'
for attempt in $(seq 1 180); do
  status=$(curl -fsS "$BASE:8081/dars/distribute/status" | jq -r '.status // empty')
  case $status in
    completed) echo 'distribution completed'; break ;;
    failed|cancelled) fail "distribution $status: $(curl -fsS "$BASE:8081/dars/distribute/status")" ;;
  esac
  [[ $attempt -eq 180 ]] && fail 'distribution did not complete in time'
  sleep 2
done

say 'Read back the vetted package on every participant'
for port in 8081 8082 8083; do
  curl -fsS "$BASE:$port/packages/vetted" | grep -q "$EXPECTED" || fail "package $EXPECTED not vetted on $port"
  echo "port $port: $EXPECTED vetted"
done
echo "PASS: $(basename "$DAR") distributed and vetted on all three participants"
