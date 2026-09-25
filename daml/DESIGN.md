# Alluvren Daml Module Design

2026-09-21 | Implementation specification, not compiled source

## Product and trust boundary

A redemption shortfall desk for a tokenized fund operator. A frozen window gets a deterministic allocation; designated fund and treasury reviewers approve that exact allocation; BitSafe governs finalization. Investors receive private allocation and outstanding-balance records.

MVP: one fund, one window, three investors, zero fees, fixed price of one cash minor unit per share unit. Shares and liquidity are explicitly demonstration records. No token transfer or cash settlement is claimed. Fractional pricing, multiple assets, automatic rollover and role changes during a window are deferred.

Two distinct controls are required:
- Business authorization: BOTH designated FundReviewer and TreasuryReviewer sign, with distinct parties and neither equal to the operator.
- BitSafe authorization: its configured member threshold confirms the final GovernableAction proposal. Arbitrary two members do not replace either business role.

Governance hosts can see the batch. Investor isolation is from other investors, not from the governance party, its hosting participants, or authorized operators. A party's multiple roles are not independent organizations.

## Verified integration contract

Local upstream commit: aa13fa993b6b056d5fc5a3c2c1de9996bb59229b.
Source: ../decentralization-manager/daml/governance-action-v1/daml/Governance/Action.daml.
SDK: 3.4.11; interface package targets LF 2.2. Recheck the VM revision and deployed package IDs before building.

`Governance.Action.GovernableAction` requires:
- `view : GovernableActionView`, containing governanceParty, proposer, actionLabel, description.
- `executeImpl : Update ()`.
- Interface consuming choice `GovernableAction_Execute`, controlled by governanceParty.

`GovernanceRules_ConfirmAction` binds a confirmation to the proposal contract ID. `GovernanceRules_ExecuteConfirmedAction` consumes confirmations, checks unique current members and threshold, exercises the action, and emits GovernanceExecutionResult. The interface does NOT pass the confirmer list into executeImpl. Therefore use separate role approvals; do not invent an interface argument.

The interface also exposes proposer/governance cancellation which only archives the proposal. Recovery MUST NOT depend on those choices releasing other contracts.

Important security boundary: a command authorized directly as governanceParty can invoke the interface choice. Alluvren cannot detect its caller's stack. Do not give the web backend unilateral governanceParty actAs; validate decentralized-party topology and API rights. Mandatory role checks remain inside finalization even for direct calls. Do not claim threshold enforcement against an administrator who controls all participant infrastructure.

## Modules to implement

| Module | Responsibility |
| --- | --- |
| Alluvren.Types | Typed roles, IDs, allocation rows, status and validation bounds |
| Alluvren.Allocation | Pure deterministic integer allocation; no parties or network calls |
| Alluvren.Redemption | Positions, window, request reservations, immutable batch and recovery |
| Alluvren.Approval | Reusable signed approval of an immutable target, role and expiry |
| Alluvren.BitSafe | FinalizeBatchProposal implementing the real upstream interface |
| Alluvren.Claims | Private demo entitlement acknowledgment and receipts |
| Alluvren.Tests.* | Daml Script authorization, arithmetic, lifecycle and visibility checks |

Avoid cyclic module imports. Keep reusable approval targets as a typed data record containing a stable batch reference, not a user-supplied display hash. If concrete ContractId dependencies introduce cycles, merge Redemption/BitSafe into one module first; don't weaken the checks to preserve folder structure.

## Contract model

The following are proposed template names, not existing APIs. Governance party G is the trusted demo issuer. Operator O is an additional proposer or member in BitSafe. Reviewers F and T are distinct authorized parties. Investor I owns only their position/request/claim.

| Template | Signatories / observers | Contents and behavior |
| --- | --- | --- |
| FundPolicy | G / O,F,T | Immutable fund ID, policy version, O/F/T, asset label, unit convention, cutoff, recovery deadline; validate distinct roles |
| InvestorPosition | G / I | Available integer units, fund/policy reference; investor-controlled consuming request locks units and recreates only the remainder |
| RedemptionWindow | G / O,F,T | Exact policy reference, ordered request registry, Open/Frozen phase; serialized consuming updates prevent incomplete freeze |
| RedemptionRequest | G,I / O | Investor, window, reserved units, request sequence; no other investors observe it |
| DemoLiquidityReserve | G / O,T | Available cash units for this window; not an asset holding or verified bank balance |
| AllocationBatch | G / O,F,T | Immutable frozen request IDs and ordered amounts, policy CID, reserve CID, allocation rows, expiry; one active batch per consumed window generation |
| RoleApproval | reviewer / G,O | Exact batch CID, policy CID, role, expiry; signed reviewer identity verified against batch policy |
| FinalizeBatchProposal | O / G,F,T | Batch CID and exactly two role-approval CIDs, deadline, governanceParty; implements GovernableAction |
| ClaimEntitlement | G / I | Only this investor's allocated units and own request reference; acknowledgment consumes once, explicitly demo-only |
| ClaimReceipt | G / I | Acknowledged entitlement ID, amount, time, mode=Demo; never called a payment receipt |
| OutstandingRedemption | G / I | Unallocated reserved units; investor-controlled withdrawal restores demo position once; no automatic rollover |
| BatchFinalization | G / O,F,T | Batch reference, aggregate totals, created entitlement IDs and timestamp; governance audit links stored by read model |

