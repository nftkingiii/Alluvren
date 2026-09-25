# Alluvren Evidence Ledger

Updated: 2026-09-25

This file separates verified local artifacts from sponsor/runtime evidence. Historical execution evidence is timestamped so it is not mistaken for a transaction submitted during the latest recovery session.

## Previously verified build and integration evidence

| Claim | Evidence | Result |
| --- | --- | --- |
| Alluvren custom template compiles | `dpm build` in `daml/alluvren-v0` using SDK 3.4.11 | PASS |
| Alluvren test package compiles | `dpm build` in `daml/alluvren-v0-test` | PASS |
| Wrong business role is rejected, then correct roles finalize | `dpm test` in `daml/alluvren-v0-test`; `testWrongBusinessRoleRejectedThenCorrectRolesFinalize` | PASS with permanent Temurin 17 JDK |
| DAR contains the expected module and dependencies | `dpm inspect-dar daml/alluvren-v0/.daml/dist/alluvren-v0-0.1.0.dar` | PASS |
| Production DAR integrity | SHA-256 `4DB964C257BBE529D8DFB71C496702A7BDA130A85D0A2FB1862AAE0C1A82A7C6` in `artifacts/SHA256SUMS.txt` | Recorded |
| Production DAR uploaded to Hackathon DevNet | NODERS console upload on 2026-09-21; participant `hackcanton-devnet-3` | PASS; NODERS confirmed the `Unvetted` label is misleading and the package is vetted by default |
| Reviewer parties provisioned | NODERS participant console, 2026-09-21 | PASS; Fund Reviewer `0bafda28-fund-reviewer::12204a9d883d1158141d8f099d06dd2e42cb52615deb42da5a46f042c8d0e1dbdf0e`; Treasury Reviewer `0bafda28-treasury-reviewer::12204a9d883d1158141d8f099d06dd2e42cb52615deb42da5a46f042c8d0e1dbdf0e` |
| Uploaded package identity | `alluvren-v0` `0.1.0`, package ID `c0397aa3a60c03a008e54bbf98333037d703d564e78e745e023299f92cfe4a3e` | Recorded |
| Test DAR integrity | SHA-256 `0188B2A2FAED2BD6D1EF4EE002A27C7A2B3F2F48CE4F04324455797FA13E9B5A` | Recorded |
| Schema-breaking DAR build and Daml tests | `alluvren-v1` 0.1.0 built locally; both Daml Script tests passed | PASS |
| Schema-compatible package identity | `alluvren-v1` 0.1.0; package ID `7b10df4f60f86204fe5b920b9c2663cc214da4e9d29c86b4f171769d63c26512`; SHA-256 `C8F112B04E9869CB2DB909B0EB967C608DFE5771F52D29964611BA85AE3C4875` | Recorded |
| BitSafe LocalNet reachable through Google Cloud tunnel | DecMan UIs at local ports 8081, 8082 and 8083; all three nodes reported healthy and connected | PASS |
| Alluvren DAR distributed across LocalNet | DecMan `POST /dars/upload` followed by `POST /dars/distribute`; distribution status completed after peer acceptance | PASS |
| Identical Alluvren package present on all LocalNet participants | `GET /packages/vetted` on ports 8081, 8082 and 8083 returned package ID `c0397aa3a60c03a008e54bbf98333037d703d564e78e745e023299f92cfe4a3e` | PASS |
| Updated Alluvren package distributed across all LocalNet participants | DecMan distribution `dars-distribute-1790014844` completed after P2/P3 invitation acceptance; `/packages/vetted` on ports 8081, 8082 and 8083 returned package ID `7b10df4f60f86204fe5b920b9c2663cc214da4e9d29c86b4f171769d63c26512` | PASS |
| Alluvren batch and reviewer approvals created on LocalNet | Ledger API submissions created `RedemptionBatch`, distinct `FundReviewer` and `TreasuryReviewer` `RoleApproval` contracts | PASS; batch update `1220cb46d469d9925b6a3354a0109c2615a957a5012d179ba09a4794e9bb94884116` |
| BitSafe below-threshold rejection | DecMan `/governance/execute` with one confirmation returned `Enough confirmations to execute action` failure | PASS; rejection is enforced by `GovernanceRules` |
| BitSafe threshold success for Alluvren | Two independent member confirmations followed by DecMan `/governance/execute` returned `Action executed successfully` | PASS; execution update `12208345ed1505eeb6a674eb893a7494ce0f99114c78892e5c524ad185b1c23d3687` |
| Alluvren execution audit evidence | DecMan `/governance/chain-audit` recorded `FinalizeRedemption`, two confirmers, `GovernableAction_Execute`, and `GovernanceExecutionResult` | PASS; action proposal CID `00d91279a2297d51b8e0928db989af1db6b4d571f9c7f667cfc1fd2b16b5b4b116ca12122041d5d96426b9a759fae363a560f0508d7770e275f8ab8f5af184124e0b88ca70` |

