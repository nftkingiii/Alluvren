# Nodes, thresholds and operators

## What is decentralized

Alluvren's fund governance lives in one Canton party, the **governance party** (`demo-party::…`), created with BitSafe's Decentralization Manager. It is hosted with confirmation permission on three participants, its namespace is owned jointly by those three participants, and its `GovernanceRules` contract has three members with a **2-of-3 confirmation threshold**.

| Node | DecMan node | Canton participant | Governance member | Also hosts |
| --- | --- | --- | --- | --- |
| Node 1 | `decman-1` | `app-provider` | member 1 | backup host for Alluvren's operator, reviewers and investors |
| Node 2 | `decman-2` | `app-user` | member 2 | primary host for Alluvren's operator, reviewers and investors |
| Node 3 | `decman-3` | `sv` | member 3 | none |

Two actions can only happen through the governance party:

- **`UpdateFundPolicy`**: creating or changing a fund's approval policy (which roles must sign off, how many, and when extra roles are triggered).
- **`FinalizePolicyRedemption`**: finalizing a redemption batch, which creates each investor's private allocation and outstanding records.

## Two locks on every payout

1. **Member threshold (BitSafe):** a governed action executes only after 2 of the 3 members confirm, each from their own node. One member cannot act alone.
2. **Fund policy (Alluvren, enforced in Daml):** at execution the ledger re-checks the batch against the fund's pinned policy. That means every required role has its quorum, approvers are policy members, the proposer, operator and investors cannot approve, and each approval counts only once. Extra roles are triggered automatically, for example Compliance when a batch is under 50% funded. A proposal that clears the member threshold but misses a role is still rejected, with the missing role named.

Alluvren's backend checks who you are and what you may do, but it cannot get around either lock: both are enforced by the ledger.

## What we showed on LocalNet

- One confirmation: rejected. Two: executed. This holds for both policy changes and payouts.
- Threshold reached but Compliance missing: rejected (`Missing required approvals for role ComplianceReviewer`).
- **Node 1 fully offline** (participant disconnected, DecMan stopped): nodes 2 and 3 still approved a policy and executed a payout. Node 1's ledger froze, and when it reconnected it caught up and executed a proposal that had been waiting.
- **Only one member reachable:** a payout could not execute.

- **Node 2 fully offline** (the node that normally hosts the operator, reviewers and investors): because those parties are also hosted on node 1, the operator proposed a policy and a batch through node 1, and reviewers approved through Alluvren's backend, which switched to node 1 on its own. Members 1 and 3 confirmed and executed, and the investor acknowledged and withdrew. Node 2 then reconnected and caught up.

Reproduction steps are in `REPRODUCE.md`; results are in `EVIDENCE.md`.

## Any single node can fail

Alluvren's business parties are hosted on two participants: node 2 as primary and node 1 as backup, each with submission rights and a confirmation threshold of 1. Either node can act for them, so losing one node never stops the fund:

| Node offline | Governance (2 of 3 members) | Business actions (propose, approve, acknowledge) |
| --- | --- | --- |
| Node 1 | nodes 2 and 3 | node 2 |
| Node 2 | nodes 1 and 3 | node 1, with the backend failing over automatically |
| Node 3 | nodes 1 and 2 | node 2 |

The backend lists both participants. It only fails over when a request provably never reached the ledger, so a command can never be applied twice.

**Who sees what.** A participant sees every contract of every party it hosts. The governance party is a stakeholder on every Alluvren contract: it observes batches (including each investor's row) and approvals, and it signs policies, entitlements, outstanding records and receipts. Because it is hosted on all three nodes, **every governance node already sees the fund's full redemption register**. Making node 1 a backup host for the business parties therefore adds essentially nothing it could not already see. In production that is usually acceptable, since the fund administrator, transfer agent and custodian are regulated and normally hold the investor register anyway. Two ways to narrow it further:

- **Pseudonymous investor parties (built):** investors get random party IDs (`inv-<hex>`). The only link to who they are is a label in node 2's local party metadata, which Canton keeps on that participant and never shares; in production this is the transfer agent's register. Governance nodes see "party inv-3ad5… receives 400 units", not who that is.
- **Sealed batches (built, `alluvren-v1` 0.4.0):** governance approves totals, the row count, the largest single allocation and a salted SHA-256 commitment to the rows. The rows stay in an allocation book signed by the operator alone. After finalization, the operator opens the book: the ledger checks the rows against the commitment, closes the finalization exactly once, and issues each investor a private record that only they and the operator can see. Governance nodes enforce the policy without seeing who gets what. Design and tests: `daml/DESIGN.md`.

## Operators and independence

**On LocalNet, all three nodes run on one machine operated by one developer.** The demo shows the mechanics (threshold, hosting, outage and recovery), not organizational independence.

The intended production setup (planned, not deployed) gives each node to a different organization with its own keys and infrastructure:

- **Node 1: the fund administrator.** Runs NAV and the redemption calculations.
- **Node 2: the transfer agent / Alluvren operator.** Proposes batches and hosts investor records.
- **Node 3: an independent custodian or trustee.** Neither prepares nor profits from the batch.

With 2 of 3 required, no single organization, including whoever runs Alluvren, can finalize a payout or rewrite the fund's rules. Moving money or changing policy needs two independent organizations to agree, and the policy decides which named people inside them must sign.

## Known limits

- **Backup hosting is set up when the parties are created.** Adding a backup host to a party that already has contracts would need Canton's party replication, which the setup script does not do. It warns instead.
- **Two hosting participants offline at once was not tested.** We did not disconnect node 3's participant, because on LocalNet it also runs the network's Super Validator.
- **One shared ledger user on LocalNet** can act for all parties, so the backend's checks are what separate users there. Per-user ledger credentials are future work.
- **No real asset moves.** Investor receipts are demo acknowledgments.
