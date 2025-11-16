import type { ScenarioTurn } from "@/node/services/mock/scenarioTypes";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { STREAM_BASE_DELAY } from "@/node/services/mock/scenarioTypes";

export const REVIEW_PROMPTS = {
  SUMMARIZE_BRANCHES: "Let's summarize the current branches.",
  OPEN_ONBOARDING_DOC: "Open the onboarding doc.",
  SHOW_ONBOARDING_DOC: "Show the onboarding doc contents instead.",
} as const;

const summarizeBranchesTurn: ScenarioTurn = {
  user: {
    text: REVIEW_PROMPTS.SUMMARIZE_BRANCHES,
    thinkingLevel: "medium",
    mode: "plan",
  },
  assistant: {
    messageId: "msg-plan-1",
    events: [
      { kind: "stream-start", delay: 0, messageId: "msg-plan-1", model: KNOWN_MODELS.GPT.id },
      {
        kind: "reasoning-delta",
        delay: STREAM_BASE_DELAY,
        text: "Looking at demo-repo/workspaces…",
      },
      { kind: "reasoning-delta", delay: STREAM_BASE_DELAY * 2, text: "Found three branches." },
      {
        kind: "tool-start",
        delay: STREAM_BASE_DELAY * 3,
        toolCallId: "tool-branches",
        toolName: "git.branchList",
        args: { project: "demo-repo" },
      },
      {
        kind: "tool-end",
        delay: STREAM_BASE_DELAY * 4,
        toolCallId: "tool-branches",
        toolName: "git.branchList",
        result: [{ name: "main" }, { name: "feature/login" }, { name: "demo-review" }],
      },
      {
        kind: "stream-delta",
        delay: STREAM_BASE_DELAY * 5,
        text: "Here’s the current branch roster:\n",
      },
      {
        kind: "stream-delta",
        delay: STREAM_BASE_DELAY * 5 + 100,
        text: "• `main` – release baseline\n",
      },
      {
        kind: "stream-delta",
        delay: STREAM_BASE_DELAY * 5 + 200,
        text: "• `feature/login` – authentication refresh\n",
      },
      {
        kind: "stream-delta",
        delay: STREAM_BASE_DELAY * 5 + 300,
        text: "• `demo-review` – sandbox you just created",
      },
      {
        kind: "stream-end",
        delay: STREAM_BASE_DELAY * 6,
        metadata: {
          model: KNOWN_MODELS.GPT.id,
          inputTokens: 128,
          outputTokens: 85,
          systemMessageTokens: 32,
        },
        parts: [
          { type: "text", text: "Here’s the current branch roster:" },
          { type: "text", text: "\n• `main` – release baseline" },
          { type: "text", text: "\n• `feature/login` – authentication refresh" },
          { type: "text", text: "\n• `demo-review` – sandbox you just created" },
        ],
      },
    ],
  },
};

const openOnboardingDocTurn: ScenarioTurn = {
  user: {
    text: REVIEW_PROMPTS.OPEN_ONBOARDING_DOC,
    thinkingLevel: "low",
    mode: "exec",
  },
  assistant: {
    messageId: "msg-exec-1",
    events: [
      { kind: "stream-start", delay: 0, messageId: "msg-exec-1", model: KNOWN_MODELS.GPT.id },
      {
        kind: "tool-start",
        delay: STREAM_BASE_DELAY,
        toolCallId: "tool-open",
        toolName: "filesystem.open",
        args: { path: "docs/onboarding.md" },
      },
      {
        kind: "stream-error",
        delay: STREAM_BASE_DELAY * 2,
        error: "ENOENT: docs/onboarding.md not found",
        errorType: "api",
      },
    ],
  },
};

const showOnboardingDocTurn: ScenarioTurn = {
  user: {
    text: REVIEW_PROMPTS.SHOW_ONBOARDING_DOC,
    thinkingLevel: "low",
    mode: "exec",
    editOfTurn: 2,
  },
  assistant: {
    messageId: "msg-exec-2",
    events: [
      { kind: "stream-start", delay: 0, messageId: "msg-exec-2", model: KNOWN_MODELS.GPT.id },
      {
        kind: "tool-start",
        delay: STREAM_BASE_DELAY,
        toolCallId: "tool-open",
        toolName: "filesystem.open",
        args: { path: "docs/onboarding.md" },
      },
      {
        kind: "tool-end",
        delay: STREAM_BASE_DELAY * 2,
        toolCallId: "tool-open",
        toolName: "filesystem.open",
        result: { excerpt: "1. Clone the repo→ 2. Run bun install→ 3. bun dev" },
      },
      {
        kind: "stream-delta",
        delay: STREAM_BASE_DELAY * 2 + 100,
        text: "Found it. Here’s the quick-start summary:\n",
      },
      {
        kind: "stream-delta",
        delay: STREAM_BASE_DELAY * 2 + 200,
        text: "• Clone → bun install\n",
      },
      {
        kind: "stream-delta",
        delay: STREAM_BASE_DELAY * 2 + 300,
        text: "• bun dev boots the desktop shell\n",
      },
      {
        kind: "stream-delta",
        delay: STREAM_BASE_DELAY * 2 + 400,
        text: "• See docs/onboarding.md for the full checklist",
      },
      {
        kind: "stream-end",
        delay: STREAM_BASE_DELAY * 3,
        metadata: {
          model: KNOWN_MODELS.GPT.id,
          inputTokens: 96,
          outputTokens: 142,
          systemMessageTokens: 32,
        },
        parts: [
          { type: "text", text: "Found it. Here’s the quick-start summary:" },
          { type: "text", text: "\n• Clone → bun install" },
          { type: "text", text: "\n• bun dev boots the desktop shell" },
          { type: "text", text: "\n• See docs/onboarding.md for the full checklist" },
        ],
      },
    ],
  },
};

export const scenarios: ScenarioTurn[] = [
  summarizeBranchesTurn,
  openOnboardingDocTurn,
  showOnboardingDocTurn,
];
