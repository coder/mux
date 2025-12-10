import path from "path";
import { _electron as electron } from "playwright";
import { electronTest as test, electronExpect as expect } from "../electronTest";
import { LIST_PROGRAMMING_LANGUAGES } from "@/node/services/mock/scenarios/basicChat";

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Electron scenario runs on chromium only"
);

// Regression test for: activate event during startup causing "Services must be loaded" assertion
// This test launches with delayed services, emits activate, and verifies no crash
test.describe("startup race conditions", () => {
  test("activate during service loading does not crash", async ({ workspace }) => {
    const { configRoot } = workspace;
    const appRoot = path.resolve(__dirname, "..", "..", "..");

    // Launch with delayed services so we have time to emit activate
    const electronApp = await electron.launch({
      args: ["."],
      cwd: appRoot,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === "string")),
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
        MUX_MOCK_AI: "1",
        MUX_ROOT: configRoot,
        MUX_E2E: "1",
        MUX_E2E_DELAY_SERVICES_MS: "2000", // 2s delay to ensure we can emit activate
        NODE_ENV: "development",
      },
    });

    try {
      // Emit activate event while services are still loading
      // This simulates clicking the dock icon during startup on macOS
      await electronApp.evaluate(({ app }) => {
        app.emit("activate");
      });

      // Wait a bit then emit again to be thorough
      await new Promise((r) => setTimeout(r, 500));
      await electronApp.evaluate(({ app }) => {
        app.emit("activate");
      });

      // Wait for app to finish loading (services delay + normal startup)
      const window = await electronApp.firstWindow();
      await window.waitForLoadState("domcontentloaded");

      // Verify no error dialog appeared
      const errorDialog = window.getByRole("dialog", { name: /error/i });
      await expect(errorDialog).not.toBeVisible();

      // App should be functional
      await expect(window.getByRole("navigation", { name: "Projects" })).toBeVisible();
    } finally {
      await electronApp.close();
    }
  });
});

test.describe("window lifecycle", () => {
  test("window opens with expected structure", async ({ page }) => {
    await expect(page.getByRole("navigation", { name: "Projects" })).toBeVisible();
    await expect(page.locator("main, #root, .app-container").first()).toBeVisible();
    await expect(page.getByRole("dialog", { name: /error/i })).not.toBeVisible();
  });

  test("workspace content loads correctly", async ({ ui, page }) => {
    await ui.projects.openFirstWorkspace();
    await expect(page.getByRole("log", { name: "Conversation transcript" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: /message/i })).toBeVisible();
  });

  test("survives rapid settings navigation", async ({ ui, page }) => {
    await ui.projects.openFirstWorkspace();

    // Stress test settings modal with rapid open/close/navigate
    for (let i = 0; i < 3; i++) {
      await ui.settings.open();
      await ui.settings.selectSection("Providers");
      await ui.settings.selectSection("Models");
      await ui.settings.close();
    }

    // Verify app remains functional
    await expect(page.getByRole("navigation", { name: "Projects" })).toBeVisible();
    const chatInput = page.getByRole("textbox", { name: /message/i });
    await expect(chatInput).toBeVisible();
    await chatInput.click();
    await expect(chatInput).toBeFocused();
  });

  // Exercises IPC handler stability under heavy use (regression: #851 duplicate handler registration)
  test("IPC stable after heavy operations", async ({ ui, page }) => {
    await ui.projects.openFirstWorkspace();

    // Many IPC calls: stream + mode switches + settings navigation
    const timeline = await ui.chat.captureStreamTimeline(async () => {
      await ui.chat.sendMessage(LIST_PROGRAMMING_LANGUAGES);
    });
    expect(timeline.events.some((e) => e.type === "stream-end")).toBe(true);

    await ui.chat.setMode("Exec");
    await ui.chat.setMode("Plan");
    await ui.settings.open();
    await ui.settings.selectSection("Providers");
    await ui.settings.close();

    // Verify app remains functional after all IPC calls
    await expect(page.getByRole("navigation", { name: "Projects" })).toBeVisible();
    await ui.chat.expectTranscriptContains("Python");
  });
});
