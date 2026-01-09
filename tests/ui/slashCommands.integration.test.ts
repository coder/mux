/**
 * Integration tests for custom slash commands (.mux/commands/*).
 *
 * Tests cover:
 * - Custom command discovery and autocomplete suggestions
 * - Command execution with stdout becoming the user message
 * - Exit code 2 (user abort) handling
 * - Error handling for failed commands
 *
 * Note: These tests drive the UI from the user's perspective - typing in chat input,
 * clicking suggestions, not calling backend APIs directly for the actions being tested.
 */

import { fireEvent, waitFor } from "@testing-library/react";
import * as fs from "fs/promises";
import * as path from "path";

import { shouldRunIntegrationTests } from "../testUtils";
import {
  cleanupSharedRepo,
  createSharedRepo,
  withSharedWorkspace,
} from "../ipc/sendMessageTestHelpers";

import { installDom } from "./dom";
import { renderApp } from "./renderReviewPanel";
import { cleanupView, setupWorkspaceView } from "./helpers";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// Helper to create a custom slash command in the workspace
async function createCustomCommand(
  workspacePath: string,
  name: string,
  script: string
): Promise<void> {
  const commandsDir = path.join(workspacePath, ".mux", "commands");
  await fs.mkdir(commandsDir, { recursive: true });
  const commandPath = path.join(commandsDir, name);
  await fs.writeFile(commandPath, script);
  await fs.chmod(commandPath, 0o755);
}

// Helper to get the chat input textarea
function getChatInput(container: HTMLElement): HTMLTextAreaElement | null {
  return container.querySelector(
    'textarea[data-testid="chat-input"]'
  ) as HTMLTextAreaElement | null;
}

// Helper to type in chat input
function typeInChatInput(input: HTMLTextAreaElement, text: string): void {
  fireEvent.change(input, { target: { value: text } });
}

// Helper to submit chat input (press Enter)
function submitChatInput(input: HTMLTextAreaElement): void {
  fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
}

