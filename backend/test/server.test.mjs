import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { hashPassword } from "../src/auth.mjs";
import { damlReason } from "../src/ledger.mjs";

const ORIGIN = "http://127.0.0.1:5173";
const GOV = "governance-party";
const party = (name) => `${name}::1220${"a".repeat(64)}`;
const OPERATOR = party("operator");
const TREAS = party("treasury");
const MEMBER = party("member");
const INV_A = party("investor-a");
const INV_B = party("investor-b");
const PASSWORD = "correct horse battery staple";
const PKG = "#alluvren-v1";

const decmanCalls = [];
const ledgerSubmits = [];
let p1;
let p2;
let ledgerServer;
let app;
let appNoWrites;
let apiBase;
let apiBaseNoWrites;

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function close(server) {
  if (!server?.listening) return;
  server.close();
  await once(server, "close");
}

async function readBody(req) {
  let data = "";
  for await (const chunk of req) data += chunk;
  return data ? JSON.parse(data) : {};
}

function decman(node) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const body = req.method === "POST" ? await readBody(req) : null;
    decmanCalls.push({ node, method: req.method, path: url.pathname, body });
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/participants-status") return res.end(JSON.stringify({ ok: true }));
    if (url.pathname === "/governance/confirmations") {
      const proposal = (cid, label, canExecute) => ({
        proposal_cid: cid, action_label: label, description: cid, proposer: OPERATOR,
        confirmations: [{ contract_id: `${cid}-c1`, confirming_party: MEMBER }, { contract_id: `${cid}-c2`, confirming_party: "other" }],
        confirmation_count: 2, can_execute: canExecute, orphaned: false, created_at: 1790007000,
      });
      return res.end(JSON.stringify({
        threshold: 2,
        rules_contract_id: "rules-current",
        domain_actions: [
          proposal("proposal-ok", "FinalizePolicyRedemption", true),
          proposal("proposal-low", "FinalizePolicyRedemption", false),
          proposal("proposal-other", "SetThreshold", true),
          proposal("proposal-fail", "FinalizePolicyRedemption", true),
        ],
      }));
    }
    if (url.pathname === "/governance/confirm") return res.end(JSON.stringify({ ok: true }));
    if (url.pathname === "/governance/execute") {
      if (body.proposal_cid === "proposal-fail") {
        res.statusCode = 500;
        return res.end(JSON.stringify({ error: "DAML_FAILURE: The requirement 'Missing required approvals for role ComplianceReviewer' was not met. party=secret-internal" }));
      }
      return res.end(JSON.stringify({ message: "Action executed successfully" }));
    }
    if (url.pathname === "/governance/chain-audit") {
      return res.end(JSON.stringify({ entries: [{
        event_type: "propose", timestamp: 1790007000, template_id: "Alluvren.Redemption:FinalizeRedemption",
        action_summary: "FinalizeRedemption proposed", contract_id: "proposal-ok", update_id: "update-cid",
        acting_parties: [OPERATOR], details: { actionLabel: "FinalizeRedemption", description: "Batch 17", secret: "must-not-leak" },
      }] }));
    }
    if (url.pathname === "/contracts/query") {
      const entity = url.searchParams.get("entity_name");
      const payload = entity === "RedemptionBatch" ? {
        batchId: "window-17", policyVersion: "policy-v3", proposer: OPERATOR, operator: OPERATOR,
        fundReviewer: "fund-reviewer", treasuryReviewer: TREAS, totalRequested: 100, totalAllocated: 80,
        recoveryDeadline: 1790009000000000,
        rows: [{ requestId: "request-1", investor: INV_A, requestedUnits: 100, allocatedUnits: 80, secret: "must-not-leak" }],
        secret: "must-not-leak",
      } : {
        reviewer: TREAS, role: "TreasuryReviewer",
        target: { batchCid: "batch-1", batchId: "window-17", policyVersion: "policy-v3", secret: "must-not-leak" },
        expiresAt: 1790009000000000, secret: "must-not-leak",
      };
      return res.end(JSON.stringify({ contracts: [{ contract_id: entity === "RedemptionBatch" ? "batch-1" : "approval-t", blob: "private-created-event-blob", payload }] }));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
}

