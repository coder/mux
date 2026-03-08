import "../dom";

import { createHash } from "crypto";
import { existsSync } from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";
import { waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { MuxMessage } from "@/common/types/message";
import { getFlowPromptRelativePath } from "@/common/constants/flowPrompting";
import { buildMockStreamStartGateMessage } from "@/node/services/mock/mockAiRouter";
import { preloadTestModules } from "../../ipc/setup";
import { createStreamCollector } from "../../ipc/streamCollector";
import { createAppHarness, type AppHarness } from "../harness";

function getFlowPromptPath(app: AppHarness): string {
  return path.join(app.metadata.namedWorkspacePath, getFlowPromptRelativePath(app.metadata.name));
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function getMessageText(message: MuxMessage): string {
  return (
    message.parts
      ?.filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n") ?? ""
  );
}

function getLastMockPromptMessages(app: AppHarness): MuxMessage[] {
  const result = app.env.services.aiService.debugGetLastMockPrompt(app.workspaceId);
  if (!result.success) {
    throw new Error(result.error);
  }
  if (!result.data) {
    throw new Error("Expected mock AI prompt to be captured");
  }
  return result.data;
}

function getLastUserPromptText(messages: MuxMessage[]): string {
  const lastUserMessage = [...messages].reverse().find((message) => message.role === "user");
  if (!lastUserMessage) {
    throw new Error("Expected prompt to include a user message");
  }
  return getMessageText(lastUserMessage);
}

function getSystemPromptText(messages: MuxMessage[]): string {
  return messages
    .filter((message) => message.role === "system")
    .map((message) => getMessageText(message))
    .join("\n\n");
}

async function getActiveTextarea(app: AppHarness): Promise<HTMLTextAreaElement> {
  return waitFor(
    () => {
      const textareas = Array.from(
        app.view.container.querySelectorAll('textarea[aria-label="Message Claude"]')
      ) as HTMLTextAreaElement[];
      if (textareas.length === 0) {
        throw new Error("Active chat textarea not found");
      }

      const enabled = [...textareas].reverse().find((textarea) => !textarea.disabled);
      if (!enabled) {
        throw new Error("Chat textarea is disabled");
      }

      return enabled;
    },
    { timeout: 10_000 }
  );
}

async function waitForChatInputSection(app: AppHarness): Promise<HTMLElement> {
  return waitFor(
    () => {
      const section = app.view.container.querySelector(
        '[data-component="ChatInputSection"]'
      ) as HTMLElement | null;
      if (!section) {
        throw new Error("Chat input section not rendered");
      }
      return section;
    },
    { timeout: 10_000 }
  );
}

async function waitForPromptFile(promptPath: string): Promise<void> {
  await waitFor(
    () => {
      if (!existsSync(promptPath)) {
        throw new Error(`Flow prompt file does not exist yet: ${promptPath}`);
      }
    },
    { timeout: 10_000 }
  );
}

async function waitForFlowPromptCard(app: AppHarness): Promise<HTMLButtonElement> {
  return waitFor(
    () => {
      const openButton = Array.from(app.view.container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Open flow prompt")
      ) as HTMLButtonElement | undefined;
      if (!openButton) {
        throw new Error("Flow Prompting CTA not visible");
      }
      return openButton;
    },
    { timeout: 10_000 }
  );
}

async function waitForFlowPromptState(
  app: AppHarness,
  predicate: (
    state: Awaited<ReturnType<typeof app.env.orpc.workspace.flowPrompt.getState>>
  ) => boolean,
  description: string,
  timeoutMs: number = 20_000
): Promise<void> {
  await waitFor(
    async () => {
      const state = await app.env.orpc.workspace.flowPrompt.getState({
        workspaceId: app.workspaceId,
      });
      if (!predicate(state)) {
        throw new Error(`Flow prompt state did not match: ${description}`);
      }
    },
    { timeout: timeoutMs }
  );
}

async function openWorkspaceActionsMenu(
  app: AppHarness,
  user: ReturnType<typeof userEvent.setup>
): Promise<ReturnType<typeof within>> {
  const menuButton = await waitFor(
    () => {
      const button = app.view.container.querySelector(
        'button[aria-label="Workspace actions"]'
      ) as HTMLButtonElement | null;
      if (!button) {
        throw new Error("Workspace actions button not found");
      }
      return button;
    },
    { timeout: 10_000 }
  );

  await user.click(menuButton);
  return within(app.view.container.ownerDocument.body);
}

async function clickWorkspaceAction(
  app: AppHarness,
  user: ReturnType<typeof userEvent.setup>,
  label: string
): Promise<void> {
  const body = await openWorkspaceActionsMenu(app, user);
  const actionButton = await body.findByRole("button", { name: label }, { timeout: 10_000 });
  await user.click(actionButton);
}

async function enableFlowPromptViaUI(
  app: AppHarness,
  user: ReturnType<typeof userEvent.setup>
): Promise<string> {
  const promptPath = getFlowPromptPath(app);
  await clickWorkspaceAction(app, user, "Enable Flow Prompting");
  await waitForPromptFile(promptPath);
  await waitForFlowPromptCard(app);
  return promptPath;
}

// Writing the file directly simulates the external-editor save path that Flow Prompting is built for.
async function writeFlowPrompt(promptPath: string, content: string): Promise<void> {
  await fsPromises.writeFile(promptPath, content, "utf8");
}

describe("Flow Prompting (mock AI router)", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("enabling Flow Prompting keeps the chat input active and places the CTA above it", async () => {
    const app = await createAppHarness({ branchPrefix: "flow-ui-enable" });
    const user = userEvent.setup({ document: app.view.container.ownerDocument });

    try {
      const promptPath = await enableFlowPromptViaUI(app, user);
      const openButton = await waitForFlowPromptCard(app);
      const chatInputSection = await waitForChatInputSection(app);
      const textarea = await getActiveTextarea(app);

      expect(
        openButton.compareDocumentPosition(chatInputSection) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
      expect(textarea.disabled).toBe(false);
      expect(await fsPromises.readFile(promptPath, "utf8")).toBe("");

      const inlineMessage = "Inline follow-up still works with Flow Prompting enabled";
      await app.chat.send(inlineMessage);
      await app.chat.expectTranscriptContains(`Mock response: ${inlineMessage}`);
      await app.chat.expectStreamComplete();
    } finally {
      await app.dispose();
    }
  }, 60_000);

  test("saving the flow prompt while idle sends a visible update and injects the exact path into later requests", async () => {
    const app = await createAppHarness({ branchPrefix: "flow-ui-idle" });
    const user = userEvent.setup({ document: app.view.container.ownerDocument });
    const collector = createStreamCollector(app.env.orpc, app.workspaceId);
    collector.start();
    await collector.waitForSubscription(10_000);

    try {
      const promptPath = await enableFlowPromptViaUI(app, user);
      collector.clear();

      const flowPromptText = "Keep edits scoped and summarize why each change matters.";
      await writeFlowPrompt(promptPath, flowPromptText);

      const promptUpdateEnd = await collector.waitForEvent("stream-end", 45_000);
      expect(promptUpdateEnd).not.toBeNull();
      await app.chat.expectTranscriptContains(
        "Flow prompt updated. Follow current agent instructions."
      );
      await app.chat.expectTranscriptContains(flowPromptText);

      collector.clear();
      const inlineMessage = "Please confirm which model is currently active for this conversation.";
      await app.chat.send(inlineMessage);
      const inlineStreamEnd = await collector.waitForEvent("stream-end", 30_000);
      expect(inlineStreamEnd).not.toBeNull();

      const lastPrompt = getLastMockPromptMessages(app);
      const systemPromptText = getSystemPromptText(lastPrompt);
      expect(systemPromptText).toContain(`Flow prompt file path: ${promptPath}`);
      expect(systemPromptText).toContain("A flow prompt file exists for this workspace.");
    } finally {
      await collector.waitForStop();
      await app.dispose();
    }
  }, 90_000);

  test("while a turn is busy, Flow Prompting queues only the latest saved version after the current step", async () => {
    const app = await createAppHarness({ branchPrefix: "flow-ui-queued" });
    const user = userEvent.setup({ document: app.view.container.ownerDocument });
    const collector = createStreamCollector(app.env.orpc, app.workspaceId);
    collector.start();
    await collector.waitForSubscription(10_000);

    try {
      const promptPath = await enableFlowPromptViaUI(app, user);
      collector.clear();

      const busyTurn = buildMockStreamStartGateMessage(`Busy turn${" keep-streaming".repeat(600)}`);
      await app.chat.send(busyTurn);

      const firstQueuedContent = "First queued flow prompt version";
      await writeFlowPrompt(promptPath, firstQueuedContent);
      await waitForFlowPromptState(
        app,
        (state) =>
          state.contentFingerprint === sha256(firstQueuedContent) &&
          state.hasPendingUpdate === true,
        "first queued flow prompt save"
      );
      await waitFor(
        () => {
          const text = app.view.container.textContent ?? "";
          if (!text.includes("Latest save queued after the current step.")) {
            throw new Error("Queued Flow Prompting status not shown");
          }
        },
        { timeout: 20_000 }
      );

      const latestQueuedContent = "Latest queued flow prompt version";
      await writeFlowPrompt(promptPath, latestQueuedContent);
      await waitForFlowPromptState(
        app,
        (state) =>
          state.contentFingerprint === sha256(latestQueuedContent) &&
          state.hasPendingUpdate === true,
        "latest queued flow prompt save"
      );

      app.env.services.aiService.releaseMockStreamStartGate(app.workspaceId);

      const secondStreamEnd = await collector.waitForEventN("stream-end", 2, 90_000);
      expect(secondStreamEnd).not.toBeNull();
      await app.chat.expectTranscriptContains(latestQueuedContent, 20_000);
      await waitFor(
        () => {
          const text = app.view.container.textContent ?? "";
          if (text.includes(firstQueuedContent)) {
            throw new Error("Intermediate queued flow prompt version should not be rendered");
          }
        },
        { timeout: 5_000 }
      );

      const lastPrompt = getLastMockPromptMessages(app);
      const lastUserPromptText = getLastUserPromptText(lastPrompt);
      expect(lastUserPromptText).toContain(latestQueuedContent);
      expect(lastUserPromptText).not.toContain(firstQueuedContent);
    } finally {
      await collector.waitForStop();
      await app.dispose();
    }
  }, 120_000);

  test("disabling Flow Prompting warns before deleting a non-empty prompt file", async () => {
    const app = await createAppHarness({ branchPrefix: "flow-ui-disable" });
    const user = userEvent.setup({ document: app.view.container.ownerDocument });
    const collector = createStreamCollector(app.env.orpc, app.workspaceId);
    collector.start();
    await collector.waitForSubscription(10_000);

    try {
      const promptPath = await enableFlowPromptViaUI(app, user);
      collector.clear();

      const promptText = "Preserve this durable instruction until the user confirms deletion.";
      await writeFlowPrompt(promptPath, promptText);
      const promptUpdateEnd = await collector.waitForEvent("stream-end", 45_000);
      expect(promptUpdateEnd).not.toBeNull();
      await waitForFlowPromptState(
        app,
        (state) => state.hasNonEmptyContent === true && state.hasPendingUpdate === false,
        "non-empty prompt file recognized"
      );

      const disableButton = await within(app.view.container).findByRole(
        "button",
        { name: "Disable" },
        { timeout: 10_000 }
      );
      await user.click(disableButton);

      const body = within(app.view.container.ownerDocument.body);
      const dialog = await body.findByRole("dialog", {}, { timeout: 10_000 });
      expect(dialog.textContent).toContain(
        `Delete ${getFlowPromptRelativePath(app.metadata.name)} and return to inline chat?`
      );
      expect(dialog.textContent).toContain(
        "The flow prompt file contains content and will be deleted."
      );

      const cancelButton = await body.findByRole(
        "button",
        { name: /cancel/i },
        { timeout: 10_000 }
      );
      await user.click(cancelButton);
      await waitFor(
        () => {
          if (body.queryByRole("dialog")) {
            throw new Error("Disable confirmation dialog should close after cancel");
          }
        },
        { timeout: 10_000 }
      );
      expect(existsSync(promptPath)).toBe(true);
      expect(within(app.view.container).queryByText("Flow Prompting")).toBeTruthy();

      collector.clear();
      const disableAgainButton = await within(app.view.container).findByRole(
        "button",
        { name: "Disable" },
        { timeout: 10_000 }
      );
      await user.click(disableAgainButton);

      const deleteButton = await body.findByRole(
        "button",
        { name: /delete file/i },
        { timeout: 10_000 }
      );
      await user.click(deleteButton);

      const clearingStreamEnd = await collector.waitForEvent("stream-end", 45_000);
      expect(clearingStreamEnd).not.toBeNull();
      await app.chat.expectTranscriptContains("The flow prompt file is now empty.", 20_000);

      await waitFor(
        () => {
          if (existsSync(promptPath)) {
            throw new Error("Flow prompt file should be deleted after confirmation");
          }
        },
        { timeout: 10_000 }
      );
      await waitFor(
        () => {
          const text = app.view.container.textContent ?? "";
          if (text.includes("Flow Prompting")) {
            throw new Error("Flow Prompting CTA should disappear after disabling");
          }
        },
        { timeout: 10_000 }
      );

      const lastPrompt = getLastMockPromptMessages(app);
      expect(getLastUserPromptText(lastPrompt)).toContain("The flow prompt file is now empty.");
      expect(await getActiveTextarea(app)).toBeTruthy();
    } finally {
      await collector.waitForStop();
      await app.dispose();
    }
  }, 90_000);
});
