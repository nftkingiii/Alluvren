#!/usr/bin/env bash
# Runs the Canton Wallet Gateway (CIP-0103) next to BitSafe LocalNet. Alluvren
# has no passwords: every account signs in with a wallet held here.
#
#   bash infra/wallet-gateway.sh start         install (pinned) and start on 127.0.0.1:3030
#   bash infra/wallet-gateway.sh party <name>  print an account's wallet party (creating it if needed)
#   bash infra/wallet-gateway.sh stop          stop the gateway (its data stays in $WALLET_GATEWAY_DIR)
#
# Every Alluvren account signs in with a wallet here. demo-session.sh creates
# one per role; in the gateway's login page the client ID is alluvren-<name>.
#
# The gateway talks to node 2's JSON Ledger API, where Alluvren's parties
# are hosted. Development setup only: logins are self-signed LocalNet tokens,
# and each wallet's Ed25519 key sits in the gateway's own signing store
# (the `wallet-kernel` provider). A real deployment would log users in through
# an OAuth provider and keep keys with the participant or a custody provider.
# Needs Node 20+ and infra/setup-localnet.sh to have run on this LocalNet.
set -Eeuo pipefail
. "$(cd "$(dirname "$0")" && pwd)/localnet-env.sh"

VERSION=1.12.0
WALLET_GATEWAY_DIR=${WALLET_GATEWAY_DIR:-$HOME/.alluvren-wallet-gateway}
PORT=3030

stop_gateway() {
  if [[ -f $WALLET_GATEWAY_DIR/gateway.pid ]]; then
    kill "$(cat "$WALLET_GATEWAY_DIR/gateway.pid")" >/dev/null 2>&1 || true
    rm -f "$WALLET_GATEWAY_DIR/gateway.pid"
  fi
}

case ${1:-} in
  stop)
    stop_gateway
    echo "Wallet Gateway stopped. Its data stays in $WALLET_GATEWAY_DIR."
    exit 0 ;;
  party)
    node "$INFRA_DIR/wallet-gateway.mjs" setup "${2:?usage: bash infra/wallet-gateway.sh party <name>}"
    exit 0 ;;
  start) ;;
  *) echo "usage: bash infra/wallet-gateway.sh start|party|stop" >&2; exit 2 ;;
esac

command -v node >/dev/null 2>&1 && [[ $(node -p 'process.versions.node.split(".")[0]') -ge 20 ]] \
  || fail 'Node.js 20+ is required for the Wallet Gateway'

say "Wallet Gateway $VERSION"
mkdir -p "$WALLET_GATEWAY_DIR"; chmod 700 "$WALLET_GATEWAY_DIR"
if [[ ! -x $WALLET_GATEWAY_DIR/node_modules/.bin/wallet-gateway ]] \
  || [[ $(node -p "require('$WALLET_GATEWAY_DIR/node_modules/@canton-network/wallet-gateway-remote/package.json').version" 2>/dev/null) != "$VERSION" ]]; then
  # npm init would take the package name from the dot-directory, which npm rejects.
  [[ -f $WALLET_GATEWAY_DIR/package.json ]] || printf '{ "name": "alluvren-wallet-gateway", "private": true }\n' > "$WALLET_GATEWAY_DIR/package.json"
  (cd "$WALLET_GATEWAY_DIR" && npm install --no-audit --no-fund --save-exact "@canton-network/wallet-gateway-remote@$VERSION" >/dev/null)
fi
cp "$INFRA_DIR/wallet-gateway.config.json" "$WALLET_GATEWAY_DIR/config.json"

stop_gateway
pushd "$WALLET_GATEWAY_DIR" >/dev/null
# Detached from this script's stdin and stdout so callers that pipe its output
# are not held open by the gateway.
nohup ./node_modules/.bin/wallet-gateway -c ./config.json -p "$PORT" -f json > gateway.log 2>&1 < /dev/null &
echo $! > gateway.pid
popd >/dev/null
for _ in $(seq 1 30); do curl -fsS -o /dev/null "$BASE:$PORT/" 2>/dev/null && break; sleep 1; done
curl -fsS -o /dev/null "$BASE:$PORT/" || fail "the Wallet Gateway did not start; see $WALLET_GATEWAY_DIR/gateway.log"
echo "User UI    $BASE:$PORT/"
echo "dApp API   $BASE:$PORT/api/v0/dapp"
echo "Next: bash infra/demo-session.sh start"