The Daml Script test proves the Alluvren contract boundary. The separately recorded LocalNet run proves the BitSafe threshold integration for the Alluvren action; it is not evidence of a Hackathon DevNet execution or an asset settlement.

## VM startup recovery verification (2026-09-24)

| Claim | Evidence | Result |
| --- | --- | --- |
| Cold-start failure cause identified | After VM restart, Postgres remained exited while Docker auto-started Canton and Splice. Splice logs showed `UnknownHostException: postgres` during database initialization. | Confirmed startup-order race; existing volumes/data were preserved |
| LocalNet recovered without reset | Started the existing Postgres container and waited for its health check; Canton then reached healthy. Restarted only the existing Splice container after Postgres was healthy. | PASS |
| Splice validator readiness | `/app/health-check.sh` returned success for validator endpoints on ports 2903, 3903 and 4903, plus SV endpoints on 5012 and 5014. | PASS; container health `healthy` |
| DecMan nodes and v1 package remained available | `/healthz` returned `{"status":"ok"}` on ports 8081, 8082 and 8083; `/packages/vetted` on each returned v1 package `7b10df4f60f86204fe5b920b9c2663cc214da4e9d29c86b4f171769d63c26512`. | PASS |
| Existing Alluvren v1 ledger execution re-read after recovery | DecMan chain audit returned the historical `FinalizeRedemption` result for proposal `00d91279a2297d51b8e0928db989af1db6b4d571f9c7f667cfc1fd2b16b5b4b116ca12122041d5d96426b9a759fae363a560f0508d7770e275f8ab8f5af184124e0b88ca70`; two distinct confirmation CIDs and the same execution update were present. The action description names `redemption-window-001` and an allocation of 300 of 500 requested units. | PASS; historical update `12208345ed1505eeb6a674eb893a7494ce0f99114c78892e5c524ad185b1c23d3687` (2026-09-21 16:37:42 UTC); no new transaction submitted during recovery |
| Repeatable, data-preserving VM recovery helper | `infra/recover-localnet.ps1` and `infra/recover-localnet.sh` were syntax-checked and executed; Postgres, Canton, Splice, all three DecMan health endpoints, v1 package availability and validator health checks passed. | PASS; existing volumes preserved |
| VM cost control | Google Cloud instance `alluvren-bitsafe` in `us-central1-a` was stopped after audit readback and verified `TERMINATED`. | PASS |

## DecMan payload adapter and live read verification (2026-09-25)

