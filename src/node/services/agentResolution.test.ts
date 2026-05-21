import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import type { ProjectsConfig } from "@/common/types/project";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { DisposableTempDir } from "@/node/services/tempDir";
import { resolveAgentForStream } from "./agentResolution";

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

async function resolvePolicyForAgent(params: { agentId: string; advisorAvailable?: boolean }) {
  using tempDir = new DisposableTempDir("agent-resolution-advisor-gating");
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
    advisorAvailable: params.advisorAvailable ?? true,
  });

  if (!result.success) {
    throw new Error("Expected agent resolution to succeed");
  }
  return result.data.effectiveToolPolicy ?? [];
}

describe("resolveAgentForStream advisor gating", () => {
  test("enables the advisor regex when an advisor is available, regardless of agent id", async () => {
    const [execPolicy, planPolicy] = await Promise.all([
      resolvePolicyForAgent({ agentId: "exec", advisorAvailable: true }),
      resolvePolicyForAgent({ agentId: "plan", advisorAvailable: true }),
    ]);

    expect(execPolicy).toContainEqual({ regex_match: "advisor", action: "enable" });
    expect(planPolicy).toContainEqual({ regex_match: "advisor", action: "enable" });
  });

  test("disables the advisor regex when no advisor file is loaded", async () => {
    const policy = await resolvePolicyForAgent({ agentId: "exec", advisorAvailable: false });

    expect(policy).toContainEqual({ regex_match: "advisor", action: "disable" });
    expect(policy).not.toContainEqual({ regex_match: "advisor", action: "enable" });
  });
});
