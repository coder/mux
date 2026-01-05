import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { buildSystemMessage, extractToolInstructions } from "./systemMessage";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";

const extractTagContent = (message: string, tagName: string): string | null => {
  const pattern = new RegExp(`<${tagName}>\\s*([\\s\\S]*?)\\s*</${tagName}>`, "i");
  const match = pattern.exec(message);
  return match ? match[1].trim() : null;
};
import { describe, test, expect, beforeEach, afterEach, spyOn, type Mock } from "bun:test";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";

describe("extractToolInstructions", () => {
  // Use a model that has bash tool available
  const modelString = "anthropic:claude-sonnet-4-20250514";

  test("extracts tool section from agentInstructions first", () => {
    const globalInstructions = `## Tool: bash
From global: Use rg for searching.
`;
    const contextInstructions = `## Tool: bash
From context: Use fd for finding.
`;
    const agentInstructions = `## Tool: bash
From agent: Use ripgrep alias.
`;

    const result = extractToolInstructions(globalInstructions, contextInstructions, modelString, {
      agentInstructions,
    });

    expect(result.bash).toContain("From agent: Use ripgrep alias.");
    expect(result.bash).not.toContain("From context");
    expect(result.bash).not.toContain("From global");
  });

  test("falls back to context when agentInstructions has no matching tool section", () => {
    const globalInstructions = `## Tool: bash
From global: Use rg for searching.
`;
    const contextInstructions = `## Tool: bash
From context: Use fd for finding.
`;
    const agentInstructions = `## Tool: file_read
From agent: Read files carefully.
`;

    const result = extractToolInstructions(globalInstructions, contextInstructions, modelString, {
      agentInstructions,
    });

    expect(result.bash).toContain("From context: Use fd for finding.");
    expect(result.bash).not.toContain("From global");
  });

  test("falls back to global when neither agentInstructions nor context has tool section", () => {
    const globalInstructions = `## Tool: bash
From global: Use rg for searching.
`;
    const contextInstructions = `General context instructions.`;
    const agentInstructions = `General agent instructions.`;

    const result = extractToolInstructions(globalInstructions, contextInstructions, modelString, {
      agentInstructions,
    });

    expect(result.bash).toContain("From global: Use rg for searching.");
  });

  test("returns empty object when no tool sections found", () => {
    const result = extractToolInstructions("No tool sections here.", "Nor here.", modelString, {
      agentInstructions: "Or here.",
    });

    expect(result.bash).toBeUndefined();
  });
});

