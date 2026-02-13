import fsPromises from "fs/promises";
import path from "path";
import type { DemoProjectConfig } from "./demoProject";
import { createMuxMessage, type MuxMessage } from "../../../src/common/types/message";
import { HistoryService } from "../../../src/node/services/historyService";

const BASE_TIMESTAMP_MS = 1_700_000_000_000;

type HistoryProfileDefinition = {
  messagePairs: number;
  userChars: number;
  assistantChars: number;
  reasoningChars: number;
  toolOutputChars: number;
};

export type HistoryProfileName = "small" | "medium" | "large" | "tool-heavy" | "reasoning-heavy";

export interface SeededHistoryProfileSummary {
  profile: HistoryProfileName;
  messageCount: number;
  assistantMessageCount: number;
  estimatedCharacterCount: number;
  hasToolParts: boolean;
  hasReasoningParts: boolean;
}

const HISTORY_PROFILES: Record<HistoryProfileName, HistoryProfileDefinition> = {
  small: {
    messagePairs: 12,
    userChars: 200,
    assistantChars: 2_000,
    reasoningChars: 0,
    toolOutputChars: 0,
  },
  medium: {
    messagePairs: 40,
    userChars: 260,
    assistantChars: 4_500,
    reasoningChars: 0,
    toolOutputChars: 0,
  },
  large: {
    messagePairs: 90,
    userChars: 320,
    assistantChars: 9_500,
    reasoningChars: 0,
    toolOutputChars: 0,
  },
  "tool-heavy": {
    messagePairs: 36,
    userChars: 220,
    assistantChars: 2_800,
    reasoningChars: 0,
    toolOutputChars: 5_200,
  },
  "reasoning-heavy": {
    messagePairs: 34,
    userChars: 220,
    assistantChars: 2_600,
    reasoningChars: 4_400,
    toolOutputChars: 0,
  },
};

function buildDeterministicText(label: string, targetLength: number): string {
  const sentence = `${label}: deterministic payload for workspace replay performance profiling. `;
  if (sentence.length >= targetLength) {
    return sentence.slice(0, targetLength);
  }

  let content = "";
  while (content.length < targetLength) {
    content += sentence;
  }
  return content.slice(0, targetLength);
}

function createAssistantParts(args: {
  profile: HistoryProfileName;
  index: number;
  toolOutputChars: number;
  reasoningChars: number;
}): MuxMessage["parts"] {
  const parts: MuxMessage["parts"] = [];

  if (args.toolOutputChars > 0) {
    const toolName = args.index % 2 === 0 ? "file_read" : "bash";
    const outputKey = toolName === "file_read" ? "content" : "output";
    const toolPayload = buildDeterministicText(
      `${args.profile}-tool-${args.index}`,
      args.toolOutputChars
    );

    parts.push({
      type: "dynamic-tool",
      state: "output-available",
      toolCallId: `${args.profile}-tool-call-${args.index}`,
      toolName,
      input:
        toolName === "file_read"
          ? { path: `src/example-${args.index}.ts` }
          : { script: `echo profile-${args.index}` },
      output: {
        success: true,
        [outputKey]: toolPayload,
      },
      timestamp: BASE_TIMESTAMP_MS + args.index,
    });
  }

  if (args.reasoningChars > 0) {
    parts.push({
      type: "reasoning",
      text: buildDeterministicText(`${args.profile}-reasoning-${args.index}`, args.reasoningChars),
      timestamp: BASE_TIMESTAMP_MS + args.index,
    });
  }

  return parts;
}

export async function seedWorkspaceHistoryProfile(args: {
  demoProject: DemoProjectConfig;
  profile: HistoryProfileName;
}): Promise<SeededHistoryProfileSummary> {
  const { demoProject, profile } = args;
  const profileConfig = HISTORY_PROFILES[profile];

  const historyService = new HistoryService({
    getSessionDir: (workspaceId: string) => path.join(demoProject.sessionsDir, workspaceId),
  });

  await fsPromises.writeFile(demoProject.historyPath, "", "utf-8");

  let estimatedCharacterCount = 0;
  let totalMessages = 0;
  let assistantMessages = 0;

  for (let pairIndex = 0; pairIndex < profileConfig.messagePairs; pairIndex++) {
    const userText = buildDeterministicText(
      `${profile}-user-${pairIndex}`,
      profileConfig.userChars
    );
    const userMessage = createMuxMessage(`${profile}-user-msg-${pairIndex}`, "user", userText, {
      timestamp: BASE_TIMESTAMP_MS + pairIndex * 2,
    });

    const userAppendResult = await historyService.appendToHistory(
      demoProject.workspaceId,
      userMessage
    );
    if (!userAppendResult.success) {
      throw new Error(
        `Failed to append user message for profile ${profile}: ${userAppendResult.error}`
      );
    }

    const assistantText = buildDeterministicText(
      `${profile}-assistant-${pairIndex}`,
      profileConfig.assistantChars
    );
    const assistantParts = createAssistantParts({
      profile,
      index: pairIndex,
      toolOutputChars: profileConfig.toolOutputChars,
      reasoningChars: profileConfig.reasoningChars,
    });

    const assistantMessage = createMuxMessage(
      `${profile}-assistant-msg-${pairIndex}`,
      "assistant",
      assistantText,
      {
        model: "anthropic:claude-sonnet-4-5",
        timestamp: BASE_TIMESTAMP_MS + pairIndex * 2 + 1,
      },
      assistantParts
    );

    const assistantAppendResult = await historyService.appendToHistory(
      demoProject.workspaceId,
      assistantMessage
    );
    if (!assistantAppendResult.success) {
      throw new Error(
        `Failed to append assistant message for profile ${profile}: ${assistantAppendResult.error}`
      );
    }

    estimatedCharacterCount +=
      userText.length +
      assistantText.length +
      profileConfig.toolOutputChars +
      profileConfig.reasoningChars;
    totalMessages += 2;
    assistantMessages += 1;
  }

  return {
    profile,
    messageCount: totalMessages,
    assistantMessageCount: assistantMessages,
    estimatedCharacterCount,
    hasToolParts: profileConfig.toolOutputChars > 0,
    hasReasoningParts: profileConfig.reasoningChars > 0,
  };
}

export function parseHistoryProfilesFromEnv(rawProfiles: string | undefined): HistoryProfileName[] {
  if (!rawProfiles) {
    return ["small", "medium", "large", "tool-heavy", "reasoning-heavy"];
  }

  const requested = rawProfiles
    .split(",")
    .map((profile) => profile.trim())
    .filter((profile) => profile.length > 0);

  const validProfiles = new Set<HistoryProfileName>([
    "small",
    "medium",
    "large",
    "tool-heavy",
    "reasoning-heavy",
  ]);

  for (const profile of requested) {
    if (!validProfiles.has(profile as HistoryProfileName)) {
      throw new Error(
        `Invalid MUX_E2E_PERF_PROFILES entry "${profile}". Expected one of: ${Array.from(validProfiles).join(", ")}.`
      );
    }
  }

  return requested as HistoryProfileName[];
}
