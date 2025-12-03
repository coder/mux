import { electronTest as test, electronExpect as expect } from "../electronTest";
import { LIST_PROGRAMMING_LANGUAGES } from "@/node/services/mock/scenarios/basicChat";
import { ERROR_PROMPTS, ERROR_MESSAGES } from "@/node/services/mock/scenarios/errorScenarios";

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Electron scenario runs on chromium only"
);

test.describe("streaming behavior", () => {
  test("stream continues after settings modal opens", async ({ ui, page }) => {
    await ui.projects.openFirstWorkspace();

    const streamPromise = ui.chat.captureStreamTimeline(async () => {
      await ui.chat.sendMessage(LIST_PROGRAMMING_LANGUAGES);
    });

    await page.waitForTimeout(50);
    await ui.settings.open();
    const timeline = await streamPromise;
    await ui.settings.close();

    expect(timeline.events.some((e) => e.type === "stream-end")).toBe(true);
    await ui.chat.expectTranscriptContains("Python");
  });

  test("mode switching doesn't break streaming", async ({ ui }) => {
    await ui.projects.openFirstWorkspace();

    await ui.chat.setMode("Exec");
    await ui.chat.setMode("Plan");

    const timeline = await ui.chat.captureStreamTimeline(async () => {
      await ui.chat.sendMessage(LIST_PROGRAMMING_LANGUAGES);
    });

    expect(timeline.events.some((e) => e.type === "stream-end")).toBe(true);
    await ui.chat.expectTranscriptContains("Python");
  });

  // Consolidate error tests using parameterization
  for (const [errorType, prompt, expectedMessage] of [
    ["rate limit", ERROR_PROMPTS.TRIGGER_RATE_LIMIT, ERROR_MESSAGES.RATE_LIMIT],
    ["server", ERROR_PROMPTS.TRIGGER_API_ERROR, ERROR_MESSAGES.API_ERROR],
    ["network", ERROR_PROMPTS.TRIGGER_NETWORK_ERROR, ERROR_MESSAGES.NETWORK_ERROR],
  ] as const) {
    test(`${errorType} error displays in transcript`, async ({ ui, page }) => {
      await ui.projects.openFirstWorkspace();
      await ui.chat.setMode("Exec");

      const timeline = await ui.chat.captureStreamTimeline(async () => {
        await ui.chat.sendMessage(prompt);
      });

      expect(timeline.events.some((e) => e.type === "stream-error")).toBe(true);
      const transcript = page.getByRole("log", { name: "Conversation transcript" });
      await expect(transcript.getByText(expectedMessage)).toBeVisible();
    });
  }

  test("app recovers after error", async ({ ui }) => {
    await ui.projects.openFirstWorkspace();
    await ui.chat.setMode("Exec");

    await ui.chat.captureStreamTimeline(async () => {
      await ui.chat.sendMessage(ERROR_PROMPTS.TRIGGER_API_ERROR);
    });

    await ui.chat.setMode("Plan");
    const timeline = await ui.chat.captureStreamTimeline(async () => {
      await ui.chat.sendMessage(LIST_PROGRAMMING_LANGUAGES);
    });

    expect(timeline.events.some((e) => e.type === "stream-end")).toBe(true);
    await ui.chat.expectTranscriptContains("Python");
  });
});