describe("buildSystemMessage", () => {
  let tempDir: string;
  let projectDir: string;
  let workspaceDir: string;
  let globalDir: string;
  let mockHomedir: Mock<typeof os.homedir>;
  let runtime: LocalRuntime;
  let originalMuxRoot: string | undefined;

  beforeEach(async () => {
    // Snapshot any existing MUX_ROOT so we can restore it after the test.
    originalMuxRoot = process.env.MUX_ROOT;

    // Create temp directory for test
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "systemMessage-test-"));
    projectDir = path.join(tempDir, "project");
    workspaceDir = path.join(tempDir, "workspace");
    globalDir = path.join(tempDir, ".mux");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(globalDir, { recursive: true });

    // Mock homedir to return our test directory (getSystemDirectory will append .mux)
    mockHomedir = spyOn(os, "homedir");
    mockHomedir.mockReturnValue(tempDir);

    // Force mux home to our test .mux directory regardless of host MUX_ROOT.
    process.env.MUX_ROOT = globalDir;

    // Create a local runtime for tests
    runtime = new LocalRuntime(tempDir);
  });

  afterEach(async () => {
    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true });

    // Restore environment override
    if (originalMuxRoot === undefined) {
      delete process.env.MUX_ROOT;
    } else {
      process.env.MUX_ROOT = originalMuxRoot;
    }

    // Restore the original homedir
    mockHomedir?.mockRestore();
  });

  test("includes general instructions in custom-instructions", async () => {
    await fs.writeFile(
      path.join(projectDir, "AGENTS.md"),
      `# General Instructions
Always be helpful.
Use clear examples.
`
    );

    const metadata: WorkspaceMetadata = {
      id: "test-workspace",
      name: "test-workspace",
      projectName: "test-project",
      projectPath: projectDir,
      runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    };

    const systemMessage = await buildSystemMessage(metadata, runtime, workspaceDir);

    const customInstructions = extractTagContent(systemMessage, "custom-instructions") ?? "";
    expect(customInstructions).toContain("Always be helpful.");
    expect(customInstructions).toContain("Use clear examples.");
  });

  test("includes model-specific section when regex matches active model", async () => {
    await fs.writeFile(
      path.join(projectDir, "AGENTS.md"),
      `# Instructions
## Model: sonnet
Respond to Sonnet tickets in two sentences max.
`
    );

    const metadata: WorkspaceMetadata = {
      id: "test-workspace",
      name: "test-workspace",
      projectName: "test-project",
      projectPath: projectDir,
      runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    };

    const systemMessage = await buildSystemMessage(
      metadata,
      runtime,
      workspaceDir,
      undefined,
      "anthropic:claude-3.5-sonnet"
    );

    const customInstructions = extractTagContent(systemMessage, "custom-instructions") ?? "";
    expect(customInstructions).not.toContain("Respond to Sonnet tickets in two sentences max.");

    expect(systemMessage).toContain("<model-anthropic-claude-3-5-sonnet>");
    expect(systemMessage).toContain("Respond to Sonnet tickets in two sentences max.");
    expect(systemMessage).toContain("</model-anthropic-claude-3-5-sonnet>");
  });

  test("falls back to global model section when project lacks a match", async () => {
    await fs.writeFile(
      path.join(globalDir, "AGENTS.md"),
      `# Global Instructions
## Model: /openai:.*codex/i
OpenAI's GPT-5.1 Codex models already default to terse replies.
`
    );

    await fs.writeFile(
      path.join(projectDir, "AGENTS.md"),
      `# Project Instructions
General details only.
`
    );

    const metadata: WorkspaceMetadata = {
      id: "test-workspace",
      name: "test-workspace",
      projectName: "test-project",
      projectPath: projectDir,
      runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    };

    const systemMessage = await buildSystemMessage(
      metadata,
      runtime,
      workspaceDir,
      undefined,
      "openai:gpt-5.1-codex"
    );

    const customInstructions = extractTagContent(systemMessage, "custom-instructions") ?? "";
    expect(customInstructions).not.toContain(
      "OpenAI's GPT-5.1 Codex models already default to terse replies."
    );

    expect(systemMessage).toContain("<model-openai-gpt-5-1-codex>");
    expect(systemMessage).toContain(
      "OpenAI's GPT-5.1 Codex models already default to terse replies."
    );
  });

  describe("agentSystemPrompt scoped instructions", () => {
    test("extracts model section from agentSystemPrompt", async () => {
      const agentSystemPrompt = `You are a helpful agent.

## Model: sonnet

Be extra concise when using Sonnet.
`;

      const metadata: WorkspaceMetadata = {
        id: "test-workspace",
        name: "test-workspace",
        projectName: "test-project",
        projectPath: projectDir,
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
      };

      const systemMessage = await buildSystemMessage(
        metadata,
        runtime,
        workspaceDir,
        undefined,
        "anthropic:claude-3.5-sonnet",
        undefined,
        { agentSystemPrompt }
      );

      // Agent instructions should have scoped sections stripped
      const agentInstructions = extractTagContent(systemMessage, "agent-instructions") ?? "";
      expect(agentInstructions).toContain("You are a helpful agent.");
      expect(agentInstructions).not.toContain("Be extra concise when using Sonnet.");

      // Model section should be extracted and injected
      expect(systemMessage).toContain("<model-anthropic-claude-3-5-sonnet>");
      expect(systemMessage).toContain("Be extra concise when using Sonnet.");
    });

    test("agentSystemPrompt model section takes precedence over AGENTS.md", async () => {
      await fs.writeFile(
        path.join(projectDir, "AGENTS.md"),
        `## Model: sonnet
From AGENTS.md: Be verbose.
`
      );

      const agentSystemPrompt = `## Model: sonnet
From agent: Be terse.
`;

      const metadata: WorkspaceMetadata = {
        id: "test-workspace",
        name: "test-workspace",
        projectName: "test-project",
        projectPath: projectDir,
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
      };

      const systemMessage = await buildSystemMessage(
        metadata,
        runtime,
        workspaceDir,
        undefined,
        "anthropic:claude-3.5-sonnet",
        undefined,
        { agentSystemPrompt }
      );

      // Agent definition's model section wins
      expect(systemMessage).toContain("From agent: Be terse.");
      expect(systemMessage).not.toContain("From AGENTS.md: Be verbose.");
    });

    test("falls back to AGENTS.md when agentSystemPrompt has no matching model section", async () => {
      await fs.writeFile(
        path.join(projectDir, "AGENTS.md"),
        `## Model: sonnet
From AGENTS.md: Sonnet instructions.
`
      );

      const agentSystemPrompt = `## Model: opus
From agent: Opus instructions.
`;

      const metadata: WorkspaceMetadata = {
        id: "test-workspace",
        name: "test-workspace",
        projectName: "test-project",
        projectPath: projectDir,
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
      };

      const systemMessage = await buildSystemMessage(
        metadata,
        runtime,
        workspaceDir,
        undefined,
        "anthropic:claude-3.5-sonnet",
        undefined,
        { agentSystemPrompt }
      );

      // Falls back to AGENTS.md since agent has no sonnet section
      expect(systemMessage).toContain("From AGENTS.md: Sonnet instructions.");
      expect(systemMessage).not.toContain("From agent: Opus instructions.");
    });
  });

  describe("instruction scoping matrix", () => {
    interface Scenario {
      name: string;
      mdContent: string;
      model?: string;
      assert: (message: string) => void;
    }

    const scopingScenarios: Scenario[] = [
      {
        name: "strips model sections when no model provided",
        mdContent: `# Notes
General guidance for everyone.

## Model: sonnet
Anthropic-only instructions.
`,
        assert: (message) => {
          const custom = extractTagContent(message, "custom-instructions") ?? "";
          expect(custom).toContain("General guidance for everyone.");
          expect(custom).not.toContain("Anthropic-only instructions.");
          expect(message).not.toContain("Anthropic-only instructions.");
        },
      },
      {
        name: "injects only the matching model section",
        mdContent: `General base instructions.

## Model: sonnet
Anthropic-only instructions.

## Model: /openai:.*/
OpenAI-only instructions.
`,
        model: "openai:gpt-5.1-codex",
        assert: (message) => {
          const custom = extractTagContent(message, "custom-instructions") ?? "";
          expect(custom).toContain("General base instructions.");
          expect(custom).not.toContain("Anthropic-only instructions.");
          expect(custom).not.toContain("OpenAI-only instructions.");

          const openaiSection = extractTagContent(message, "model-openai-gpt-5-1-codex") ?? "";
          expect(openaiSection).toContain("OpenAI-only instructions.");
          expect(openaiSection).not.toContain("Anthropic-only instructions.");
          expect(message).not.toContain("Anthropic-only instructions.");
        },
      },
    ];

    for (const scenario of scopingScenarios) {
      test(scenario.name, async () => {
        await fs.writeFile(path.join(projectDir, "AGENTS.md"), scenario.mdContent);

        const metadata: WorkspaceMetadata = {
          id: "test-workspace",
          name: "test-workspace",
          projectName: "test-project",
          projectPath: projectDir,
          runtimeConfig: DEFAULT_RUNTIME_CONFIG,
        };

        const systemMessage = await buildSystemMessage(
          metadata,
          runtime,
          workspaceDir,
          undefined,
          scenario.model
        );

        scenario.assert(systemMessage);
      });
    }
  });
});
