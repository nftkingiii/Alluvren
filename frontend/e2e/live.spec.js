import { expect, test } from "@playwright/test";

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const TREAS = `treasury::1220${"a".repeat(64)}`;
const INV = `investor::1220${"b".repeat(64)}`;

// A scripted CIP-0103 wallet, used only when Vite runs with VITE_E2E_WALLET=1.
// It records what it was asked to sign and submit.
async function useScriptedWallet(page, party) {
  await page.addInitScript((walletParty) => {
    window.__walletCalls = { signed: [], submitted: [] };
    window.__ALLUVREN_E2E_WALLET__ = {
      connect: async () => ({ partyId: walletParty, publicKey: "cHVibGljLWtleS1vZi10aGUtd2FsbGV0LTMyYnl0ZXM=" }),
      signMessage: async (message) => { window.__walletCalls.signed.push(message); return `signature-${window.__walletCalls.signed.length}`; },
      submit: async (request) => { window.__walletCalls.submitted.push(request); return { updateId: "update-1" }; },
      disconnect: async () => null,
    };
  }, party);
}

const challengeText = (wallet, host = "127.0.0.1:5173") =>
  `Sign in to Alluvren at ${host}\nWallet: ${wallet}\nNonce: ${"a".repeat(32)}\nExpires: 2026-10-21T14:05:00.000Z`;

async function openLive(page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Live ledger" }).first().click();
}

test("reviewer signs in with a wallet and approves with the session CSRF token; rejections show the Daml reason", async ({ page }) => {
  const TREAS_WALLET = `alluvren-treasury::1220${"e".repeat(64)}`;
  let signedIn = false;
  let walletAttempts = 0;
  const posts = [];
  const walletBodies = [];
  await useScriptedWallet(page, TREAS_WALLET);
  await page.route("**/healthz", (route) => json(route, { ok: true, environment: "LocalNet", writesEnabled: true, nodes: [] }));
  await page.route("**/api/auth/me", (route) =>
    signedIn ? json(route, { user: { username: "treasury", wallet: TREAS_WALLET, party: TREAS, roles: ["TreasuryReviewer"], actsThroughWallet: false }, csrfToken: "csrf-1" }) : json(route, { error: "Sign in required" }, 401));
  await page.route("**/api/auth/challenge", (route) => {
    expect(route.request().postDataJSON()).toEqual({ wallet: TREAS_WALLET });
    return json(route, { message: challengeText(TREAS_WALLET) });
  });
  await page.route("**/api/auth/wallet", (route) => {
    walletBodies.push(route.request().postDataJSON());
    walletAttempts += 1;
    // The first signature is refused, as a wrong key would be.
    if (walletAttempts === 1) return json(route, { error: "Wallet sign-in failed: the signature, the challenge or the wallet was not accepted" }, 401);
    signedIn = true;
    return json(route, { user: { username: "treasury", wallet: TREAS_WALLET, party: TREAS, roles: ["TreasuryReviewer"], actsThroughWallet: false }, csrfToken: "csrf-1" });
  });
  await page.route("**/api/me/records", (route) => json(route, { entitlements: [], outstanding: [], receipts: [], releases: [], approvals: [] }));
  await page.route("**/api/workflow", (route) => json(route, {
    threshold: 2,
    proposals: [],
    activeContracts: { configured: true, redemptionBatches: [{ contractId: "batch-1", data: { batchId: "window-17", policyVersion: "demo-fund@v1", totalRequested: 1000, totalAllocated: 400, rows: [] } }], roleApprovals: [] },
    audit: [],
    batchStatus: {
      "batch-1": {
        batchCid: "batch-1", kind: "policy", policyVisible: true, policyVersion: "demo-fund@v1", fundedBps: 4000, fundingThresholdBps: 5000, complete: false,
        roles: [
          { role: "TreasuryReviewer", quorum: 1, members: [TREAS], approvals: [], met: false, conditional: false, reasons: [] },
          { role: "ComplianceReviewer", quorum: 1, members: ["compliance::1220"], approvals: [], met: false, conditional: true, reasons: ["funded below 50%"] },
        ],
      },
    },
  }));
  let reject = false;
  await page.route("**/api/approvals", (route) => {
    posts.push({ headers: route.request().headers(), body: route.request().postDataJSON() });
    return reject ? json(route, { error: "Missing required approvals for role ComplianceReviewer" }, 409) : json(route, { ok: true, approvalCid: "approval-1" });
  });

  await openLive(page);
  await expect(page.getByRole("heading", { name: "Sign in with your wallet" })).toBeVisible();
  await expect(page.getByLabel("Password")).toHaveCount(0);
  await page.getByRole("button", { name: "Connect wallet" }).click();
  // Connecting shows which wallet will sign; nothing is signed until the person asks.
  await expect(page.getByText("Connected: alluvren-treasury")).toBeVisible();
  expect(await page.evaluate(() => window.__walletCalls.signed)).toEqual([]);
  await page.getByRole("button", { name: "Sign in with this wallet" }).click();
  await expect(page.getByRole("alert")).toHaveText("Wallet sign-in failed: the signature, the challenge or the wallet was not accepted");

  await page.getByRole("button", { name: "Sign in with this wallet" }).click();
  await expect(page.getByText("window-17")).toBeVisible();
  // The wallet signed exactly the backend's challenge, and the signature went back with it.
  const signed = await page.evaluate(() => window.__walletCalls.signed);
  expect(signed).toEqual([challengeText(TREAS_WALLET), challengeText(TREAS_WALLET)]);
  expect(walletBodies[1]).toEqual({ wallet: TREAS_WALLET, publicKey: "cHVibGljLWtleS1vZi10aGUtd2FsbGV0LTMyYnl0ZXM=", signature: "signature-2", message: challengeText(TREAS_WALLET) });
  await expect(page.locator("#live-header-slot")).toContainText("treasury");
  await expect(page.locator("#live-header-slot")).toContainText("LocalNet");
  await expect(page.getByText("1 batch needs your Treasury approval")).toBeVisible();
  await expect(page.getByText("Required because funded below 50%")).toBeVisible();
  await expect(page.getByRole("img", { name: "Funded 40%; policy threshold 50%" })).toBeVisible();

  // A rejected action can be tried again...
  reject = true;
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Treasury approval rejected: Missing required approvals for role ComplianceReviewer")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve" })).toBeEnabled();

  // ...an accepted one runs once and stays disabled.
  reject = false;
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Treasury approval: done. The ledger accepted it.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approved" })).toBeDisabled();
  expect(posts).toHaveLength(2);
  expect(posts[1].headers["x-alluvren-csrf"]).toBe("csrf-1");
  expect(posts[1].body).toEqual({ batchCid: "batch-1", role: "TreasuryReviewer" });
});