| Check | Evidence | Result |
| --- | --- | --- |
| DecMan payload projection | Added an allowlisted payload projection for the Alluvren redemption batch and role approval templates; focused Rust test confirms unlisted fields are dropped. `cargo fmt --check` passes. | PASS |
| Linux DecMan build and type generation | Temporary VM-side build completed with `--features typegen`; the `ContractWithBlob.payload` field is exposed as TypeScript `unknown` for generated API types. | PASS |
| Package query configuration | Canton LocalNet rejected the package hash with `expected a package name`; using the package reference `#alluvren-v1` was accepted. Backend config now uses `ALLUVREN_PACKAGE_REF`, and `.env.example` quotes the leading `#`. | PASS |
| Live backend-to-DecMan workflow read | Temporary backend queried the live LocalNet through a temporary DecMan build. `/api/workflow` returned threshold 2 and the historical `FinalizeRedemption` execution result with two distinct confirmers. | PASS; historical update `12208345ed1505eeb6a674eb893a7494ce0f99114c78892e5c524ad185b1c23d3687`; no ledger write submitted |
| Live active payload decoding | Created a tagged `RedemptionBatch` plus separate `FundReviewer` and `TreasuryReviewer` `RoleApproval` contracts on LocalNet participant 1. The compiled DecMan adapter returned allowlisted JSON for all three, including allocation row values, reviewer role names, and the exact batch CID/id/policy binding. | PASS; batch create update `1220b1aaf2cbd782225495c11a892baa407cd8b477d27c5c8d3f30b503054ed099de`; approval updates `1220b00b263238127a3af4be07322e05a1bed1867b88ddbb1ef10d094f8c3e89be92` and `12206cfecd98f837ef2f9f078f150437f126269f08e43352259dfe81a3e17a1bd6e4` |
| Tagged test contract cleanup | Revoked both reviewer approvals and exercised `RedemptionBatch_RecoverExpired` after its deliberately elapsed recovery deadline. Follow-up DecMan active queries returned empty arrays for both templates. | PASS; cleanup updates `1220510a398d6d1ad3c682bcae55fac2ca256f26f67e23ab731634d6f09b21f0a013`, `12204c635d2154f2b40361f309426c8790367994dc5aee454b0414e013e1ceda2bd5`, and `1220c61cd6c6fdab3b8b4ba7c0f5d4819331981a2283b2b55b9a91ed9f3f76f91e1a`; no test contracts remain active |
| Live stale-approval rejection | Created two otherwise identical active batches with distinct contract IDs and two approvals bound to the source batch. Submitted `RedemptionBatch_Finalize` against the other batch. Canton returned `DAML_FAILURE` with `The requirement 'Fund approval targets the wrong batch' was not met`; no finalization update was emitted. The harness used a locally authorized synthetic governance party because `demo-party` is not an acting party on this participant; this directly tests the Alluvren choice guard, not the separate BitSafe threshold. | PASS; source batch update `1220669aaec285a5700d107d989c001cecf73d7eed09292495cdebfc18bc9a39ce21`; target batch update `1220cad21ed25d0aeb1ad087a5b319c9db27cf80ad0ef8f0d5e7c4ce306fe1257d08`; fund approval `12206e0df81750806ea04506daffdc70096ec32440fd85d04f02a0f0ff4bddc8a766`; treasury approval `1220bc52f4be0e4e96c95fc33e4323725f38b137541538765f8cfc487da597f09439`; failed attempt correlation `dd758ef2-3833-49ec-83d6-2775b43e4833` |
| Failed-attempt rollback and cleanup | After the failed finalize, both approval consume choices succeeded, confirming the failed transaction had not consumed them. The synthetic approvals were then consumed explicitly and both expired test batches recovered. Follow-up queries returned no active test contracts. | PASS; approval cleanup updates `122025aeace8b137aa3391b7d94d6ef7fea118c18b418cc46fe6b481cfe82c14e958`, `12204fb550a4453f7afa148b6e3d5af297cf9f1499d8b3a232adca5dae197237d7ea`; batch recovery updates `1220294416380067bad78e0478b680d348d3b1a3cfd2319e492693a534110c06b7d6` and `1220a6ffc44c841257c48da900218d24a7b024486854768ec60c00ec096cf42df0d4` |
| Backend tests and syntax | `npm test` (2 tests) and `npm run check` pass after package-reference config change. | PASS |
| Frontend checks | `npm test` (6 tests), `npm run build`, and `npx playwright test` (7/7) pass. | PASS |
| Rust workspace tests | Fresh `DECMAN_SKIP_FRONTEND=1 cargo test --workspace --lib -- --test-threads=1` with protoc 36.2 on PATH passed: common 20/20, DecMan 598/598, decman-lib 120/120, decman-wallet 6/6. | PASS; 744 total |
| Test resource shutdown | Temporary backend/tunnel and disposable VM containers/worktree removed; existing LocalNet services/data were preserved. After the 2026-09-25 payload-decoding and Daml stale-CID tests, `gcloud compute instances stop` completed and `describe` returned `TERMINATED` for `alluvren-bitsafe` in `us-central1-a`. | PASS for that earlier session; this session's final shutdown is recorded below |

The live read proves the compiled adapter can query the LocalNet, read its audit history, and project active batch/approval payloads into allowlisted JSON. The separate Gate 6 run below subsequently verified stale-CID and tamper rejection after BitSafe threshold, valid execution, replay rejection, and cleanup. Any settlement asset transfer remains unverified.

