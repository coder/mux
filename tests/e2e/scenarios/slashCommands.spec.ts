import fs from "fs/promises";
import path from "path";
import { parse } from "jsonc-parser";
import { electronTest as test, electronExpect as expect } from "../electronTest";
import { TOOL_FLOW_PROMPTS } from "@/node/services/mock/scenarios/toolFlows";
import {
  COMPACT_SUMMARY_TEXT,
  SLASH_COMMAND_PROMPTS,
} from "@/node/services/mock/scenarios/slashCommands";

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Electron scenario runs on chromium only"
);

test.describe("slash command flows", () => {
  test("slash command /clear resets conversation history", async ({ ui, page }) => {
    await ui.projects.openFirstWorkspace();

    await ui.chat.captureStreamTimeline(async () => {
      await ui.chat.sendMessage(TOOL_FLOW_PROMPTS.FILE_READ);
    });
    await ui.chat.expectTranscriptContains("Mock README content");

    await ui.chat.captureStreamTimeline(async () => {
      await ui.chat.sendMessage(TOOL_FLOW_PROMPTS.LIST_DIRECTORY);
    });
    await ui.chat.expectTranscriptContains("Directory listing:");

    await ui.chat.sendMessage("/clear");
    await ui.chat.expectStatusMessageContains("Chat history cleared");

    const transcript = page.getByRole("log", { name: "Conversation transcript" });
    await expect(transcript.getByText("No Messages Yet")).toBeVisible();
    await expect(transcript).not.toContainText("Mock README content");
    await expect(transcript).not.toContainText("Directory listing:");
  });

  test("slash command /truncate 50 removes earlier context", async ({ ui, page }) => {
    await ui.projects.openFirstWorkspace();

    // Build a conversation with five distinct turns
    const prompts = [
      TOOL_FLOW_PROMPTS.FILE_READ,
      TOOL_FLOW_PROMPTS.LIST_DIRECTORY,
      TOOL_FLOW_PROMPTS.CREATE_TEST_FILE,
      TOOL_FLOW_PROMPTS.READ_TEST_FILE,
      TOOL_FLOW_PROMPTS.RECALL_TEST_FILE,
    ];

    for (const prompt of prompts) {
      await ui.chat.captureStreamTimeline(async () => {
        await ui.chat.sendMessage(prompt);
      });
    }

    const transcript = page.getByRole("log", { name: "Conversation transcript" });
    await expect(transcript).toContainText("Mock README content");
    await expect(transcript).toContainText("hello");

    await ui.chat.sendMessage("/truncate 50");
    await ui.chat.expectStatusMessageContains("Chat history truncated by 50%");

    await expect(transcript).not.toContainText("Mock README content");
    await expect(transcript).toContainText("hello");
  });

  test("slash command /compact produces compacted summary", async ({ ui, page }) => {
    await ui.projects.openFirstWorkspace();

    const setupPrompts = [
      TOOL_FLOW_PROMPTS.FILE_READ,
      TOOL_FLOW_PROMPTS.LIST_DIRECTORY,
      TOOL_FLOW_PROMPTS.CREATE_TEST_FILE,
      TOOL_FLOW_PROMPTS.READ_TEST_FILE,
    ];

    for (const prompt of setupPrompts) {
      await ui.chat.captureStreamTimeline(async () => {
        await ui.chat.sendMessage(prompt);
      });
    }

    await ui.chat.captureStreamTimeline(
      async () => {
        await ui.chat.sendMessage("/compact -t 500");
      },
      { timeoutMs: 20_000 }
    );

    await ui.chat.expectStatusMessageContains("Compaction started");

    // Compaction now uses direct text streaming instead of a tool call
    // Verify the summary text appears in the transcript
    const transcript = page.getByRole("log", { name: "Conversation transcript" });
    await ui.chat.expectTranscriptContains(COMPACT_SUMMARY_TEXT);
    await expect(transcript).toContainText(COMPACT_SUMMARY_TEXT);
    await expect(transcript.getByText("📦 compacted")).toBeVisible();
    await expect(transcript).not.toContainText("Mock README content");
    await expect(transcript).not.toContainText("Directory listing:");
  });

  test("slash command /model opus switches models for subsequent turns", async ({ ui, page }) => {
    await ui.projects.openFirstWorkspace();

    const modeToggles = page.locator('[data-component="ChatModeToggles"]');
    await expect(
      modeToggles.getByText("anthropic:claude-sonnet-4-5", { exact: true })
    ).toBeVisible();

    await ui.chat.sendMessage("/model opus");
    await ui.chat.expectStatusMessageContains("Model changed to anthropic:claude-opus-4-5");
    await expect(modeToggles.getByText("anthropic:claude-opus-4-5", { exact: true })).toBeVisible();

    const timeline = await ui.chat.captureStreamTimeline(async () => {
      await ui.chat.sendMessage(SLASH_COMMAND_PROMPTS.MODEL_STATUS);
    });

    const streamStart = timeline.events.find((event) => event.type === "stream-start");
    expect(streamStart?.model).toBe("anthropic:claude-opus-4-5");
    await ui.chat.expectTranscriptContains(
      "Claude Opus 4.5 is now responding with enhanced reasoning capacity."
    );
  });

  test("slash command /providers set anthropic baseUrl updates provider config", async ({
    ui,
    workspace,
  }) => {
    await ui.projects.openFirstWorkspace();

    await ui.chat.sendMessage("/providers set anthropic baseUrl https://custom.endpoint");
    await ui.chat.expectStatusMessageContains("Provider anthropic updated");

    const providersPath = path.join(workspace.configRoot, "providers.jsonc");
    await expect
      .poll(async () => {
        try {
          await fs.access(providersPath);
          return true;
        } catch {
          return false;
        }
      })
      .toBeTruthy();
    const content = await fs.readFile(providersPath, "utf-8");
    const parsed = parse(content) as Record<string, unknown>;
    const anthropicConfig = parsed?.anthropic as Record<string, unknown> | undefined;
    expect(anthropicConfig?.baseUrl).toBe("https://custom.endpoint");
  });
});
