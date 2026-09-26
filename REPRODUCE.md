# Reproduce Alluvren on BitSafe LocalNet

This guide runs Alluvren's governed redemption flow on the BitSafe Decentralization Manager LocalNet, starting from nothing. It proves the two things the BitSafe challenge asks for:

- **Shared control:** a redemption payout or a fund-policy change cannot execute below the 2-of-3 member threshold, and even above it the ledger refuses a payout that is missing a role the fund policy requires.
- **Distributed hosting:** any one node can go offline, including the one that hosts the fund's operator, reviewers and investors, and Alluvren keeps working; with one member left, nothing executes; the offline node catches up when it returns.

Every ID is discovered from your running LocalNet. Nothing is tied to our machines.

## What you need

- The DecMan hackathon kit's requirements: Docker with Compose v2.1.1+, **12 GB memory and 4 CPUs for Docker**, about 20 GB of disk, `bash`, `curl`, `jq` 1.6+, `tar`, `base64`. macOS or Linux; on Windows use WSL2.
- Optional: Node.js 20+ on your PATH. The app demo uses it to run Alluvren's backend; without it the script runs the backend in the `node:22-alpine` image with host networking, which needs Linux.

## Steps

1. Clone the two repositories next to each other:

   ```bash
   git clone -b hackathon https://github.com/DLC-link/decentralization-manager.git
   git clone https://github.com/nftkingiii/Alluvren.git
   ```

   We tested with DecMan `hackathon` at commit `aa13fa9`.

2. Start LocalNet and create the decentralized party with its governance core. This is BitSafe's kit, unchanged. The first `up.sh` downloads about 760 MB and then several GB of images:

   ```bash
   cd decentralization-manager
   ./hackathon/up.sh
   ./hackathon/seed.sh
   cd ..
   ```

3. Install Alluvren on LocalNet (about two minutes). This checks the DAR checksum, distributes `alluvren-v1` 0.4.0 to all three participants through DecMan, allocates the business parties on node 2, and adds node 1 as their backup host:

   ```bash
   bash Alluvren/infra/setup-localnet.sh
   ```

   It prints the governance party, the member hosted on each node, and six business parties, each hosted on node 2 and node 1: `alluvren-operator`, `alluvren-treasury`, `alluvren-coo` and `alluvren-compliance`, plus two investors with random IDs (`inv-<hex>`). Only node 2 knows which investor is which: the label sits in its local party metadata, which is never shared with the other nodes. Finally, the members on nodes 2 and 3 approve adding `alluvren-operator` to the governance core's additional proposers: the operator may propose, but never confirm or execute. Re-running it is safe. Run it right after `seed.sh`, before anything else uses these parties: backup hosting is added while the parties have no contracts.

4. Run the demonstrations (about 15 minutes; each prints `PASS` lines and stops at the first failure):

   ```bash
   bash Alluvren/infra/demo-localnet.sh
   ```

   To run one at a time: `bash Alluvren/infra/demo-localnet.sh shared-control` (or `app`, `sealed`, `outage`, `outage-node2`). Add `--all` to include the earlier two-reviewer checks.

If the DecMan checkout is not next to Alluvren, set `DECMAN_DIR=/path/to/decentralization-manager` for steps 3 and 4. The scripts read the kit's public LocalNet development token from it.

## What each demonstration shows

