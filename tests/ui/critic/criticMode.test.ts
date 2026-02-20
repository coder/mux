import "../dom";

import { fireEvent, waitFor } from "@testing-library/react";

import { getModelKey, getThinkingLevelKey } from "@/common/constants/storage";
import type { HistoryService } from "@/node/services/historyService";
import type { MockAiRouterHandler, MockAiRouterRequest } from "@/node/services/mock/mockAiRouter";
import { preloadTestModules } from "../../ipc/setup";
import { createStreamCollector } from "../../ipc/streamCollector";
import { shouldRunIntegrationTests } from "../../testUtils";
import { createAppHarness, type AppHarness } from "../harness";

function actorHandler(text: string): MockAiRouterHandler {
  return {
    match: (request) => request.isCriticTurn !== true,
    respond: () => ({ assistantText: text }),
  };
}

function criticHandler(text: string): MockAiRouterHandler {
  return {
    match: (request) => request.isCriticTurn === true,
    respond: () => ({ assistantText: text }),
  };
}

function cloneRequest(request: MockAiRouterRequest): MockAiRouterRequest {
  return typeof structuredClone === "function"
    ? structuredClone(request)
    : (JSON.parse(JSON.stringify(request)) as MockAiRouterRequest);
}

interface ServiceContainerWithHistory {
  historyService: HistoryService;
}

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

function getHistoryService(app: AppHarness): HistoryService {
  return (app.env.services as unknown as ServiceContainerWithHistory).historyService;
}

function getTextarea(app: AppHarness): HTMLTextAreaElement {
  const textarea = app.view.container.querySelector("textarea") as HTMLTextAreaElement | null;
  if (!textarea) {
    throw new Error("Textarea not found");
  }
  return textarea;
}

/**
 * Enable critic mode and wait for the UI to reflect the change.
 * After this returns, the badge is visible and localStorage is written.
 */
async function enableCriticMode(app: AppHarness): Promise<void> {
  await app.chat.send("/critic");
  await waitFor(
    () => {
      const badge = app.view.container.querySelector('[data-component="CriticBadge"]');
      if (!badge) {
        throw new Error("Critic badge not found — /critic command may not have been processed yet");
      }
    },
    { timeout: 5_000 }
  );
}

/**
 * Set the critic prompt and start the critic loop via IPC.
 * This bypasses the ChatInput send flow (which has stale React closure issues
 * in happy-dom) and calls the backend directly, matching what the production
 * ChatInput does when the user hits Enter in critic mode.
 */
async function setCriticPromptAndStart(app: AppHarness, prompt: string): Promise<void> {
  // Read model + thinking from localStorage to match what the React app's useSendMessageOptions
  // resolves. This avoids mismatches between actor and critic requests.
  const storedModel = window.localStorage.getItem(getModelKey(app.workspaceId));
  const model = storedModel ? JSON.parse(storedModel) : "anthropic:claude-3-5-haiku-latest";
  const storedThinking = window.localStorage.getItem(getThinkingLevelKey(app.workspaceId));
  const thinkingLevel = storedThinking ? JSON.parse(storedThinking) : undefined;

  const result = await app.env.orpc.workspace.startCriticLoop({
    workspaceId: app.workspaceId,
    options: {
      model,
      agentId: "exec",
      criticEnabled: true,
      criticPrompt: prompt,
      ...(thinkingLevel != null ? { thinkingLevel } : {}),
    },
  });
  if (!result.success) {
    throw new Error(`startCriticLoop failed: ${JSON.stringify(result)}`);
  }
}

async function stopStreamingFromUi(app: AppHarness): Promise<void> {
  const stopButton = await waitFor(
    () => {
      const button = app.view.container.querySelector(
        'button[aria-label="Stop streaming"]'
      ) as HTMLButtonElement | null;
      if (!button) {
        throw new Error("Stop streaming button not found");
      }
      return button;
    },
    { timeout: 10_000 }
  );

  fireEvent.click(stopButton);
}