test("operator's double click proposes once, with the approvals the server counts", async ({ page }) => {
  const OP = `operator::1220${"d".repeat(64)}`;
  const proposals = [];
  let proposed = false;
  const role = (name, cid) => ({ role: name, quorum: 1, members: ["m::1220"], approvals: [{ approvalCid: cid, reviewer: "m::1220" }], met: true, conditional: false, reasons: [] });
  await page.route("**/healthz", (route) => json(route, { ok: true, environment: "LocalNet", writesEnabled: true, nodes: [] }));
  await page.route("**/api/auth/me", (route) => json(route, { user: { username: "operator", party: OP, roles: ["Operator"] }, csrfToken: "csrf-4" }));
  await page.route("**/api/me/records", (route) => json(route, { entitlements: [], outstanding: [], receipts: [], releases: [], approvals: [] }));
  await page.route("**/api/workflow", (route) => json(route, {
    threshold: 2, audit: [],
    proposals: proposed ? [{ proposalCid: "prop-1", label: "FinalizePolicyRedemption", description: "Finalize window-19 with 3 approvals", confirmationCount: 1, confirmations: [], canExecute: false }] : [],
    activeContracts: { configured: true, roleApprovals: [], sealedFinalizations: [],
      redemptionBatches: [{ contractId: "batch-2", data: { batchId: "window-19", policyVersion: "demo-fund@v1", totalRequested: 1000, totalAllocated: 400, rows: [] } }] },
    batchStatus: { "batch-2": {
      batchCid: "batch-2", kind: "policy", policyVisible: true, policyVersion: "demo-fund@v1", fundedBps: 4000, fundingThresholdBps: 5000, complete: true,
      roles: [role("TreasuryReviewer", "a-t"), role("FinalSignoff", "a-f"), role("ComplianceReviewer", "a-c")],
      openProposals: proposed ? 1 : 0, currentProposed: proposed, currentProposalCid: proposed ? "prop-1" : null,
    } },
  }));
  await page.route("**/api/proposals/finalize", async (route) => {
    proposals.push(route.request().postDataJSON());
    await new Promise((resolve) => setTimeout(resolve, 300));
    proposed = true;
    return json(route, { ok: true, proposalCid: "prop-1", approvalCount: 3, complete: true });
  });

  await openLive(page);
  // Move off the navigation, which expands over the content while hovered.
  await page.mouse.move(900, 400);
  // Two locks: the fund's rules are met, governance hasn't started.
  const locks = page.getByRole("group", { name: "Locks on this payout" });
  await expect(locks).toContainText("Fund rules");
  await expect(locks).toContainText("All 3 roles approved");
  await expect(locks).toContainText("Not proposed yet · needs 2 members");
  await page.getByRole("button", { name: "Propose with 3 approvals" }).dblclick();
  await expect(page.getByText("Finalization proposal with 3 approvals: done. The ledger accepted it.")).toBeVisible();
  expect(proposals).toEqual([{ batchCid: "batch-2" }]);
  await expect(page.getByRole("button", { name: "Proposed" })).toBeDisabled();
  await expect(page.getByText("A proposal with these 3 approvals is open.")).toBeVisible();
  await expect(locks).toContainText("1 of 2 members confirmed");
});