describeIntegration("Custom Slash Commands (UI)", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("custom commands appear in autocomplete suggestions", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      // Create a custom command in the workspace
      await createCustomCommand(
        metadata.namedWorkspacePath,
        "test-cmd",
        '#!/bin/bash\necho "Test output"'
      );

      const cleanupDom = installDom();
      const view = renderApp({
        apiClient: env.orpc,
        metadata,
      });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);

        // Find the chat input
        const chatInput = await waitFor(
          () => {
            const input = getChatInput(view.container);
            if (!input) throw new Error("Chat input not found");
            return input;
          },
          { timeout: 10_000 }
        );

        // Type "/" to trigger suggestions
        typeInChatInput(chatInput, "/");

        // Wait for suggestions to appear - custom command should be included
        await waitFor(
          () => {
            // Look for suggestion container
            const suggestions = view.container.querySelectorAll('[role="option"]');
            if (!suggestions.length) {
              throw new Error("No suggestions displayed");
            }
            // Look for our custom command
            const customSuggestion = Array.from(suggestions).find((el) =>
              el.textContent?.includes("/test-cmd")
            );
            if (!customSuggestion) {
              throw new Error("Custom command not in suggestions");
            }
          },
          { timeout: 10_000 }
        );
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 60_000);

  test("custom command filters suggestions by partial match", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      // Create multiple custom commands
      await createCustomCommand(
        metadata.namedWorkspacePath,
        "alpha-cmd",
        '#!/bin/bash\necho "Alpha"'
      );
      await createCustomCommand(
        metadata.namedWorkspacePath,
        "beta-cmd",
        '#!/bin/bash\necho "Beta"'
      );

      const cleanupDom = installDom();
      const view = renderApp({
        apiClient: env.orpc,
        metadata,
      });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);

        const chatInput = await waitFor(
          () => {
            const input = getChatInput(view.container);
            if (!input) throw new Error("Chat input not found");
            return input;
          },
          { timeout: 10_000 }
        );

        // Type "/alpha" - should filter to just alpha-cmd
        typeInChatInput(chatInput, "/alpha");

        await waitFor(
          () => {
            const suggestions = view.container.querySelectorAll('[role="option"]');
            const alphaSuggestion = Array.from(suggestions).find((el) =>
              el.textContent?.includes("/alpha-cmd")
            );
            const betaSuggestion = Array.from(suggestions).find((el) =>
              el.textContent?.includes("/beta-cmd")
            );
            if (!alphaSuggestion) {
              throw new Error("alpha-cmd should appear");
            }
            if (betaSuggestion) {
              throw new Error("beta-cmd should NOT appear when filtering by 'alpha'");
            }
          },
          { timeout: 5_000 }
        );
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 60_000);

  test("custom command executes and sends output as message", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata, collector }) => {
      // Create a command that outputs a specific message
      await createCustomCommand(
        metadata.namedWorkspacePath,
        "echo-test",
        '#!/bin/bash\necho "Custom command output for test"'
      );

      const cleanupDom = installDom();
      const view = renderApp({
        apiClient: env.orpc,
        metadata,
      });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);

        const chatInput = await waitFor(
          () => {
            const input = getChatInput(view.container);
            if (!input) throw new Error("Chat input not found");
            return input;
          },
          { timeout: 10_000 }
        );

        // Type and submit the custom command
        typeInChatInput(chatInput, "/echo-test");
        submitChatInput(chatInput);

        // Wait for init events (command execution streams via init events)
        await collector.waitForEvent("init-start", 10_000);
        await collector.waitForEvent("init-end", 10_000);

        // Wait for a user message to appear with the command output
        await waitFor(
          () => {
            const messages = view.container.querySelectorAll('[data-role="user"]');
            const outputMessage = Array.from(messages).find((el) =>
              el.textContent?.includes("Custom command output for test")
            );
            if (!outputMessage) {
              throw new Error("Command output not found in messages");
            }
          },
          { timeout: 15_000 }
        );
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 90_000);

  test("custom command with exit code 2 shows error and restores input", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      // Create a command that exits with code 2 (user abort)
      await createCustomCommand(
        metadata.namedWorkspacePath,
        "abort-test",
        '#!/bin/bash\necho "Some output"\nexit 2'
      );

      const cleanupDom = installDom();
      const view = renderApp({
        apiClient: env.orpc,
        metadata,
      });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);

        const chatInput = await waitFor(
          () => {
            const input = getChatInput(view.container);
            if (!input) throw new Error("Chat input not found");
            return input;
          },
          { timeout: 10_000 }
        );

        const originalInput = "/abort-test";
        typeInChatInput(chatInput, originalInput);
        submitChatInput(chatInput);

        // Wait for error toast to appear
        await waitFor(
          () => {
            // Look for toast with abort message
            const toast = view.container.querySelector('[role="status"]');
            if (!toast?.textContent?.toLowerCase().includes("abort")) {
              throw new Error("Abort toast not found");
            }
          },
          { timeout: 15_000 }
        );

        // Verify input is restored
        await waitFor(
          () => {
            const input = getChatInput(view.container);
            if (input?.value !== originalInput) {
              throw new Error(`Expected input "${originalInput}" but got "${input?.value}"`);
            }
          },
          { timeout: 5_000 }
        );

        // Verify no user message was sent
        const messages = view.container.querySelectorAll('[data-role="user"]');
        const outputMessage = Array.from(messages).find((el) =>
          el.textContent?.includes("Some output")
        );
        expect(outputMessage).toBeUndefined();
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 60_000);

  test("custom command with non-zero exit shows error", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      // Create a command that fails with exit code 1
      await createCustomCommand(
        metadata.namedWorkspacePath,
        "fail-test",
        '#!/bin/bash\necho "Error output" >&2\nexit 1'
      );

      const cleanupDom = installDom();
      const view = renderApp({
        apiClient: env.orpc,
        metadata,
      });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);

        const chatInput = await waitFor(
          () => {
            const input = getChatInput(view.container);
            if (!input) throw new Error("Chat input not found");
            return input;
          },
          { timeout: 10_000 }
        );

        typeInChatInput(chatInput, "/fail-test");
        submitChatInput(chatInput);

        // Wait for error toast
        await waitFor(
          () => {
            const toast = view.container.querySelector('[role="status"]');
            if (!toast?.textContent?.toLowerCase().includes("failed")) {
              throw new Error("Error toast not found");
            }
          },
          { timeout: 15_000 }
        );

        // Verify input is restored
        await waitFor(
          () => {
            const input = getChatInput(view.container);
            if (input?.value !== "/fail-test") {
              throw new Error("Input not restored after error");
            }
          },
          { timeout: 5_000 }
        );
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 60_000);

  test("custom command receives arguments", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata, collector }) => {
      // Create a command that echoes its arguments
      await createCustomCommand(
        metadata.namedWorkspacePath,
        "args-test",
        '#!/bin/bash\necho "Args: $@"'
      );

      const cleanupDom = installDom();
      const view = renderApp({
        apiClient: env.orpc,
        metadata,
      });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);

        const chatInput = await waitFor(
          () => {
            const input = getChatInput(view.container);
            if (!input) throw new Error("Chat input not found");
            return input;
          },
          { timeout: 10_000 }
        );

        // Submit command with arguments
        typeInChatInput(chatInput, "/args-test foo bar baz");
        submitChatInput(chatInput);

        // Wait for command execution
        await collector.waitForEvent("init-end", 10_000);

        // Verify the output includes the args
        await waitFor(
          () => {
            const messages = view.container.querySelectorAll('[data-role="user"]');
            const outputMessage = Array.from(messages).find((el) =>
              el.textContent?.includes("Args: foo bar baz")
            );
            if (!outputMessage) {
              throw new Error("Command output with args not found");
            }
          },
          { timeout: 15_000 }
        );
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 90_000);

  test("custom command receives stdin from multiline input", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata, collector }) => {
      // Create a command that reads stdin
      await createCustomCommand(
        metadata.namedWorkspacePath,
        "stdin-test",
        '#!/bin/bash\necho "Got stdin:"\ncat'
      );

      const cleanupDom = installDom();
      const view = renderApp({
        apiClient: env.orpc,
        metadata,
      });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);

        const chatInput = await waitFor(
          () => {
            const input = getChatInput(view.container);
            if (!input) throw new Error("Chat input not found");
            return input;
          },
          { timeout: 10_000 }
        );

        // Submit command with multiline input (stdin on subsequent lines)
        const multilineInput = "/stdin-test\nHello from stdin\nLine 2";
        typeInChatInput(chatInput, multilineInput);
        submitChatInput(chatInput);

        // Wait for command execution
        await collector.waitForEvent("init-end", 10_000);

        // Verify the output includes stdin content
        await waitFor(
          () => {
            const messages = view.container.querySelectorAll('[data-role="user"]');
            const outputMessage = Array.from(messages).find(
              (el) =>
                el.textContent?.includes("Got stdin:") &&
                el.textContent?.includes("Hello from stdin")
            );
            if (!outputMessage) {
              throw new Error("Command output with stdin not found");
            }
          },
          { timeout: 15_000 }
        );
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 90_000);
});
