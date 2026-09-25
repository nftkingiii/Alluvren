import { test, expect } from "@playwright/test";

const health = {
  ok: true,
  environment: "LocalNet",
  nodes: [{ node: "p1", ok: true }],
};
const evidence = {
  threshold: 2,
  proposals: [{
    proposalCid: "proposal-one-cid",
    label: "FinalizeRedemption",
    description: "Finalize the current redemption batch",
    confirmationCount: 1,
    confirmations: [{ party: "reviewer-one-party" }],
    canExecute: false,
    orphaned: false,
  }],
  activeContracts: {
    configured: true,
    redemptionBatches: [{ contractId: "batch-cid", data: { batchId: "window-17", policyVersion: "v3", totalRequested: 100, totalAllocated: 80, recoveryDeadline: 1790009000000000, rows: [{ requestId: "req-1", investor: "investor-party", requestedUnits: 100, allocatedUnits: 80 }] } }],
    roleApprovals: [{ contractId: "approval-cid", data: { role: "FundReviewer", reviewer: "fund-reviewer", target: { batchCid: "batch-cid", batchId: "window-17", policyVersion: "v3" }, expiresAt: 1790009000000000 } }],
  },
  audit: [{
    eventType: "propose",
    timestamp: 1790008662,
    template: "Alluvren.Redemption:FinalizeRedemption",
    summary: "FinalizeRedemption proposed",
    contractId: "proposal-one-cid",
    updateId: "update-one-id",
    details: { actionLabel: "FinalizeRedemption" },
  }],
};
const respond = (route, json, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(json),
  });
async function openConnection(page) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Demo workspace", exact: true })
    .click();
}

test("first load has a skeleton, failed refresh retains evidence, recovery updates it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let failing = false;
  let workflowCalls = 0;
  await page.route("**/healthz", (route) => respond(route, health));
  await page.route("**/api/workflow", async (route) => {
    workflowCalls++;
    await gate;
    await respond(route, failing ? {} : evidence, failing ? 503 : 200);
  });
  await openConnection(page);
  await page
    .getByRole("button", { name: "Check read-only connection" })
    .click();
  await expect(page.getByTestId("evidence-skeleton")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Loading…", exact: true }),
  ).toBeDisabled();
  await page.screenshot({
    path: "test-results/evidence-loading.png",
    animations: "disabled",
  });
  release();
  await expect(
    page.getByText("Connected, read-only", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("LocalNet", { exact: true })).toBeVisible();
  await expect(page.getByText("FinalizeRedemption", { exact: true })).toBeVisible();
  await expect(page.getByText("1/2 confirmations", { exact: true })).toBeVisible();
  await expect(page.getByText("Redemption batches", { exact: true })).toBeVisible();
  await expect(page.getByText("Active Alluvren contracts", { exact: true })).toBeVisible();
  await expect(page.getByText("window-17", { exact: true })).toBeVisible();
  await expect(page.getByText("FundReviewer", { exact: true })).toBeVisible();
  await expect(page.getByText("investor-party", { exact: true })).toBeVisible();
  await expect(page.getByText("Recent ledger activity", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/evidence-connected.png", animations: "disabled" });
  failing = true;
  await page.getByRole("button", { name: "Refresh evidence" }).click();
  await expect(
    page.getByText("Showing saved evidence", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Last successful update")).toBeVisible();
  await expect(page.getByText("LocalNet", { exact: true })).toBeVisible();
  await expect(page.getByTestId("evidence-skeleton")).toHaveCount(0);
  expect(workflowCalls).toBe(3);
  await page.screenshot({
    path: "test-results/evidence-stale.png",
    animations: "disabled",
  });
  failing = false;
  await page.getByRole("button", { name: "Refresh evidence" }).click();
  await expect(
    page.getByText("Connected, read-only", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Demo workspace", exact: true }),
  ).toBeFocused();
});

test("denied access is actionable, not an empty state, and can recover to empty evidence", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let denied = true,
    calls = 0;
  await page.route("**/healthz", (route) => {
    calls++;
    return respond(route, denied ? {} : health, denied ? 403 : 200);
  });
  await page.route("**/api/workflow", (route) =>
    respond(route, {
      threshold: 2,
      proposals: [],
      activeContracts: { configured: false, redemptionBatches: [], roleApprovals: [] },
      audit: [],
    }),
  );
  await openConnection(page);
  await page
    .getByRole("button", { name: "Check read-only connection" })
    .click();
  await expect(
    page.getByText("Read access denied", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Use Live ledger to see your own records, or sign in with a staff account."),
  ).toBeVisible();
  await expect(page.getByText("No governance activity yet")).toHaveCount(0);
  expect(calls).toBe(1);
  await page.screenshot({
    path: "test-results/evidence-denied-mobile.png",
    animations: "disabled",
  });
  denied = false;
  await page.getByRole("button", { name: "Retry connection" }).click();
  await expect(page.getByText("No governance activity yet")).toBeVisible();
  await page.screenshot({
    path: "test-results/evidence-empty-mobile.png",
    animations: "disabled",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("cancel read prevents a late response from replacing idle state", async ({
  page,
}) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/healthz", async (route) => {
    await gate;
    await respond(route, health).catch(() => {});
  });
  await openConnection(page);
  await page
    .getByRole("button", { name: "Check read-only connection" })
    .click();
  await expect(page.getByTestId("evidence-skeleton")).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  release();
  await expect(page.getByText("Not connected", { exact: true })).toBeVisible();
  await expect(page.getByTestId("evidence-skeleton")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Check read-only connection" }),
  ).toBeEnabled();
});

test("reserve errors preserve input; search filters survive navigation and have independent recovery", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Review batch", exact: true }).click();
  await page.getByRole("button", { name: "Simulate reserve change" }).click();
  const field = page.getByLabel("Available reserve (whole units)");
  await field.fill("-1");
  await page.getByRole("button", { name: "Create demo version 2" }).click();
  await expect(field).toHaveValue("-1");
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await page.screenshot({
    path: "test-results/reserve-validation.png",
    animations: "disabled",
  });
  await field.fill("40000");
  await page.getByRole("button", { name: "Create demo version 2" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Requests", exact: true }).click();
  await page.getByLabel("Search requests").fill("Aster");
  await page.getByLabel("Filter requests").selectOption("full");
  await page.getByRole("button", { name: "Desk", exact: true }).click();
  await page.getByRole("button", { name: "Requests", exact: true }).click();
  await expect(page.getByLabel("Search requests")).toHaveValue("Aster");
  await expect(page.getByText("No matching requests")).toBeVisible();
  await page
    .getByRole("button", { name: "Reset filters", exact: true })
    .click();
  await expect(
    page.getByRole("row", { name: "View Aster Capital request details" }),
  ).toBeVisible();
  await expect(
    page.getByRole("row", { name: "View Meridian Partners request details" }),
  ).toHaveCount(0);
});
