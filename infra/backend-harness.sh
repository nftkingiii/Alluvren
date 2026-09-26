# Sourced after localnet-env.sh by scripts that drive Alluvren's real backend
# (backend/src) over HTTP as signed-in users, the same calls the Live ledger UI
# makes.
#   - Throwaway accounts get random passwords that are hashed, never printed,
#     and deleted with the private work directory by backend_stop.
#   - The backend listens on loopback port 8787 with writes enabled, using
#     Node 20+ if installed, otherwise the node:22-alpine image with host
#     networking (Linux), run as the calling user.
# Callers must run backend_stop on exit (put it in their EXIT trap).

API=$BASE:8787
ORIGIN=http://alluvren.harness
APP_DIR=$REPO_DIR/backend
HARNESS_WORK=$(mktemp -d)
chmod 700 "$HARNESS_WORK"
BACKEND_PID=""
BACKEND_CONTAINER=alluvren-backend-harness
if command -v node >/dev/null 2>&1 && [[ $(node -p 'process.versions.node.split(".")[0]') -ge 20 ]]; then
  NODE_MODE=host
else
  NODE_MODE=docker
fi
declare -A CSRF

pass() { echo "PASS: $*"; }

# Runs node with APP and WORKD pointing at the backend and the private work dir.
run_node() {
  if [[ $NODE_MODE == host ]]; then
    APP=$APP_DIR WORKD=$HARNESS_WORK node "$@"
  else
    docker run --rm --user "$(id -u):$(id -g)" -v "$APP_DIR:/app:ro" -v "$HARNESS_WORK:/work" -e APP=/app -e WORKD=/work node:22-alpine node "$@"
  fi
}

# backend_start <people-json> <comma-separated JSON Ledger API URLs>
# people-json: [{username, party, roles, decmanNode?}]
backend_start() {
  printf '%s' "$1" > "$HARNESS_WORK/people.json"
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
  (umask 077; cat > "$HARNESS_WORK/backend.env" <<ENV
PORT=8787
ALLOWED_ORIGINS=$ORIGIN
DEC_MAN_URLS=p1=http://127.0.0.1:8081,p2=http://127.0.0.1:8082,p3=http://127.0.0.1:8083
GOVERNANCE_PARTY_ID=$GOV
RULES_CONTRACT_ID=$RULES
ALLUVREN_PACKAGE_REF=#alluvren-v1
ENVIRONMENT=LocalNet
LEDGER_JSON_API_URL=$2
LEDGER_TOKEN=$TOKEN
WRITES_ENABLED=true
RATE_LIMIT_PER_MINUTE=1000
ENV
  )
  if [[ $NODE_MODE == host ]]; then
    (set -a; . "$HARNESS_WORK/backend.env"; ACCOUNTS_FILE=$HARNESS_WORK/accounts.json; exec node "$APP_DIR/src/server.mjs") > "$HARNESS_WORK/backend.log" 2>&1 &
    BACKEND_PID=$!
  else
    docker rm -f "$BACKEND_CONTAINER" >/dev/null 2>&1 || true
    docker run -d --name "$BACKEND_CONTAINER" --network host --user "$(id -u):$(id -g)" -v "$APP_DIR:/app:ro" -v "$HARNESS_WORK:/work:ro" \
      --env-file "$HARNESS_WORK/backend.env" -e ACCOUNTS_FILE=/work/accounts.json node:22-alpine node /app/src/server.mjs >/dev/null
  fi
  for _ in $(seq 1 30); do curl -fsS "$API/healthz" >/dev/null 2>&1 && break; sleep 1; done
}

backend_stop() {
  [[ -n $BACKEND_PID ]] && kill "$BACKEND_PID" >/dev/null 2>&1 || true
  docker rm -f "$BACKEND_CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$HARNESS_WORK"
}

login() {
  local user=$1 response
  response=$(jq -cn --arg u "$user" --slurpfile pw "$HARNESS_WORK/passwords.json" '{username:$u,password:$pw[0][$u]}' \
    | curl -sS -c "$HARNESS_WORK/$user.jar" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d @- "$API/api/auth/login")
  CSRF[$user]=$(echo "$response" | jq -r '.csrfToken // empty')
  [[ -n ${CSRF[$user]} ]] || fail "login $user failed: $(echo "$response" | jq -c '.error')"
}
get() { curl -sS -b "$HARNESS_WORK/$1.jar" -w '\n%{http_code}' "$API$2"; }
post() { curl -sS -b "$HARNESS_WORK/$1.jar" -H "Origin: $ORIGIN" -H "x-alluvren-csrf: ${CSRF[$1]}" -H 'Content-Type: application/json' -w '\n%{http_code}' -d "$3" "$API$2"; }
code() { tail -n1 <<<"$1"; }
body() { sed '$d' <<<"$1"; }
expect() { [[ $(code "$1") == "$2" ]] || fail "$3: expected HTTP $2, got $(code "$1") $(body "$1" | head -c 300)"; }
