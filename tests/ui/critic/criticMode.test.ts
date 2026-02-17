import "../dom";

import { act, waitFor } from "@testing-library/react";

import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getCriticEnabledKey, getCriticPromptKey } from "@/common/constants/storage";
import type { HistoryService } from "@/node/services/historyService";
import type { MockAiRouterHandler, MockAiRouterRequest } from "@/node/services/mock/mockAiRouter";
import { preloadTestModules } from "../../ipc/setup";
import { createStreamCollector } from "../../ipc/streamCollector";
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

function getHistoryService(app: AppHarness): HistoryService {
  return (app.env.services as unknown as ServiceContainerWithHistory).historyService;
}

async function waitMs(durationMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, durationMs));
}

describe("Actor-Critic mode", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("/critic toggles critic mode and shows ChatInput badge", async () => {
    const app = await createAppHarness({ branchPrefix: "critic-toggle" });

    try {
      const footer = () =>
        app.view.container.querySelector(
          '[data-component="ChatModeToggles"]'
        ) as HTMLElement | null;

      expect(footer()?.textContent ?? "").not.toContain("Critic mode active");
      expect(window.localStorage.getItem(getCriticEnabledKey(app.workspaceId))).toBeNull();

      await app.chat.send("/critic");

      await waitFor(
        () => {
          expect(footer()?.textContent ?? "").toContain("Critic mode active");
        },
        { timeout: 5_000 }
      );

      expect(window.localStorage.getItem(getCriticEnabledKey(app.workspaceId))).toBe("true");

      await app.chat.send("/critic");

      await waitFor(
        () => {
          expect(footer()?.textContent ?? "").not.toContain("Critic mode active");
        },
        { timeout: 5_000 }
      );

      expect(window.localStorage.getItem(getCriticEnabledKey(app.workspaceId))).toBe("false");
    } finally {
      await app.dispose();
    }
  }, 30_000);

  test("actor turn automatically triggers a critic turn with distinct message source", async () => {
    const app = await createAppHarness({ branchPrefix: "critic-loop" });
    const collector = createStreamCollector(app.env.orpc, app.workspaceId);
    collector.start();
    await collector.waitForSubscription(5_000);

    const router = app.env.services.aiService.getMockRouter();
    expect(router).not.toBeNull();
    router?.prependHandlers([criticHandler("/done"), actorHandler("Actor implementation ready.")]);

    try {
      await app.chat.send("/critic");
      await app.chat.send("Implement a sorting algorithm");

      await app.chat.expectTranscriptContains("Actor implementation ready.", 15_000);

      const secondStart = await collector.waitForEventN("stream-start", 2, 15_000);
      expect(secondStart).not.toBeNull();

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

  test("critic prompt is forwarded into critic turn instructions", async () => {
    const app = await createAppHarness({ branchPrefix: "critic-prompt" });

    const criticPrompt = "Focus on correctness and edge cases.";
    act(() => {
      updatePersistedState(getCriticPromptKey(app.workspaceId), criticPrompt);
    });

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
      await app.chat.send("/critic");
      await app.chat.send("Review this implementation");

      await waitFor(
        () => {
          expect(criticRequests.length).toBeGreaterThan(0);
        },
        { timeout: 15_000 }
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
      await app.chat.send("/critic");
      await app.chat.send("Build something");

      await app.chat.expectTranscriptContains("Almost there", 20_000);
      await app.chat.expectTranscriptContains("Actor revision 2", 25_000);

      await waitFor(
        () => {
          expect(criticCalls).toBe(2);
        },
        { timeout: 25_000 }
      );

      await waitMs(2_000);
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
      await app.chat.send("/critic");
      await app.chat.send("What's in the readme?");

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
      await app.chat.send("/critic");
      await app.chat.send("Write a parser");

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

  test("critic context_exceeded auto-compacts and preserves critic settings", async () => {
    const app = await createAppHarness({ branchPrefix: "critic-context-recovery" });

    const criticPrompt = "Demand stronger invariants before approving.";
    act(() => {
      updatePersistedState(getCriticPromptKey(app.workspaceId), criticPrompt);
    });

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
      await app.chat.send("/critic");
      await app.chat.send("Build a resilient parser");

      await app.chat.expectTranscriptContains("Mock compaction summary:", 90_000);

      await waitFor(
        () => {
          expect(criticCalls).toBeGreaterThanOrEqual(2);
        },
        { timeout: 90_000 }
      );

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
      await app.chat.send("/critic");
      await app.chat.send("Verify critic model parity");

      await waitFor(
        () => {
          expect(actorRequests.length).toBeGreaterThan(0);
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

  test("queued user input flushes before critic auto-continuation", async () => {
    const app = await createAppHarness({ branchPrefix: "critic-queue-priority" });
    const collector = createStreamCollector(app.env.orpc, app.workspaceId);
    collector.start();
    await collector.waitForSubscription(5_000);

    const actorRequests: MockAiRouterRequest[] = [];

    const router = app.env.services.aiService.getMockRouter();
    expect(router).not.toBeNull();
    router?.prependHandlers([
      {
        match: (request) => request.isCriticTurn === true,
        // Keep critic streaming long enough to queue a follow-up, but not so long that
        // overloaded CI workers time out waiting for the stream to finish.
        respond: () => ({ assistantText: "Critic feedback ".repeat(600) }),
      },
      {
        match: (request) => request.isCriticTurn !== true,
        respond: (request) => {
          actorRequests.push(cloneRequest(request));
          if (request.latestUserText.toLowerCase().includes("queued follow-up")) {
            return { assistantText: "Queued follow-up processed." };
          }
          return { assistantText: "Actor baseline." };
        },
      },
    ]);

    try {
      await app.chat.send("/critic");
      await app.chat.send("Start critic loop");

      await app.chat.expectTranscriptContains("Actor baseline.", 15_000);

      const criticStreamStart = await collector.waitForEventN("stream-start", 2, 20_000);
      expect(criticStreamStart).not.toBeNull();

      // Queue a manual follow-up while critic is still streaming.
      await app.chat.send("queued follow-up");

      await waitFor(
        () => {
          expect(actorRequests.length).toBeGreaterThanOrEqual(2);
        },
        { timeout: 40_000 }
      );

      expect(actorRequests[1]?.latestUserText.toLowerCase()).toContain("queued follow-up");
      await app.chat.expectTranscriptContains("Queued follow-up processed.", 40_000);

      const interruptResult = await app.env.orpc.workspace.interruptStream({
        workspaceId: app.workspaceId,
      });
      expect(interruptResult.success).toBe(true);
      await app.chat.expectStreamComplete(10_000);
    } finally {
      collector.stop();
      await app.dispose();
    }
  }, 120_000);

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
      await app.chat.send("/critic");
      await app.chat.send("Do something complex");

      await app.chat.expectTranscriptContains("Actor initial response.", 15_000);

      const criticStreamStart = await collector.waitForEventN("stream-start", 2, 20_000);
      expect(criticStreamStart).not.toBeNull();

      const interruptResult = await app.env.orpc.workspace.interruptStream({
        workspaceId: app.workspaceId,
      });
      expect(interruptResult.success).toBe(true);

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

      await waitMs(2_000);
      expect(criticCalled).toBe(false);
      const criticMessages = app.view.container.querySelectorAll('[data-message-source="critic"]');
      expect(criticMessages.length).toBe(0);
    } finally {
      await app.dispose();
    }
  }, 45_000);
});
