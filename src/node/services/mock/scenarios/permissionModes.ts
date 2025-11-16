import type { ScenarioTurn } from "@/node/services/mock/scenarioTypes";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { STREAM_BASE_DELAY } from "@/node/services/mock/scenarioTypes";

export const PERMISSION_MODE_PROMPTS = {
  PLAN_REFACTOR: "How should I refactor this function?",
  EXECUTE_PLAN: "Do it",
} as const;

const planRefactorTurn: ScenarioTurn = {
  user: {
    text: PERMISSION_MODE_PROMPTS.PLAN_REFACTOR,
    thinkingLevel: "medium",
    mode: "plan",
  },
  assistant: {
    messageId: "msg-plan-refactor",
    events: [
      {
        kind: "stream-start",
        delay: 0,
        messageId: "msg-plan-refactor",
        model: KNOWN_MODELS.GPT.id,
      },
      {
        kind: "stream-delta",
        delay: STREAM_BASE_DELAY,
        text: "Plan summary:\n",
      },
      {
        kind: "stream-delta",
        delay: STREAM_BASE_DELAY * 2,
        text: "1. Extract validation into verifyInputs().\n",
      },
      {
        kind: "stream-delta",
        delay: STREAM_BASE_DELAY * 3,
        text: "2. Move formatting logic into buildResponse().\n",
      },
      {
        kind: "stream-delta",
        delay: STREAM_BASE_DELAY * 4,
        text: "3. Keep handleRequest lean by delegating to helpers.",
      },
      {
        kind: "stream-end",
        delay: STREAM_BASE_DELAY * 5,
        metadata: {
          model: KNOWN_MODELS.GPT.id,
          inputTokens: 180,
          outputTokens: 130,
          systemMessageTokens: 24,
        },
        parts: [
          { type: "text", text: "Plan summary:\n" },
          { type: "text", text: "1. Extract validation into verifyInputs().\n" },
          { type: "text", text: "2. Move formatting logic into buildResponse().\n" },
          { type: "text", text: "3. Keep handleRequest lean by delegating to helpers." },
        ],
      },
    ],
  },
};

const executePlanTurn: ScenarioTurn = {
  user: {
    text: PERMISSION_MODE_PROMPTS.EXECUTE_PLAN,
    thinkingLevel: "low",
    mode: "exec",
  },
  assistant: {
    messageId: "msg-exec-refactor",
    events: [
      {
        kind: "stream-start",
        delay: 0,
        messageId: "msg-exec-refactor",
        model: KNOWN_MODELS.GPT.id,
      },
      {
        kind: "tool-start",
        delay: STREAM_BASE_DELAY,
        toolCallId: "tool-apply-refactor",
        toolName: "bash",
        args: {
          script:
            'apply_patch <<\'PATCH\'\n*** Begin Patch\n*** Update File: src/utils/legacyFunction.ts\n@@\n-export function handleRequest(input: Request) {\n-  if (!input.userId || !input.payload) {\n-    throw new Error("Missing fields");\n-  }\n-\n-  const result = heavyFormatter(input.payload);\n-  return {\n-    id: input.userId,\n-    details: result,\n-  };\n-}\n+function verifyInputs(input: Request) {\n+  if (!input.userId || !input.payload) {\n+    throw new Error("Missing fields");\n+  }\n+}\n+\n+function buildResponse(input: Request) {\n+  const result = heavyFormatter(input.payload);\n+  return { id: input.userId, details: result };\n+}\n+\n+export function handleRequest(input: Request) {\n+  verifyInputs(input);\n+  return buildResponse(input);\n+}\n*** End Patch\nPATCH',
          timeout_secs: 10,
        },
      },
      {
        kind: "tool-end",
        delay: STREAM_BASE_DELAY * 2,
        toolCallId: "tool-apply-refactor",
        toolName: "bash",
        result: {
          success: true,
          output: "patch applied\n",
          exitCode: 0,
          wall_duration_ms: 180,
        },
      },
      {
        kind: "stream-delta",
        delay: STREAM_BASE_DELAY * 2 + 100,
        text: "Applied refactor plan:\n",
      },
      {
        kind: "stream-delta",
        delay: STREAM_BASE_DELAY * 2 + 200,
        text: "- Updated src/utils/legacyFunction.ts\n",
      },
      {
        kind: "stream-delta",
        delay: STREAM_BASE_DELAY * 2 + 300,
        text: "- Extracted verifyInputs and buildResponse helpers.",
      },
      {
        kind: "stream-end",
        delay: STREAM_BASE_DELAY * 3,
        metadata: {
          model: KNOWN_MODELS.GPT.id,
          inputTokens: 220,
          outputTokens: 110,
          systemMessageTokens: 18,
        },
        parts: [
          { type: "text", text: "Applied refactor plan:\n" },
          { type: "text", text: "- Updated src/utils/legacyFunction.ts\n" },
          { type: "text", text: "- Extracted verifyInputs and buildResponse helpers." },
        ],
      },
    ],
  },
};

export const scenarios: ScenarioTurn[] = [planRefactorTurn, executePlanTurn];
