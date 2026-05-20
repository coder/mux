import { electronTest as test, electronExpect as expect } from "../electronTest";

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Electron scenario runs on chromium only"
);

const DEMO_DISPLAY_NAME = "Mux Platform Demo";

// Smoke test for the Extension Platform. Verifies, end-to-end, that the bundled
// Demo Extension's `mux-extensions` skill is discoverable as a card in the
// Extensions Settings Section without any manual setup. Extensions intentionally
// have no experiment kill switch because built-in skills may migrate onto this
// platform and must remain available.
test.describe("Extension Platform smoke", () => {
  test("Demo Extension is discoverable", async ({ ui, page }) => {
    await ui.projects.openFirstWorkspace();

    await page.evaluate(async () => {
      if (!window.__ORPC_CLIENT__) {
        throw new Error("ORPC client not initialized");
      }
      await window.__ORPC_CLIENT__.extensions.reload({});
    });

    await ui.settings.open();
    const extensionsTab = page.getByRole("button", { name: "Extensions", exact: true });
    await expect(extensionsTab).toBeVisible();
    await extensionsTab.click();

    // The bundled Demo Extension card surfaces the friendly displayName from
    // its manifest, regardless of whether the user has granted it yet — the
    // card is the entry point for granting.
    await expect(page.getByText(DEMO_DISPLAY_NAME, { exact: false })).toBeVisible({
      timeout: 15_000,
    });

    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await ui.projects.openFirstWorkspace();
    await ui.settings.open();

    const restoredExtensionsTab = page.getByRole("button", { name: "Extensions", exact: true });
    await expect(restoredExtensionsTab).toBeVisible({ timeout: 5_000 });
    await restoredExtensionsTab.click();
    await expect(page.getByText(DEMO_DISPLAY_NAME, { exact: false })).toBeVisible({
      timeout: 15_000,
    });
  });
});