const batch = {
  governanceParty: GOV, proposer: OPERATOR, operator: OPERATOR, batchId: "window-17", policyVersion: "demo-fund@v1", policyCid: "policy-1",
  fundReviewer: "fund-reviewer", treasuryReviewer: TREAS, totalRequested: "1000", totalAllocated: "400",
  rows: [{ requestId: "r-a", investor: INV_A, requestedUnits: "1000", allocatedUnits: "400" }], exceptions: null,
};
const fundPolicy = {
  fundId: "demo-fund", version: "1",
  base: [{ role: "TreasuryReviewer", members: [TREAS], quorum: "1" }, { role: "FinalSignoff", members: [party("coo")], quorum: "1" }],
  conditional: [{ trigger: { tag: "FundedBelowBps", value: "5000" }, requirement: { role: "ComplianceReviewer", members: [party("compliance")], quorum: "1" } }],
};
const acs = {
  [OPERATOR]: [{ templateId: `${PKG}:Alluvren.Redemption:RedemptionBatch`, contractId: "batch-1", createArgument: batch }],
  [TREAS]: [
    { templateId: `${PKG}:Alluvren.Redemption:RedemptionBatch`, contractId: "batch-1", createArgument: batch },
    { templateId: `${PKG}:Alluvren.Redemption:FundPolicy`, contractId: "policy-1", createArgument: fundPolicy },
    { templateId: `${PKG}:Alluvren.Redemption:RoleApproval`, contractId: "approval-t", createArgument: { reviewer: TREAS, role: "TreasuryReviewer", target: { batchCid: "batch-1", batchId: "window-17" } } },
  ],
  [INV_A]: [
    { templateId: `${PKG}:Alluvren.Claims:ClaimEntitlement`, contractId: "entitlement-a", createArgument: { investor: INV_A, units: "400", batchId: "window-17", requestId: "r-a" } },
    { templateId: `${PKG}:Alluvren.Claims:OutstandingRedemption`, contractId: "outstanding-a", createArgument: { investor: INV_A, units: "600", batchId: "window-17", requestId: "r-a" } },
  ],
  [INV_B]: [
    { templateId: `${PKG}:Alluvren.Claims:ClaimEntitlement`, contractId: "entitlement-b", createArgument: { investor: INV_B, units: "150", batchId: "window-17", requestId: "r-b" } },
  ],
};

function ledgerMock() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    res.setHeader("content-type", "application/json");
    assert.equal(req.headers.authorization, "Bearer test-ledger-token");
    if (url.pathname === "/v2/state/ledger-end") return res.end(JSON.stringify({ offset: 42 }));
    const body = await readBody(req);
    if (url.pathname === "/v2/state/active-contracts") {
      const [filterParty] = Object.keys(body.filter.filtersByParty);
      const contracts = acs[filterParty] ?? [];
      return res.end(JSON.stringify(contracts.map((createdEvent) => ({ workflowId: "", contractEntry: { JsActiveContract: { createdEvent } } }))));
    }
    if (url.pathname === "/v2/commands/submit-and-wait-for-transaction") {
      ledgerSubmits.push(body.commands);
      const command = body.commands.commands[0];
      const created = [];
      if (command.CreateCommand) created.push({ templateId: command.CreateCommand.templateId, contractId: "new-contract" });
      if (command.ExerciseCommand?.choice === "ClaimEntitlement_Acknowledge") created.push({ templateId: `${PKG}:Alluvren.Claims:ClaimReceipt`, contractId: "receipt-1" });
      return res.end(JSON.stringify({ transaction: { updateId: "update-1", events: created.map((CreatedEvent) => ({ CreatedEvent })) } }));
    }
    res.statusCode = 404;
    res.end("{}");
  });
}

