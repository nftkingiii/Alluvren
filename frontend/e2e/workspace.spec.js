import { test, expect } from "@playwright/test";

test("review, replacement, fresh authorization, finalization and receipt", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Redemption desk", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/desk-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Review batch", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Finalize demo batch", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Review", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", {
      name: "Approve as fund reviewer (demo)",
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: "Simulate reserve change" }).click();
  await page.getByRole("button", { name: "Create demo version 2" }).click();
  await expect(
    page.getByText("Reserve changed. Fresh approval required."),
  ).toBeVisible();
  await page.getByLabel("Batch version").selectOption("1");
  await expect(page.getByText("This batch has been superseded")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Finalize demo batch", exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "test-results/stale-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Open current" }).click();
  await page
    .getByRole("button", { name: "Review", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", {
      name: "Approve as fund reviewer (demo)",
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Approve as treasury reviewer (demo)",
      exact: true,
    })
    .click();
  for (const member of ["A", "B"]) {
    await page
      .getByRole("button", { name: `Confirm as member ${member}`, exact: true })
      .click();
    await page
      .getByRole("button", { name: "Confirm in demo", exact: true })
      .click();
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "test-results/review-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "Finalize demo batch", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Finalize in demo", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Batch finalized", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Switch demo perspective" }).click();
  await page
    .getByRole("button", { name: /Aster Capital Own allocation/ })
    .click();
  await page
    .getByRole("button", { name: "Acknowledge demo allocation", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Acknowledge in demo", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Acknowledged", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Download PDF receipt" }),
  ).toBeVisible();
  await expect(page.getByText("Meridian Partners")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("all views fit narrow, tablet and wide screens with reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  for (const width of [320, 768, 1024, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const name of [
      "Desk",
      "Requests",
      "Batches",
      "Approvals",
      "Activity",
    ]) {
      await page
        .getByRole("button", { name: new RegExp(`^${name}`) })
        .click();
      const activeBox = await page
        .getByRole("button", { name: new RegExp(`^${name}`) })
        .boundingBox();
      expect(activeBox?.x, `${name} active tab left edge at ${width}`).toBeGreaterThanOrEqual(0);
      expect(
        (activeBox?.x ?? 0) + (activeBox?.width ?? 0),
        `${name} active tab right edge at ${width}`,
      ).toBeLessThanOrEqual(width);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        `${name} at ${width}`,
      ).toBe(true);
    }
  }
});

test("mobile layout, filtering, dialogs and unavailable evidence", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.screenshot({
    path: "test-results/desk-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Requests", exact: true }).click();
  await page.getByLabel("Search requests").fill("no match");
  await expect(page.getByText("No matching requests")).toBeVisible();
  await page.getByRole("button", { name: "Clear search" }).click();
  await page.getByRole("row", { name: "View Aster Capital request details" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Batches", exact: true }).click();
  await page.screenshot({
    path: "test-results/review-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.route("**/healthz", (route) =>
    route.fulfill({ status: 503, body: "{}" }),
  );
  await page
    .getByRole("button", { name: "Demo workspace", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Check read-only connection" })
    .click();
  await expect(
    page.getByText("Service unavailable", { exact: true }),
  ).toBeVisible();
});
