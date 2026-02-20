import { createTestEnvironment, cleanupTestEnvironment, type TestEnvironment } from "../setup";
import {
  createTempGitRepo,
  cleanupTempGitRepo,
  createWorkspace,
  generateBranchName,
  sendMessageWithModel,
  HAIKU_MODEL,
  waitFor,
  createStreamCollector,
} from "../helpers";
import type { MockAiRouterRequest } from "@/node/services/mock/mockAiRouter";

describe("resumeStream critic turn continuity", () => {
  let env: TestEnvironment | null = null;
  let repoPath: string | null = null;

  beforeEach(async () => {
    env = await createTestEnvironment();
    env.services.aiService.enableMockMode();
    repoPath = await createTempGitRepo();
  });

  afterEach(async () => {
    if (repoPath) {
      await cleanupTempGitRepo(repoPath);
      repoPath = null;
    }
    if (env) {
      await cleanupTestEnvironment(env);
      env = null;
    }
  });

  test("resume keeps critic turn semantics when resuming a critic turn", async () => {
    if (!env || !repoPath) {
      throw new Error("Test environment not initialized");
    }

    const branchName = generateBranchName("test-resume-critic-turn");
    const result = await createWorkspace(env, repoPath, branchName);
    if (!result.success) {
      throw new Error(`Failed to create workspace: ${result.error}`);
    }

    const workspaceId = result.metadata.id;
    const collector = createStreamCollector(env.orpc, workspaceId);
    collector.start();

    const requestKinds: Array<"actor" | "critic"> = [];
    const actorRequests: MockAiRouterRequest[] = [];
    const criticRequests: MockAiRouterRequest[] = [];
    let criticCalls = 0;
    const requiredToolPolicy: MockAiRouterRequest["toolPolicy"] = [
      { regex_match: "bash", action: "require" },
    ];
    const actorInstructions = "Preserve actor loop settings";
    const criticPrompt = "Check for edge cases in the implementation.";

    const router = env.services.aiService.getMockRouter();
    expect(router).not.toBeNull();
    router?.prependHandlers([
      {
        match: (request) => request.isCriticTurn === true,
        respond: (request) => {
          requestKinds.push("critic");
          criticRequests.push(structuredClone(request));
          criticCalls += 1;

          if (criticCalls === 1) {
            return {
              // Gate stream-start so we can deterministically interrupt the first critic turn
              // before it finishes and then resume it explicitly as a critic turn.
              assistantText: "Critic feedback ".repeat(4_000),
              waitForStreamStart: true,
            };
          }

          if (criticCalls === 2) {
            return { assistantText: "Needs stronger test coverage." };
          }

          return { assistantText: "/done" };
        },
      },
      {
        match: (request) => request.isCriticTurn !== true,
        respond: (request) => {
          requestKinds.push("actor");
          actorRequests.push(structuredClone(request));
          return { assistantText: `Actor baseline response ${actorRequests.length}.` };
        },
      },
    ]);

    try {
      await collector.waitForSubscription(5000);

      const sendResult = await sendMessageWithModel(
        env,
        workspaceId,
        "Start actor-critic loop",
        HAIKU_MODEL,
        {
          criticEnabled: true,
          criticPrompt,
          toolPolicy: requiredToolPolicy,
          additionalSystemInstructions: actorInstructions,
        }
      );
      expect(sendResult.success).toBe(true);

      // First stream-end should be actor completion; critic stream is still gated.
      const actorStreamEnd = await collector.waitForEvent("stream-end", 10000);
      if (!actorStreamEnd) {
        throw new Error("Actor stream did not complete before critic gate release");
      }

      env.services.aiService.releaseMockStreamStartGate(workspaceId);

      const criticStreamStart = await collector.waitForEventN("stream-start", 2, 10000);
      if (!criticStreamStart) {
        throw new Error("Critic stream did not start after releasing gate");
      }

      const criticDelta = await collector.waitForEvent("stream-delta", 10000);
      if (!criticDelta) {
        throw new Error("Critic stream produced no delta before interrupt");
      }

      const interruptResult = await env.orpc.workspace.interruptStream({ workspaceId });
      expect(interruptResult.success).toBe(true);

      const abortEvent = await collector.waitForEvent("stream-abort", 10000);
      if (!abortEvent) {
        throw new Error("Expected stream-abort after interrupting critic stream");
      }

      const resumeResult = await env.orpc.workspace.resumeStream({
        workspaceId,
        options: {
          model: HAIKU_MODEL,
          agentId: "exec",
          criticEnabled: true,
          isCriticTurn: true,
        },
      });
      expect(resumeResult.success).toBe(true);

      const resumedStreamEnd = await collector.waitForEventN("stream-end", 2, 10000);
      if (!resumedStreamEnd) {
        throw new Error("Resumed stream did not complete");
      }

      const observedResumeRequest = await waitFor(() => requestKinds.length >= 3, 10000);
      if (!observedResumeRequest) {
        throw new Error("Did not observe routed resume request");
      }

      const observedResumedActorTurn = await waitFor(() => actorRequests.length >= 2, 20000);
      if (!observedResumedActorTurn) {
        throw new Error("Resumed critic turn did not trigger a follow-up actor turn");
      }

      const resumedActorRequest = actorRequests[1];
      if (!resumedActorRequest) {
        throw new Error("Missing resumed actor request");
      }

      // Regression: criticLoopState must survive abort/resume so the auto actor turn keeps
      // the original actor options instead of inheriting critic-only settings.
      expect(resumedActorRequest.toolPolicy).toEqual(requiredToolPolicy);
      expect(resumedActorRequest.additionalSystemInstructions).toBe(actorInstructions);

      // The resumed critic turn must reapply critic guardrails (tool policy disabled,
      // critic system instructions with /done contract and user critic prompt), even though
      // the frontend resume only sets isCriticTurn: true without these options.
      const resumedCriticRequest = criticRequests[1];
      expect(resumedCriticRequest).toBeDefined();
      expect(resumedCriticRequest?.toolPolicy).toEqual([{ regex_match: ".*", action: "disable" }]);
      expect(resumedCriticRequest?.additionalSystemInstructions).toContain("exactly /done");
      expect(resumedCriticRequest?.additionalSystemInstructions).toContain(criticPrompt);

      const criticLoopSettled = await waitFor(() => criticCalls >= 3, 20000);
      if (!criticLoopSettled) {
        throw new Error("Critic loop did not reach /done after resumed actor turn");
      }

      expect(requestKinds[0]).toBe("actor");
      expect(requestKinds[1]).toBe("critic");
      // Resume must continue critic turn, not switch straight to actor.
      expect(requestKinds[2]).toBe("critic");
    } finally {
      collector.stop();
      await env.orpc.workspace.remove({ workspaceId });
    }
  }, 30000);
});
