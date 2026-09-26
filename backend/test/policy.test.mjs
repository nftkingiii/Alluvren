import assert from "node:assert/strict";
import { test } from "node:test";
import { batchStatus, effectiveRequirements, parseBatch, parsePolicy } from "../src/policy.mjs";

// JSON Ledger API encodings: Int as string, enums as strings, variants as {tag, value}.
const policy = parsePolicy({
  fundId: "demo-fund",
  version: "1",
  base: [
    { role: "TreasuryReviewer", members: ["t1", "t2"], quorum: "1" },
    { role: "AdministratorCheck", members: ["adm"], quorum: "1" },
    { role: "FinalSignoff", members: ["coo"], quorum: "1" },
  ],
  conditional: [
    { trigger: { tag: "FundedBelowBps", value: "5000" }, requirement: { role: "ComplianceReviewer", members: ["comp", "t2"], quorum: "1" } },
    { trigger: { tag: "InvestorShareAboveBps", value: "8000" }, requirement: { role: "TreasuryReviewer", members: ["t1", "t2"], quorum: "2" } },
    { trigger: { tag: "ExceptionsPresent", value: {} }, requirement: { role: "ComplianceReviewer", members: ["comp", "t2"], quorum: "1" } },
  ],
});
const batch = (rows, extra = {}) => parseBatch({
  batchId: "b", policyVersion: "demo-fund@v1", policyCid: "pol", fundReviewer: "coo", treasuryReviewer: "t1",
  totalRequested: String(rows.reduce((s, r) => s + r[0], 0)),
  totalAllocated: String(rows.reduce((s, r) => s + r[1], 0)),
  rows: rows.map(([requestedUnits, allocatedUnits]) => ({ requestedUnits: String(requestedUnits), allocatedUnits: String(allocatedUnits) })),
  exceptions: null,
  ...extra,
});
const roles = (reqs) => reqs.map((r) => `${r.role}:${r.quorum}`);

test("requirements match the Daml policy at the trigger boundaries", () => {
  assert.deepEqual(roles(effectiveRequirements(policy, batch([[600, 300], [400, 200]]))), ["TreasuryReviewer:1", "AdministratorCheck:1", "FinalSignoff:1"]);
  assert.deepEqual(roles(effectiveRequirements(policy, batch([[6000, 2999], [4000, 2000]]))), ["TreasuryReviewer:1", "AdministratorCheck:1", "FinalSignoff:1", "ComplianceReviewer:1"]);
  assert.deepEqual(roles(effectiveRequirements(policy, batch([[900, 450], [100, 50]]))), ["TreasuryReviewer:2", "AdministratorCheck:1", "FinalSignoff:1"]);
  assert.deepEqual(roles(effectiveRequirements(policy, batch([[600, 300], [400, 200]], { exceptions: [{ requestId: "r", note: "lockup" }] }))),
    ["TreasuryReviewer:1", "AdministratorCheck:1", "FinalSignoff:1", "ComplianceReviewer:1"]);
});

test("status counts distinct member approvals for this batch only", () => {
  const b = batch([[6000, 2999], [4000, 2000]]);
  const status = batchStatus({
    batchCid: "b1", batch: b, policy,
    approvals: [
      { contractId: "a1", reviewer: "t1", role: "TreasuryReviewer", batchCid: "b1" },
      { contractId: "a2", reviewer: "t1", role: "TreasuryReviewer", batchCid: "b1" },
      { contractId: "a3", reviewer: "outsider", role: "FinalSignoff", batchCid: "b1" },
      { contractId: "a4", reviewer: "coo", role: "FinalSignoff", batchCid: "other" },
      { contractId: "a5", reviewer: "adm", role: "AdministratorCheck", batchCid: "b1" },
    ],
  });
  assert.equal(status.fundedBps, 4999);
  assert.equal(status.fundingThresholdBps, 5000);
  const byRole = Object.fromEntries(status.roles.map((r) => [r.role, r]));
  assert.equal(byRole.TreasuryReviewer.approvals.length, 1);
  assert.equal(byRole.TreasuryReviewer.met, true);
  assert.equal(byRole.FinalSignoff.met, false);
  assert.equal(byRole.AdministratorCheck.met, true);
  assert.equal(byRole.ComplianceReviewer.conditional, true);
  assert.deepEqual(byRole.ComplianceReviewer.reasons, ["funded below 50%"]);
  assert.equal(status.complete, false);
});

test("legacy batches need the named fund and treasury reviewers; hidden policies are reported", () => {
  const legacy = parseBatch({ batchId: "l", policyVersion: "legacy", policyCid: null, fundReviewer: "f", treasuryReviewer: "t", totalRequested: "10", totalAllocated: "5", rows: [] });
  const status = batchStatus({ batchCid: "l1", batch: legacy, policy: null, approvals: [{ contractId: "x", reviewer: "f", role: "FundReviewer", batchCid: "l1" }] });
  assert.equal(status.kind, "legacy");
  assert.deepEqual(status.roles.map((r) => [r.role, r.met]), [["FundReviewer", true], ["TreasuryReviewer", false]]);

  const hidden = batchStatus({ batchCid: "p1", batch: batch([[10, 5]]), policy: null, approvals: [] });
  assert.equal(hidden.policyVisible, false);
  assert.equal(hidden.complete, false);
});

test("sealed batches use the declared largest row for the concentration trigger", () => {
  const sealed = (maxRowAllocatedUnits) => parseBatch({
    batchId: "s", policyVersion: "demo-fund@v1", policyCid: "pol", fundReviewer: "coo", treasuryReviewer: "t1",
    totalRequested: "2000", totalAllocated: "1000", rows: [], exceptions: null,
    sealed: { commitment: "a".repeat(64), rowCount: "2", maxRowAllocatedUnits: String(maxRowAllocatedUnits) },
  });
  assert.equal(sealed(900).sealed.rowCount, 2);
  assert.deepEqual(roles(effectiveRequirements(policy, sealed(800))), ["TreasuryReviewer:1", "AdministratorCheck:1", "FinalSignoff:1"]);
  assert.deepEqual(roles(effectiveRequirements(policy, sealed(801))), ["TreasuryReviewer:2", "AdministratorCheck:1", "FinalSignoff:1"]);
});
