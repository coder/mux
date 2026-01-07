import { expect } from "@playwright/test";
import { electronTest as test } from "../electronTest";

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Electron scenario runs on chromium only"
);

test.describe("sidebar drag and drop", () => {
  test("can drag an active tab to reorder within tabstrip", async ({ page, ui }) => {
    await ui.projects.openFirstWorkspace();

    const sidebar = page.getByRole("complementary", { name: "Workspace insights" });
    await expect(sidebar).toBeVisible({ timeout: 5000 });

    const tablist = sidebar.getByRole("tablist");
    await expect(tablist).toBeVisible({ timeout: 5000 });

    const costsTab = tablist.getByRole("tab", { name: /Costs/ });
    const reviewTab = tablist.getByRole("tab", { name: /Review/ });
    await expect(costsTab).toBeVisible({ timeout: 5000 });
    await expect(reviewTab).toBeVisible({ timeout: 5000 });

    // Costs tab should be selected (active) by default
    await expect(costsTab).toHaveAttribute("aria-selected", "true");

    // Verify initial order: costs comes before review
    const initialTabs = await tablist.getByRole("tab").all();
    const initialLabels = await Promise.all(initialTabs.map((t) => t.textContent()));
    const costsIndex = initialLabels.findIndex((l) => l?.includes("Costs"));
    const reviewIndex = initialLabels.findIndex((l) => l?.includes("Review"));
    expect(costsIndex).toBeLessThan(reviewIndex);

    // Drag active costs tab to after review tab position (reorder)
    // Tabs are directly draggable without needing a handle
    await ui.dragElement(costsTab, reviewTab, { targetPosition: "after" });

    // Verify tabs were reordered: review now comes before costs
    const reorderedTabs = await tablist.getByRole("tab").all();
    const reorderedLabels = await Promise.all(reorderedTabs.map((t) => t.textContent()));
    const newCostsIndex = reorderedLabels.findIndex((l) => l?.includes("Costs"));
    const newReviewIndex = reorderedLabels.findIndex((l) => l?.includes("Review"));
    expect(newReviewIndex).toBeLessThan(newCostsIndex);
  });

  test("can drag an inactive tab to reorder within tabstrip", async ({ page, ui }) => {
    await ui.projects.openFirstWorkspace();

    const sidebar = page.getByRole("complementary", { name: "Workspace insights" });
    await expect(sidebar).toBeVisible({ timeout: 5000 });

    // Add a terminal tab first (not present by default)
    await ui.metaSidebar.addTerminal();

    const tablist = sidebar.getByRole("tablist");
    const costsTab = tablist.getByRole("tab", { name: /Costs/ });
    const reviewTab = tablist.getByRole("tab", { name: /Review/ });
    const terminalTab = tablist.getByRole("tab", { name: /Terminal/ });
    await expect(costsTab).toBeVisible({ timeout: 5000 });
    await expect(reviewTab).toBeVisible({ timeout: 5000 });
    await expect(terminalTab).toBeVisible({ timeout: 5000 });

    // Terminal tab is selected after adding; select Costs to make Terminal inactive
    await costsTab.click();
    await expect(costsTab).toHaveAttribute("aria-selected", "true");
    await expect(terminalTab).toHaveAttribute("aria-selected", "false");

    // Verify initial order: costs, review, terminal
    const initialTabs = await tablist.getByRole("tab").all();
    const initialLabels = await Promise.all(initialTabs.map((t) => t.textContent()));
    const reviewIndex = initialLabels.findIndex((l) => l?.includes("Review"));
    const terminalIndex = initialLabels.findIndex((l) => l?.includes("Terminal"));
    expect(reviewIndex).toBeLessThan(terminalIndex);

    // Drag INACTIVE terminal tab to before review tab (reorder)
    // This tests that inactive tabs can be dragged just like active tabs
    await ui.dragElement(terminalTab, reviewTab, { targetPosition: "before" });

    // Verify tabs were reordered: terminal now comes before review
    const reorderedTabs = await tablist.getByRole("tab").all();
    const reorderedLabels = await Promise.all(reorderedTabs.map((t) => t.textContent()));
    const newReviewIndex = reorderedLabels.findIndex((l) => l?.includes("Review"));
    const newTerminalIndex = reorderedLabels.findIndex((l) => l?.includes("Terminal"));
    expect(newTerminalIndex).toBeLessThan(newReviewIndex);

    // The active tab should still be costs (drag shouldn't change selection)
    await expect(costsTab).toHaveAttribute("aria-selected", "true");
  });

  test("sidebar tabs are interactive and switch content", async ({ page, ui }) => {
    await ui.projects.openFirstWorkspace();

    const sidebar = page.getByRole("complementary", { name: "Workspace insights" });
    await expect(sidebar).toBeVisible();

    // Add a terminal tab first (not present by default)
    await ui.metaSidebar.addTerminal();

    const tablist = sidebar.getByRole("tablist");
    await expect(tablist).toBeVisible();

    // Get all tabs
    const costsTab = tablist.getByRole("tab", { name: /Costs/ });
    const reviewTab = tablist.getByRole("tab", { name: /Review/ });
    const terminalTab = tablist.getByRole("tab", { name: /Terminal/ });

    // Click through each tab and verify it becomes selected
    await costsTab.click();
    await expect(costsTab).toHaveAttribute("aria-selected", "true");

    await reviewTab.click();
    await expect(reviewTab).toHaveAttribute("aria-selected", "true");
    await expect(costsTab).toHaveAttribute("aria-selected", "false");

    await terminalTab.click();
    await expect(terminalTab).toHaveAttribute("aria-selected", "true");
    await expect(reviewTab).toHaveAttribute("aria-selected", "false");

    // Return to costs
    await costsTab.click();
    await expect(costsTab).toHaveAttribute("aria-selected", "true");
  });

  test("split layout can be created and navigated via keyboard/localStorage", async ({
    page,
    ui,
  }) => {
    await ui.projects.openFirstWorkspace();

    const sidebar = page.getByRole("complementary", { name: "Workspace insights" });
    await expect(sidebar).toBeVisible();

    // Set up a split layout via localStorage (simulating persistence)
    await page.evaluate(() => {
      const splitLayout = {
        version: 1,
        nextId: 3,
        focusedTabsetId: "tabset-1",
        root: {
          type: "split",
          id: "split-0",
          direction: "vertical",
          sizes: [50, 50],
          children: [
            {
              type: "tabset",
              id: "tabset-1",
              tabs: ["costs", "review"],
              activeTab: "costs",
            },
            {
              type: "tabset",
              id: "tabset-2",
              tabs: ["terminal"],
              activeTab: "terminal",
            },
          ],
        },
      };
      localStorage.setItem("right-sidebar:layout", JSON.stringify(splitLayout));
    });

    // Reload to pick up the layout
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    // Wait for sidebar to appear
    await expect(sidebar).toBeVisible({ timeout: 10000 });

    // Verify we now have two tablists (split layout)
    const tablists = await sidebar.getByRole("tablist").all();
    expect(tablists.length).toBe(2);

    // Verify each tablist has the expected tabs
    const topTabs = await tablists[0].getByRole("tab").all();
    const bottomTabs = await tablists[1].getByRole("tab").all();

    expect(topTabs.length).toBe(2); // Costs, Review
    expect(bottomTabs.length).toBe(1); // Terminal
  });

  // Note: Full drag-drop tests require real browser mouse events which
  // don't work reliably with Playwright + Xvfb + react-dnd HTML5 backend.
  // Drag behavior is tested via:
  // - Unit tests: src/browser/utils/rightSidebarLayout.test.ts
  // - UI integration: tests/ui/rightSidebar.integration.test.ts
});