async function startApp(extraEnv) {
  const probe = createServer();
  const port = await listen(probe);
  await close(probe);
  const child = spawn(process.execPath, [fileURLToPath(new URL("../src/server.mjs", import.meta.url))], {
    env: { ...process.env, PORT: String(port), ...extraEnv },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error(`Backend exited early: ${stderr}`);
    try {
      if ((await fetch(`${base}/healthz`)).status > 0) return { child, base };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Backend did not start: ${stderr}`);
}

before(async () => {
  p1 = decman("p1");
  p2 = decman("p2");
  ledgerServer = ledgerMock();
  const [p1Port, p2Port, ledgerPort] = [await listen(p1), await listen(p2), await listen(ledgerServer)];
  const hash = await hashPassword(PASSWORD);
  const dir = mkdtempSync(join(tmpdir(), "alluvren-test-"));
  const accountsFile = join(dir, "accounts.json");
  writeFileSync(accountsFile, JSON.stringify({ users: [
    { username: "operator", passwordHash: hash, party: OPERATOR, roles: ["Operator"] },
    { username: "treasury", passwordHash: hash, party: TREAS, roles: ["TreasuryReviewer"] },
    { username: "member", passwordHash: hash, party: MEMBER, roles: ["GovernanceMember"], decmanNode: "p2" },
    { username: "investor-a", passwordHash: hash, party: INV_A, roles: ["Investor"] },
    { username: "investor-b", passwordHash: hash, party: INV_B, roles: ["Investor"] },
    { username: "throttle", passwordHash: hash, party: INV_B, roles: ["Investor"] },
  ] }));
  const env = {
    ALLOWED_ORIGINS: ORIGIN,
    DEC_MAN_URLS: `p1=http://127.0.0.1:${p1Port},p2=http://127.0.0.1:${p2Port}`,
    GOVERNANCE_PARTY_ID: GOV,
    ALLUVREN_PACKAGE_REF: PKG,
    ENVIRONMENT: "LocalNet test",
    ACCOUNTS_FILE: accountsFile,
    LEDGER_JSON_API_URL: `http://127.0.0.1:${ledgerPort}`,
    LEDGER_TOKEN: "test-ledger-token",
    RATE_LIMIT_PER_MINUTE: "10000",
  };
  ({ child: app, base: apiBase } = await startApp({ ...env, WRITES_ENABLED: "true" }));
  ({ child: appNoWrites, base: apiBaseNoWrites } = await startApp(env));
});

after(async () => {
  for (const child of [app, appNoWrites]) {
    child?.kill();
    if (child) await once(child, "exit");
  }
  await Promise.all([close(p1), close(p2), close(ledgerServer)]);
});

async function login(username, base = apiBase) {
  const response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  assert.equal(response.status, 200, `login ${username}`);
  const cookie = response.headers.get("set-cookie").split(";")[0];
  const { csrfToken, user } = await response.json();
  return { cookie, csrfToken, user, base };
}

function post(session, path, body, { csrf = true, origin = ORIGIN } = {}) {
  return fetch(`${session.base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: session.cookie,
      ...(origin ? { origin } : {}),
      ...(csrf ? { "x-alluvren-csrf": session.csrfToken } : {}),
    },
    body: JSON.stringify(body),
  });
}

function get(session, path) {
  return fetch(`${session.base}${path}`, { headers: { cookie: session.cookie } });
}

test("login issues an HttpOnly SameSite=Strict session and rejects bad credentials generically", async () => {
  const bad = await fetch(`${apiBase}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ username: "treasury", password: "wrong" }),
  });
  assert.equal(bad.status, 401);
  assert.deepEqual(await bad.json(), { error: "Invalid username or password" });
  const unknown = await fetch(`${apiBase}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ username: "nobody", password: "wrong" }),
  });
  assert.deepEqual(await unknown.json(), { error: "Invalid username or password" });
  const noOrigin = await fetch(`${apiBase}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "treasury", password: PASSWORD }),
  });
  assert.equal(noOrigin.status, 403);

  const ok = await fetch(`${apiBase}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ username: "treasury", password: PASSWORD }),
  });
  const cookie = ok.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\//);
  const payload = await ok.json();
  assert.deepEqual(payload.user, { username: "treasury", party: TREAS, roles: ["TreasuryReviewer"] });
  assert.equal(JSON.stringify(payload).includes("passwordHash"), false);
});

test("repeated failed sign-ins are throttled", async () => {
  let last;
  for (let i = 0; i < 6; i++) {
    last = await fetch(`${apiBase}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ username: "throttle", password: "wrong" }),
    });
  }
  assert.equal(last.status, 429);
});

