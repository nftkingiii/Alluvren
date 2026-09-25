#!/usr/bin/env bash
set -Eeuo pipefail

PACKAGE_ID="7b10df4f60f86204fe5b920b9c2663cc214da4e9d29c86b4f171769d63c26512"

container_state() {
  sudo docker inspect --format '{{.State.Status}}' "$1" 2>/dev/null || printf 'missing'
}

container_health() {
  sudo docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$1" 2>/dev/null || printf 'missing'
}

wait_healthy() {
  local name=$1 limit=$2 elapsed=0 state health
  while (( elapsed < limit )); do
    state=$(container_state "$name")
    health=$(container_health "$name")
    if [[ "$state" == "running" && "$health" == "healthy" ]]; then
      printf '%s is healthy\n' "$name"
      return 0
    fi
    if [[ "$state" == "missing" ]]; then
      printf 'Required container %s is missing\n' "$name" >&2
      return 1
    fi
    sleep 5
    elapsed=$((elapsed + 5))
  done
  printf '%s did not become healthy (state=%s, health=%s)\n' \
    "$name" "$(container_state "$name")" "$(container_health "$name")" >&2
  return 1
}

start_and_wait() {
  local name=$1 limit=$2 state health
  state=$(container_state "$name")
  if [[ "$state" == "missing" ]]; then
    printf 'Required container %s is missing\n' "$name" >&2
    return 1
  fi
  if [[ "$state" != "running" ]]; then
    printf 'Starting %s\n' "$name"
    sudo docker start "$name" >/dev/null
  fi
  health=$(container_health "$name")
  if [[ "$health" != "healthy" ]]; then
    if wait_healthy "$name" "$limit"; then
      return 0
    fi
    printf 'Restarting %s after dependency readiness\n' "$name"
    sudo docker restart "$name" >/dev/null
    wait_healthy "$name" "$limit"
  fi
}

restart_splice_after_db_race() {
  local state health logs
  state=$(container_state splice)
  health=$(container_health splice)
  if [[ "$state" == "missing" ]]; then
    printf 'Required container splice is missing\n' >&2
    return 1
  fi
  if [[ "$state" != "running" ]]; then
    sudo docker start splice >/dev/null
    return 0
  fi
  if [[ "$health" == "healthy" ]]; then
    return 0
  fi

  logs=$(sudo docker logs --tail 120 splice 2>&1 || true)
  if grep --fixed-strings --quiet 'UnknownHostException: postgres' <<<"$logs"; then
    printf 'Splice failed before Postgres DNS was ready; restarting it now\n'
    sudo docker restart splice >/dev/null
  fi
}

printf 'Restoring LocalNet dependencies without touching volumes\n'
start_and_wait postgres 180
start_and_wait canton 240
restart_splice_after_db_race
wait_healthy splice 300

for port in 8081 8082 8083; do
  curl --fail --silent --show-error "http://127.0.0.1:${port}/healthz" >/dev/null
  curl --fail --silent --show-error "http://127.0.0.1:${port}/packages/vetted" \
    | grep --fixed-strings --quiet "$PACKAGE_ID"
  printf 'DecMan %s healthy; Alluvren v1 package present\n' "$port"
done

printf 'Validator endpoints:\n'
sudo docker exec splice /app/health-check.sh
