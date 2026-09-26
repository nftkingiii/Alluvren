# alluvren-v1 0.4.0: sealed batches

- Package ID `564cef4f541a96c6616b1ec99ecc49177ef91d0de690ae23bcd354e20f7d1315`; SHA-256 of `alluvren-v1-0.4.0.dar` in `SHA256SUMS.txt`.
- Smart-contract upgrade of 0.3.0 (`upgrades:` checked at build). The only schema change to existing templates is a new trailing field, `RedemptionBatch.sealed : Optional SealedSummary`. The batch precondition now branches on it; for batches without it (every earlier batch), the checks are unchanged.
- New module `Alluvren.Sealed`: `SealedFinalization`, `AllocationBook` with `AllocationBook_Distribute`, `PrivateEntitlement`, `PrivateOutstanding`, `PrivateClaimReceipt`, `PrivateReleaseReceipt`.
- New module `Alluvren.Allocation`: the largest-remainder check, now shared by regular and sealed batches.
- `RedemptionBatch_FinalizeWithPolicy` creates a `SealedFinalization` (no rows) for sealed batches instead of governance-signed investor records. For `InvestorShareAboveBps`, sealed batches use their declared largest allocation, which is checked against the real rows at distribution.
- Uses `DA.Crypto.Text.sha256` (an alpha Daml feature), compiled for LF 2.2 with `-Wno-crypto-text-is-alpha`.
- Verification: 19 Daml Script tests pass (12 existing, 7 new sealed tests S-01..S-07). Six mutations were each caught by the targeted test: commitment check, approver-investor check, declared-maximum check, single-use finalization, the trigger using the declared maximum, and governance visibility of the book. Design: `daml/DESIGN.md`.