test("workflow requires a staff session; investors are refused", async () => {
  assert.equal((await fetch(`${apiBase}/api/workflow`)).status, 401);
  const investor = await login("investor-a");
  assert.equal((await get(investor, "/api/workflow")).status, 403);

  const staff = await login("treasury");
  const response = await get(staff, "/api/workflow");
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.threshold, 2);
  assert.equal(payload.activeContracts.redemptionBatches[0].data.batchId, "window-17");
  const status = payload.batchStatus["batch-1"];
  assert.equal(status.fundedBps, 4000);
  assert.equal(status.fundingThresholdBps, 5000);
  assert.deepEqual(status.roles.map((r) => [r.role, r.met, r.conditional]), [
    ["TreasuryReviewer", true, false], ["FinalSignoff", false, false], ["ComplianceReviewer", false, true],
  ]);
  assert.equal(status.complete, false);
  assert.equal(payload.audit[0].details.secret, undefined);
  assert.equal(JSON.stringify(payload).includes("private-created-event-blob"), false);
  assert.equal(JSON.stringify(payload).includes("must-not-leak"), false);
});

test("writes need an allowed origin and the session CSRF token", async () => {
  const staff = await login("treasury");
  ledgerSubmits.length = 0;
  assert.equal((await post(staff, "/api/approvals", { batchCid: "batch-1", role: "TreasuryReviewer" }, { csrf: false })).status, 403);
  assert.equal((await post(staff, "/api/approvals", { batchCid: "batch-1", role: "TreasuryReviewer" }, { origin: null })).status, 403);
  const anonymous = await fetch(`${apiBase}/api/approvals`, {
    method: "POST", headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ batchCid: "batch-1", role: "TreasuryReviewer" }),
  });
  assert.equal(anonymous.status, 401);
  assert.equal(ledgerSubmits.length, 0);
});

test("ledger writes stay disabled unless WRITES_ENABLED=true", async () => {
  const staff = await login("treasury", apiBaseNoWrites);
  ledgerSubmits.length = 0;
  const response = await post(staff, "/api/approvals", { batchCid: "batch-1", role: "TreasuryReviewer" });
  assert.equal(response.status, 403);
  assert.equal(ledgerSubmits.length, 0);
});

test("approvals act only as the session party with ledger-derived targets", async () => {
  const staff = await login("treasury");
  ledgerSubmits.length = 0;
  const response = await post(staff, "/api/approvals", {
    batchCid: "batch-1", role: "TreasuryReviewer", actAs: [INV_A], party: INV_A, reviewer: INV_A, batchId: "forged", policyVersion: "forged",
  });
  assert.equal(response.status, 200);
  assert.equal(ledgerSubmits.length, 1);
  assert.deepEqual(ledgerSubmits[0].actAs, [TREAS]);
  const args = ledgerSubmits[0].commands[0].CreateCommand.createArguments;
  assert.equal(args.reviewer, TREAS);
  assert.deepEqual(args.target, { batchCid: "batch-1", batchId: "window-17", policyVersion: "demo-fund@v1" });

  assert.equal((await post(staff, "/api/approvals", { batchCid: "batch-1", role: "FinalSignoff" })).status, 403);
  assert.equal((await post(staff, "/api/approvals", { batchCid: "batch-unknown", role: "TreasuryReviewer" })).status, 404);
  assert.equal((await post(staff, "/api/approvals/revoke", { approvalCid: "approval-someone-else" })).status, 404);
  assert.equal(ledgerSubmits.length, 1);
});

