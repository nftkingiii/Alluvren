#!/usr/bin/env bash
# Runs the Alluvren BitSafe LocalNet demonstrations in order and stops at the
# first failure. Run infra/setup-localnet.sh once before this.
#   shared-control  test-policy-localnet.sh   governed fund policy; a finalization below the
#                                             member threshold or missing a required role fails
#   app             test-gate8-localnet.sh    signed-in users drive the same flow through the backend
#   outage          test-outage-localnet.sh   one hosting node offline, recovery and catch-up
#   legacy          test-gate6/7-localnet.sh  earlier two-reviewer checks (only with --all)
# Usage: bash infra/demo-localnet.sh [--all | shared-control | app | outage | legacy]
set -Eeuo pipefail
INFRA_DIR="$(cd "$(dirname "$0")" && pwd)"

run() {
  printf '\n######## %s ########\n' "$1"
  bash "$INFRA_DIR/$2"
}

case "${1:-default}" in
  default) set -- shared-control app outage ;;
  --all) set -- shared-control app outage legacy ;;
esac
for step in "$@"; do
  case $step in
    shared-control) run 'Shared control: governed fund policy' test-policy-localnet.sh ;;
    app) run 'Signed-in users through the backend' test-gate8-localnet.sh ;;
    outage) run 'Distributed hosting: node outage' test-outage-localnet.sh ;;
    legacy) run 'Legacy: threshold and replay checks' test-gate6-localnet.sh
            run 'Legacy: investor-private records' test-gate7-localnet.sh ;;
    *) echo "unknown step: $step" >&2; exit 2 ;;
  esac
done
printf '\nAll requested Alluvren LocalNet demonstrations passed.\n'
