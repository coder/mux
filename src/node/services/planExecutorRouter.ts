import assert from "@/common/utils/assert";

import { generateText, tool, type LanguageModel, type Tool } from "ai";
import { z } from "zod";

import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";
import { linkAbortSignal } from "@/node/utils/abort";

export type PlanExecutorRoutingTarget = "exec" | "orchestrator";

export interface PlanExecutorRoutingDecision {
  target: PlanExecutorRoutingTarget;
  reasoning?: string;
}

export type GenerateTextLike = (
  args: Parameters<typeof generateText>[0]
) => Promise<{ finishReason?: string }>;

interface RoutePlanToExecutorParams {
  model: LanguageModel;
  planContent: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  generateTextImpl?: GenerateTextLike;
}

const PLAN_EXECUTOR_ROUTING_TIMEOUT_MS = 15_000;

const PLAN_EXECUTOR_ROUTING_PROMPT = `You are a routing agent.

Given a software implementation plan, decide which executor should implement it:
- "exec": a single execution agent should implement the plan.
- "orchestrator": an orchestrator should coordinate multiple sub-agents.

Choose "exec" when:
- The plan is focused and mostly sequential.
- The work is likely confined to one subsystem or a small set of related files.
- Parallelism would add coordination overhead without clear benefit.

Choose "orchestrator" when:
- The plan spans multiple subsystems with separable workstreams.
- The plan can be parallelized into independent tasks.
- The implementation likely needs coordinated backend/frontend/test updates in parallel.

You MUST call select_executor exactly once.
Do not output plain text.`;

const SELECT_EXECUTOR_REMINDER =
  "Reminder: You MUST call select_executor exactly once. Do not output any text.";

const selectExecutorInputSchema = z.object({
  target: z.enum(["exec", "orchestrator"]),
  reasoning: z.string().min(1),
});

export async function routePlanToExecutor(
  params: RoutePlanToExecutorParams
): Promise<PlanExecutorRoutingDecision> {
  assert(params, "routePlanToExecutor: params is required");
  assert(params.model, "routePlanToExecutor: model is required");
  assert(
    typeof params.planContent === "string" && params.planContent.trim().length > 0,
    "routePlanToExecutor: planContent must be a non-empty string"
  );

  const timeoutMs = params.timeoutMs ?? PLAN_EXECUTOR_ROUTING_TIMEOUT_MS;
  assert(
    Number.isInteger(timeoutMs) && timeoutMs > 0,
    "routePlanToExecutor: timeoutMs must be a positive integer"
  );

  const routeAbortController = new AbortController();
  const unlinkAbortSignal = linkAbortSignal(params.abortSignal, routeAbortController);

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    routeAbortController.abort();
  }, timeoutMs);
  timeout.unref?.();

  let selectedDecision: PlanExecutorRoutingDecision | undefined;

  const tools: Record<string, Tool> = {
    select_executor: tool({
      description: "Select which executor should implement this plan.",
      inputSchema: selectExecutorInputSchema,
      execute: (input) => {
        const reasoning = input.reasoning.trim();
        selectedDecision = {
          target: input.target,
          reasoning: reasoning.length > 0 ? reasoning : undefined,
        };

        // Signal-tool semantics: the decision is consumed by the caller.
        return {
          ok: true,
          target: input.target,
        };
      },
    }),
  };

  const attemptMessages: Array<NonNullable<Parameters<typeof generateText>[0]["messages"]>> = [
    [{ role: "user", content: params.planContent }],
    [
      { role: "user", content: params.planContent },
      { role: "user", content: SELECT_EXECUTOR_REMINDER },
    ],
  ];

  const generate = params.generateTextImpl ?? generateText;

  try {
    for (const messages of attemptMessages) {
      selectedDecision = undefined;

      await generate({
        model: params.model,
        system: PLAN_EXECUTOR_ROUTING_PROMPT,
        messages,
        tools,
        toolChoice: { type: "tool", toolName: "select_executor" },
        maxRetries: 0,
        abortSignal: routeAbortController.signal,
      });

      if (selectedDecision) {
        return selectedDecision;
      }
    }

    log.warn("Plan executor routing returned no tool decision; defaulting to exec");
    return { target: "exec" };
  } catch (error: unknown) {
    log.warn("Plan executor routing failed; defaulting to exec", {
      timedOut,
      error: getErrorMessage(error),
    });
    return { target: "exec" };
  } finally {
    clearTimeout(timeout);
    unlinkAbortSignal();
  }
}