## Gate 6 threshold-bound integrity tests (2026-09-25)

The repeatable harness `infra/test-gate6-localnet.sh` submitted the workflow through the LocalNet Ledger API and DecMan. It used the seeded three-member governance party and its 2-of-3 threshold, plus locally controlled operator/reviewer parties. These are test identities within one sandbox, not independent external operators or customer validation.

| Check | Evidence | Result |
| --- | --- | --- |
| Below-threshold execution | Stale proposal `009d5cedc320cd92e35d8d75130d78c7c7cb4226aff66a40c8d5e02a49c5a6a272ca1212209671edc565a868ccc96143a67ebef12ed251c36572fce1d3e3dd028ba9d18ba3`; one confirmation returned the expected `Enough confirmations` rejection. | PASS |
| Stale batch binding after threshold | The same proposal reached two confirmations; execution rejected the source-bound Fund approval against a distinct target batch with `Fund approval targets the wrong batch`. | PASS; Daml transaction rejection after BitSafe threshold |
| Reviewer identity mismatch after threshold | Proposal `00297d2ba93e72571e28e5be60a9479c34c8f0c5d8bdb6db08576d676b1db83356ca12122005e8e29d67fd87b5fff47ca186685e11e20c4faa664e761d49930109d09efbf5`; after threshold, execution rejected the approval because it was not issued by the configured Fund reviewer. | PASS |
| Valid finalization | Proposal `000f242db7a520f7f3fb2cabd269ab874e644562c70a2af398eb3b36ede839cfd5ca121220092bf7e8d36795f8973abb0c0fc850b7232026b8d0dc2075df6ef87938b1473c`; two distinct member confirmations; DecMan audit offset 4917 recorded `GovernableAction_Execute`, `FinalizeRedemption`, and `GovernanceExecutionResult`. | PASS; update `1220d91d50c5f8edcc8b2889b9315d55171c25203c6791e7bc05e25e2fa098621fe5` |
| Replay rejection | Re-submitting the same valid proposal and confirmation CIDs after execution returned an HTTP 400/500 rejection. | PASS; the harness asserted rejection |
| Rejection atomicity and cleanup | Failed stale/tamper proposals and four unconsumed confirmations were canceled. Remaining Fund approval `00b90ac1...900c2ea5e`, Treasury approval `00d83e2a...a69bf89e`, and tampered-reviewer approval `002b9b66...8e3bf4d` were revoked in update `1220a4951e30cca784f0e3990a93c2d17ba68f57c49deb498e85fa8e3249fd9ad3f4`; expired source batch `0080cddf...9ab12ff` was recovered in update `1220be4f17f27209171931718da6da5bf117d06a1756f7c221cd3a7cca27998e24c5`. DecMan active-contract queries on the authorized participant returned no remaining test batches, approvals, or proposals. | PASS |
| Repeatable harness cleanup | Fixed signer-party-to-DecMan-node mapping, changed TSV cleanup to a line-oriented read loop, and replaced the ineffective placeholder query with checked active-contract queries. `bash -n infra/test-gate6-localnet.sh` passes. | PASS syntax; full harness run preceded this cleanup-only harness correction |
| Final LocalNet cleanup verification | DecMan `/contracts/query` on the authorized participant returned zero active `RedemptionBatch`, `RoleApproval` (for Fund, Treasury, and operator parties), and `FinalizeRedemption` contracts. | PASS; five zero-count queries |
| Google Cloud cost control after Gate 6 | `gcloud compute instances stop alluvren-bitsafe` completed; subsequent `gcloud compute instances describe ... --format="value(status)"` returned `TERMINATED`. | PASS; VM stopped after all tests and cleanup |

Gate 6 is complete for the LocalNet integration. It does not establish independent external operators, investor privacy, settlement, or authenticated frontend writes.

## Gate 7 Daml-level investor outcomes (2026-09-25, local only)