test("investor sees only their own records, never the batch list, and acknowledges once", async ({ page }) => {
  let workflowCalls = 0;
  let acknowledged = false;
  await page.route("**/healthz", (route) => json(route, { ok: true, environment: "LocalNet", writesEnabled: true, nodes: [] }));
  await page.route("**/api/auth/me", (route) => json(route, { user: { username: "investor", party: INV, roles: ["Investor"] }, csrfToken: "csrf-2" }));
  await page.route("**/api/workflow", (route) => { workflowCalls++; return json(route, { error: "Investors can only view their own records" }, 403); });
  await page.route("**/api/me/records", (route) => json(route, {
    entitlements: acknowledged ? [] : [{ contractId: "ent-1", batchId: "window-17", requestId: "r-1", units: 400 }],
    outstanding: [{ contractId: "out-1", batchId: "window-17", requestId: "r-1", units: 600 }],
    receipts: acknowledged ? [{ contractId: "rec-1", batchId: "window-17", requestId: "r-1", units: 400, mode: "DemoAcknowledgment" }] : [],
    releases: [],
    approvals: [],
  }));
  await page.route("**/api/claims/acknowledge", (route) => {
    expect(route.request().postDataJSON()).toEqual({ entitlementCid: "ent-1" });
    expect(route.request().headers()["x-alluvren-csrf"]).toBe("csrf-2");
    acknowledged = true;
    return json(route, { ok: true, receiptCid: "rec-1", units: 400 });
  });

  await openLive(page);
  await expect(page.getByRole("heading", { name: "My redemption records" })).toBeVisible();
  await expect(page.locator(".live-row").filter({ hasText: /Allocated\s*400\s*units/ })).toBeVisible();
  await expect(page.locator(".live-row").filter({ hasText: /Not funded\s*600\s*units/ })).toBeVisible();
  await expect(page.getByText("You have 400 units to acknowledge")).toBeVisible();
  expect(workflowCalls).toBe(0);
  await expect(page.getByRole("heading", { name: "Batches" })).toHaveCount(0);

  await page.getByRole("button", { name: "Acknowledge" }).click();
  await expect(page.getByText("Acknowledgment: done. The ledger accepted it.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Acknowledge" })).toHaveCount(0);
  await expect(page.getByText("Acknowledged 400 units · window-17")).toBeVisible();
});

test("the wallet refuses to sign a challenge for another site", async ({ page }) => {
  const W = `alluvren-treasury::1220${"e".repeat(64)}`;
  await useScriptedWallet(page, W);
  await page.route("**/healthz", (route) => json(route, { ok: true, environment: "LocalNet", writesEnabled: true, nodes: [] }));
  await page.route("**/api/auth/me", (route) => json(route, { error: "Sign in required" }, 401));
  await page.route("**/api/auth/challenge", (route) => json(route, { message: challengeText(W, "evil.example") }));
  let walletPosts = 0;
  await page.route("**/api/auth/wallet", (route) => { walletPosts += 1; return json(route, { error: "no" }, 401); });

  await openLive(page);
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await page.getByRole("button", { name: "Sign in with this wallet" }).click();
  await expect(page.getByRole("alert")).toHaveText("Unexpected sign-in challenge; nothing was signed");
  expect(await page.evaluate(() => window.__walletCalls.signed)).toEqual([]);
  expect(walletPosts).toBe(0);
});

