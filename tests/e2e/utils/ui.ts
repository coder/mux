import { expect, type Locator, type Page } from "@playwright/test";
import type { DemoProjectConfig } from "./demoProject";

type ChatMode = "Plan" | "Exec";

export interface StreamTimelineEvent {
  type: string;
  timestamp: number;
  delta?: string;
  messageId?: string;
  model?: string;
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
  result?: unknown;
}

export interface StreamTimeline {
  events: StreamTimelineEvent[];
}

export interface WorkspaceUI {
  readonly projects: {
    openFirstWorkspace(): Promise<void>;
  };
  readonly chat: {
    waitForTranscript(): Promise<void>;
    setMode(mode: ChatMode): Promise<void>;
    setThinkingLevel(value: number): Promise<void>;
    sendMessage(message: string): Promise<void>;
    expectTranscriptContains(text: string): Promise<void>;
    expectActionButtonVisible(label: string): Promise<void>;
    clickActionButton(label: string): Promise<void>;
    expectStatusMessageContains(text: string): Promise<void>;
    sendCommandAndExpectStatus(command: string, expectedStatus: string): Promise<void>;
    captureStreamTimeline(
      action: () => Promise<void>,
      options?: { timeoutMs?: number }
    ): Promise<StreamTimeline>;
  };
  readonly metaSidebar: {
    expectVisible(): Promise<void>;
    selectTab(label: string): Promise<void>;
  };
  readonly settings: {
    open(): Promise<void>;
    close(): Promise<void>;
    expectOpen(): Promise<void>;
    expectClosed(): Promise<void>;
    selectSection(section: "General" | "Providers" | "Models"): Promise<void>;
    expandProvider(providerName: string): Promise<void>;
  };
  readonly context: DemoProjectConfig;
}

function sanitizeMode(mode: ChatMode): ChatMode {
  const normalized = mode.toLowerCase();
  switch (normalized) {
    case "plan":
      return "Plan";
    case "exec":
      return "Exec";
    default:
      throw new Error(`Unsupported chat mode: ${mode as string}`);
  }
}

function sliderLocator(page: Page): Locator {
  return page.getByRole("slider", { name: "Thinking level" });
}

function transcriptLocator(page: Page): Locator {
  return page.getByRole("log", { name: "Conversation transcript" });
}

