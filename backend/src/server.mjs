import http from "node:http";
import { URL } from "node:url";

const PORT = Number(process.env.PORT || 8787);
const MAX_BODY = 32 * 1024;
const UPSTREAM_TIMEOUT_MS = 8000;
const RATE_LIMIT = 60;
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

function json(res, status, payload, origin) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    ...(origin ? { "access-control-allow-origin": origin, "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST,OPTIONS" } : {})
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
  const [governance, audit, batches, approvals] = await Promise.all([
    upstream("p1", `/governance/confirmations?party_id=${party}&limit=25`),
    upstream("p1", `/governance/chain-audit?party_id=${party}&limit=25&refresh=true`),
    queryContracts("RedemptionBatch"),
    queryContracts("RoleApproval"),
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

async function queryContracts(entityName) {
  if (!alluvrenPackageRef) return [];
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
  const integer = (value) => Number.isSafeInteger(value) ? value : null;

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
      recoveryDeadline: integer(payload.recoveryDeadline),
      rows,
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
      expiresAt: integer(payload.expiresAt),
    };
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && !allowedOrigins.has(origin)) return json(res, 403, { error: "Origin not allowed" });
  if (req.method === "OPTIONS") return json(res, 204, {}, origin);
  if (rateLimited(req.socket.remoteAddress || "unknown")) return json(res, 429, { error: "Rate limit exceeded" }, origin);
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (req.method === "POST") return json(res, 403, { error: "Governance writes disabled pending authenticated operator authorization" }, origin);
    if (req.method === "GET" && url.pathname === "/healthz") {
      const statuses = await Promise.all(Object.keys(nodeUrls).map(async (node) => {
        try { await upstream(node, "/participants-status"); return { node, ok: true }; }
        catch { return { node, ok: false }; }
      }));
      return json(res, statuses.every((item) => item.ok) ? 200 : 503, { ok: statuses.every((item) => item.ok), environment, nodes: statuses }, origin);
    }
    if (req.method === "GET" && url.pathname === "/api/workflow") return json(res, 200, await workflowSnapshot(), origin);
    if (req.method === "POST" && url.pathname === "/api/governance/confirm") {
      const body = await jsonBody(req);
      if (!/^(p1|p2|p3)$/.test(body.node) || !validId(body.proposalCid)) return json(res, 400, { error: "node and proposalCid are required" }, origin);
      const result = await upstream(body.node, "/governance/confirm", { method: "POST", body: JSON.stringify({ party_id: governancePartyId, rules_contract_id: rulesContractId, proposal_cid: body.proposalCid, action: fixedAction() }) });
      return json(res, 200, { ok: true, node: body.node, result }, origin);
    }
    if (req.method === "POST" && url.pathname === "/api/governance/execute") {
      const body = await jsonBody(req);
      if (!validId(body.proposalCid) || !Array.isArray(body.confirmationCids) || body.confirmationCids.length < 1 || body.confirmationCids.length > 10 || body.confirmationCids.some((id) => !validId(id))) return json(res, 400, { error: "proposalCid and confirmationCids are required" }, origin);
      const result = await upstream("p1", "/governance/execute", { method: "POST", body: JSON.stringify({ party_id: governancePartyId, rules_contract_id: rulesContractId, proposal_cid: body.proposalCid, confirmation_cids: body.confirmationCids, action: fixedAction() }) });
      return json(res, 200, { ok: true, result }, origin);
    }
    return json(res, 404, { error: "Not found" }, origin);
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 502;
    return json(res, status === 400 || status === 413 ? status : 502, { error: status === 400 || status === 413 ? error.message : errorMessage(error) }, origin);
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`Alluvren backend listening on loopback port ${PORT}`));
