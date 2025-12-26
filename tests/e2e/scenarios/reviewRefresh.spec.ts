import { electronTest as test, electronExpect as expect } from "../electronTest";

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Electron scenario runs on chromium only"
);

test.describe("review refresh", () => {
  test("manual refresh updates lastRefreshInfo timestamp each time", async ({ page, ui }) => {
    // Open workspace and navigate to Review tab
    await ui.projects.openFirstWorkspace();
    await ui.metaSidebar.expectVisible();
    await ui.metaSidebar.selectTab("Review");

    // Wait for the review panel to be ready by finding the refresh button
    const refreshButton = page.getByTestId("review-refresh");
    await expect(refreshButton).toBeVisible({ timeout: 10_000 });

    // First manual refresh
    await refreshButton.click();

    // Wait for data attributes to be populated (indicating refresh completed)
    await expect(refreshButton).toHaveAttribute("data-last-refresh-trigger", "manual", {
      timeout: 10_000,
    });

    const timestamp1 = await refreshButton.getAttribute("data-last-refresh-timestamp");
    expect(timestamp1).toBeTruthy();
    const ts1 = Number(timestamp1);
    expect(ts1).toBeGreaterThan(0);

    console.log(`[e2e] First refresh: timestamp=${timestamp1}`);

    // Wait a moment to ensure timestamps differ
    await page.waitForTimeout(100);

    // Second manual refresh
    await refreshButton.click();

    // Wait for timestamp to change (this is the critical assertion)
    await expect(async () => {
      const ts2Str = await refreshButton.getAttribute("data-last-refresh-timestamp");
      const ts2 = Number(ts2Str);
      expect(ts2).toBeGreaterThan(ts1);
    }).toPass({ timeout: 10_000 });

    const trigger2 = await refreshButton.getAttribute("data-last-refresh-trigger");
    const timestamp2 = await refreshButton.getAttribute("data-last-refresh-timestamp");

    console.log(`[e2e] Second refresh: trigger=${trigger2}, timestamp=${timestamp2}`);

    expect(trigger2).toBe("manual");
    expect(Number(timestamp2)).toBeGreaterThan(ts1);
  });

  test("Ctrl+R triggers manual refresh", async ({ page, ui }) => {
    // Open workspace and navigate to Review tab
    await ui.projects.openFirstWorkspace();
    await ui.metaSidebar.expectVisible();
    await ui.metaSidebar.selectTab("Review");

    const refreshButton = page.getByTestId("review-refresh");
    await expect(refreshButton).toBeVisible({ timeout: 10_000 });

    // Get initial state (may be empty string initially)
    const initialTimestamp = await refreshButton.getAttribute("data-last-refresh-timestamp");
    console.log(`[e2e] Initial timestamp: ${initialTimestamp}`);

    // Press Ctrl+R (must focus the panel first for keyboard events to work)
    const reviewPanel = page.locator('[aria-labelledby*="review"]').first();
    await reviewPanel.focus();
    await page.keyboard.press("Control+r");

    // Wait for data attributes to be populated
    await expect(refreshButton).toHaveAttribute("data-last-refresh-trigger", "manual", {
      timeout: 10_000,
    });

    const timestamp = await refreshButton.getAttribute("data-last-refresh-timestamp");
    console.log(`[e2e] After Ctrl+R: timestamp=${timestamp}`);

    expect(timestamp).toBeTruthy();
    const ts = Number(timestamp);
    expect(ts).toBeGreaterThan(0);

    // If there was a previous timestamp, new one should be greater
    if (initialTimestamp && initialTimestamp !== "") {
      expect(ts).toBeGreaterThan(Number(initialTimestamp));
    }
  });

  // Note: Tooltip behavior is tested via data attributes on the refresh button
  // (data-last-refresh-trigger, data-last-refresh-timestamp) which are verified
  // in the tests above. The actual tooltip rendering uses Radix UI portals which
  // are harder to test reliably in Playwright, and the tooltip merely displays
  // the same data that's already validated via attributes.
});
