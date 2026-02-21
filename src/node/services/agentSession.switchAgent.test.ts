import { afterEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "events";
import * as fs from "fs/promises";
import * as path from "path";

import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import type { SendMessageOptions } from "@/common/orpc/types";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import type { Config } from "@/node/config";

import type { AIService } from "./aiService";
import { AgentSession } from "./agentSession";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import type { HistoryService } from "./historyService";
import type { InitStateManager } from "./initStateManager";
import { createTestHistoryService } from "./testHistoryService";
import { DisposableTempDir } from "./tempDir";

interface SessionInternals {
  dispatchAgentSwitch: (
    switchResult: { agentId: string; reason?: string; followUp?: string },
    currentOptions: SendMessageOptions | undefined,
    fallbackModel: string
  ) => Promise<boolean>;
  sendMessage: (
    message: string,
    options?: SendMessageOptions,
    internal?: { synthetic?: boolean }
  ) => Promise<{ success: boolean }>;
}

function createAiService(
  projectPath: string,
  metadataOverrides?: Partial<WorkspaceMetadata>
): AIService {
  const emitter = new EventEmitter();
  const workspaceMetadata: WorkspaceMetadata = {
    id: "workspace-switch",
    name: "workspace-switch-name",
    projectName: "workspace-switch-project",
    projectPath,
    runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    ...metadataOverrides,
  };

  return {
    on(eventName: string | symbol, listener: (...args: unknown[]) => void) {
      emitter.on(String(eventName), listener);
      return this;
    },
    off(eventName: string | symbol, listener: (...args: unknown[]) => void) {
      emitter.off(String(eventName), listener);
      return this;
    },
    getWorkspaceMetadata: mock(() =>
      Promise.resolve({
        success: true as const,
        data: workspaceMetadata,
      })
    ),
    stopStream: mock(() => Promise.resolve({ success: true as const, data: undefined })),
  } as unknown as AIService;
}

function createSession(
  historyService: HistoryService,
  sessionDir: string,
  projectPath: string,
  metadataOverrides?: Partial<WorkspaceMetadata>
): AgentSession {
  const initStateManager: InitStateManager = {
    on() {
      return this;
    },
    off() {
      return this;
    },
  } as unknown as InitStateManager;

  const backgroundProcessManager: BackgroundProcessManager = {
    setMessageQueued: mock(() => undefined),
    cleanup: mock(() => Promise.resolve()),
  } as unknown as BackgroundProcessManager;

  const config: Config = {
    srcDir: sessionDir,
    getSessionDir: mock(() => sessionDir),
    loadConfigOrDefault: mock(() => ({})),
  } as unknown as Config;

  return new AgentSession({
    workspaceId: "workspace-switch",
    config,
    historyService,
    aiService: createAiService(projectPath, metadataOverrides),
    initStateManager,
    backgroundProcessManager,
  });
}

async function writeAgentDefinition(
  projectPath: string,
  agentId: string,
  extraFrontmatter: string
): Promise<void> {
  const agentsDir = path.join(projectPath, ".mux", "agents");
  await fs.mkdir(agentsDir, { recursive: true });
  await fs.writeFile(
    path.join(agentsDir, `${agentId}.md`),
    `---\nname: ${agentId}\ndescription: ${agentId} description\n${extraFrontmatter}---\n${agentId} body\n`,
    "utf-8"
  );
}

describe("AgentSession switch_agent target validation", () => {
  let historyCleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await historyCleanup?.();
  });

  test("inherits model/thinking from outgoing stream when target has no aiSettingsByAgent entry", async () => {
    using projectDir = new DisposableTempDir("agent-session-switch-valid");
    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const session = createSession(historyService, projectDir.path, projectDir.path, {
      // Legacy workspace aiSettings should not override the active stream
      // when switch_agent has no explicit target-agent override.
      aiSettings: {
        model: "openai:gpt-4.1",
        thinkingLevel: "high",
      },
    });

    try {
      const internals = session as unknown as SessionInternals;
      const sendMessageMock = mock(() => Promise.resolve({ success: true as const }));
      internals.sendMessage = sendMessageMock as unknown as SessionInternals["sendMessage"];

      const result = await internals.dispatchAgentSwitch(
        {
          agentId: "plan",
          reason: "needs planning",
          followUp: "Create a plan.",
        },
        { model: "openai:gpt-4o-mini", agentId: "exec", thinkingLevel: "low" },
        "openai:gpt-4o"
      );

      expect(result).toBe(true);
      expect(sendMessageMock).toHaveBeenCalledTimes(1);

      const firstCall = sendMessageMock.mock.calls[0];
      expect(firstCall).toBeDefined();
      const [messageArg, optionsArg, internalArg] = firstCall as unknown as [
        string,
        SendMessageOptions,
        { synthetic?: boolean },
      ];
      expect(messageArg).toBe("Create a plan.");
      expect(optionsArg.agentId).toBe("plan");
      expect(optionsArg.model).toBe("openai:gpt-4o-mini");
      expect(optionsArg.thinkingLevel).toBe("low");
      expect(internalArg).toEqual({ synthetic: true });
    } finally {
      session.dispose();
    }
  });

  test("uses target agent settings from aiSettingsByAgent over outgoing stream", async () => {
    using projectDir = new DisposableTempDir("agent-session-switch-agent-settings");
    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const session = createSession(historyService, projectDir.path, projectDir.path, {
      aiSettings: {
        model: "openai:gpt-4.1",
        thinkingLevel: "off",
      },
      aiSettingsByAgent: {
        plan: {
          model: "anthropic:claude-sonnet-4-5",
          thinkingLevel: "high",
        },
      },
    });

    try {
      const internals = session as unknown as SessionInternals;
      const sendMessageMock = mock(() => Promise.resolve({ success: true as const }));
      internals.sendMessage = sendMessageMock as unknown as SessionInternals["sendMessage"];

      const result = await internals.dispatchAgentSwitch(
        {
          agentId: "plan",
          reason: "needs planning",
          followUp: "Create a plan.",
        },
        { model: "openai:gpt-4o-mini", agentId: "exec", thinkingLevel: "low" },
        "openai:gpt-4o"
      );

      expect(result).toBe(true);
      expect(sendMessageMock).toHaveBeenCalledTimes(1);

      const firstCall = sendMessageMock.mock.calls[0];
      expect(firstCall).toBeDefined();
      const [messageArg, optionsArg, internalArg] = firstCall as unknown as [
        string,
        SendMessageOptions,
        { synthetic?: boolean },
      ];
      expect(messageArg).toBe("Create a plan.");
      expect(optionsArg.agentId).toBe("plan");
      expect(optionsArg.model).toBe("anthropic:claude-sonnet-4-5");
      expect(optionsArg.thinkingLevel).toBe("high");
      expect(internalArg).toEqual({ synthetic: true });
    } finally {
      session.dispose();
    }
  });

  test("falls back to safe agent when switch target is hidden", async () => {
    using projectDir = new DisposableTempDir("agent-session-switch-hidden");
    await writeAgentDefinition(projectDir.path, "hidden-agent", "ui:\n  hidden: true\n");

    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const session = createSession(historyService, projectDir.path, projectDir.path, {
      aiSettingsByAgent: {
        exec: {
          model: "anthropic:claude-sonnet-4-5",
          thinkingLevel: "high",
        },
      },
    });

    try {
      const internals = session as unknown as SessionInternals;
      const sendMessageMock = mock(() => Promise.resolve({ success: true as const }));
      internals.sendMessage = sendMessageMock as unknown as SessionInternals["sendMessage"];

      const result = await internals.dispatchAgentSwitch(
        {
          agentId: "hidden-agent",
          followUp: "Should not send",
        },
        { model: "openai:gpt-4o-mini", agentId: "exec", thinkingLevel: "low" },
        "openai:gpt-4o"
      );

      expect(result).toBe(true);
      expect(sendMessageMock).toHaveBeenCalledTimes(1);

      const firstCall = sendMessageMock.mock.calls[0];
      expect(firstCall).toBeDefined();
      const [messageArg, optionsArg] = firstCall as unknown as [string, SendMessageOptions];
      expect(messageArg).toContain('target "hidden-agent" is unavailable');
      expect(optionsArg.agentId).toBe("exec");
      expect(optionsArg.model).toBe("openai:gpt-4o-mini");
      expect(optionsArg.thinkingLevel).toBe("low");
    } finally {
      session.dispose();
    }
  });

  test("falls back to safe agent when switch target is disabled", async () => {
    using projectDir = new DisposableTempDir("agent-session-switch-disabled");
    await writeAgentDefinition(projectDir.path, "disabled-agent", "disabled: true\n");

    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const session = createSession(historyService, projectDir.path, projectDir.path);

    try {
      const internals = session as unknown as SessionInternals;
      const sendMessageMock = mock(() => Promise.resolve({ success: true as const }));
      internals.sendMessage = sendMessageMock as unknown as SessionInternals["sendMessage"];

      const result = await internals.dispatchAgentSwitch(
        {
          agentId: "disabled-agent",
          followUp: "Should not send",
        },
        { model: "openai:gpt-4o-mini", agentId: "exec" },
        "openai:gpt-4o"
      );

      expect(result).toBe(true);
      expect(sendMessageMock).toHaveBeenCalledTimes(1);

      const firstCall = sendMessageMock.mock.calls[0];
      expect(firstCall).toBeDefined();
      const [messageArg, optionsArg] = firstCall as unknown as [string, SendMessageOptions];
      expect(messageArg).toContain('target "disabled-agent" is unavailable');
      expect(optionsArg.agentId).toBe("exec");
    } finally {
      session.dispose();
    }
  });

  test("falls back to exec when auto requests an unresolved switch target", async () => {
    using projectDir = new DisposableTempDir("agent-session-switch-missing");
    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const session = createSession(historyService, projectDir.path, projectDir.path);

    try {
      const internals = session as unknown as SessionInternals;
      const sendMessageMock = mock(() => Promise.resolve({ success: true as const }));
      internals.sendMessage = sendMessageMock as unknown as SessionInternals["sendMessage"];

      const result = await internals.dispatchAgentSwitch(
        {
          agentId: "missing-agent",
          followUp: "Should not send",
        },
        { model: "openai:gpt-4o-mini", agentId: "auto" },
        "openai:gpt-4o"
      );

      expect(result).toBe(true);
      expect(sendMessageMock).toHaveBeenCalledTimes(1);

      const firstCall = sendMessageMock.mock.calls[0];
      expect(firstCall).toBeDefined();
      const [messageArg, optionsArg] = firstCall as unknown as [string, SendMessageOptions];
      expect(messageArg).toContain('target "missing-agent" is unavailable');
      expect(optionsArg.agentId).toBe("exec");
    } finally {
      session.dispose();
    }
  });
});
