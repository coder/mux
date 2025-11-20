import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { buildSystemMessage } from "./systemMessage";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";

const extractTagContent = (message: string, tagName: string): string | null => {
  const pattern = new RegExp(`<${tagName}>\\s*([\\s\\S]*?)\\s*</${tagName}>`, "i");
  const match = pattern.exec(message);
  return match ? match[1].trim() : null;
};
import { describe, test, expect, beforeEach, afterEach, spyOn, type Mock } from "bun:test";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";

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

  test("includes mode-specific section when mode is provided", async () => {
    // Write instruction file with mode section to projectDir
    await fs.writeFile(
      path.join(projectDir, "AGENTS.md"),
      `# General Instructions
Always be helpful.

## Mode: Plan
Focus on planning and design.
Use diagrams where appropriate.
`
    );

    const metadata: WorkspaceMetadata = {
      id: "test-workspace",
      name: "test-workspace",
      projectName: "test-project",
      projectPath: projectDir,
      runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    };

    const systemMessage = await buildSystemMessage(metadata, runtime, workspaceDir, "plan");

    const customInstructions = extractTagContent(systemMessage, "custom-instructions") ?? "";
    expect(customInstructions).toContain("Always be helpful.");
    expect(customInstructions).not.toContain("Focus on planning and design.");

    // Should include the mode-specific content
    expect(systemMessage).toContain("<plan>");
    expect(systemMessage).toContain("Focus on planning and design");
    expect(systemMessage).toContain("Use diagrams where appropriate");
    expect(systemMessage).toContain("</plan>");

    // Should also include general instructions
    expect(systemMessage).toContain("Always be helpful");
  });

  test("excludes mode-specific section when mode is not provided", async () => {
    // Write instruction file with mode section to projectDir
    await fs.writeFile(
      path.join(projectDir, "AGENTS.md"),
      `# General Instructions
Always be helpful.

## Mode: Plan
Focus on planning and design.
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

    // Should NOT include the <plan> mode-specific tag
    expect(systemMessage).not.toContain("<plan>");
    expect(systemMessage).not.toContain("</plan>");

    const customInstructions = extractTagContent(systemMessage, "custom-instructions") ?? "";
    expect(customInstructions).toContain("Always be helpful.");
    expect(customInstructions).not.toContain("Focus on planning and design.");
  });

  test("prefers project mode section over global mode section", async () => {
    // Write global instruction file with mode section
    await fs.writeFile(
      path.join(globalDir, "AGENTS.md"),
      `# Global Instructions

## Mode: Plan
Global plan instructions.
`
    );

    // Write project instruction file with mode section
    await fs.writeFile(
      path.join(projectDir, "AGENTS.md"),
      `# Project Instructions

## Mode: Plan
Project plan instructions (should win).
`
    );

    const metadata: WorkspaceMetadata = {
      id: "test-workspace",
      name: "test-workspace",
      projectName: "test-project",
      projectPath: projectDir,
      runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    };

    const systemMessage = await buildSystemMessage(metadata, runtime, workspaceDir, "plan");

    // Should include project mode section in the <plan> tag (project wins)
    expect(systemMessage).toMatch(/<plan>\s*Project plan instructions \(should win\)\./s);
    // Global instructions are still present in <custom-instructions> section (that's correct)
    // But the mode-specific <plan> section should only have project content
    expect(systemMessage).not.toMatch(/<plan>[^<]*Global plan instructions/s);
  });

  test("falls back to global mode section when project has none", async () => {
    // Write global instruction file with mode section
    await fs.writeFile(
      path.join(globalDir, "AGENTS.md"),
      `# Global Instructions

## Mode: Plan
Global plan instructions.
`
    );

    // Write project instruction file WITHOUT mode section
    await fs.writeFile(
      path.join(projectDir, "AGENTS.md"),
      `# Project Instructions
Just general project stuff.
`
    );

    const metadata: WorkspaceMetadata = {
      id: "test-workspace",
      name: "test-workspace",
      projectName: "test-project",
      projectPath: projectDir,
      runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    };

    const systemMessage = await buildSystemMessage(metadata, runtime, workspaceDir, "plan");

    // Should include global mode section as fallback
    expect(systemMessage).toContain("Global plan instructions");
  });

  test("handles mode with special characters by sanitizing tag name", async () => {
    await fs.writeFile(
      path.join(projectDir, "AGENTS.md"),
      `## Mode: My-Special_Mode!
Special mode instructions.
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
      "My-Special_Mode!"
    );

    // Tag should be sanitized to only contain valid characters
    expect(systemMessage).toContain("<my-special_mode->");
    expect(systemMessage).toContain("Special mode instructions");
    expect(systemMessage).toContain("</my-special_mode->");
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

  describe("instruction scoping matrix", () => {
    interface Scenario {
      name: string;
      mdContent: string;
      mode?: string;
      model?: string;
      assert: (message: string) => void;
    }

    const scopingScenarios: Scenario[] = [
      {
        name: "strips scoped sections when no mode or model provided",
        mdContent: `# Notes
General guidance for everyone.

## Mode: Plan
Plan depth instructions.

## Model: sonnet
Anthropic-only instructions.
`,
        assert: (message) => {
          const custom = extractTagContent(message, "custom-instructions") ?? "";
          expect(custom).toContain("General guidance for everyone.");
          expect(custom).not.toContain("Plan depth instructions.");
          expect(custom).not.toContain("Anthropic-only instructions.");
          expect(message).not.toContain("Plan depth instructions.");
          expect(message).not.toContain("Anthropic-only instructions.");
        },
      },
      {
        name: "injects only the requested mode section",
        mdContent: `General context for all contributors.

## Mode: Plan
Plan-only reminders.

## Mode: Exec
Exec reminders.
`,
        mode: "plan",
        assert: (message) => {
          const custom = extractTagContent(message, "custom-instructions") ?? "";
          expect(custom).toContain("General context for all contributors.");
          expect(custom).not.toContain("Plan-only reminders.");
          expect(custom).not.toContain("Exec reminders.");

          const planSection = extractTagContent(message, "plan") ?? "";
          expect(planSection).toContain("Plan-only reminders.");
          expect(planSection).not.toContain("Exec reminders.");
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
      {
        name: "supports simultaneous mode and model scoping",
        mdContent: `General instructions for everyone.

## Mode: Exec
Stay focused on implementation details.

## Model: sonnet
Answer in two sentences max.
`,
        mode: "exec",
        model: "anthropic:claude-3.5-sonnet",
        assert: (message) => {
          const custom = extractTagContent(message, "custom-instructions") ?? "";
          expect(custom).toContain("General instructions for everyone.");
          expect(custom).not.toContain("Stay focused on implementation details.");
          expect(custom).not.toContain("Answer in two sentences max.");

          const execSection = extractTagContent(message, "exec") ?? "";
          expect(execSection).toContain("Stay focused on implementation details.");

          const sonnetSection =
            extractTagContent(message, "model-anthropic-claude-3-5-sonnet") ?? "";
          expect(sonnetSection).toContain("Answer in two sentences max.");
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
          scenario.mode,
          undefined,
          scenario.model
        );

        scenario.assert(systemMessage);
      });
    }
  });
});
