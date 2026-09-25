// Mirrors Alluvren.Redemption's effectiveRequirements/triggerHolds so the UI can
// show what a batch still needs. Display only: the ledger stays authoritative
// and re-checks everything at finalization.

const int = (value) => {
  const n = typeof value === "string" ? Number(value) : value;
  return Number.isSafeInteger(n) ? n : null;
};
const list = (value) => (Array.isArray(value) ? value : []);

function parseTrigger(value) {
  const tag = value?.tag;
  if (tag === "FundedBelowBps" || tag === "InvestorShareAboveBps") return { tag, bps: int(value.value) };
  if (tag === "ExceptionsPresent") return { tag };
  return null;
}

function parseRequirement(value) {
  return { role: String(value?.role ?? ""), members: list(value?.members).map(String), quorum: int(value?.quorum) ?? 0 };
}

export function parsePolicy(argument) {
  return {
    fundId: String(argument?.fundId ?? ""),
    version: int(argument?.version),
    base: list(argument?.base).map(parseRequirement),
    conditional: list(argument?.conditional)
      .map((c) => ({ trigger: parseTrigger(c?.trigger), requirement: parseRequirement(c?.requirement) }))
      .filter((c) => c.trigger),
  };
}

export function parseBatch(argument) {
  return {
    batchId: String(argument?.batchId ?? ""),
    policyVersion: String(argument?.policyVersion ?? ""),
    fundReviewer: String(argument?.fundReviewer ?? ""),
    treasuryReviewer: String(argument?.treasuryReviewer ?? ""),
    totalRequested: int(argument?.totalRequested) ?? 0,
    totalAllocated: int(argument?.totalAllocated) ?? 0,
    rows: list(argument?.rows).map((r) => ({ allocatedUnits: int(r?.allocatedUnits) ?? 0 })),
    exceptions: list(argument?.exceptions),
    policyCid: typeof argument?.policyCid === "string" ? argument.policyCid : null,
  };
}

export function triggerHolds(batch, trigger) {
  switch (trigger.tag) {
    case "FundedBelowBps":
      return batch.totalAllocated * 10000 < trigger.bps * batch.totalRequested;
    case "InvestorShareAboveBps":
      return batch.totalAllocated > 0
        && batch.rows.some((r) => r.allocatedUnits * 10000 > trigger.bps * batch.totalAllocated);
    case "ExceptionsPresent":
      return batch.exceptions.length > 0;
    default:
      return false;
  }
}

export function triggerReason(trigger) {
  switch (trigger.tag) {
    case "FundedBelowBps": return `funded below ${trigger.bps / 100}%`;
    case "InvestorShareAboveBps": return `one investor above ${trigger.bps / 100}% of liquidity`;
    case "ExceptionsPresent": return "exceptions flagged on this batch";
    default: return "";
  }
}

// Base requirements plus triggered ones, merged per role by the highest quorum,
// in first-seen order (as in Daml).
export function effectiveRequirements(policy, batch) {
  const merged = [];
  const add = (requirement, reason) => {
    const existing = merged.find((r) => r.role === requirement.role);
    if (!existing) {
      merged.push({ ...requirement, reasons: reason ? [reason] : [], conditional: Boolean(reason) });
    } else if (reason) {
      existing.reasons.push(reason);
      existing.quorum = Math.max(existing.quorum, requirement.quorum);
    }
  };
  for (const r of policy.base) add(r, null);
  for (const c of policy.conditional) if (triggerHolds(batch, c.trigger)) add(c.requirement, triggerReason(c.trigger));
  return merged;
}

// approvals: [{ contractId, reviewer, role, batchCid }]
export function batchStatus({ batchCid, batch, policy, approvals }) {
  const fundedBps = batch.totalRequested > 0 ? Math.floor((batch.totalAllocated * 10000) / batch.totalRequested) : 0;
  const forBatch = approvals.filter((a) => a.batchCid === batchCid);
  let kind = "legacy";
  let requirements;
  if (batch.policyCid) {
    kind = "policy";
    if (!policy) return { batchCid, kind, policyVisible: false, fundedBps, fundingThresholdBps: null, roles: [], complete: false };
    requirements = effectiveRequirements(policy, batch);
  } else {
    requirements = [
      { role: "FundReviewer", members: [batch.fundReviewer], quorum: 1, reasons: [], conditional: false },
      { role: "TreasuryReviewer", members: [batch.treasuryReviewer], quorum: 1, reasons: [], conditional: false },
    ];
  }
  const roles = requirements.map((r) => {
    const seen = new Set();
    const valid = forBatch.filter((a) => a.role === r.role && r.members.includes(a.reviewer) && !seen.has(a.reviewer) && seen.add(a.reviewer));
    return {
      role: r.role,
      quorum: r.quorum,
      members: r.members,
      approvals: valid.map((a) => ({ approvalCid: a.contractId, reviewer: a.reviewer })),
      met: valid.length >= r.quorum,
      conditional: r.conditional,
      reasons: r.reasons,
    };
  });
  const thresholds = (policy?.conditional ?? []).filter((c) => c.trigger.tag === "FundedBelowBps").map((c) => c.trigger.bps);
  return {
    batchCid,
    kind,
    policyVisible: kind === "legacy" || Boolean(policy),
    policyVersion: batch.policyVersion,
    fundedBps,
    fundingThresholdBps: thresholds.length ? Math.max(...thresholds) : null,
    roles,
    complete: roles.every((r) => r.met),
  };
}
