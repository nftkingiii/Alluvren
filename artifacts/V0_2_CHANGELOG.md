# Alluvren v1 foundation changes

Verification: production DAR build passed; both Daml Script tests passed
(allocation examples/tie rounding and rejection/finalization/replay sequence).
Node syntax check passed; HTTP smoke test confirmed POST execution returns 403.
DAR SHA256: `C8F112B04E9869CB2DB909B0EB967C608DFE5771F52D29964611BA85AE3C4875`.

Because the schema adds required fields to `ApprovalTarget`, Canton rejected the
first `alluvren-v0` 0.2.0 package as an unsafe in-place upgrade. The compatible
deployment is published as a new package identity: `alluvren-v1` 0.1.0,
package ID `7b10df4f60f86204fe5b920b9c2663cc214da4e9d29c86b4f171769d63c26512`.

This version changes the Daml contract schema. Existing `alluvren-v0` 0.1.0
contracts and earlier evidence remain historical; new batches and approvals
must be created using `alluvren-v1`. The new package was distributed across
the three-node BitSafe LocalNet and read back from all three nodes.

- Approvals reference the exact RedemptionBatch contract ID, batch label and policy version.
- Proposer cannot be either required reviewer; reviewers cannot be the governance party.
- Finalization checks approval governance identities and the execution deadline.
- Positive requested units, per-row allocation bounds, nonempty requests and unique request IDs are enforced.
- Allocation uses largest remainder proportional distribution, ties by request ID ascending.
- Total requested units are capped at 1,000,000,000 to bound integer multiplication.
- Backend writes are disabled pending authenticated operator authorization; binds to loopback only.

Remaining work: governed policy and role grants, liquidity commitment revalidation,
private investor receipts, authenticated backend writes, UI rehearsal, and new
BitSafe LocalNet end-to-end evidence. Current totalAllocated is a declared budget,
not a verified reserve or asset transfer. Current policyVersion is a label; the
implemented allocation algorithm is fixed. Request provenance is not yet enforced.