`alluvren-v1` 0.2.0 adds module `Alluvren.Claims` (`ClaimEntitlement`, `ClaimReceipt`, `OutstandingRedemption`, `OutstandingReleaseReceipt`). `RedemptionBatch_Finalize` keeps its signature and now also creates, for each allocation row, a private entitlement for allocated units (if > 0) and an outstanding record for unallocated units (if > 0). Each record is signed by the governance party and observed only by its investor. Acknowledgment and withdrawal are investor-controlled, consuming, and produce `DemoAcknowledgment` receipts; no asset moves and no share balance is restored (investor positions are Gate 2).

| Check | Evidence | Result |
| --- | --- | --- |
| Baseline reproducibility | Fresh `dpm build` (SDK 3.4.11, `~/dpm-sdk/windows-amd64/bin/dpm.exe`, not on PATH) of unmodified v1 0.1.0 reproduced SHA-256 `C8F112B0...4875` byte-for-byte; both existing Daml Script tests passed | PASS |
| Smart-contract-upgrade compatibility | `daml.yaml` `upgrades: ../../artifacts/alluvren-v1-0.1.0.dar`; 0.2.0 builds cleanly. Negative control on a throwaway copy (adding a required field to `RoleApproval`) failed the upgrade typecheck as expected | PASS locally; LocalNet upgrade/vetting not yet run |
| 0.2.0 DAR identity | `artifacts/alluvren-v1-0.2.0.dar`, SHA-256 `4696F1DE8C8CBF580D686014B6DC860E568DE9BD128D73766C84D7E1FDA23741`. Package ID not yet read back from a participant | Recorded |
| Finalization creates private records (600/300/100 vs 500 → 300/150/50) | `testFinalizeCreatesPrivateInvestorRecords`: each investor sees exactly one entitlement and one outstanding record with correct units; allocated + outstanding = requested; batch archived | PASS |
| Visibility and wrong-party actions | `testInvestorsCannotSeeOrActOnOthersRecords`: other investors, operator and both reviewers cannot fetch another investor's records; another investor cannot acknowledge or withdraw them | PASS |
| Replay / duplicate prevention | `testAcknowledgeAndWithdrawOnlyOnce`: second acknowledgment and second withdrawal fail; receipts private to the investor and labelled `DemoAcknowledgment` | PASS |
| Zero allocation | `testZeroAllocationCreatesNoEntitlement`: no zero-value entitlement; full request outstanding | PASS |
| Atomicity on rejected finalization | `testRejectedFinalizationCreatesNoInvestorRecords`: wrong-role approval rejects finalization and leaves no investor records | PASS |
| Tests detect a privacy leak | Mutation (entitlements observed by every batch investor) made three privacy/lifecycle tests fail; code restored and all 7 tests re-passed | PASS |
| Backend exposure | Backend queries only `RedemptionBatch`/`RoleApproval` by package name `#alluvren-v1`; new investor templates are not exposed by existing read routes | Checked by source inspection; backend tests not rerun (no backend change) |

Boundary: Daml Script visibility is not an authenticated Ledger API test.

## Gate 7 on BitSafe LocalNet (2026-09-25)

VM `alluvren-bitsafe` started, services recovered with `infra/recover-localnet.sh` (no volume reset; DecMan 8081-8083 healthy, validators healthy), then stopped and verified `TERMINATED` after the run.