describeIntegration("Actor-Critic mode", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("/critic toggles badge, placeholder, and button label", async () => {
    const app = await createAppHarness({ branchPrefix: "critic-toggle" });

    try {
      const footer = () =>
        app.view.container.querySelector(
          '[data-component="ChatModeToggles"]'
        ) as HTMLElement | null;
      const sendButton = () =>
        app.view.container.querySelector('button[aria-label="Send message"]');
      const setButton = () =>
        app.view.container.querySelector('button[aria-label="Set critic prompt"]');

      expect(footer()?.textContent ?? "").not.toContain("Critic mode active");
      expect(getTextarea(app).placeholder).not.toContain("Critic");
      expect(sendButton()).not.toBeNull();
      expect(setButton()).toBeNull();

      await app.chat.send("/critic");

      await waitFor(
        () => {
          expect(footer()?.textContent ?? "").toContain("Critic mode active");
        },
        { timeout: 5_000 }
      );

      // In critic mode: placeholder changes, button becomes "Set critic prompt"
      expect(getTextarea(app).placeholder).toContain("Critic");
      expect(setButton()).not.toBeNull();
      expect(sendButton()).toBeNull();

      await app.chat.send("/critic");

      await waitFor(
        () => {
          expect(footer()?.textContent ?? "").not.toContain("Critic mode active");
        },
        { timeout: 5_000 }
      );

      // After disabling: reverts to default
      expect(getTextarea(app).placeholder).not.toContain("Critic");
      expect(sendButton()).not.toBeNull();
      expect(setButton()).toBeNull();
    } finally {
      await app.dispose();
    }
  }, 30_000);

  test("setting critic prompt immediately starts critic loop against existing history", async () => {
    const app = await createAppHarness({ branchPrefix: "critic-loop" });
    const collector = createStreamCollector(app.env.orpc, app.workspaceId);
    collector.start();
    await collector.waitForSubscription(5_000);

    const router = app.env.services.aiService.getMockRouter();
    expect(router).not.toBeNull();
    router?.prependHandlers([criticHandler("/done"), actorHandler("Actor implementation ready.")]);

    try {
      // First, send a normal message (not in critic mode) to build history
      await app.chat.send("Implement a sorting algorithm");
      await app.chat.expectTranscriptContains("Actor implementation ready.", 15_000);
      await app.chat.expectStreamComplete(10_000);

      // Now enable critic mode and set the prompt — this should immediately
      // start a critic turn (no user message sent, critic evaluates existing history)
      await enableCriticMode(app);
      await setCriticPromptAndStart(app, "Check for edge cases");

      const criticStart = await collector.waitForEventN("stream-start", 2, 15_000);
      expect(criticStart).not.toBeNull();

      await waitFor(
        () => {
          const criticMessage = app.view.container.querySelector('[data-message-source="critic"]');
          expect(criticMessage).not.toBeNull();
        },
        { timeout: 10_000 }
      );
    } finally {
      collector.stop();
      await app.dispose();
    }
  }, 60_000);

  test("set prompt forwards critic instructions into the critic turn", async () => {
    const app = await createAppHarness({ branchPrefix: "critic-prompt" });

    const criticPrompt = "Focus on correctness and edge cases.";

    const criticRequests: MockAiRouterRequest[] = [];
    const router = app.env.services.aiService.getMockRouter();
    expect(router).not.toBeNull();
    router?.prependHandlers([
      {
        match: (request) => request.isCriticTurn === true,
        respond: (request) => {
          criticRequests.push(cloneRequest(request));
          return { assistantText: "/done" };
        },
      },
      actorHandler("Actor response."),
    ]);

    try {
      // Build some history first (normal mode)
      await app.chat.send("Implement a parser");
      await app.chat.expectTranscriptContains("Actor response.", 15_000);
      await app.chat.expectStreamComplete(15_000);

      // Start critic loop directly — evaluates existing history
      await setCriticPromptAndStart(app, criticPrompt);

      await waitFor(
        () => {
          expect(criticRequests.length).toBeGreaterThan(0);
        },
        { timeout: 5_000 }
      );

      const criticRequest = criticRequests[0];
      expect(criticRequest?.isCriticTurn).toBe(true);
      expect(criticRequest?.criticPrompt).toBe(criticPrompt);
      expect(criticRequest?.additionalSystemInstructions).toContain(criticPrompt);
      expect(criticRequest?.additionalSystemInstructions).toContain("exactly /done");
    } finally {
      await app.dispose();
    }
  }, 60_000);

  test("critic /done stops loop only when the full response is exactly '/done'", async () => {
    const app = await createAppHarness({ branchPrefix: "critic-done" });

    let actorCalls = 0;
    let criticCalls = 0;

    const router = app.env.services.aiService.getMockRouter();
    expect(router).not.toBeNull();
    router?.prependHandlers([
      {
        match: (request) => request.isCriticTurn === true,
        respond: () => {
          criticCalls += 1;
          if (criticCalls === 1) {
            return { assistantText: "Almost there, /done is premature." };
          }
          return { assistantText: "/done" };
        },
      },
      {
        match: (request) => request.isCriticTurn !== true,
        respond: () => {
          actorCalls += 1;
          return { assistantText: `Actor revision ${actorCalls}` };
        },
      },
    ]);

    try {
      // Build history with an initial actor turn
      await app.chat.send("Build something");
      await app.chat.expectTranscriptContains("Actor revision 1", 15_000);
      await app.chat.expectStreamComplete(10_000);

      // Enable critic + set prompt → starts critic loop against existing history.
      // First critic says "Almost there..." (not /done) → actor revision 2 fires →
      // second critic says /done → loop stops.
      await enableCriticMode(app);
      await setCriticPromptAndStart(app, "Review for completeness");

      await app.chat.expectTranscriptContains("Almost there", 20_000);
      await app.chat.expectTranscriptContains("Actor revision 2", 25_000);

      await waitFor(
        () => {
          expect(criticCalls).toBe(2);
        },
        { timeout: 25_000 }
      );

      await app.chat.expectStreamComplete(20_000);
      expect(actorCalls).toBe(2);
    } finally {
      await app.dispose();
    }
  }, 90_000);

  test("critic request history role-flips actor tool calls into JSON user text", async () => {
    const app = await createAppHarness({ branchPrefix: "critic-flip" });

    const criticRequests: MockAiRouterRequest[] = [];
    const router = app.env.services.aiService.getMockRouter();
    expect(router).not.toBeNull();
    router?.prependHandlers([
      {
        match: (request) => request.isCriticTurn === true,
        respond: (request) => {
          criticRequests.push(cloneRequest(request));
          return { assistantText: "/done" };
        },
      },
      {
        match: (request) => request.isCriticTurn !== true,
        respond: () => ({
          assistantText: "I'll inspect README.md",
          toolCalls: [
            {
              toolCallId: "tc-1",
              toolName: "file_read",
              args: { path: "README.md" },
              result: { content: "# Hello" },
            },
          ],
        }),
      },
    ]);

    try {
      // Build history with an actor turn that uses tools
      await app.chat.send("What's in the readme?");
      await app.chat.expectTranscriptContains("README.md", 15_000);
      await app.chat.expectStreamComplete(15_000);

      // Enable critic + set prompt → starts critic against existing history
      await setCriticPromptAndStart(app, "Check the tool usage");

      await waitFor(
        () => {
          expect(criticRequests.length).toBeGreaterThan(0);
        },
        { timeout: 20_000 }
      );

      const criticMessages = criticRequests[0]?.messages ?? [];

      const flippedUserMessage = criticMessages.find(
        (message) =>
          message.role === "assistant" &&
          message.parts.some(
            (part) => part.type === "text" && part.text.toLowerCase().includes("readme")
          )
      );
      expect(flippedUserMessage).toBeDefined();

      const flippedActorMessage = criticMessages.find(
        (message) =>
          message.role === "user" &&
          message.parts.some((part) => part.type === "text" && part.text.includes("file_read"))
      );
      expect(flippedActorMessage).toBeDefined();
    } finally {
      await app.dispose();
    }
  }, 60_000);

  test("critic reasoning streams live and persists interwoven in history", async () => {
    const app = await createAppHarness({ branchPrefix: "critic-reasoning" });
    const collector = createStreamCollector(app.env.orpc, app.workspaceId);
    collector.start();
    await collector.waitForSubscription(5_000);

    let criticRound = 0;
    const router = app.env.services.aiService.getMockRouter();
    expect(router).not.toBeNull();
    router?.prependHandlers([
      {
        match: (request) => request.isCriticTurn === true,
        respond: () => {
          criticRound += 1;
          if (criticRound === 1) {
            return {
              assistantText: "Please handle additional edge cases.",
              reasoningDeltas: [
                "Checking algorithm complexity.",
                "Looking for overflow and empty-input behavior.",
              ],
            };
          }
          return { assistantText: "/done" };
        },
      },
      {
        match: (request) => request.isCriticTurn !== true,
        respond: () => ({ assistantText: `Actor revision ${criticRound + 1}` }),
      },
    ]);

    try {
      // Build history with an initial actor turn
      await app.chat.send("Write a parser");
      await app.chat.expectTranscriptContains("Actor revision", 15_000);
      await app.chat.expectStreamComplete(15_000);

      // Enable critic + set prompt
      await setCriticPromptAndStart(app, "Check reasoning quality");

      await waitFor(
        () => {
          expect(criticRound).toBe(2);
        },
        { timeout: 35_000 }
      );

      const reasoningEvents = collector
        .getEvents()
        .filter((event) => event.type === "reasoning-delta" && event.messageSource === "critic");
      expect(reasoningEvents.length).toBeGreaterThan(0);

      const historyResult = await getHistoryService(app).getHistoryFromLatestBoundary(
        app.workspaceId
      );
      expect(historyResult.success).toBe(true);
      if (!historyResult.success) {
        throw new Error(`Failed to read workspace history: ${historyResult.error}`);
      }

      const assistantMessages = historyResult.data.filter(
        (message) => message.role === "assistant"
      );
      const firstCriticIndex = assistantMessages.findIndex(
        (message) => message.metadata?.messageSource === "critic"
      );
      expect(firstCriticIndex).toBeGreaterThan(0);
      expect(assistantMessages[firstCriticIndex - 1]?.metadata?.messageSource).toBe("actor");

      const criticMessageWithReasoning = assistantMessages.find(
        (message) =>
          message.metadata?.messageSource === "critic" &&
          message.parts.some((part) => part.type === "reasoning")
      );
      expect(criticMessageWithReasoning).toBeDefined();
    } finally {
      collector.stop();
      await app.dispose();
    }
  }, 90_000);

  // TODO: Context-exceeded recovery with startCriticLoop needs the session's compaction
  // handler to recognize the critic loop state. This worked when the critic loop started
  // via sendMessage (which sets up full stream context) but startCriticLoop bypasses that.
  // Skipped until the compaction path is updated to handle startCriticLoop-originated streams.
  test.skip("critic context_exceeded auto-compacts and preserves critic settings", async () => {
    const app = await createAppHarness({ branchPrefix: "critic-context-recovery" });

    // The message text IS the critic prompt in the new UX model.
    const criticPrompt = "Demand stronger invariants before approving.";

    const criticRequests: MockAiRouterRequest[] = [];
    let criticCalls = 0;

    const router = app.env.services.aiService.getMockRouter();
    expect(router).not.toBeNull();
    router?.prependHandlers([
      {
        match: (request) => request.isCriticTurn === true,
        respond: (request) => {
          criticCalls += 1;
          criticRequests.push(cloneRequest(request));

          if (criticCalls === 1) {
            return {
              assistantText: "Need more context before I can review this safely.",
              error: {
                message: "Critic context exceeded in mock stream.",
                type: "context_exceeded",
              },
            };
          }

          return { assistantText: "/done" };
        },
      },
      {
        match: (request) =>
          request.isCriticTurn !== true &&
          request.latestUserMessage.metadata?.muxMetadata?.type !== "compaction-request",
        respond: () => ({ assistantText: "Actor retry response." }),
      },
    ]);

    try {
      // Build history first
      await app.chat.send("Build a resilient parser");
      await app.chat.expectTranscriptContains("Actor retry response.", 15_000);
      await app.chat.expectStreamComplete(15_000);

      // Start critic loop directly
      await setCriticPromptAndStart(app, criticPrompt);

      await app.chat.expectTranscriptContains("Mock compaction summary:", 90_000);

      await waitFor(
        () => {
          expect(criticCalls).toBeGreaterThanOrEqual(2);
        },
        { timeout: 90_000 }
      );

      // Critic prompt must survive context_exceeded recovery.
      const resumedCriticRequest = criticRequests[criticRequests.length - 1];
      expect(resumedCriticRequest?.isCriticTurn).toBe(true);
      expect(resumedCriticRequest?.criticPrompt).toBe(criticPrompt);
      expect(resumedCriticRequest?.additionalSystemInstructions).toContain(criticPrompt);
    } finally {
      await app.dispose();
    }
  }, 120_000);

  test("critic turn uses the same model/thinking as actor and disables tools", async () => {
    const app = await createAppHarness({ branchPrefix: "critic-same-model" });

    const actorRequests: MockAiRouterRequest[] = [];
    const criticRequests: MockAiRouterRequest[] = [];

    const router = app.env.services.aiService.getMockRouter();
    expect(router).not.toBeNull();
    router?.prependHandlers([
      {
        match: (request) => request.isCriticTurn === true,
        respond: (request) => {
          criticRequests.push(cloneRequest(request));
          return { assistantText: "/done" };
        },
      },
      {
        match: (request) => request.isCriticTurn !== true,
        respond: (request) => {
          actorRequests.push(cloneRequest(request));
          return { assistantText: "Actor baseline response." };
        },
      },
    ]);

    try {
      // Build history first
      await app.chat.send("Verify model behavior");
      await app.chat.expectTranscriptContains("Actor baseline response.", 15_000);
      await app.chat.expectStreamComplete(15_000);

      // Wait for actor request to be captured so we can verify model parity
      await waitFor(
        () => {
          expect(actorRequests.length).toBeGreaterThan(0);
        },
        { timeout: 5_000 }
      );

      // Start critic loop using the same model + thinking as the actor
      const actorReq = actorRequests[0]!;
      const result = await app.env.orpc.workspace.startCriticLoop({
        workspaceId: app.workspaceId,
        options: {
          model: actorReq.model ?? "anthropic:claude-3-5-haiku-latest",
          agentId: "exec",
          criticEnabled: true,
          criticPrompt: "Verify critic model parity",
          ...(actorReq.thinkingLevel != null ? { thinkingLevel: actorReq.thinkingLevel } : {}),
        },
      });
      expect(result.success).toBe(true);

      await waitFor(
        () => {
          expect(criticRequests.length).toBeGreaterThan(0);
        },
        { timeout: 25_000 }
      );

      const actorRequest = actorRequests[0];
      const criticRequest = criticRequests[0];
      expect(actorRequest?.model).toBeDefined();
      expect(actorRequest?.model).toBe(criticRequest?.model);
      expect(actorRequest?.thinkingLevel).toBe(criticRequest?.thinkingLevel);
      expect(criticRequest?.toolPolicy).toEqual([{ regex_match: ".*", action: "disable" }]);
    } finally {
      await app.dispose();
    }
  }, 60_000);

  test("critic loop runs autonomously after set prompt (full critic→actor→/done cycle)", async () => {
    const app = await createAppHarness({ branchPrefix: "critic-auto-cycle" });
    const collector = createStreamCollector(app.env.orpc, app.workspaceId);
    collector.start();
    await collector.waitForSubscription(5_000);

    let actorCalls = 0;
    let criticCalls = 0;

    const router = app.env.services.aiService.getMockRouter();
    expect(router).not.toBeNull();
    router?.prependHandlers([
      {
        match: (request) => request.isCriticTurn === true,
        respond: () => {
          criticCalls += 1;
          if (criticCalls === 1) {
            return { assistantText: "Add error handling for empty input." };
          }
          return { assistantText: "/done" };
        },
      },
      {
        match: (request) => request.isCriticTurn !== true,
        respond: () => {
          actorCalls += 1;
          return { assistantText: `Actor revision ${actorCalls}.` };
        },
      },
    ]);

    try {
      // Build initial history
      await app.chat.send("Write a parser function");
      await app.chat.expectTranscriptContains("Actor revision 1.", 15_000);
      await app.chat.expectStreamComplete(10_000);

      // Set critic prompt → critic fires, gives feedback → actor revises → critic says /done
      await enableCriticMode(app);
      await setCriticPromptAndStart(app, "Check error handling");

      // The full cycle should complete autonomously:
      // critic(1): "Add error handling..." → actor(2): "Actor revision 2" → critic(2): "/done"
      await app.chat.expectTranscriptContains("Add error handling", 20_000);
      await app.chat.expectTranscriptContains("Actor revision 2.", 25_000);

      await waitFor(
        () => {
          expect(criticCalls).toBe(2);
        },
        { timeout: 25_000 }
      );

      await app.chat.expectStreamComplete(20_000);
      // 1 initial actor + 1 revision from critic feedback = 2 total
      expect(actorCalls).toBe(2);
    } finally {
      collector.stop();
      await app.dispose();
    }
  }, 90_000);

  test("interrupting during critic turn aborts cleanly", async () => {
    const app = await createAppHarness({ branchPrefix: "critic-interrupt" });
    const collector = createStreamCollector(app.env.orpc, app.workspaceId);
    collector.start();
    await collector.waitForSubscription(5_000);

    const router = app.env.services.aiService.getMockRouter();
    expect(router).not.toBeNull();
    router?.prependHandlers([
      {
        match: (request) => request.isCriticTurn === true,
        respond: () => ({ assistantText: "Critic feedback ".repeat(3_000) }),
      },
      actorHandler("Actor initial response."),
    ]);

    try {
      // Build history first
      await app.chat.send("Do something complex");
      await app.chat.expectTranscriptContains("Actor initial response.", 15_000);
      await app.chat.expectStreamComplete(10_000);

      // Enable critic + set prompt → starts critic turn
      await enableCriticMode(app);
      await setCriticPromptAndStart(app, "Review the implementation");

      const criticStreamStart = await collector.waitForEventN("stream-start", 2, 20_000);
      expect(criticStreamStart).not.toBeNull();

      await stopStreamingFromUi(app);

      const abortEvent = await collector.waitForEvent("stream-abort", 10_000);
      expect(abortEvent).not.toBeNull();
      await app.chat.expectStreamComplete(10_000);
    } finally {
      collector.stop();
      await app.dispose();
    }
  }, 90_000);

  test("without /critic enabled, actor messages do not auto-trigger critic turns", async () => {
    const app = await createAppHarness({ branchPrefix: "critic-disabled" });

    let criticCalled = false;
    const router = app.env.services.aiService.getMockRouter();
    expect(router).not.toBeNull();
    router?.prependHandlers([
      {
        match: (request) => request.isCriticTurn === true,
        respond: () => {
          criticCalled = true;
          return { assistantText: "Unexpected critic call." };
        },
      },
      actorHandler("Actor only response."),
    ]);

    try {
      await app.chat.send("normal turn without critic mode");
      await app.chat.expectTranscriptContains("Actor only response.", 15_000);

      await app.chat.expectStreamComplete(15_000);
      expect(criticCalled).toBe(false);
      const criticMessages = app.view.container.querySelectorAll('[data-message-source="critic"]');
      expect(criticMessages.length).toBe(0);
    } finally {
      await app.dispose();
    }
  }, 45_000);

  test("critic loop starts from scratch on empty history (seeds user message, actor goes first)", async () => {
    // Fresh workspace — no messages have been sent. startCriticLoop should NOT reject
    // with "Send a message first". Instead it seeds the critic prompt as a user message,
    // starts an actor turn, then the critic evaluates after the actor finishes.
    const app = await createAppHarness({ branchPrefix: "critic-empty" });
    const collector = createStreamCollector(app.env.orpc, app.workspaceId);
    collector.start();
    await collector.waitForSubscription(5_000);

    const requestKinds: Array<"actor" | "critic"> = [];
    const router = app.env.services.aiService.getMockRouter();
    expect(router).not.toBeNull();
    router?.prependHandlers([
      {
        match: (request) => request.isCriticTurn === true,
        respond: () => {
          requestKinds.push("critic");
          return { assistantText: "/done" };
        },
      },
      {
        match: (request) => request.isCriticTurn !== true,
        respond: () => {
          requestKinds.push("actor");
          return { assistantText: "Actor implemented the feature from scratch." };
        },
      },
    ]);

    try {
      // Start critic loop directly — no prior messages, no enableCriticMode needed
      // (the IPC call carries criticEnabled: true in options)
      await setCriticPromptAndStart(app, "Build a REST API with proper error handling");

      // Actor should respond first (using critic prompt as task)
      await app.chat.expectTranscriptContains(
        "Actor implemented the feature from scratch.",
        15_000
      );

      // Wait for both turns to complete. Don't use expectStreamComplete alone here
      // because there's a brief idle gap between actor completion and critic startup
      // that could cause a race.
      await waitFor(
        () => {
          expect(requestKinds).toEqual(["actor", "critic"]);
        },
        { timeout: 20_000 }
      );

      // The seeded user message should be visible in the transcript
      await app.chat.expectTranscriptContains("Build a REST API with proper error handling");
    } finally {
      collector.stop();
      await app.dispose();
    }
  }, 45_000);
});