Authority must flow through choices, not backend assertions. Do not require all investors to co-sign finalization. Their signed request reserves authorize later consumption by G. Never make investor parties observers of the shared window, batch or full finalization record.

## Choice contracts and authorization flow

1. Bootstrap: G creates policy, demo positions, reserve and empty window in a setup-only flow. Record issuance as demo data. Do not expose arbitrary bootstrap/mint to the frontend.
2. InvestorPosition.RequestRedemption(windowCid, units): I controls; checks ownership, positive units, same fund/policy and available units. Creates signed request under I+G authority and exercises window Register(requestCid). Register is consuming, G-controlled, checks Open, ledger time < cutoff, uniqueness and matching request, appends once and returns new window CID. Return request/new position/new window IDs to caller.
3. RedemptionRequest.Cancel(windowCid): I controls before cutoff; atomically consumes the request, exercises window RemoveRequest, restores position. Window removal and creation require checks against the actual fetched request. Concurrent cutoff/cancellation serializes on window CID. A public G-controlled consume helper must be documented as inside the governance trust boundary.
4. RedemptionWindow.Freeze(reserveCid): O controls, ledger time >= cutoff. Fetch every registered request and the matching reserve, not an arbitrary caller subset. Consume Open window; compute rows inside Daml; create one frozen batch. Fixed allocation terms cannot be edited after this choice. Bound request count to 100 for the MVP.
5. RoleApproval: reviewer creates a contract referencing the frozen batch after inspection. Business approval does not consume the batch. Revoke is consuming and reviewer-controlled. ConsumeForExecution is G-controlled, checks now < expiry and returns approval payload.
6. O creates FinalizeBatchProposal with batch and two approval CIDs. Its ensure/view checks are not the security boundary: executeImpl must fetch and validate all authority and identity fields. Multiple proposals for the same batch are harmless because the batch can finalize only once.
7. BitSafe members confirm the FINAL proposal CID and execute through GovernanceRules. Changing an approval CID or other proposal field means a new proposal and new BitSafe confirmations.
8. executeImpl exercises AllocationBatch.Finalize with its approval CIDs. Finalize is G-controlled; checks G/O identity, policy, distinct exact required reviewers, matching batch and policy references, unexpired batch/approvals, recomputed allocation and original request set. Consume approvals, requests, batch and matching reserve atomically. Create investor entitlements, outstanding records, remaining demo reserve, closed-window/finalization evidence. Roll back everything if any check fails.
9. Investor ClaimEntitlement.Acknowledge creates a demo receipt once. It does not transfer assets. Withdrawal of outstanding units restores only unallocated units. Allocated units cannot reappear as available shares.

The authoritative batch CID binds immutable request list, policy version, amounts and allocation. A hash may be added for export, but is NOT needed to replace contract identity or ledger checks. No server-supplied JSON hash is accepted as allocation proof.

## Allocation algorithm and bounds

Use positive Int units; fixed MVP price 1:1. Bound each amount and liquidity to 1,000,000,000 units and requests to 100, so total requests <= 100,000,000,000 and products <= 10^18, within signed 64-bit range. Check bounds BEFORE multiplication or summation. No Float or UI-calculated authoritative values.

For total requests S, distributable D=min(liquidity,S): base_i=(D*q_i) div S; residual_i=(D*q_i) mod S. Allocate remaining D-sum(base) units by descending residual, ties by ascending immutable request sequence. Reject duplicate sequence/IDs. With S=0, produce no entitlements and leave reserve unchanged. With D=0, all requested units remain outstanding. Never create zero-value entitlements.

Required invariants: sum(allocation)=D; each allocation is in [0,request]; request=allocation+outstanding; no unit is both restored and allocated. Input ordering must not alter output. Expected 600/300/100 with liquidity 500 -> 300/150/50.

## Recovery and concurrency

