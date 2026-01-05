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

  test("refresh state persists after tab switch", async ({ page, ui }) => {
    // Open workspace and navigate to Review tab
    await ui.projects.openFirstWorkspace();
    await ui.metaSidebar.expectVisible();
    await ui.metaSidebar.selectTab("Review");

    const refreshButton = page.getByTestId("review-refresh");
    await expect(refreshButton).toBeVisible({ timeout: 10_000 });

    // Do a manual refresh
    await refreshButton.click();

    // Wait for refresh to complete
    await expect(refreshButton).toHaveAttribute("data-last-refresh-trigger", "manual", {
      timeout: 10_000,
    });

    const timestamp1 = await refreshButton.getAttribute("data-last-refresh-timestamp");
    console.log(`[e2e] Before tab switch: timestamp=${timestamp1}`);

    // Switch to Costs tab
    await ui.metaSidebar.selectTab("Costs");

    // Switch back to Review tab
    await ui.metaSidebar.selectTab("Review");

    // Check if lastRefreshInfo survived (it won't - component remounts)
    const triggerAfter = await refreshButton.getAttribute("data-last-refresh-trigger");
    const timestampAfter = await refreshButton.getAttribute("data-last-refresh-timestamp");
    console.log(`[e2e] After tab switch: trigger=${triggerAfter}, timestamp=${timestampAfter}`);

    // The state resets on remount - this documents current behavior
    // If we want state to persist, we'd need to lift it to a parent or use context
    expect(triggerAfter).toBe("");
    expect(timestampAfter).toBe("");
  });

  test("rapid manual refreshes all update timestamp", async ({ page, ui }) => {
    // Open workspace and navigate to Review tab
    await ui.projects.openFirstWorkspace();
    await ui.metaSidebar.expectVisible();
    await ui.metaSidebar.selectTab("Review");

    const refreshButton = page.getByTestId("review-refresh");
    await expect(refreshButton).toBeVisible({ timeout: 10_000 });

    const timestamps: number[] = [];

    // Do 5 rapid manual refreshes
    for (let i = 0; i < 5; i++) {
      await refreshButton.click();

      // Wait for this refresh to complete
      await expect(async () => {
        const ts = await refreshButton.getAttribute("data-last-refresh-timestamp");
        const num = Number(ts);
        if (timestamps.length === 0 || num > timestamps[timestamps.length - 1]) {
          timestamps.push(num);
        }
        expect(timestamps.length).toBe(i + 1);
      }).toPass({ timeout: 10_000 });

      const trigger = await refreshButton.getAttribute("data-last-refresh-trigger");
      expect(trigger).toBe("manual");

      console.log(`[e2e] Refresh ${i + 1}: timestamp=${timestamps[i]}`);
    }

    // All timestamps should be increasing
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]).toBeGreaterThan(timestamps[i - 1]);
    }
  });

  test("refresh works immediately after opening Review tab", async ({ page, ui }) => {
    // Open workspace
    await ui.projects.openFirstWorkspace();
    await ui.metaSidebar.expectVisible();

    // Start on a different tab (Costs)
    await ui.metaSidebar.selectTab("Costs");

    // Now switch to Review tab
    await ui.metaSidebar.selectTab("Review");

    const refreshButton = page.getByTestId("review-refresh");
    await expect(refreshButton).toBeVisible({ timeout: 10_000 });

    // Verify initial state is empty
    const initialTrigger = await refreshButton.getAttribute("data-last-refresh-trigger");
    const initialTimestamp = await refreshButton.getAttribute("data-last-refresh-timestamp");
    console.log(`[e2e] Initial: trigger="${initialTrigger}", timestamp="${initialTimestamp}"`);
    expect(initialTrigger).toBe("");

    // Click refresh
    await refreshButton.click();

    // Wait for refresh to complete - this is the critical test
    await expect(refreshButton).toHaveAttribute("data-last-refresh-trigger", "manual", {
      timeout: 10_000,
    });

    const timestamp = await refreshButton.getAttribute("data-last-refresh-timestamp");
    console.log(`[e2e] After refresh: timestamp=${timestamp}`);
    expect(Number(timestamp)).toBeGreaterThan(0);
  });
});
