import { electronTest as test } from "../electronTest";
import { MOCK_LIST_PROGRAMMING_LANGUAGES } from "../mockAiPrompts";

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Electron scenario runs on chromium only"
);

test.describe("persistence", () => {
  test("chat history persists across page reload", async ({ ui, page }) => {
    await ui.projects.openFirstWorkspace();

    await ui.chat.captureStreamTimeline(async () => {
      await ui.chat.sendMessage(MOCK_LIST_PROGRAMMING_LANGUAGES);
    });
    await ui.chat.expectTranscriptContains("Python");

    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await ui.projects.openFirstWorkspace();

    await ui.chat.expectTranscriptContains("Python");
  });

  test("chat history survives settings navigation", async ({ ui }) => {
    await ui.projects.openFirstWorkspace();

    await ui.chat.captureStreamTimeline(async () => {
      await ui.chat.sendMessage(MOCK_LIST_PROGRAMMING_LANGUAGES);
    });

    // Navigate through settings (potential state corruption points)
    await ui.settings.open();
    await ui.settings.selectSection("Models");
    await ui.settings.selectSection("Providers");
    await ui.settings.close();

    await ui.chat.expectTranscriptContains("Python");
    await ui.chat.expectTranscriptContains("JavaScript");
  });
});
