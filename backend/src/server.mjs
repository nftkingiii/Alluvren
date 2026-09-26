import http from "node:http";
import { URL } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { APPROVAL_ROLES, createAuth, hasRole, isStaff, loadAccounts, publicUser } from "./auth.mjs";
import { createLedger, damlReason, templateName } from "./ledger.mjs";
import { batchStatus, parseBatch, parsePolicy } from "./policy.mjs";

const PORT = Number(process.env.PORT || 8787);
const MAX_BODY = 32 * 1024;
const UPSTREAM_TIMEOUT_MS = 8000;
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_MINUTE || 60);
const rateBuckets = new Map();

function parseNodeUrls(value = "") {
  return Object.fromEntries(value.split(",").map((entry) => entry.trim().split("=")).filter(([name, url]) =>
    /^(p1|p2|p3)$/.test(name) && /^https?:\/\//.test(url)
  ));
}

const nodeUrls = parseNodeUrls(process.env.DEC_MAN_URLS || "p1=http://localhost:8081");
const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS || "http://localhost:5173").split(",").map((value) => value.trim()).filter(Boolean));
const governancePartyId = process.env.GOVERNANCE_PARTY_ID || "";
const rulesContractId = process.env.RULES_CONTRACT_ID || "";
const alluvrenPackageRef = process.env.ALLUVREN_PACKAGE_REF || "";
const environment = process.env.ENVIRONMENT || "LocalNet";
const appModule = "Alluvren.Redemption";