test("investors can act only on their own records", async () => {
  const investorB = await login("investor-b");
  ledgerSubmits.length = 0;
  assert.equal((await post(investorB, "/api/claims/acknowledge", { entitlementCid: "entitlement-a" })).status, 404);
  assert.equal(ledgerSubmits.length, 0);

  const investorA = await login("investor-a");
  const response = await post(investorA, "/api/claims/acknowledge", { entitlementCid: "entitlement-a" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).receiptCid, "receipt-1");
  assert.deepEqual(ledgerSubmits[0].actAs, [INV_A]);

  const staff = await login("treasury");
  assert.equal((await post(staff, "/api/claims/acknowledge", { entitlementCid: "entitlement-a" })).status, 403);

  const records = await (await get(investorA, "/api/me/records")).json();
  assert.deepEqual(records.entitlements.map((r) => r.contractId), ["entitlement-a"]);
  assert.deepEqual(records.outstanding.map((r) => r.contractId), ["outstanding-a"]);
  assert.equal(JSON.stringify(records).includes("entitlement-b"), false);
});

test("only the batch proposer can propose finalization, with exact approval sets", async () => {
  const operator = await login("operator");
  ledgerSubmits.length = 0;
  assert.equal((await post(operator, "/api/proposals/finalize", { batchCid: "batch-1", approvalCids: ["a", "a"] })).status, 400);
  const response = await post(operator, "/api/proposals/finalize", { batchCid: "batch-1", approvalCids: ["approval-t", "approval-c"] });
  assert.equal(response.status, 200);
  assert.deepEqual(ledgerSubmits[0].actAs, [OPERATOR]);
  const command = ledgerSubmits[0].commands[0].CreateCommand;
  assert.match(command.templateId, /FinalizePolicyRedemption$/);
  assert.deepEqual(command.createArguments.approvalCids, ["approval-t", "approval-c"]);
  assert.equal(command.createArguments.proposer, OPERATOR);

  const staff = await login("treasury");
  assert.equal((await post(staff, "/api/proposals/finalize", { batchCid: "batch-1", approvalCids: ["approval-t"] })).status, 403);
});

test("governance actions use the member's own node and server-side confirmation state", async () => {
  const member = await login("member");
  decmanCalls.length = 0;
  const confirm = await post(member, "/api/governance/confirm", { proposalCid: "proposal-ok", node: "p1" });
  assert.equal(confirm.status, 200);
  const confirmCalls = decmanCalls.filter((call) => call.path === "/governance/confirm");
  assert.equal(confirmCalls.length, 1);
  assert.equal(confirmCalls[0].node, "p2");

  assert.equal((await post(member, "/api/governance/confirm", { proposalCid: "proposal-other" })).status, 403);
  assert.equal((await post(member, "/api/governance/execute", { proposalCid: "proposal-low" })).status, 409);

  decmanCalls.length = 0;
  const execute = await post(member, "/api/governance/execute", { proposalCid: "proposal-ok", confirmationCids: ["forged-1", "forged-2"] });
  assert.equal(execute.status, 200);
  const executeCall = decmanCalls.find((call) => call.path === "/governance/execute");
  assert.equal(executeCall.node, "p2");
  assert.deepEqual(executeCall.body.confirmation_cids, ["proposal-ok-c1", "proposal-ok-c2"]);

  const failed = await post(member, "/api/governance/execute", { proposalCid: "proposal-fail" });
  assert.equal(failed.status, 409);
  assert.deepEqual(await failed.json(), { error: "Missing required approvals for role ComplianceReviewer" });

  const investor = await login("investor-a");
  assert.equal((await post(investor, "/api/governance/confirm", { proposalCid: "proposal-ok" })).status, 403);
});

test("logout ends the session", async () => {
  const staff = await login("treasury");
  assert.equal((await get(staff, "/api/auth/me")).status, 200);
  assert.equal((await post(staff, "/api/auth/logout", {})).status, 200);
  assert.equal((await get(staff, "/api/auth/me")).status, 401);
});

test("only Daml requirement text is surfaced from ledger errors", () => {
  assert.equal(damlReason("INVALID ... The requirement 'Fund approval targets the wrong batch' was not met ... token=abc"), "Fund approval targets the wrong batch");
  assert.equal(damlReason("internal stack trace"), null);
});
