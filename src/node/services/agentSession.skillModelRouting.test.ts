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
  const tempDirs: string[] = [];
  const sessions: Array<{ dispose: () => void }> = [];
  afterEach(async () => {
    // Safety net: a failed assertion above a test's own dispose() must not
    // leak a live session into the rest of the file, and temp skill trees
    // must not accumulate in the OS temp dir.
    for (const session of sessions.splice(0)) {
      try {
        session.dispose();
      } catch {
        // Already disposed by the test body.
      }
    }
    await historyCleanup?.();
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  async function createWorkspaceWithSkill(args: { skillName: string; metadataYaml?: string }) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mux-skill-routing-"));
    tempDirs.push(tmp);
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
    sessions.push(session);
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
    // The accepted-send payload reports the routed model and thinking so the
    // frontend can attribute send telemetry to what actually streams.
    expect(result.success && result.data?.routedModel).toBe(KNOWN_MODELS.HAIKU.id);
    expect(result.success && result.data?.routedThinkingLevel).toBe("off");
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

  it("never re-routes sends that carry an explicit model override (skipSkillModelRouting)", async () => {
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
      skillSendOptions({ skipSkillModelRouting: true })
    );
    expect(result.success).toBe(true);
    // No routing applied — the accepted-send payload must not name a model.
    expect(result.success && result.data?.routedModel).toBeUndefined();
    expect(streamed[0].modelString).toBe(USER_MODEL);
    expect(streamed[0].thinkingLevel).toBeUndefined();
    session.dispose();
  });

  it("still routes sends that only skip settings persistence (thinking-only one-shots)", async () => {
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" } },
    });

    // "/+2 /done" sets skipAiSettingsPersistence (to protect preferences) with
    // no model override — class routing must still apply to the model while
    // the explicit thinking level wins over the class default.
    const result = await session.sendMessage(
      "Use skill done",
      skillSendOptions({ skipAiSettingsPersistence: true, thinkingLevel: "medium" })
    );
    expect(result.success).toBe(true);
    expect(streamed[0].modelString).toBe(KNOWN_MODELS.HAIKU.id);
    expect(streamed[0].thinkingLevel).toBe("medium");
    // The payload reports the effective level even when the one-shot rode
    // through unchanged — telemetry must see what the routed stream runs at.
    expect(result.success && result.data?.routedThinkingLevel).toBe("medium");
    session.dispose();
  });

  it("re-resolves a numeric one-shot thinking index against the routed model", async () => {
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      configValues: { modelClasses: { small: "haiku" } },
    });

    // "/+0 /done" typed on a workspace model whose lowest allowed level is
    // "medium": the frontend resolves thinkingLevel against the WORKSPACE
    // ladder and passes the raw index alongside. The routed model's ladder
    // differs (haiku's index 0 is "off"), so the re-resolved index — not the
    // pre-resolved level — must win.
    const result = await session.sendMessage(
      "Use skill done",
      skillSendOptions({
        skipAiSettingsPersistence: true,
        thinkingLevel: "medium",
        oneShotThinkingIndex: 0,
      })
    );
    expect(result.success).toBe(true);
    expect(streamed[0].modelString).toBe(KNOWN_MODELS.HAIKU.id);
    expect(streamed[0].thinkingLevel).toBe("off");
    session.dispose();
  });

  it("leaves frontmatter bindings to an undefined class inert (streams the caller's model)", async () => {
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: tiny\n",
    });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" } },
    });

    // Skills the user does not own must not fail sends just because some
    // other class is configured — an undefined frontmatter class is inert.
    const result = await session.sendMessage("Use skill done", skillSendOptions());
    expect(result.success).toBe(true);
    expect(streamed[0].modelString).toBe(USER_MODEL);
    session.dispose();
  });

  it("fails the send with an actionable error on a dangling table binding", async () => {
    const workspacePath = await createWorkspaceWithSkill({ skillName: "done" });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      // The table is the user's own routing intent: naming a class that no
      // longer exists must error loudly, not silently unroute.
      configValues: { modelClasses: { small: "haiku+0" }, skillModelClasses: { done: "tiny" } },
    });

    const result = await session.sendMessage("Use skill done", skillSendOptions());
    expect(result.success).toBe(false);
    // The error must name the class so the user knows which mapping to fix.
    const raw = !result.success && result.error.type === "unknown" ? result.error.raw : "";
    expect(raw).toContain('"tiny"');
    expect(streamed).toHaveLength(0);
    session.dispose();
  });

  it("honors frontmatter routing when a hand-edited table entry is blank", async () => {
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      // A blank table value (hand-edit meaning "no override") must not
      // suppress the frontmatter read and silently unroute the skill.
      configValues: { modelClasses: { small: "haiku+0" }, skillModelClasses: { done: "  " } },
    });

    const result = await session.sendMessage("Use skill done", skillSendOptions());
    expect(result.success).toBe(true);
    expect(streamed[0].modelString).toBe(KNOWN_MODELS.HAIKU.id);
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