test("an investor whose party is its wallet acknowledges in the wallet, never through the server", async ({ page }) => {
  const WALLET_INV = `alluvren-investor-a::1220${"f".repeat(64)}`;
  let acknowledged = false;
  let serverAcks = 0;
  await useScriptedWallet(page, WALLET_INV);
  await page.route("**/healthz", (route) => json(route, { ok: true, environment: "LocalNet", writesEnabled: true, nodes: [] }));
  await page.route("**/api/auth/me", (route) => json(route, { user: { username: "investor-a", wallet: WALLET_INV, party: WALLET_INV, roles: ["Investor"], actsThroughWallet: true }, csrfToken: "csrf-3" }));
  await page.route("**/api/me/records", async (route) => {
    acknowledged = (await page.evaluate(() => window.__walletCalls.submitted.length)) > 0;
    return json(route, {
      entitlements: acknowledged ? [] : [{ contractId: "ent-9", batchId: "window-21", requestId: "r-9", units: 240 }],
      outstanding: [{ contractId: "out-9", batchId: "window-21", requestId: "r-9", units: 360, sealed: true }],
      receipts: acknowledged ? [{ contractId: "rec-9", batchId: "window-21", requestId: "r-9", units: 240, mode: "DemoAcknowledgment", at: "2026-10-21T14:02:00Z" }] : [],
      releases: [],
      approvals: [],
    });
  });
  await page.route("**/api/claims/acknowledge", (route) => { serverAcks += 1; return json(route, { error: "no" }, 409); });

  await openLive(page);
  await expect(page.getByText("Your wallet signs each one with its key.")).toBeVisible();
  await page.getByRole("button", { name: "Acknowledge in wallet" }).click();
  await expect(page.getByText("Acknowledgment: done. The ledger accepted it.")).toBeVisible();
  await expect(page.getByText("Acknowledged 240 units · window-21")).toBeVisible();
  await expect(page.locator(".live-row").filter({ hasText: "window-21" }).first()).toContainText("21 Oct, 14:02 UTC · signed by your wallet key");
  const [request] = await page.evaluate(() => window.__walletCalls.submitted);
  expect(request.actAs).toEqual([WALLET_INV]);
  expect(request.commands).toEqual([{ ExerciseCommand: { templateId: "#alluvren-v1:Alluvren.Claims:ClaimEntitlement", contractId: "ent-9", choice: "ClaimEntitlement_Acknowledge", choiceArgument: {} } }]);
  expect(serverAcks).toBe(0);
  // A sealed record uses the sealed template's choice.
  await expect(page.getByRole("button", { name: "Withdraw in wallet" })).toBeVisible();
});

test("operator sees a sealed batch's summary and opens its allocation book", async ({ page }) => {
  const OP = `operator::1220${"c".repeat(64)}`;
  const distributions = [];
  let distributed = false;
  await page.route("**/healthz", (route) => json(route, { ok: true, environment: "LocalNet", writesEnabled: true, nodes: [] }));
  await page.route("**/api/auth/me", (route) => json(route, { user: { username: "operator", party: OP, roles: ["Operator"] }, csrfToken: "csrf-3" }));
  await page.route("**/api/me/records", (route) => json(route, { entitlements: [], outstanding: [], receipts: [], releases: [], approvals: [] }));
  await page.route("**/api/workflow", (route) => json(route, {
    threshold: 2,
    proposals: [],
    audit: [],
    batchStatus: {},
    activeContracts: {
      configured: true,
      roleApprovals: [],
      redemptionBatches: [{ contractId: "batch-s", data: { batchId: "sealed-9", policyVersion: "demo-fund@v1", totalRequested: 1000, totalAllocated: 500, rows: [],
        sealed: { commitment: "ab12".repeat(16), rowCount: 2, maxRowAllocatedUnits: 300 } } }],
      sealedFinalizations: distributed ? [] : [{ contractId: "fin-9", data: { batchId: "sealed-8", operator: OP, totalAllocated: 400, sealed: { rowCount: 3 } } }],
    },
  }));
  await page.route("**/api/sealed/distribute", (route) => {
    distributions.push({ headers: route.request().headers(), body: route.request().postDataJSON() });
    distributed = true;
    return json(route, { ok: true, batchId: "sealed-8", entitlements: 3, outstanding: 1 });
  });

  await openLive(page);
  await expect(page.getByText("Rows sealed: 2 requests, largest allocation 300 units.")).toBeVisible();
  await expect(page.getByText("1 sealed batch is finalized and ready to distribute")).toBeVisible();
  await page.getByRole("button", { name: "Open allocation book" }).click();
  await expect(page.getByText("Distribution: done. The ledger accepted it.")).toBeVisible();
  expect(distributions).toHaveLength(1);
  expect(distributions[0].body).toEqual({ finalizationCid: "fin-9" });
  expect(distributions[0].headers["x-alluvren-csrf"]).toBe("csrf-3");
  await expect(page.getByRole("heading", { name: "Sealed batches to distribute" })).toHaveCount(0);
});