function json(res, status, payload, origin, extraHeaders = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    ...(origin ? {
      "access-control-allow-origin": origin,
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "content-type,x-alluvren-csrf",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      vary: "Origin",
    } : {}),
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

function errorMessage(error) {
  return error?.name === "AbortError" ? "Configured upstream timed out" : "Configured upstream unavailable";
}

async function upstream(node, path, options = {}) {
  const base = nodeUrls[node];
  if (!base) throw Object.assign(new Error("Unknown configured node"), { status: 400 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(new URL(path, base), {
      ...options,
      signal: controller.signal,
      headers: { accept: "application/json", ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) }
    });
    const text = await response.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { message: "Invalid upstream response" }; }
    if (!response.ok) throw Object.assign(new Error("Upstream request failed"), { status: response.status, body });
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function validId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && /^[A-Za-z0-9:_-]+$/.test(value);
}

function jsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      if (Buffer.byteLength(data) > MAX_BODY) return;
      data += chunk;
      if (Buffer.byteLength(data) > MAX_BODY) reject(Object.assign(new Error("Body too large"), { status: 413 }));
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(Object.assign(new Error("Invalid JSON"), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

function rateLimited(ip) {
  const now = Date.now();
  const bucket = rateBuckets.get(ip) || { started: now, count: 0 };
  if (now - bucket.started > 60_000) { bucket.started = now; bucket.count = 0; }
  bucket.count += 1;
  rateBuckets.set(ip, bucket);
  return bucket.count > RATE_LIMIT;
}

function fixedAction() {
  return { type: "governance_set_threshold", new_threshold: 0 };
}

async function workflowSnapshot() {
  if (!governancePartyId) {
    throw Object.assign(new Error("Governance party is not configured"), { status: 503 });
  }
  const party = encodeURIComponent(governancePartyId);
  let view;
  const governanceView = () => (view ??= ledger.activeContracts(governancePartyId));
  const [governance, audit, batches, approvals, sealedFinalizations] = await Promise.all([
    upstream("p1", `/governance/confirmations?party_id=${party}&limit=25`),
    upstream("p1", `/governance/chain-audit?party_id=${party}&limit=25&refresh=true`),
    queryContracts("RedemptionBatch", governanceView),
    queryContracts("RoleApproval", governanceView),
    // Sealed batches (Alluvren.Sealed) are only read through the Ledger API.
    ledger.configured ? queryContracts("SealedFinalization", governanceView) : [],
  ]);
  const domainActions = Array.isArray(governance?.domain_actions) ? governance.domain_actions : [];
  const auditEntries = Array.isArray(audit?.entries) ? audit.entries : [];
  return {
    environment,
    governancePartyId,
    rulesContractId: governance?.rules_contract_id || rulesContractId || null,
    threshold: Number.isInteger(governance?.threshold) ? governance.threshold : null,
    proposals: domainActions.map((item) => ({
      proposalCid: item.proposal_cid,
      label: item.action_label,
      description: item.description || null,
      proposer: item.proposer || null,
      confirmationCount: Number.isInteger(item.confirmation_count) ? item.confirmation_count : 0,
      confirmations: (Array.isArray(item.confirmations) ? item.confirmations : []).map((confirmation) => ({
        party: confirmation.confirming_party,
        createdAt: confirmation.created_at || null,
        expiresAt: confirmation.expires_at || null,
      })),
      canExecute: item.can_execute === true,
      orphaned: item.orphaned === true,
      createdAt: item.created_at || null,
    })),
    activeContracts: {
      configured: Boolean(alluvrenPackageRef),
      redemptionBatches: batches,
      roleApprovals: approvals,
      sealedFinalizations,
    },
    audit: auditEntries.map((entry) => ({
      eventType: entry.event_type,
      timestamp: entry.timestamp,
      template: entry.template_id,
      summary: entry.action_summary,
      contractId: entry.contract_id,
      updateId: entry.update_id,
      parties: Array.isArray(entry.acting_parties) ? entry.acting_parties : [],
      details: {
        actionLabel: entry.details?.actionLabel || null,
        description: entry.details?.description || null,
        confirmers: Array.isArray(entry.details?.confirmers) ? entry.details.confirmers : [],
        executor: entry.details?.executor || null,
      },
    })),
  };
}

// Batches and approvals as the governance party sees them. The Ledger API
// returns decoded arguments; DecMan's contract query only returns blobs on
// LocalNet, so it is a fallback for deployments without a ledger token.
async function queryContracts(entityName, governanceView) {
  if (!alluvrenPackageRef) return [];
  if (ledger.configured) {
    const contracts = await governanceView();
    return contracts
      .filter((contract) => templateName(contract.templateId) === entityName)
      .map((contract) => ({ contractId: contract.contractId, data: projectContractPayload(entityName, contract.argument) }));
  }
  const params = new URLSearchParams({
    party_id: governancePartyId,
    package_id: alluvrenPackageRef,
    module_name: appModule,
    entity_name: entityName,
    include_payload: "true",
  });
  const result = await upstream("p1", `/contracts/query?${params}`);
  return Array.isArray(result?.contracts)
    ? result.contracts
      .filter((contract) => typeof contract?.contract_id === "string")
      .map((contract) => ({
        contractId: contract.contract_id,
        data: projectContractPayload(entityName, contract.payload),
      }))
    : [];
}

function projectContractPayload(entityName, payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const text = (value) => typeof value === "string" && value.length <= 4096 ? value : null;
  // The JSON Ledger API encodes Int as a string and Time as an ISO string.
  const integer = (value) => {
    const number = typeof value === "string" && /^-?\d{1,16}$/.test(value) ? Number(value) : value;
    return Number.isSafeInteger(number) ? number : null;
  };
  const micros = (value) => {
    if (typeof value === "string" && !/^-?\d+$/.test(value)) {
      const ms = Date.parse(value);
      return Number.isFinite(ms) ? ms * 1000 : null;
    }
    return integer(value);
  };

  // A sealed batch shows governance only its totals and commitment.
  const sealedSummary = (value) => value && typeof value === "object" ? {
    commitment: text(value.commitment),
    rowCount: integer(value.rowCount),
    maxRowAllocatedUnits: integer(value.maxRowAllocatedUnits),
  } : null;

  if (entityName === "RedemptionBatch") {
    if (typeof payload.batchId !== "string" || !Array.isArray(payload.rows)) return null;
    const rows = Array.isArray(payload.rows) ? payload.rows.slice(0, 500).map((row) => ({
      requestId: text(row?.requestId),
      investor: text(row?.investor),
      requestedUnits: integer(row?.requestedUnits),
      allocatedUnits: integer(row?.allocatedUnits),
    })) : [];
    return {
      batchId: text(payload.batchId),
      policyVersion: text(payload.policyVersion),
      proposer: text(payload.proposer),
      operator: text(payload.operator),
      fundReviewer: text(payload.fundReviewer),
      treasuryReviewer: text(payload.treasuryReviewer),
      totalRequested: integer(payload.totalRequested),
      totalAllocated: integer(payload.totalAllocated),
      recoveryDeadline: micros(payload.recoveryDeadline),
      rows,
      sealed: sealedSummary(payload.sealed),
    };
  }

  if (entityName === "SealedFinalization") {
    if (typeof payload.batchId !== "string") return null;
    return {
      batchId: text(payload.batchId),
      policyVersion: text(payload.policyVersion),
      operator: text(payload.operator),
      totalRequested: integer(payload.totalRequested),
      totalAllocated: integer(payload.totalAllocated),
      sealed: sealedSummary(payload.summary),
      finalizedAt: micros(payload.finalizedAt),
    };
  }

  if (entityName === "RoleApproval") {
    if (typeof payload.reviewer !== "string" || typeof payload.role !== "string") return null;
    return {
      reviewer: text(payload.reviewer),
      role: text(payload.role),
      target: payload.target && typeof payload.target === "object" ? {
        batchCid: text(payload.target.batchCid),
        batchId: text(payload.target.batchId),
        policyVersion: text(payload.target.policyVersion),
      } : null,
      expiresAt: micros(payload.expiresAt),
    };
  }
  return null;
}


// ---------------------------------------------------------------------------
// Gate 8: authenticated identity and server-side party/role authorization.
// Every ledger write acts as the session's party; request bodies never choose
// the acting party, the DecMan node, or the confirmation set.

const writesEnabled = process.env.WRITES_ENABLED === "true";
const cookieSecure = process.env.COOKIE_SECURE === "true";
const SESSION_COOKIE = "alluvren_session";
const APPROVAL_TTL_MS = 30 * 60 * 1000;
const GOVERNED_LABELS = new Set(["FinalizeRedemption", "FinalizePolicyRedemption", "UpdateFundPolicy"]);
const accounts = loadAccounts(process.env.ACCOUNTS_FILE || "", Object.keys(nodeUrls));
const auth = createAuth({ accounts });
const ledger = createLedger({
  baseUrl: process.env.LEDGER_JSON_API_URL || "",
  token: process.env.LEDGER_TOKEN || "",
  userId: process.env.LEDGER_USER_ID || "ledger-api-user",
});

function httpError(status, message) {
  return Object.assign(new Error(message), { status, expose: true });
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return out;
}

function sessionCookie(value, maxAgeSeconds) {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${cookieSecure ? "; Secure" : ""}`;
}

function sameToken(a, b) {
  const left = Buffer.from(String(a ?? ""));
  const right = Buffer.from(String(b ?? ""));
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

function requireSession(req) {
  const session = auth.get(cookies(req)[SESSION_COOKIE]);
  if (!session) throw httpError(401, "Sign in required");
  return session;
}

// State-changing requests must come from an allowed browser origin and carry
// the session's CSRF token (in addition to the SameSite=Strict cookie).
function requireWriteContext(req, origin, { csrf = true } = {}) {
  if (!origin || !allowedOrigins.has(origin)) throw httpError(403, "Origin not allowed");
  if (!csrf) return null;
  const session = requireSession(req);
  if (!sameToken(req.headers["x-alluvren-csrf"], session.csrfToken)) throw httpError(403, "Missing or invalid CSRF token");
  return session;
}

function requireRole(session, role) {
  if (!hasRole(session, role)) throw httpError(403, "Your account does not hold the role required for this action");
}

function requireWrites() {
  if (!writesEnabled) throw httpError(403, "Ledger writes are disabled on this deployment");
}

function audit(session, action, target, outcome) {
  console.log(JSON.stringify({ at: new Date().toISOString(), user: session?.username ?? null, action, target, outcome }));
}

function templateId(module, entity) {
  if (!alluvrenPackageRef) throw httpError(503, "Alluvren package reference is not configured");
  return `${alluvrenPackageRef}:Alluvren.${module}:${entity}`;
}

// Finds a contract the session party can see, by ID and template name.
async function ownVisibleContract(session, contractId, entity) {
  if (!validId(contractId)) throw httpError(400, "A valid contract ID is required");
  const contracts = await ledger.activeContracts(session.party);
  const match = contracts.find((contract) => contract.contractId === contractId && templateName(contract.templateId) === entity);
  if (!match) throw httpError(404, "Contract not found for your account");
  return match;
}

async function exercise(session, module, entity, contractId, choice) {
  return ledger.submit(session.party, [{ ExerciseCommand: { templateId: templateId(module, entity), contractId, choice, choiceArgument: {} } }]);
}

async function createApproval(session, body) {
  requireWrites();
  const role = body.role;
  if (!APPROVAL_ROLES.includes(role)) throw httpError(400, "Unknown approval role");
  requireRole(session, role);
  const batch = await ownVisibleContract(session, body.batchCid, "RedemptionBatch");
  if (batch.argument.governanceParty !== governancePartyId) throw httpError(409, "Batch belongs to a different governance party");
  const now = Date.now();
  const mine = (await ledger.activeContracts(session.party)).some((c) => templateName(c.templateId) === "RoleApproval"
    && c.argument.reviewer === session.party && c.argument.role === role
    && c.argument.target?.batchCid === batch.contractId && approvalLive(c.argument.expiresAt, now));
  if (mine) throw httpError(409, "You have already approved this batch for that role");
  const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
  const result = await ledger.submit(session.party, [{ CreateCommand: {
    templateId: templateId("Redemption", "RoleApproval"),
    createArguments: {
      governanceParty: governancePartyId,
      reviewer: session.party,
      role,
      target: { batchCid: batch.contractId, batchId: batch.argument.batchId, policyVersion: batch.argument.policyVersion },
      expiresAt,
    },
  } }]);
  const approvalCid = result.created.find((event) => templateName(event.templateId) === "RoleApproval")?.contractId ?? null;
  return { approvalCid, batchCid: batch.contractId, role, expiresAt, updateId: result.updateId };
}

async function revokeApproval(session, body) {
  requireWrites();
  const approval = await ownVisibleContract(session, body.approvalCid, "RoleApproval");
  if (approval.argument.reviewer !== session.party) throw httpError(403, "You can only revoke your own approvals");
  const result = await exercise(session, "Redemption", "RoleApproval", approval.contractId, "RoleApproval_Revoke");
  return { revoked: approval.contractId, updateId: result.updateId };
}

// [module, template, choice, receipt template] per investor action. Sealed
// batches (Alluvren.Sealed) issue operator-signed records with the same shape.
const INVESTOR_ACTIONS = {
  acknowledge: { field: "entitlementCid", kinds: [
    ["Claims", "ClaimEntitlement", "ClaimEntitlement_Acknowledge", "ClaimReceipt"],
    ["Sealed", "PrivateEntitlement", "PrivateEntitlement_Acknowledge", "PrivateClaimReceipt"],
  ] },
  withdraw: { field: "outstandingCid", kinds: [
    ["Claims", "OutstandingRedemption", "OutstandingRedemption_Withdraw", "OutstandingReleaseReceipt"],
    ["Sealed", "PrivateOutstanding", "PrivateOutstanding_Withdraw", "PrivateReleaseReceipt"],
  ] },
};

async function investorAction(session, body, action) {
  requireWrites();
  requireRole(session, "Investor");
  const { field, kinds } = INVESTOR_ACTIONS[action];
  const contractId = body[field];
  if (!validId(contractId)) throw httpError(400, "A valid contract ID is required");
  const contracts = await ledger.activeContracts(session.party);
  const record = contracts.find((c) => c.contractId === contractId && kinds.some(([, entity]) => entity === templateName(c.templateId)));
  if (!record) throw httpError(404, "Contract not found for your account");
  if (record.argument.investor !== session.party) throw httpError(403, "This record belongs to another investor");
  const [module, entity, choice, receiptEntity] = kinds.find(([, e]) => e === templateName(record.templateId));
  const result = await exercise(session, module, entity, record.contractId, choice);
  const receiptCid = result.created.find((event) => templateName(event.templateId) === receiptEntity)?.contractId ?? null;
  return { receiptCid, units: Number(record.argument.units), updateId: result.updateId };
}

// After a sealed batch is finalized, the operator opens its AllocationBook:
// the ledger checks the rows against the approved commitment and issues each
// investor's private records.
async function distributeSealed(session, body) {
  requireWrites();
  requireRole(session, "Operator");
  const finalization = await ownVisibleContract(session, body.finalizationCid, "SealedFinalization");
  if (finalization.argument.operator !== session.party) throw httpError(403, "Only the batch operator can distribute it");
  const contracts = await ledger.activeContracts(session.party);
  const book = contracts.find((c) => templateName(c.templateId) === "AllocationBook"
    && c.argument.operator === session.party
    && c.argument.batchId === finalization.argument.batchId
    && c.argument.policyVersion === finalization.argument.policyVersion);
  if (!book) throw httpError(404, "No allocation book for this batch");
  const result = await ledger.submit(session.party, [{ ExerciseCommand: {
    templateId: templateId("Sealed", "AllocationBook"),
    contractId: book.contractId,
    choice: "AllocationBook_Distribute",
    choiceArgument: { finalizationCid: finalization.contractId },
  } }]);
  const count = (entity) => result.created.filter((event) => templateName(event.templateId) === entity).length;
  return { batchId: String(finalization.argument.batchId), entitlements: count("PrivateEntitlement"), outstanding: count("PrivateOutstanding"), updateId: result.updateId };
}

async function proposeFinalize(session, body) {
  requireWrites();
  requireRole(session, "Operator");
  const batch = await ownVisibleContract(session, body.batchCid, "RedemptionBatch");
  if (batch.argument.proposer !== session.party) throw httpError(403, "Only the batch proposer can propose its finalization");
  if (!batch.argument.policyCid) throw httpError(400, "Legacy two-reviewer batches are finalized through the operator runbook");
  // The approvals valid now, read from the ledger rather than taken from the
  // request: a page loaded before an approval arrived (or expired) would
  // otherwise propose a stale set.
  const status = ledgerStatuses(await ledger.activeContracts(governancePartyId))[batch.contractId];
  const approvalCids = status ? status.roles.flatMap((r) => r.approvals.map((a) => a.approvalCid)) : [];
  if (approvalCids.length === 0) throw httpError(409, "This batch has no valid approvals yet");
  const what = `${String(batch.argument.batchId).slice(0, 120)} with ${approvalCids.length} approval${approvalCids.length === 1 ? "" : "s"}`;
  if (status.currentProposed) throw httpError(409, `A proposal to finalize ${what} is already open`);
  const result = await ledger.submit(session.party, [{ CreateCommand: {
    templateId: templateId("Redemption", "FinalizePolicyRedemption"),
    createArguments: {
      governanceParty: governancePartyId,
      proposer: session.party,
      batchCid: batch.contractId,
      approvalCids,
      // The approval count tells a corrected proposal apart from a rejected one.
      description: `Finalize ${what}`,
    },
  } }]);
  const proposalCid = result.created.find((event) => templateName(event.templateId) === "FinalizePolicyRedemption")?.contractId ?? null;
  return { proposalCid, approvalCount: approvalCids.length, complete: status.complete, updateId: result.updateId };
}

async function governedProposal(session, proposalCid) {
  if (!validId(proposalCid)) throw httpError(400, "A valid proposal ID is required");
  const state = await upstream(session.decmanNode, `/governance/confirmations?party_id=${encodeURIComponent(governancePartyId)}&limit=50`);
  const actions = Array.isArray(state?.domain_actions) ? state.domain_actions : [];
  const proposal = actions.find((item) => item.proposal_cid === proposalCid);
  if (!proposal) throw httpError(404, "Proposal not found");
  if (!GOVERNED_LABELS.has(proposal.action_label)) throw httpError(403, "Only Alluvren governance actions can be confirmed here");
  return { proposal, rules: state.rules_contract_id || rulesContractId };
}

async function governanceConfirm(session, body) {
  requireWrites();
  requireRole(session, "GovernanceMember");
  const { proposal, rules } = await governedProposal(session, body.proposalCid);
  if ((proposal.confirmations ?? []).some((c) => c.confirming_party === session.party)) {
    throw httpError(409, "You have already confirmed this proposal");
  }
  await upstream(session.decmanNode, "/governance/confirm", { method: "POST", body: JSON.stringify({
    party_id: governancePartyId, rules_contract_id: rules, proposal_cid: proposal.proposal_cid, action: fixedAction(), governance_type: "core_domain",
  }) });
  const after = await governedProposal(session, proposal.proposal_cid);
  return { proposalCid: proposal.proposal_cid, confirmationCount: after.proposal.confirmation_count ?? null, canExecute: after.proposal.can_execute === true };
}

async function governanceExecute(session, body) {
  requireWrites();
  requireRole(session, "GovernanceMember");
  const { proposal, rules } = await governedProposal(session, body.proposalCid);
  if (proposal.can_execute !== true) throw httpError(409, "The BitSafe confirmation threshold has not been reached");
  const confirmationCids = (Array.isArray(proposal.confirmations) ? proposal.confirmations : []).map((item) => item.contract_id).filter(validId);
  await upstream(session.decmanNode, "/governance/execute", { method: "POST", body: JSON.stringify({
    party_id: governancePartyId, rules_contract_id: rules, proposal_cid: proposal.proposal_cid, confirmation_cids: confirmationCids,
    disclosed_contracts: [], action: fixedAction(), governance_type: "core_domain",
  }) });
  return { proposalCid: proposal.proposal_cid, executed: true, label: proposal.action_label };
}

async function myRecords(session) {
  const contracts = await ledger.activeContracts(session.party);
  const own = (entity, owner) => contracts.filter((c) => templateName(c.templateId) === entity && c.argument[owner] === session.party);
  const record = (c) => ({
    contractId: c.contractId,
    batchId: String(c.argument.batchId ?? ""),
    requestId: String(c.argument.requestId ?? ""),
    units: Number(c.argument.units),
    // Sealed-batch records are operator-signed and never seen by governance.
    sealed: templateName(c.templateId).startsWith("Private"),
  });
  const both = (governed, sealed) => [...own(governed, "investor"), ...own(sealed, "investor")];
  return {
    entitlements: both("ClaimEntitlement", "PrivateEntitlement").map(record),
    outstanding: both("OutstandingRedemption", "PrivateOutstanding").map(record),
    receipts: both("ClaimReceipt", "PrivateClaimReceipt").map((c) => ({ ...record(c), at: c.argument.acknowledgedAt ?? null, mode: c.argument.mode ?? null })),
    releases: both("OutstandingReleaseReceipt", "PrivateReleaseReceipt").map((c) => ({ ...record(c), at: c.argument.releasedAt ?? null, mode: c.argument.mode ?? null })),
    approvals: own("RoleApproval", "reviewer").map((c) => ({
      contractId: c.contractId,
      role: String(c.argument.role ?? ""),
      batchCid: String(c.argument.target?.batchCid ?? ""),
      batchId: String(c.argument.target?.batchId ?? ""),
      expiresAt: c.argument.expiresAt ?? null,
    })),
  };
}

// An approval counts only until it expires: the ledger refuses expired ones when
// the payout executes, so they are neither shown as met nor proposed.
function approvalLive(expiresAt, now) {
  const ms = Date.parse(expiresAt);
  return Number.isFinite(ms) && ms > now;
}
const sameSet = (a, b) => a.length === b.length && a.every((item) => b.includes(item));

// What each batch still needs, from the batches, pinned FundPolicies, live
// approvals and open proposals the governance party sees (staff already read
// every batch through /api/workflow, and governance members need this before
// they execute). The ledger re-checks every rule at finalization.
function ledgerStatuses(contracts, now = Date.now()) {
  const of = (entity) => contracts.filter((c) => templateName(c.templateId) === entity);
  const policies = new Map(of("FundPolicy").map((c) => [c.contractId, parsePolicy(c.argument)]));
  const approvals = of("RoleApproval").filter((c) => approvalLive(c.argument.expiresAt, now)).map((c) => ({
    contractId: c.contractId, reviewer: c.argument.reviewer, role: c.argument.role, batchCid: c.argument.target?.batchCid,
  }));
  const proposals = of("FinalizePolicyRedemption").map((c) => ({
    batchCid: c.argument.batchCid, approvalCids: Array.isArray(c.argument.approvalCids) ? c.argument.approvalCids : [],
  }));
  const out = {};
  for (const c of of("RedemptionBatch")) {
    const batch = parseBatch(c.argument);
    const status = batchStatus({ batchCid: c.contractId, batch, policy: batch.policyCid ? policies.get(batch.policyCid) ?? null : null, approvals });
    const current = status.roles.flatMap((r) => r.approvals.map((a) => a.approvalCid));
    const open = proposals.filter((p) => p.batchCid === c.contractId);
    out[c.contractId] = {
      ...status,
      openProposals: open.length,
      // An open proposal already carries exactly the approvals valid now.
      currentProposed: current.length > 0 && open.some((p) => sameSet(p.approvalCids, current)),
    };
  }
  return out;
}

async function batchStatuses() {
  if (!ledger.configured) return {};
  return ledgerStatuses(await ledger.activeContracts(governancePartyId));
}

const inFlight = new Set();

const WRITE_ROUTES = {
  "/api/approvals": ["approval.create", createApproval],
  "/api/approvals/revoke": ["approval.revoke", revokeApproval],
  "/api/claims/acknowledge": ["claim.acknowledge", (s, b) => investorAction(s, b, "acknowledge")],
  "/api/outstanding/withdraw": ["outstanding.withdraw", (s, b) => investorAction(s, b, "withdraw")],
  "/api/sealed/distribute": ["sealed.distribute", distributeSealed],
  "/api/proposals/finalize": ["proposal.finalize", proposeFinalize],
  "/api/governance/confirm": ["governance.confirm", governanceConfirm],
  "/api/governance/execute": ["governance.execute", governanceExecute],
};

function damlReasonFromBody(body) {
  if (!body) return null;
  return damlReason(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && !allowedOrigins.has(origin)) return json(res, 403, { error: "Origin not allowed" });
  if (req.method === "OPTIONS") return json(res, 204, {}, origin);
  if (rateLimited(req.socket.remoteAddress || "unknown")) return json(res, 429, { error: "Rate limit exceeded" }, origin);
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  let session = null;
  try {
    if (req.method === "GET" && url.pathname === "/healthz") {
      const statuses = await Promise.all(Object.keys(nodeUrls).map(async (node) => {
        try { await upstream(node, "/participants-status"); return { node, ok: true }; }
        catch { return { node, ok: false }; }
      }));
      return json(res, statuses.every((item) => item.ok) ? 200 : 503, { ok: statuses.every((item) => item.ok), environment, writesEnabled, nodes: statuses }, origin);
    }
    if (req.method === "POST" && url.pathname === "/api/auth/login") {
      requireWriteContext(req, origin, { csrf: false });
      const body = await jsonBody(req);
      const result = await auth.login(body.username, body.password, req.socket.remoteAddress || "unknown");
      if (result.status === "throttled") return json(res, 429, { error: "Too many sign-in attempts; try again later" }, origin);
      if (result.status !== "ok") return json(res, 401, { error: "Invalid username or password" }, origin);
      audit(result.session, "auth.login", null, "ok");
      return json(res, 200, { user: publicUser(result.session), csrfToken: result.session.csrfToken }, origin,
        { "set-cookie": sessionCookie(result.session.id, auth.sessionMaxAgeSeconds) });
    }
    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      session = requireWriteContext(req, origin);
      auth.logout(session.id);
      return json(res, 200, { ok: true }, origin, { "set-cookie": sessionCookie("", 0) });
    }
    if (req.method === "GET" && url.pathname === "/api/auth/me") {
      session = requireSession(req);
      return json(res, 200, { user: publicUser(session), csrfToken: session.csrfToken }, origin);
    }
    if (req.method === "GET" && url.pathname === "/api/workflow") {
      session = requireSession(req);
      // Full batches list every investor's allocation; investors use /api/me/records.
      if (!isStaff(session)) throw httpError(403, "Investors can only view their own records");
      const snapshot = await workflowSnapshot();
      snapshot.batchStatus = await batchStatuses().catch(() => ({}));
      return json(res, 200, snapshot, origin);
    }
    if (req.method === "GET" && url.pathname === "/api/me/records") {
      session = requireSession(req);
      return json(res, 200, await myRecords(session), origin);
    }
    if (req.method === "POST" && WRITE_ROUTES[url.pathname]) {
      const [action, handler] = WRITE_ROUTES[url.pathname];
      session = requireWriteContext(req, origin);
      const body = await jsonBody(req);
      const target = body?.proposalCid ?? body?.batchCid ?? body?.approvalCid ?? body?.entitlementCid ?? body?.outstandingCid ?? body?.finalizationCid ?? null;
      // One submission at a time per party, action and target: a double click
      // or a second tab reaches the ledger once.
      const key = [action, session.party, target, body?.role].join("|");
      if (inFlight.has(key)) throw httpError(409, "This action is already being submitted");
      inFlight.add(key);
      try {
        const result = await handler(session, body);
        audit(session, action, target, "ok");
        return json(res, 200, { ok: true, ...result }, origin);
      } catch (error) {
        audit(session, action, null, `rejected:${error.status ?? 500}`);
        throw error;
      } finally {
        inFlight.delete(key);
      }
    }
    return json(res, 404, { error: "Not found" }, origin);
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 502;
    if (error.expose) return json(res, status, { error: error.message }, origin);
    if (status === 400 || status === 413) return json(res, status, { error: error.message }, origin);
    if (error.unknownOutcome) return json(res, 504, { error: "The ledger did not answer in time; the outcome is unknown. Refresh before retrying." }, origin);
    // Ledger or DecMan rejection: surface only the Daml requirement text.
    const reason = error.ledgerReason ?? damlReasonFromBody(error.body);
    if (reason) return json(res, 409, { error: reason }, origin);
    return json(res, 502, { error: errorMessage(error) }, origin);
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`Alluvren backend listening on loopback port ${PORT}; ledger writes ${writesEnabled ? "ENABLED" : "disabled"}`));
