import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";
import type { Tool } from "ai";

import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { applyToolPolicy } from "@/common/utils/tools/toolPolicy";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import {
  clearBuiltInAgentCache,
  getBuiltInAgentDefinitions,
} from "./agentDefinitions/builtInAgentDefinitions";
import { resolveToolPolicyForAgent } from "./agentDefinitions/resolveToolPolicy";
import { buildSystemMessage } from "./systemMessage";
import { DisposableTempDir } from "./tempDir";
import { maybeAppendHarnessConfigSchemaToAdditionalInstructions } from "./harnessConfigSchemaPrompt";

describe("harness config schema prompt injection", () => {
  test("includes <harness_config_schema> in additional instructions for harness agents", async () => {
    using tempDir = new DisposableTempDir("harness-schema-prompt");

    const projectDir = path.join(tempDir.path, "project");
    const workspaceDir = path.join(tempDir.path, "workspace");
    const globalMuxDir = path.join(tempDir.path, "global-mux");

    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(globalMuxDir, { recursive: true });

    const originalMuxRoot = process.env.MUX_ROOT;
    process.env.MUX_ROOT = globalMuxDir;

    try {
      const runtime = new LocalRuntime(tempDir.path);
      const metadata: WorkspaceMetadata = {
        id: "test-workspace",
        name: "test-workspace",
        projectName: "test-project",
        projectPath: projectDir,
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
      };

      for (const agentId of ["harness-init"] as const) {
        const additional = maybeAppendHarnessConfigSchemaToAdditionalInstructions({
          agentId,
          workspaceName: metadata.name,
          additionalInstructions: "extra",
        });
        expect(additional).toContain("<harness_config_schema");
        expect(additional).toContain("<harness_output_path>");
        expect(additional).toContain(`.mux/harness/${metadata.name}.jsonc`);

        const systemMessage = await buildSystemMessage(metadata, runtime, workspaceDir, additional);
        expect(systemMessage).toContain("<harness_config_schema");
        expect(systemMessage).toContain("<harness_output_path>");
        expect(systemMessage).toContain(`.mux/harness/${metadata.name}.jsonc`);

        const match = /<harness_config_schema[^>]*>\s*([\s\S]*?)\s*<\/harness_config_schema>/m.exec(
          systemMessage
        );
        expect(match).not.toBeNull();

        const schema = JSON.parse(match![1]) as { required?: string[] };
        const required = schema.required ?? [];
        expect(required).toContain("version");
        expect(required).toContain("checklist");
        expect(required).toContain("gates");
      }

      const nonHarness = maybeAppendHarnessConfigSchemaToAdditionalInstructions({
        agentId: "exec",
        workspaceName: metadata.name,
        additionalInstructions: "extra",
      });
      expect(nonHarness).toBe("extra");
    } finally {
      if (originalMuxRoot === undefined) {
        delete process.env.MUX_ROOT;
      } else {
        process.env.MUX_ROOT = originalMuxRoot;
      }
    }
  });
});

describe("harness-init tool policy", () => {
  test("disables web_* tools", () => {
    clearBuiltInAgentCache();
    const builtIns = getBuiltInAgentDefinitions();

    const harnessInit = builtIns.find((a) => a.id === "harness-init");
    const exec = builtIns.find((a) => a.id === "exec");

    expect(harnessInit).toBeDefined();
    expect(exec).toBeDefined();

    const agents = [{ tools: harnessInit!.frontmatter.tools }, { tools: exec!.frontmatter.tools }];

    const policy = resolveToolPolicyForAgent({
      agents,
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });

    const tool = {} as unknown as Tool;
    const filtered = applyToolPolicy(
      {
        file_read: tool,
        web_search: tool,
        web_fetch: tool,
        google_search: tool,
      },
      policy
    );

    expect(Object.keys(filtered)).toContain("file_read");
    expect(Object.keys(filtered)).not.toContain("web_search");
    expect(Object.keys(filtered)).not.toContain("web_fetch");
    expect(Object.keys(filtered)).not.toContain("google_search");
  });
});
