// End to end through the real Canton Wallet Gateway: the SDK's wallet picker,
// the gateway's login page, and its Sign and Approve pages, against a live
// `infra/demo-session.sh` on BitSafe LocalNet. Every person signs in with their
// own gateway wallet in their own browser, then the 40%-funded batch goes from
// review to execution and investor A acknowledges it with its wallet key.
// Skipped unless WALLET_GATEWAY_E2E=1, since it needs that whole stack, freshly
// started (it uses the batch the session opens):
//   bash infra/wallet-gateway.sh start && bash infra/demo-session.sh start
//   (cd frontend && npx vite --host 127.0.0.1)
//   WALLET_GATEWAY_E2E=1 npx playwright test e2e/wallet-gateway.spec.js
import { expect, test } from "@playwright/test";

test.skip(process.env.WALLET_GATEWAY_E2E !== "1", "needs the LocalNet demo session and the Wallet Gateway");
test.describe.configure({ mode: "serial", timeout: 180_000 });

// What each person's page said, printed when a test fails.
let consoleLog = [];
test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) console.log(consoleLog.join("\n"));
  consoleLog = [];
});

// A fresh browser for `name`: Connect wallet → SDK picker → gateway login →
// Sign in with this wallet → gateway Sign page, at a person's pace. Returns the signed-in app page and
// every popup it opened.
async function signInThroughGateway(browser, name) {
  const context = await browser.newContext({ baseURL: "http://127.0.0.1:5173" });
  const popups = [];
  context.on("page", (p) => popups.push(p));
  const page = await context.newPage();
  page.on("console", (m) => consoleLog.push(`${name}: ${m.text().slice(0, 200)}`));
  page.on("dialog", (d) => d.accept());
  await page.goto("/");
  await page.getByRole("button", { name: "Live ledger" }).first().click();
  await page.getByRole("button", { name: "Connect wallet" }).click();

  await expect.poll(() => popups.some((p) => p.url().startsWith("blob:")), { timeout: 15_000 }).toBe(true);
  await popups.find((p) => p.url().startsWith("blob:")).getByText("Alluvren Wallet Gateway (LocalNet)").click();

  await expect.poll(() => popups.some((p) => !p.isClosed() && p.url().includes("/login")), { timeout: 15_000 }).toBe(true);
  const gateway = popups.find((p) => !p.isClosed() && p.url().includes("/login"));
  await expect(gateway.locator("#client-id")).toBeVisible();
  await gateway.waitForTimeout(3000);
  await gateway.selectOption("#network-select", { label: "BitSafe LocalNet (node 2, app-user)" });
  await gateway.fill("#client-id", `alluvren-${name}`);
  await gateway.fill("#client-secret", "unsafe");
  await gateway.getByRole("button", { name: "Connect" }).click();

  // Connected: the app names the wallet; signing is the person's next click.
  await expect(page.getByText(`Connected: alluvren-${name}`)).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Sign in with this wallet" }).click();

  // The gateway shows exactly what Alluvren asked it to sign, and who asked.
  await expect(gateway).toHaveURL(/\/sign-message\//, { timeout: 30_000 });
  await expect(gateway.getByRole("heading", { name: "Sign message" })).toBeVisible();
  await expect(gateway.getByText("http://127.0.0.1:5173")).toBeVisible();
  await expect(gateway.getByText(/Sign in to Alluvren at 127\.0\.0\.1:5173/)).toBeVisible();
  await expect(gateway.getByText(new RegExp(`Wallet: alluvren-${name}::1220`))).toBeVisible();
  await gateway.getByRole("button", { name: "Sign", exact: true }).click();
  await expect(page.locator("#live-header-slot")).toContainText(name, { timeout: 20_000 });
  return { page, popups, context };
}

// The batch the demo session funds at 40%: investor A 240 of 600, B 160 of 400.
const fortyPercent = (page) => page.locator("article.live-batch").filter({ hasText: "400 of 1,000 units funded" });
// Its name in this session (window-N); investor A's wallet keeps receipts from earlier sessions.
let batchId = null;

for (const reviewer of ["treasury", "coo", "compliance"]) {
  test(`${reviewer} signs in with its gateway wallet and approves the 40% batch`, async ({ browser }) => {
    const { page, context } = await signInThroughGateway(browser, reviewer);
    const batch = fortyPercent(page);
    await expect(batch).toBeVisible();
    batchId ??= (await batch.locator(".live-batch-head strong").innerText()).trim();
    await batch.getByRole("button", { name: "Approve" }).click();
    await expect(batch.getByText("You approved")).toBeVisible({ timeout: 45_000 });
    await context.close();
  });
}

test("the operator proposes the batch with all three approvals", async ({ browser }) => {
  const { page, context } = await signInThroughGateway(browser, "operator");
  const batch = fortyPercent(page);
  await batch.getByRole("button", { name: "Propose with 3 approvals" }).click();
  await expect(batch.getByRole("button", { name: "Proposed" })).toBeVisible({ timeout: 45_000 });
  await context.close();
});

test("two BitSafe members confirm from their nodes and execute", async ({ browser }) => {
  for (const member of ["member-1", "member-2"]) {
    const { page, context } = await signInThroughGateway(browser, member);
    const row = page.locator(".live-row").filter({ has: page.getByRole("button", { name: "Execute" }) }).first();
    await row.getByRole("button", { name: "Confirm" }).click();
    await expect(row.getByRole("button", { name: "Confirmed" })).toBeVisible({ timeout: 45_000 });
    if (member === "member-2") {
      await expect(async () => {
        await page.getByRole("button", { name: "Refresh" }).click();
        await expect(row.getByRole("button", { name: "Execute" })).toBeEnabled({ timeout: 3_000 });
      }).toPass({ timeout: 30_000 });
      await row.getByRole("button", { name: "Execute" }).click();
      // The executed proposal leaves the list; the app says what the ledger did.
      await expect(page.getByText("Execution: done. The ledger accepted it.")).toBeVisible({ timeout: 60_000 });
    }
    await context.close();
  }
});

test("investor A acknowledges in the gateway, signed by its own key, never through the server", async ({ browser }) => {
  const { page, popups, context } = await signInThroughGateway(browser, "investor-a");
  await expect(page.getByText("Your wallet signs each one with its key.")).toBeVisible();
  await expect(async () => {
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(page.getByRole("button", { name: "Acknowledge in wallet" }).first()).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
  await page.getByRole("button", { name: "Acknowledge in wallet" }).first().click();

  // The gateway's own approval page for the transaction.
  await expect.poll(() => popups.some((p) => !p.isClosed() && /\/approve\//.test(p.url())), { timeout: 20_000 }).toBe(true);
  const approve = popups.find((p) => !p.isClosed() && /\/approve\//.test(p.url()));
  await expect(approve.getByRole("button", { name: "Reject", exact: true })).toBeVisible({ timeout: 15_000 });
  await approve.getByRole("button", { name: "Approve", exact: true }).click();

  await expect(page.getByText("Acknowledgment: done. The ledger accepted it.")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(`Acknowledged 240 units · ${batchId}`)).toBeVisible({ timeout: 20_000 });
  await context.close();
});