export function createWorkspaceUI(page: Page, context: DemoProjectConfig): WorkspaceUI {
  const projects = {
    async openFirstWorkspace(): Promise<void> {
      const navigation = page.getByRole("navigation", { name: "Projects" });
      await expect(navigation).toBeVisible();

      const projectItems = navigation.locator('[role="button"][aria-controls]');
      const projectItem = projectItems.first();
      await expect(projectItem).toBeVisible();

      const workspaceListId = await projectItem.getAttribute("aria-controls");
      if (!workspaceListId) {
        throw new Error("Project item is missing aria-controls attribute");
      }

      const workspaceItems = page.locator(`#${workspaceListId} > div[role="button"]`);
      const workspaceItem = workspaceItems.first();
      const isVisible = await workspaceItem.isVisible().catch(() => false);
      if (!isVisible) {
        await projectItem.click();
        await workspaceItem.waitFor({ state: "visible" });
      }

      await workspaceItem.click();
      await chat.waitForTranscript();
    },
  };

  const chat = {
    async waitForTranscript(): Promise<void> {
      await transcriptLocator(page).waitFor();
    },

    async setMode(mode: ChatMode): Promise<void> {
      const normalizedMode = sanitizeMode(mode);
      const button = page.getByRole("button", { name: normalizedMode, exact: true });
      await expect(button).toBeVisible();
      await button.click();
      const pressed = await button.getAttribute("aria-pressed");
      if (pressed !== "true") {
        throw new Error(`"${normalizedMode}" button did not toggle into active state`);
      }
    },

    async setThinkingLevel(value: number): Promise<void> {
      if (!Number.isInteger(value)) {
        throw new Error("Slider value must be an integer");
      }
      if (value < 0 || value > 10) {
        throw new Error(`Slider value ${value} is outside expected range 0-10`);
      }

      const slider = sliderLocator(page);
      await expect(slider).toBeVisible();
      await slider.evaluate((element, desiredValue) => {
        const input = element as HTMLInputElement;
        input.value = String(desiredValue);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }, value);

      await expect(slider).toHaveValue(String(value));
    },

    async sendMessage(message: string): Promise<void> {
      if (message.length === 0) {
        throw new Error("Message must not be empty");
      }
      const input = page.getByRole("textbox", {
        name: /Message Claude|Edit your last message/,
      });
      await expect(input).toBeVisible();
      await input.fill(message);
      await page.keyboard.press("Enter");
    },

    async expectTranscriptContains(text: string): Promise<void> {
      await expect(transcriptLocator(page)).toContainText(text, { timeout: 45_000 });
    },

    async expectActionButtonVisible(label: string): Promise<void> {
      const button = page.getByRole("button", { name: label });
      await expect(button.last()).toBeVisible();
    },

    async clickActionButton(label: string): Promise<void> {
      const button = page.getByRole("button", { name: label });
      const lastButton = button.last();
      await expect(lastButton).toBeVisible();
      await lastButton.click();
    },

    async expectStatusMessageContains(text: string): Promise<void> {
      const status = page.getByRole("status").filter({ hasText: text });
      await expect(status).toBeVisible();
    },

    /**
     * Send a slash command and wait for a status toast concurrently.
     * This avoids the race condition where the toast can auto-dismiss (after 3s)
     * before a sequential assertion has a chance to observe it.
     *
     * Uses waitForSelector which polls more aggressively than expect().toBeVisible()
     * to catch transient elements like auto-dismissing toasts.
     */
    async sendCommandAndExpectStatus(command: string, expectedStatus: string): Promise<void> {
      if (!command.startsWith("/")) {
        throw new Error("sendCommandAndExpectStatus expects a slash command");
      }
      const input = page.getByRole("textbox", {
        name: /Message Claude|Edit your last message/,
      });
      await expect(input).toBeVisible();

      // Use page.waitForSelector which polls aggressively for transient elements.
      // Start the wait BEFORE triggering the action to catch the toast immediately.
      // Use longer timeout since slash commands involve async ORPC calls under the hood.
      const toastSelector = `[role="status"]:has-text("${expectedStatus}")`;
      const toastPromise = page.waitForSelector(toastSelector, {
        state: "attached",
        timeout: 30_000,
      });

      // Send the command
      await input.fill(command);
      await page.keyboard.press("Enter");

      // Wait for the toast we started watching for
      await toastPromise;
    },

    async captureStreamTimeline(
      action: () => Promise<void>,
      options?: { timeoutMs?: number }
    ): Promise<StreamTimeline> {
      const timeoutMs = options?.timeoutMs ?? 20_000;
      const workspaceId = context.workspaceId;
      await page.evaluate((id: string) => {
        type StreamCaptureEvent = {
          type: string;
          timestamp: number;
          delta?: string;
          messageId?: string;
          model?: string;
          toolName?: string;
          toolCallId?: string;
          args?: unknown;
          result?: unknown;
        };
        type StreamCapture = {
          events: StreamCaptureEvent[];
          unsubscribe: () => void;
        };

        const win = window as unknown as {
          __muxStreamCapture?: Record<string, StreamCapture>;
        };

        const store =
          win.__muxStreamCapture ??
          (win.__muxStreamCapture = Object.create(null) as Record<string, StreamCapture>);
        const existing = store[id];
        if (existing) {
          existing.unsubscribe();
          delete store[id];
        }

        const events: StreamCaptureEvent[] = [];
        const controller = new AbortController();
        const signal = controller.signal;

        // Start processing in background
        void (async () => {
          try {
            if (!window.__ORPC_CLIENT__) {
              throw new Error("ORPC client not initialized");
            }
            const iterator = await window.__ORPC_CLIENT__.workspace.onChat(
              { workspaceId: id },
              { signal }
            );

            for await (const message of iterator) {
              if (signal.aborted) break;

              if (!message || typeof message !== "object") {
                continue;
              }
              if (
                !("type" in message) ||
                typeof (message as { type?: unknown }).type !== "string"
              ) {
                continue;
              }
              const eventType = (message as { type: string }).type;
              const isStreamEvent = eventType.startsWith("stream-");
              const isToolEvent = eventType.startsWith("tool-call-");
              const isReasoningEvent = eventType.startsWith("reasoning-");
              if (!isStreamEvent && !isToolEvent && !isReasoningEvent) {
                continue;
              }
              const entry: StreamCaptureEvent = {
                type: eventType,
                timestamp: Date.now(),
              };
              if (
                "delta" in message &&
                typeof (message as { delta?: unknown }).delta === "string"
              ) {
                entry.delta = (message as { delta: string }).delta;
              }
              if (
                "messageId" in message &&
                typeof (message as { messageId?: unknown }).messageId === "string"
              ) {
                entry.messageId = (message as { messageId: string }).messageId;
              }
              if (
                "model" in message &&
                typeof (message as { model?: unknown }).model === "string"
              ) {
                entry.model = (message as { model: string }).model;
              }
              if (
                isToolEvent &&
                "toolName" in message &&
                typeof (message as { toolName?: unknown }).toolName === "string"
              ) {
                entry.toolName = (message as { toolName: string }).toolName;
              }
              if (
                isToolEvent &&
                "toolCallId" in message &&
                typeof (message as { toolCallId?: unknown }).toolCallId === "string"
              ) {
                entry.toolCallId = (message as { toolCallId: string }).toolCallId;
              }
              if (isToolEvent && "args" in message) {
                entry.args = (message as { args?: unknown }).args;
              }
              if (isToolEvent && "result" in message) {
                entry.result = (message as { result?: unknown }).result;
              }
              events.push(entry);
            }
          } catch (err) {
            if (!signal.aborted) {
              console.error("[E2E] Stream capture error:", err);
            }
          }
        })();

        store[id] = {
          events,
          unsubscribe: () => controller.abort(),
        };
      }, workspaceId);

      let actionError: unknown;
      try {
        await action();
        await page.waitForFunction(
          (id: string) => {
            type StreamCaptureEvent = { type: string };
            type StreamCapture = { events: StreamCaptureEvent[] };
            const win = window as unknown as {
              __muxStreamCapture?: Record<string, StreamCapture>;
            };
            const capture = win.__muxStreamCapture?.[id];
            if (!capture) {
              return false;
            }
            // Wait for either stream-end or stream-error to complete the capture
            return capture.events.some(
              (event) => event.type === "stream-end" || event.type === "stream-error"
            );
          },
          workspaceId,
          { timeout: timeoutMs }
        );
      } catch (error) {
        actionError = error;
      }

      const events = await page.evaluate((id: string) => {
        type StreamCaptureEvent = {
          type: string;
          timestamp: number;
          delta?: string;
          messageId?: string;
          model?: string;
          toolName?: string;
          toolCallId?: string;
          args?: unknown;
          result?: unknown;
        };
        type StreamCapture = {
          events: StreamCaptureEvent[];
          unsubscribe: () => void;
        };
        const win = window as unknown as {
          __muxStreamCapture?: Record<string, StreamCapture>;
        };
        const store = win.__muxStreamCapture;
        const capture = store?.[id];
        if (!capture) {
          return [] as StreamCaptureEvent[];
        }
        capture.unsubscribe();
        if (store) {
          delete store[id];
        }
        return capture.events.slice();
      }, workspaceId);

      if (actionError) {
        throw actionError;
      }

      return { events };
    },
  };

  const metaSidebar = {
    async expectVisible(): Promise<void> {
      await expect(page.getByRole("complementary", { name: "Workspace insights" })).toBeVisible();
    },

    async selectTab(label: string): Promise<void> {
      const tab = page.getByRole("tab", { name: label });
      await expect(tab).toBeVisible();
      await tab.click();
      const selected = await tab.getAttribute("aria-selected");
      if (selected !== "true") {
        throw new Error(`Tab "${label}" did not enter selected state`);
      }
    },
  };

  const settings = {
    async open(): Promise<void> {
      // Click the settings gear button in the title bar
      const settingsButton = page.getByRole("button", { name: /settings/i });
      await expect(settingsButton).toBeVisible();
      await settingsButton.click();
      await settings.expectOpen();
    },

    async close(): Promise<void> {
      // Press Escape to close
      await page.keyboard.press("Escape");
      await settings.expectClosed();
    },

    async expectOpen(): Promise<void> {
      const dialog = page.getByRole("dialog", { name: "Settings" });
      await expect(dialog).toBeVisible({ timeout: 5000 });
    },

    async expectClosed(): Promise<void> {
      const dialog = page.getByRole("dialog", { name: "Settings" });
      await expect(dialog).not.toBeVisible({ timeout: 5000 });
    },

    async selectSection(section: "General" | "Providers" | "Models"): Promise<void> {
      const sectionButton = page.getByRole("button", { name: section, exact: true });
      await expect(sectionButton).toBeVisible();
      await sectionButton.click();
    },

    async expandProvider(providerName: string): Promise<void> {
      const providerButton = page.getByRole("button", { name: new RegExp(providerName, "i") });
      await expect(providerButton).toBeVisible();
      await providerButton.click();
      // Wait for expansion - look for the "Base URL" label which is more unique
      await expect(page.getByText(/Base URL/)).toBeVisible({ timeout: 5000 });
    },
  };

  return {
    projects,
    chat,
    metaSidebar,
    settings,
    context,
  };
}
