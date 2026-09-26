#!/usr/bin/env bash
# Runs the Alluvren BitSafe LocalNet demonstrations in order and stops at the
# first failure. Run infra/setup-localnet.sh once before this.
#   shared-control  test-policy-localnet.sh   governed fund policy; a finalization below the
#                                             member threshold or missing a required role fails
#   app             test-gate8-localnet.sh    signed-in users drive the same flow through the backend
#   outage          test-outage-localnet.sh   node 1 offline: governance continues on nodes 2 and 3
#   outage-node2    test-outage-node2-localnet.sh  node 2 (the business node) offline: the app fails over to node 1
#   sealed          test-sealed-localnet.sh   governance approves a batch without seeing who gets what
#   legacy          test-gate6/7-localnet.sh  earlier two-reviewer checks (only with --all)
# Usage: bash infra/demo-localnet.sh [--all | shared-control | app | sealed | outage | outage-node2 | legacy]
set -Eeuo pipefail
INFRA_DIR="$(cd "$(dirname "$0")" && pwd)"

run() {
  printf '\n######## %s ########\n' "$1"
  bash "$INFRA_DIR/$2"
}

case "${1:-default}" in
  default) set -- shared-control app sealed outage outage-node2 ;;
  --all) set -- shared-control app sealed outage outage-node2 legacy ;;
esac
for step in "$@"; do
  case $step in
    shared-control) run 'Shared control: governed fund policy' test-policy-localnet.sh ;;
    app) run 'Signed-in users through the backend' test-gate8-localnet.sh ;;
    sealed) run 'Privacy: sealed batch' test-sealed-localnet.sh ;;
    outage) run 'Distributed hosting: node 1 outage' test-outage-localnet.sh ;;
    outage-node2) run 'Distributed hosting: node 2 (business node) outage' test-outage-node2-localnet.sh ;;
    legacy) run 'Legacy: threshold and replay checks' test-gate6-localnet.sh
            run 'Legacy: investor-private records' test-gate7-localnet.sh ;;
    *) echo "unknown step: $step" >&2; exit 2 ;;
  esac
done
printf '\nAll requested Alluvren LocalNet demonstrations passed.\n'
