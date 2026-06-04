import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import type { ProjectsConfig } from "@/common/types/project";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { DisposableTempDir } from "@/node/services/tempDir";
import { getLegacyModeForAgentMetadata, resolveAgentForStream } from "./agentResolution";

const PARENT_WORKSPACE_ID = "parent-workspace";
const CHILD_WORKSPACE_ID = "child-workspace";

function createSubagentMetadata(params: {
  projectPath: string;
  agentId: string;
}): WorkspaceMetadata {
  return {
    id: CHILD_WORKSPACE_ID,
    name: CHILD_WORKSPACE_ID,
    projectName: path.basename(params.projectPath),
    projectPath: params.projectPath,
    runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    parentWorkspaceId: PARENT_WORKSPACE_ID,
    agentId: params.agentId,
    agentType: params.agentId,
  };
}

async function resolvePolicyForAgent(params: {
  agentId: string;
  agentAiDefaults?: ProjectsConfig["agentAiDefaults"];
}) {
  using tempDir = new DisposableTempDir("agent-resolution-advisor-defaults");
  const projectPath = path.join(tempDir.path, "project");
  await fs.mkdir(projectPath, { recursive: true });

  const metadata = createSubagentMetadata({
    projectPath,
    agentId: params.agentId,
  });
  const cfg: ProjectsConfig = {
    projects: new Map([
      [
        projectPath,
        {
          trusted: true,
          workspaces: [
            { id: PARENT_WORKSPACE_ID, name: PARENT_WORKSPACE_ID, path: projectPath },
            {
              id: CHILD_WORKSPACE_ID,
              name: CHILD_WORKSPACE_ID,
              path: projectPath,
              parentWorkspaceId: PARENT_WORKSPACE_ID,
              agentId: params.agentId,
              agentType: params.agentId,
            },
          ],
        },
      ],
    ]),
    ...(params.agentAiDefaults ? { agentAiDefaults: params.agentAiDefaults } : {}),
  };

  const result = await resolveAgentForStream({
    workspaceId: CHILD_WORKSPACE_ID,
    metadata,
    runtime: new LocalRuntime(projectPath),
    workspacePath: projectPath,
    requestedAgentId: params.agentId,
    disableWorkspaceAgents: false,
    callerToolPolicy: undefined,
    cfg,
    emitError: () => undefined,
    isAdvisorExperimentEnabled: true,
  });

  if (!result.success) {
    throw new Error("Expected agent resolution to succeed");
  }
  return result.data.effectiveToolPolicy ?? [];
}

describe("getLegacyModeForAgentMetadata", () => {
  test("omits legacy mode metadata for custom or derived agents", () => {
    expect(getLegacyModeForAgentMetadata("explore", "exec")).toBeUndefined();
    expect(getLegacyModeForAgentMetadata("custom-plan", "plan")).toBeUndefined();
    expect(getLegacyModeForAgentMetadata("exec", "exec")).toBe("exec");
    expect(getLegacyModeForAgentMetadata("plan", "plan")).toBe("plan");
    expect(getLegacyModeForAgentMetadata("compact", "compact")).toBe("compact");
  });
});

describe("resolveAgentForStream advisor defaults", () => {
  test("enables advisor by default for Exec and Plan sub-agents when the experiment is enabled", async () => {
    const [execPolicy, planPolicy] = await Promise.all([
      resolvePolicyForAgent({ agentId: "exec" }),
      resolvePolicyForAgent({ agentId: "plan" }),
    ]);

    expect(execPolicy).toContainEqual({ regex_match: "advisor", action: "enable" });
    expect(planPolicy).toContainEqual({ regex_match: "advisor", action: "enable" });
  });

  test("keeps explicit advisor disable overrides authoritative for default-enabled agents", async () => {
    const policy = await resolvePolicyForAgent({
      agentId: "exec",
      agentAiDefaults: { exec: { advisorEnabled: false } },
    });

    expect(policy).toContainEqual({ regex_match: "advisor", action: "disable" });
    expect(policy).not.toContainEqual({ regex_match: "advisor", action: "enable" });
  });
});