| Step | Script | What you should see |
| --- | --- | --- |
| `shared-control` | `infra/test-policy-localnet.sh` | Creating the fund policy with one member confirmation is rejected; with two it executes. A 40%-funded batch reaches the member threshold but the ledger rejects it with `Missing required approvals for role ComplianceReviewer`; after Compliance approves, it executes and the investor receives private records (400 allocated, 600 outstanding). A governed policy update then blocks a batch still pinned to the old policy version. Takes about 5 minutes because it waits out a batch deadline during cleanup. |
| `app` | `infra/test-gate8-localnet.sh` | Alluvren's backend runs on `127.0.0.1:8787` with throwaway accounts (random passwords, never printed, deleted at the end). Signed-in reviewers approve as themselves; wrong roles, missing CSRF tokens and forged parties are refused; the operator proposes; two members confirm from their own nodes; execution is refused until Compliance has approved; the investor sees only their own records and acknowledges once. |
| `sealed` | `infra/test-sealed-localnet.sh` | The operator keeps a batch's per-investor rows in a private book and proposes a sealed batch carrying only totals and a salted SHA-256 commitment. Reviewers, the operator and two members approve and execute it through the backend. Node 3, which hosts only the governance party, then holds the finalization and nothing naming an investor or an amount. A book that doesn't match the commitment is rejected; the real one issues each investor a private record that only they and the operator can see. |
| `outage` | `infra/test-outage-localnet.sh` | Node 1's participant is disconnected from the synchronizer and its DecMan stopped. A governed policy and a payout still execute on nodes 2 and 3, and node 1's ledger stops advancing. With node 3's DecMan also stopped, a payout gets one confirmation and cannot execute. Node 1 reconnects, catches up on what it missed, confirms the waiting payout and executes it. The script always brings the nodes back, even if it fails. |
| `outage-node2` | `infra/test-outage-node2-localnet.sh` | Node 2, which normally hosts the operator, reviewers and investors, is taken offline and refuses new commands. The operator creates a governed policy and a batch through node 1; Alluvren's backend, configured with node 2 then node 1, switches to node 1 on its own; reviewers approve, the operator proposes, members 1 and 3 confirm and execute, and the investor acknowledges and withdraws. Node 2 reconnects and catches up. |

## Nodes, thresholds and operators

| Node | DecMan | Canton participant | JSON Ledger API | Governance member |
| --- | --- | --- | --- | --- |
| 1 | `decman-1`, http://localhost:8081 | `app-provider` (backup host for the Alluvren business parties) | 3975 | the member party hosted on app-provider |
| 2 | `decman-2`, http://localhost:8082 | `app-user` (primary host for the Alluvren business parties) | 2975 | the member party hosted on app-user |
| 3 | `decman-3`, http://localhost:8083 | `sv` | 4975 | the member party hosted on sv |

- The governance party (`demo-party::…`) is hosted with confirmation permission on all three participants. Its namespace is owned by the three participants together, and any 2 of them must sign to change it (DecMan's party threshold).
- Its `GovernanceRules` contract has three members and a confirmation threshold of 2. Alluvren's governed actions (`UpdateFundPolicy`, `FinalizePolicyRedemption`) execute only through it.
- On top of that, each fund's `FundPolicy` requires role approvals (Treasury, Final sign-off, and Compliance when a batch is under 50% funded), which the ledger checks when the payout executes.

**Independence.** On LocalNet all three nodes run on your one machine and are operated by one person, so this reproduces the mechanics (threshold, hosting, outage and recovery), not independent organizations. In production each node would be run by a different organization (for example the fund administrator, the transfer agent and an independent custodian), so no single one can move investor money or change the fund's rules.

## Troubleshooting

- **`DecMan node N is not answering`**: LocalNet is not up yet; wait for `up.sh` to finish, or check `docker ps`.
- **`no decentralized party with prefix demo-party`**: run `./hackathon/seed.sh`. If you seeded with a different `PARTY_PREFIX`, export the same value before running Alluvren's scripts.
- **`alluvren-v1 0.4.0 is not vetted`** or **`Alluvren parties not found`**: run `infra/setup-localnet.sh`.
- **`... already has contracts; it stays on node 2 only`** from setup, or **`not hosted on both node 2 and node 1`** from `outage-node2`: the parties were used before backup hosting was added. Start over with `./hackathon/reset.sh`, then `up.sh`, `seed.sh` and setup.
- **Splice restarting after a reboot**: if Splice started before Postgres, restart it with `docker restart splice`.
- **An outage demo was interrupted before its cleanup ran**: restart the DecMan nodes with `docker start decman-1 decman-2 decman-3`, then reconnect the participant by re-running the same demo (it restores the node on exit), or run `./hackathon/down.sh` then `./hackathon/up.sh`.
- Start over completely with `./hackathon/reset.sh`, then repeat steps 2 to 4.

## What is not included

- No real money or tokens move: investor receipts are demo acknowledgments, and units are 1:1 with no fees.
- The shared hackathon DevNet is not used; everything runs on your LocalNet.
