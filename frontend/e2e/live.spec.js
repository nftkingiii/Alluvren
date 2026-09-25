import { expect, test } from "@playwright/test";

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const TREAS = `treasury::1220${"a".repeat(64)}`;
const INV = `investor::1220${"b".repeat(64)}`;

async function openLive(page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Live ledger" }).first().click();
}

test("reviewer signs in and approves with the session CSRF token; rejections show the Daml reason", async ({ page }) => {
  let signedIn = false;
  const posts = [];
  await page.route("**/healthz", (route) => json(route, { ok: true, environment: "LocalNet", writesEnabled: true, nodes: [] }));
  await page.route("**/api/auth/me", (route) =>
    signedIn ? json(route, { user: { username: "treasury", party: TREAS, roles: ["TreasuryReviewer"] }, csrfToken: "csrf-1" }) : json(route, { error: "Sign in required" }, 401));
  await page.route("**/api/auth/login", async (route) => {
    const body = route.request().postDataJSON();
    if (body.password !== "right-password") return json(route, { error: "Invalid username or password" }, 401);
    signedIn = true;
    return json(route, { user: { username: "treasury", party: TREAS, roles: ["TreasuryReviewer"] }, csrfToken: "csrf-1" });
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
  await expect(page.getByRole("heading", { name: "Sign in to the ledger" })).toBeVisible();
  await page.getByLabel("Username").fill("treasury");
  await page.getByLabel("Password").fill("wrong");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toHaveText("Invalid username or password");
  await expect(page.getByLabel("Password")).toHaveValue("");

  await page.getByLabel("Password").fill("right-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("window-17")).toBeVisible();
  await expect(page.locator("#live-header-slot")).toContainText("treasury");
  await expect(page.locator("#live-header-slot")).toContainText("LocalNet");
  await expect(page.getByText("1 batch needs your Treasury approval")).toBeVisible();
  await expect(page.getByText("Required because funded below 50%")).toBeVisible();
  await expect(page.getByRole("img", { name: "Funded 40%; policy threshold 50%" })).toBeVisible();

  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Treasury approval: done. The ledger accepted it.")).toBeVisible();
  expect(posts).toHaveLength(1);
  expect(posts[0].headers["x-alluvren-csrf"]).toBe("csrf-1");
  expect(posts[0].body).toEqual({ batchCid: "batch-1", role: "TreasuryReviewer" });

  reject = true;
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Treasury approval rejected: Missing required approvals for role ComplianceReviewer")).toBeVisible();
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