| Check | Evidence | Result |
| --- | --- | --- |
| Upgrade accepted by Canton | `infra/distribute-dar-localnet.sh` ran DecMan `/dars/distribute` (workflow `dars-021a3b39dabfe4c5-dars-distribute-1790340866`, HTTP 202, P2/P3 accepted, status completed); `/packages/vetted` on 8081, 8082, 8083 each returned `alluvren-v1` 0.2.0 package ID `070bfd7a3440607deb6455b7ce299eee4fbf09f41f4d4d56c5001681df363b24` | PASS |
| Governed finalization on 0.2.0 | `infra/test-gate7-localnet.sh` run `gate7-1790341203`: batch (A 600→300, B 300→150), Fund and Treasury approvals, `FinalizeRedemption` confirmed on 8081 and 8082, executed on 8083: HTTP 200 `Action executed successfully` | PASS; batch CID `00458cfb82bdc9c82aa9329ea94e666a9f49fdfbb0714e4de0e671abcd5008cb71ca...` |
| Records created by governed execution | Per-party active-contract queries (participant 1 JSON API): A sees exactly one 300-unit `ClaimEntitlement` and one 300-unit `OutstandingRedemption`; B sees exactly its 150/150 | PASS; A entitlement `0000aa08c741...`, A outstanding `00081c73ed22...`, B entitlement `00e6399342a7...`, B outstanding `000fbe366336...` |
| Ledger per-party privacy | A's query contains nothing of B's and vice versa; operator, Fund reviewer, Treasury reviewer and proposer queries return no `Alluvren.Claims` contracts | PASS |
| Wrong-party actions | B exercising A's acknowledge and withdraw choices was rejected (HTTP 404: contract not visible to B) | PASS |
| Once-only acknowledgment / withdrawal | A acknowledged (receipt `00dfbdecff07...`, 300 units, `DemoAcknowledgment`) and withdrew (release `00579cd0d093...`, 300 units); both replays rejected; A's receipt not visible to B | PASS |
| Cleanup | B consumed its own records; no open entitlements/outstanding remain for this run. Demo receipts remain active as evidence. An earlier run `gate7-1790341115` stopped on a harness parsing bug after A's acknowledgment; its remaining open records were consumed via the harness `cleanup` mode before the clean run | PASS |
| Audit readback | DecMan `/governance/chain-audit` on 8081 returned only 16 entries up to offset 876 (2026-09-21) regardless of page parameters, so it does not show this run (or Gate 6's offset 4917) | NOT VERIFIED; audit endpoint coverage needs investigation |

Test identities: investors are two existing participant-1 parties with no Alluvren role (`app_user_localnet-localparty-1`, `party-b3866661...`), controlled in one sandbox. Visibility used the shared harness ledger user with per-party filters: this proves the ledger's per-party projection, not isolation between separately authenticated users. Separate-credential tests (DESIGN P01/P02) remain unverified; minting per-investor tokens was not done in this session.

## Policy-driven role governance, local (2026-09-25)

`alluvren-v1` 0.3.0 adds `FundPolicy` (per-role N-of-M quorums, conditional requirements), BitSafe-governed `UpdateFundPolicy`, `RedemptionBatch_FinalizeWithPolicy` and the `FinalizePolicyRedemption` proposal; legacy finalization gains a conflict-of-interest check. Spec: `daml/DESIGN.md` § Policy-driven role governance.

| Check | Evidence | Result |
| --- | --- | --- |
| Upgrade compatibility with 0.2.0 | `upgrades: ../../artifacts/alluvren-v1-0.2.0.dar`; build succeeds with warnings only: changed observers and precondition on `RedemptionBatch` (both evaluate unchanged for legacy batches, where the new optional fields are `None`) and internal Archive name renumbering | PASS locally; not yet vetted on LocalNet |
| DAR identity | `artifacts/alluvren-v1-0.3.0.dar`, SHA-256 `CF56BF08595DD5CBA50A2A94BEAAA83B72837224903F4D72B8DA737BA5F2B836`, package `b2dcd98664024d1d872a6ec027e685400bfb568c0a6df35cf7322a333494a72d` | Recorded |
| P-01 policy validation | `testPolicyValidation`: empty base, quorum 0 or above member count, duplicate members, governance/operator as members, duplicate base roles, out-of-range triggers, inconsistent conditional members, version 0 all rejected; governed creation must start at v1 | PASS |
| P-02/P-03/P-04/P-08 | `testBaseRequirementsAndSeparation`: missing role, non-member, wrong role label, surplus approval, duplicate CID, same member twice and investor-approver all rejected; no records after rejections; exact set finalizes | PASS |
| P-05 triggers | `testConditionalTriggers`: 49.99% funded needs Compliance, 50.00% does not; >80% investor share raises Treasury quorum to 2; exception notes need Compliance; one party cannot fill Treasury and Compliance; governed `FinalizePolicyRedemption` executes | PASS |
| P-06/P-07 policy change | `testPolicyUpdateBlocksPinnedBatch`: governed v1→v2; batch pinned to v1 cannot finalize; stale update against v1 and version skip rejected; blocked batch recoverable after deadline | PASS |
| P-09 legacy path | `testLegacyPathGuards`: legacy choice rejects policy batches; legacy batch with an investor-reviewer rejected with no records. All 7 earlier tests still pass | PASS |
| Tests catch regressions | Mutations disabling the conflict-of-interest check, triggers, distinct-approver check, surplus rejection and exact-next-version rule each made at least one test fail; code restored, 12/12 pass | PASS |
| Backend compatibility | Backend passes `RoleApproval.role` through as text, so new roles display without change; new batch fields are not projected | Source inspection |

Boundary: the Script tests execute the governable actions directly as the governance party; the BitSafe threshold path is covered by P-10 below.

## P-10 policy governance on BitSafe LocalNet (2026-09-25)

VM started, services recovered (`infra/recover-localnet.sh` restarted Splice after the known Postgres DNS race; no volume reset), then stopped and verified `TERMINATED`.

| Check | Evidence | Result |
| --- | --- | --- |
| 0.3.0 upgrade accepted by Canton | `infra/distribute-dar-localnet.sh`: workflow `dars-021a3b39dabfe4c5-dars-distribute-1790345349` completed; 8081, 8082, 8083 each report package `b2dcd98664024d1d872a6ec027e685400bfb568c0a6df35cf7322a333494a72d` vetted | PASS |
| Policy creation needs the BitSafe threshold | `infra/test-policy-localnet.sh` run `p10-1790345489`: `UpdateFundPolicy` with one confirmation rejected (`Enough confirmations`); after two confirmations it executed and FundPolicy v1 became visible to its members (`00bd0d02d3ce...`) | PASS |
| Risk-based requirement enforced after threshold | 40%-funded batch with Treasury + COO approvals: `FinalizePolicyRedemption` reached the threshold, then Daml rejected it with `Missing required approvals for role ComplianceReviewer`; no investor records created; proposal and confirmations cancelled | PASS |
| Governed finalization with Compliance | Same batch with Treasury + COO + Compliance approvals: executed (HTTP 200, `Action executed successfully`); investor sees a 400-unit entitlement (`00332d6b20fd...`) and 600-unit outstanding record (`00675bd4751a...`) | PASS |
| Policy change is governed and blocks pinned batches | `UpdateFundPolicy` v1→v2 executed after two confirmations; v1 no longer active, v2 active. A second batch pinned to v1 with all three approvals was rejected on execution after threshold (HTTP 500) | PASS; rejection reason text not captured by the harness (expected: superseded policy contract not found) |
| Cleanup | Investor acknowledged/withdrew; blocked-batch approvals revoked; blocked batch recovered after its deadline; queries for all involved parties found no open batches, approvals, proposals or investor records for the run | PASS; FundPolicy v2 and demo receipts remain active by design |

Policy used on LocalNet (smaller than the Script-test policy because the harness has few actAs parties): Treasury 1-of-1, COO final sign-off 1-of-1, Compliance 1-of-1 when funded below 50%. The local `gcloud ssh` client exited with code 139 after the remote script printed its final PASS line; with `set -Eeuo pipefail` the remote script can only reach that line if every step passed. Sandbox parties are controlled by one developer: mechanics, not organizational independence.

## Workspace checks (2026-09-24)

| Check | Result |
| --- | --- |
| Frontend unit tests | PASS; 6 tests, 0 failures (`npm test` in `frontend`) |
| Frontend production build | PASS (`npm run build` in `frontend`) |
| Frontend browser tests | PASS; 7/7 Playwright journeys, including connected proposals, error recovery and responsive behavior |
| Backend API tests | PASS; 2 tests for normalized DecMan read data, no contract-blob leakage and blocked governance writes |
| Backend syntax check | PASS (`npm run check` in `backend`) |
| Live-evidence UI/API integration | PASS against mocked DecMan responses; displays governance proposals, threshold progress, audit events, decoded batch allocations and reviewer roles. DecMan now has an additive allowlisted `include_payload` path for those two templates. The VM was stopped, so the Rust extension and decoded fields have not yet been compiled or verified against LocalNet. |
| Fresh Daml compile in this session | NOT RUN; `dpm` and `daml` are not installed on the Windows PATH. Previously recorded Daml Script tests remain the available evidence. |

## Still unverified

- Alluvren DAR distribution to the BitSafe LocalNet participants is verified. Distribution to any future Gold or external participant remains unverified.
- Independent external-operator reproduction and investor privacy behavior.
- Actual settlement asset transfer. The current receipt is explicitly a demo acknowledgment.
