import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

const proposalId = "proposal-cid-123";
const upstreamCalls = [];
let upstream;
let app;
let apiBase;

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

before(async () => {
  upstream = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    upstreamCalls.push(`${req.method} ${url.pathname}`);
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/participants-status") return res.end(JSON.stringify({ ok: true }));
    if (url.pathname === "/governance/confirmations") {
      return res.end(JSON.stringify({
        threshold: 2,
        rules_contract_id: "rules-current",
        domain_actions: [{
          proposal_cid: proposalId,
          action_label: "FinalizeRedemption",
          description: "Finalize batch 17",
          proposer: "operator-party",
          confirmations: [{ contract_id: "confirmation-cid", confirming_party: "member-party", created_at: 1790008000, expires_at: 1790009000 }],
          confirmation_count: 1,
          can_execute: false,
          orphaned: false,
          created_at: 1790007000,
        }],
      }));
    }
    if (url.pathname === "/governance/chain-audit") {
      return res.end(JSON.stringify({ entries: [{
        event_type: "propose",
        timestamp: 1790007000,
        template_id: "Alluvren.Redemption:FinalizeRedemption",
        action_summary: "FinalizeRedemption proposed",
        contract_id: proposalId,
        update_id: "update-cid",
        acting_parties: ["operator-party"],
        details: { actionLabel: "FinalizeRedemption", description: "Batch 17", secret: "must-not-leak" },
      }] }));
    }
    if (url.pathname === "/contracts/query") {
      const entity = url.searchParams.get("entity_name");
      const id = entity === "RedemptionBatch" ? "batch-cid" : "approval-cid";
      const payload = entity === "RedemptionBatch" ? {
        batchId: "window-17",
        policyVersion: "policy-v3",
        proposer: "operator-party",
        operator: "operator-party",
        fundReviewer: "fund-reviewer",
        treasuryReviewer: "treasury-reviewer",
        totalRequested: 100,
        totalAllocated: 80,
        recoveryDeadline: 1790009000000000,
        rows: [{ requestId: "request-1", investor: "investor-party", requestedUnits: 100, allocatedUnits: 80, secret: "must-not-leak" }],
        secret: "must-not-leak",
      } : {
        reviewer: "fund-reviewer",
        role: "FundReviewer",
        target: { batchCid: "batch-cid", batchId: "window-17", policyVersion: "policy-v3", secret: "must-not-leak" },
        expiresAt: 1790009000000000,
        secret: "must-not-leak",
      };
      assert.equal(url.searchParams.get("include_payload"), "true");
      assert.equal(url.searchParams.get("package_id"), "#alluvren-v1");
      return res.end(JSON.stringify({ contracts: [{ contract_id: id, blob: "private-created-event-blob", payload }] }));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  const upstreamPort = await listen(upstream);
  const probe = createServer();
  const appPort = await listen(probe);
  await close(probe);
  apiBase = `http://127.0.0.1:${appPort}`;
  app = spawn(process.execPath, [fileURLToPath(new URL("../src/server.mjs", import.meta.url))], {
    env: {
      ...process.env,
      PORT: String(appPort),
      ALLOWED_ORIGINS: "http://127.0.0.1:5173",
      DEC_MAN_URLS: `p1=http://127.0.0.1:${upstreamPort}`,
      GOVERNANCE_PARTY_ID: "governance-party",
      ALLUVREN_PACKAGE_REF: "#alluvren-v1",
      ENVIRONMENT: "LocalNet test",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  app.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  for (let attempt = 0; attempt < 40; attempt++) {
    if (app.exitCode !== null) throw new Error(`Backend exited early: ${stderr}`);
    try {
      if ((await fetch(`${apiBase}/healthz`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Backend did not start: ${stderr}`);
});

after(async () => {
  app?.kill();
  if (app) await once(app, "exit");
  await close(upstream);
});

test("workflow read returns parsed live governance and contract summaries, never blobs", async () => {
  upstreamCalls.length = 0;
  const response = await fetch(`${apiBase}/api/workflow`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.threshold, 2);
  assert.equal(payload.rulesContractId, "rules-current");
  assert.deepEqual(payload.proposals[0], {
    proposalCid: proposalId,
    label: "FinalizeRedemption",
    description: "Finalize batch 17",
    proposer: "operator-party",
    confirmationCount: 1,
    confirmations: [{ party: "member-party", createdAt: 1790008000, expiresAt: 1790009000 }],
    canExecute: false,
    orphaned: false,
    createdAt: 1790007000,
  });
  assert.deepEqual(payload.activeContracts, {
    configured: true,
    redemptionBatches: [{
      contractId: "batch-cid",
      data: {
        batchId: "window-17", policyVersion: "policy-v3", proposer: "operator-party", operator: "operator-party",
        fundReviewer: "fund-reviewer", treasuryReviewer: "treasury-reviewer", totalRequested: 100, totalAllocated: 80,
        recoveryDeadline: 1790009000000000,
        rows: [{ requestId: "request-1", investor: "investor-party", requestedUnits: 100, allocatedUnits: 80 }],
      },
    }],
    roleApprovals: [{
      contractId: "approval-cid",
      data: { reviewer: "fund-reviewer", role: "FundReviewer", target: { batchCid: "batch-cid", batchId: "window-17", policyVersion: "policy-v3" }, expiresAt: 1790009000000000 },
    }],
  });
  assert.equal(payload.audit[0].details.secret, undefined);
  assert.equal(JSON.stringify(payload).includes("private-created-event-blob"), false);
  assert.equal(JSON.stringify(payload).includes("must-not-leak"), false);
  assert.equal(upstreamCalls.filter((call) => call === "GET /contracts/query").length, 2);
});

test("governance writes remain blocked and never reach DecMan", async () => {
  upstreamCalls.length = 0;
  const response = await fetch(`${apiBase}/api/governance/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ node: "p1", proposalCid: proposalId }),
  });
  assert.equal(response.status, 403);
  assert.deepEqual(upstreamCalls, []);
});