- Use ledger getTime, not browser time. Approval valid strictly before expiry; recovery allowed at or after batch recovery deadline. No overlap or equality gap.
- Batch.RecoverExpired controlled by O (authority inherited from batch G signature): consumes batch and registered requests; restores all reserved units and closes window as Aborted. Reserve is not spent. Allowed regardless of whether interface proposal was previously canceled.
- Recovery and finalization both consume the same batch, so only one wins. Canceling a proposal alone changes no investor balance. Before expiry, a replacement proposal can reference the same batch and fresh role approvals.
- Policy and role assignments are immutable for this single window. No live role rotation or emergency role revocation feature is claimed. Reviewer can revoke a still-active approval; execution must fail on the archived CID. Next-window policy changes are out of scope.
- No unilateral edit of frozen allocation. To change terms, recover/abort, restore balances, and open a new explicitly authorized window; MVP may demonstrate only abort and restoration.
- Client retries use stable command IDs and then ledger read-back. A timeout is unknown outcome, not permission to mint/recreate.

## Tests required before UI integration

| ID | Required result |
| --- | --- |
| A01 | Canonical 600/300/100 example; zero/full/partial funding; rounding ties and reordered input |
| A02 | Bounds, negatives, duplicate IDs/sequences rejected before arithmetic |
| R01 | Wrong investor, over-request, concurrent double request rejected; units conserved |
| R02 | Before/after cutoff and cancellation/freeze race; omitted request cannot be frozen |
| G01 | BitSafe below-threshold fails; threshold succeeds; duplicate member fails |
| G02 | Two valid BitSafe members but missing/wrong business role fails |
| G03 | Forged role, same party for both roles, other policy/batch approval fails |
| G04 | Revoked/expired approval, edited proposal and stale reserve fail without partial effects |
| G05 | Replay and two competing proposals produce exactly one finalization |
| G06 | Backend cannot actAs G; independently test configured participant rights |
| C01 | Investor acknowledgment once; wrong investor fails; no asset-transfer claim |
| C02 | Outstanding withdrawal, expiry recovery and execution/recovery race conserve units |
| P01 | Separate investor credentials cannot query/read another investor's records or shared batch |
| P02 | Backend errors, exports, logs and aggregate responses do not leak investor rows |

Daml Script authorization tests are not a substitute for separate authenticated Ledger API visibility tests. All local participants controlled by one developer prove mechanics, not organizational independence.

## Policy-driven role governance (proposed next slice, 2026-09-25)

Status: **design only, not implemented.** Supersedes the fixed two-reviewer rule for new batches; the shipped `alluvren-v1` 0.2.0 behavior stays valid for existing batches.

### Why

The v1 contracts hardcode one FundReviewer and one TreasuryReviewer per batch, with one approval each. The three user-reported interviews (Maya/COO, Daniel/Operations, Priya/Administrator; qualitative, not validated demand) describe five parties with distinct duties: COO final sign-off, Operations preparing the batch, Treasury confirming liquidity, Compliance clearing exceptions, and the Administrator's independent calculation. All three name the same re-review triggers: a change to liquidity, eligibility, requests, NAV or the governing rules. Their near-failures were all "approved one version, almost released another". The design below keeps Alluvren's core control (approvals bound to one exact batch) and makes *who must approve* a governed, versioned policy instead of code.

### Principles

- Exact-batch binding does not loosen. Flexibility comes from the policy, never from weaker approval targets.
- The policy is ledger data, pinned by contract ID. Changing it is itself a BitSafe-governed action.
- Required sign-off can depend on facts computed from the batch inside Daml, so a backend cannot downgrade the requirement.
- Separation of duties is enforced at finalization, not assumed.

### Contract model (proposed)

| Item | Shape | Notes |
| --- | --- | --- |
| `ApprovalRole` | extend enum with `ComplianceReviewer`, `AdministratorCheck`, `FinalSignoff` | Adding constructors at the end is upgrade-compatible; existing `FundReviewer`/`TreasuryReviewer` keep their meaning |
| `RoleRequirement` | `role : ApprovalRole`, `members : [Party]`, `quorum : Int` | Quorum N-of-M distinct members; `1 <= quorum <= length members`; members unique |
| `Trigger` | `FundedBelowBps Int` · `InvestorShareAboveBps Int` · `ExceptionsPresent` | Evaluated from batch rows and totals in integer basis points; no Float |
| `ConditionalRequirement` | `trigger : Trigger`, `requirement : RoleRequirement` | Added on top of base requirements when its trigger holds |
| `FundPolicy` (template) | `governanceParty`, `operator`, `fundId`, `version : Int`, `base : [RoleRequirement]`, `conditional : [ConditionalRequirement]`, `approvalTtl : RelTime` | Signatory governanceParty; observers operator and all members. `FundPolicy_Supersede` is consuming and governance-controlled |
| `UpdateFundPolicy` (template) | proposer, governanceParty, current policy CID, full replacement policy | Implements `GovernableAction`: after BitSafe threshold, supersedes the old policy and creates version + 1 |
| `RedemptionBatch` | add `policyCid : Optional (ContractId FundPolicy)` and `exceptions : Optional [ExceptionNote]` at the end | Optional trailing fields keep the upgrade valid. `None` = legacy two-reviewer rule |
| `RedemptionBatch_FinalizeWithPolicy` (new choice) | `approvalCids : [ContractId RoleApproval]` | The existing `RedemptionBatch_Finalize` signature is frozen by upgrade rules; it rejects batches that carry a policy |
| `FinalizePolicyRedemption` (template) | batch CID, approval CID list, description | New `GovernableAction` proposal for policy batches; the existing `FinalizeRedemption` stays for legacy batches |

