import { afterEach, describe, expect, it, mock } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { Ok } from "@/common/types/result";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { Config } from "@/node/config";
import type { AIService, StreamMessageOptions } from "@/node/services/aiService";

import { createAgentSessionHarness } from "./agentSession.testHarness";

const USER_MODEL = "anthropic:claude-fable-5";

describe("AgentSession.sendMessage (per-skill model routing)", () => {
  let historyCleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await historyCleanup?.();
  });

  async function createWorkspaceWithSkill(args: { skillName: string; metadataYaml?: string }) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mux-skill-routing-"));
    const skillDir = path.join(tmp, ".mux", "skills", args.skillName);
    await fs.mkdir(skillDir, { recursive: true });
    const skillMarkdown = `---\nname: ${args.skillName}\ndescription: Test skill\n${args.metadataYaml ?? ""}---\n\nDo the thing.\n`;
    await fs.writeFile(path.join(skillDir, "SKILL.md"), skillMarkdown, "utf-8");
    return tmp;
  }

  async function createRoutingHarness(args: {
    workspacePath: string;
    configValues?: {
      modelClasses?: Record<string, string>;
      skillModelClasses?: Record<string, string>;
      routePriority?: string[];
    };
    /** When provided, getProvidersConfigSafe sees this map (enables the availability check). */
    providersConfig?: Record<string, { isConfigured: boolean; isEnabled?: boolean }>;
  }) {
    const workspaceId = "ws-skill-routing";
    const workspaceMeta = {
      id: workspaceId,
      name: "ws",
      projectName: "proj",
      projectPath: args.workspacePath,
      namedWorkspacePath: args.workspacePath,
      runtimeConfig: { type: "local" },
    } as unknown as FrontendWorkspaceMetadata;

    const streamed: StreamMessageOptions[] = [];
    const streamMessage = mock((opts: StreamMessageOptions) => {
      streamed.push(opts);
      return Promise.resolve(Ok(undefined));
    });

    const config = {
      srcDir: "/tmp",
      getSessionDir: mock((_workspaceId: string) => "/tmp"),
      loadConfigOrDefault: mock(() => ({ ...args.configValues })),
    } as unknown as Config;

    const { session, cleanup } = await createAgentSessionHarness({
      workspaceId,
      config,
      aiServiceOverrides: {
        getWorkspaceMetadata: mock((_id: string) => Promise.resolve(Ok(workspaceMeta))),
        streamMessage: streamMessage as unknown as AIService["streamMessage"],
        ...(args.providersConfig != null
          ? { getProvidersConfig: mock(() => args.providersConfig) }
          : {}),
      } as unknown as Partial<AIService>,
    });
    historyCleanup = cleanup;
    return { session, streamed };
  }

  function skillSendOptions(overrides?: Record<string, unknown>) {
    return {
      model: USER_MODEL,
      agentId: "exec",
      muxMetadata: {
        type: "agent-skill",
        rawCommand: "/done",
        skillName: "done",
        scope: "project",
      },
      ...overrides,
    };
  }

  it("streams a metadata-bound skill on its class model with resolved thinking", async () => {
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" } },
    });

    const result = await session.sendMessage("Use skill done", skillSendOptions());
    expect(result.success).toBe(true);
    expect(streamed).toHaveLength(1);
    expect(streamed[0].modelString).toBe(KNOWN_MODELS.HAIKU.id);
    // "+0" is model-relative: haiku's lowest allowed level is "off".
    expect(streamed[0].thinkingLevel).toBe("off");
    session.dispose();
  });

  it("lets the config skillModelClasses table win over frontmatter metadata", async () => {
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      configValues: {
        modelClasses: { small: "haiku+0", big: "anthropic:claude-opus-5+high" },
        skillModelClasses: { done: "big" },
      },
    });

    const result = await session.sendMessage("Use skill done", skillSendOptions());
    expect(result.success).toBe(true);
    expect(streamed[0].modelString).toBe(KNOWN_MODELS.OPUS.id);
    expect(streamed[0].thinkingLevel).toBe("high");
    session.dispose();
  });

  it("routes a table-bound skill that has no frontmatter metadata", async () => {
    const workspacePath = await createWorkspaceWithSkill({ skillName: "done" });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      configValues: {
        modelClasses: { small: "haiku+0" },
        skillModelClasses: { done: "small" },
      },
    });

    const result = await session.sendMessage("Use skill done", skillSendOptions());
    expect(result.success).toBe(true);
    expect(streamed[0].modelString).toBe(KNOWN_MODELS.HAIKU.id);
    session.dispose();
  });

  it("never re-routes sends that carry an explicit override (skipAiSettingsPersistence)", async () => {
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" } },
    });

    const result = await session.sendMessage(
      "Use skill done",
      skillSendOptions({ skipAiSettingsPersistence: true })
    );
    expect(result.success).toBe(true);
    expect(streamed[0].modelString).toBe(USER_MODEL);
    expect(streamed[0].thinkingLevel).toBeUndefined();
    session.dispose();
  });

  it("fails the send with an actionable error when the bound class is not configured", async () => {
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: tiny\n",
    });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" } },
    });

    const result = await session.sendMessage("Use skill done", skillSendOptions());
    expect(result.success).toBe(false);
    // The error must name the class so the user knows which mapping to fix.
    const raw = !result.success && result.error.type === "unknown" ? result.error.raw : "";
    expect(raw).toContain('"tiny"');
    expect(streamed).toHaveLength(0);
    session.dispose();
  });

  it("fails the send with an actionable error when the class value is invalid", async () => {
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      // Hand-edited config can hold values the strict-on-write path would
      // have rejected; the send must not silently ignore them.
      configValues: { modelClasses: { small: "not-a-model" } },
    });

    const result = await session.sendMessage("Use skill done", skillSendOptions());
    expect(result.success).toBe(false);
    const raw = !result.success && result.error.type === "unknown" ? result.error.raw : "";
    expect(raw).toContain('"small"');
    expect(streamed).toHaveLength(0);
    session.dispose();
  });

  it("fails the send when no configured route can serve the class model", async () => {
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" }, routePriority: ["direct"] },
      providersConfig: { anthropic: { isConfigured: false } },
    });

    const result = await session.sendMessage("Use skill done", skillSendOptions());
    expect(result.success).toBe(false);
    const raw = !result.success && result.error.type === "unknown" ? result.error.raw : "";
    expect(raw).toContain(KNOWN_MODELS.HAIKU.id);
    expect(streamed).toHaveLength(0);
    session.dispose();
  });

  it("routes normally when the class model has a configured route", async () => {
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" }, routePriority: ["direct"] },
      providersConfig: { anthropic: { isConfigured: true, isEnabled: true } },
    });

    const result = await session.sendMessage("Use skill done", skillSendOptions());
    expect(result.success).toBe(true);
    expect(streamed[0].modelString).toBe(KNOWN_MODELS.HAIKU.id);
    session.dispose();
  });

  it("leaves non-skill sends untouched even with routing configured", async () => {
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      configValues: {
        modelClasses: { small: "haiku+0" },
        skillModelClasses: { done: "small" },
      },
    });

    const result = await session.sendMessage("plain message", {
      model: USER_MODEL,
      agentId: "exec",
    });
    expect(result.success).toBe(true);
    expect(streamed[0].modelString).toBe(USER_MODEL);
    session.dispose();
  });
});
