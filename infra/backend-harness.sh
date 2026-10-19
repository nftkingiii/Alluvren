# Sourced after localnet-env.sh by scripts that drive Alluvren's real backend
# (backend/src) over HTTP as signed-in users, the same calls the Live ledger UI
# makes.
#   - Throwaway accounts each get an Ed25519 wallet key, held only in the
#     private work directory and deleted with it by backend_stop. They sign in
#     as a wallet does: the backend issues a challenge, the key signs it.
#   - The backend listens on loopback port 8788 with writes enabled, using
#     Node 20+ if installed, otherwise the node:22-alpine image with host
#     networking (Linux), run as the calling user.
# Callers must run backend_stop on exit (put it in their EXIT trap).

# 8788, so a recording session (demo-session.sh, port 8787) can stay up.
API=$BASE:8788
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
# Each person gets a wallet "<username>-wallet::<key fingerprint>" bound to
# their account; the ledger party stays the one given.
backend_start() {
  printf '%s' "$1" > "$HARNESS_WORK/people.json"
  run_node --input-type=module -e '
    import { readFileSync, writeFileSync } from "node:fs";
    import { generateKeyPairSync } from "node:crypto";
    import { join } from "node:path";
    import { pathToFileURL } from "node:url";
    const { walletNamespace } = await import(pathToFileURL(join(process.env.APP, "src/auth.mjs")).href);
    const work = process.env.WORKD;
    const people = JSON.parse(readFileSync(join(work, "people.json"), "utf8"));
    const keys = {}; const users = [];
    for (const p of people) {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const raw = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("base64");
      const wallet = `${p.username}-wallet::${walletNamespace(raw)}`;
      keys[p.username] = { wallet, publicKey: raw, privateKey: privateKey.export({ format: "pem", type: "pkcs8" }) };
      users.push({ ...p, wallet });
    }
    writeFileSync(join(work, "accounts.json"), JSON.stringify({ users }), { mode: 0o600 });
    writeFileSync(join(work, "keys.json"), JSON.stringify(keys), { mode: 0o600 });
  '
  (umask 077; cat > "$HARNESS_WORK/backend.env" <<ENV
PORT=8788
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

# wallet_signin <user> [signer]: fetch a challenge for <user>'s wallet, sign it
# with [signer]'s key (default: the user's own) and send it back. Prints the
# response body and HTTP code like get/post.
wallet_signin() {
  local user=$1 signer=${2:-$1} wallet message jar
  # Someone else's key never touches the user's own session cookie.
  if [[ $signer == "$user" ]]; then jar=$HARNESS_WORK/$user.jar; else jar=$HARNESS_WORK/probe.jar; fi
  wallet=$(jq -r --arg u "$user" '.[$u].wallet' "$HARNESS_WORK/keys.json")
  message=$(jq -cn --arg w "$wallet" '{wallet:$w}' | curl -sS -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d @- "$API/api/auth/challenge" | jq -r '.message // empty')
  [[ -n $message ]] || fail "no sign-in challenge for $user"
  printf '%s' "$message" > "$HARNESS_WORK/challenge.txt"
  run_node --input-type=module -e '
    import { readFileSync } from "node:fs";
    import { sign, createPrivateKey } from "node:crypto";
    import { join } from "node:path";
    const work = process.env.WORKD;
    const keys = JSON.parse(readFileSync(join(work, "keys.json"), "utf8"));
    const [user, signer] = process.argv.slice(1);
    const message = readFileSync(join(work, "challenge.txt"), "utf8");
    const signature = sign(null, Buffer.from(message, "utf8"), createPrivateKey(keys[signer].privateKey)).toString("base64");
    process.stdout.write(JSON.stringify({ wallet: keys[user].wallet, publicKey: keys[signer].publicKey, signature, message }));
  ' "$user" "$signer" \
    | curl -sS -c "$jar" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -w '\n%{http_code}' -d @- "$API/api/auth/wallet"
}

login() {
  local user=$1 response
  response=$(wallet_signin "$user")
  CSRF[$user]=$(sed '$d' <<<"$response" | jq -r '.csrfToken // empty')
  [[ -n ${CSRF[$user]} ]] || fail "login $user failed: $(sed '$d' <<<"$response" | jq -c '.error')"
}
get() { curl -sS -b "$HARNESS_WORK/$1.jar" -w '\n%{http_code}' "$API$2"; }
post() { curl -sS -b "$HARNESS_WORK/$1.jar" -H "Origin: $ORIGIN" -H "x-alluvren-csrf: ${CSRF[$1]}" -H 'Content-Type: application/json' -w '\n%{http_code}' -d "$3" "$API$2"; }
code() { tail -n1 <<<"$1"; }
body() { sed '$d' <<<"$1"; }
expect() { [[ $(code "$1") == "$2" ]] || fail "$3: expected HTTP $2, got $(code "$1") $(body "$1" | head -c 300)"; }