### Finalization checks (policy batches)

`RedemptionBatch_FinalizeWithPolicy` must, atomically:

1. Fetch the pinned `policyCid`. If the policy was superseded (archived), fail: a rule change forces a new batch, matching the interviews' "new governing rule means new calculation and review".
2. Compute required roles = base requirements plus every conditional requirement whose trigger holds for this batch.
3. Consume each approval with the existing exact-target and expiry checks (batch CID, batch ID, policy version).
4. For every required role: count **distinct** approvers who are listed members of that role and approved with that role; require count ≥ quorum.
5. Separation of duties: no approver is the proposer or operator; no party approves under two roles in the same batch; **no approver appears as an investor in the batch rows** (conflict of interest).
6. Reject surplus or duplicate approval CIDs rather than ignoring them, so the proposal content is exact.
7. Create the investor entitlement and outstanding records exactly as 0.2.0 does.

Legacy `RedemptionBatch_Finalize` also gains the conflict-of-interest check (reviewer must not be a batch investor). This is a body-only change and upgrade-compatible.

### Governed policy change

`UpdateFundPolicy` goes through the same DecMan/BitSafe path as `FinalizeRedemption`: proposal → member confirmations → threshold → execute. Execution checks that the replaced policy is still current (no concurrent update race) and that the new version equals old + 1. Batches frozen under the old policy cannot finalize afterward and must be recovered. This extends BitSafe from gating one decision to governing the decision rules themselves.

### Demo path (the adverse state to show)

Policy: base Treasury 1-of-2 + Operations-independent Administrator check 1-of-1 + COO final sign-off; conditional `FundedBelowBps 5000` adds Compliance 1-of-1. A batch funded at 40% is proposed with Treasury, Administrator and COO approvals, passes the BitSafe threshold, and is **rejected** for missing Compliance. After Compliance approves the same batch, a new proposal finalizes it. A policy update mid-window then blocks an in-flight batch until it is re-frozen.

### Tests required

| ID | Required result |
| --- | --- |
| P-01 | Policy validation: quorum bounds, unique members, non-empty base, governance/operator not members |
| P-02 | Quorum: N-1 distinct members fail; N succeed; same member twice counts once |
| P-03 | Non-member approval, wrong role label, and approver holding two roles all fail |
| P-04 | Conflict of interest: approver who is a batch investor fails (policy and legacy paths) |
| P-05 | Triggers: funded 49.99% vs 50.00% boundary; investor-share threshold; exceptions present/absent; triggers computed from rows, not caller input |
| P-06 | Superseded policy blocks finalization; recovery still works |
| P-07 | Governed `UpdateFundPolicy`: below threshold fails; stale/concurrent update fails; version increments by exactly one |
| P-08 | Surplus or duplicate approval CIDs rejected; failed finalization leaves no investor records |
| P-09 | Upgrade check passes against 0.2.0; legacy batches (`policyCid = None`) behave exactly as before |
| P-10 | LocalNet: demo path above via DecMan, with evidence and cleanup |

### Deferred (not in this slice)

- Time-bound delegation (`RoleDelegation` with expiry and revocation) and emergency rotation through `UpdateFundPolicy`.
- Explicit `Rejection` contracts with reason codes, and attestation references on approvals (e.g., liquidity statement ID), to make the audit trail explain decisions.
- Eligibility snapshots and NAV inputs as ledger facts the triggers can read.

### Dependencies and honesty boundary

- Roles are only as strong as who controls the parties. Until Gate 8 maps authenticated users to parties, all roles are sandbox parties controlled by one developer; claim mechanics, not organizational independence.
- The role list comes from three user-reported interviews; confirm the policy shape with those contacts before treating it as validated.
