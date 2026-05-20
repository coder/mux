import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { buildSystemMessage, extractToolInstructions, readToolInstructions } from "./systemMessage";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";

const extractTagContent = (message: string, tagName: string): string | null => {
  const pattern = new RegExp(`<${tagName}>\\s*([\\s\\S]*?)\\s*</${tagName}>`, "i");
  const match = pattern.exec(message);
  return match ? match[1].trim() : null;
};
import { describe, test, expect, beforeEach, afterEach, spyOn, type Mock } from "bun:test";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";

// Note: in this file we avoid tests that are merely tautological assertions of constants. Only
// tests that verify branching logic should be here.

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

    expect(result.bash).toBe(
      [
        "From agent: Use ripgrep alias.",
        "From context: Use fd for finding.",
        "From global: Use rg for searching.",
      ].join("\n\n")
    );
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

    expect(result.bash).toBe(
      ["From context: Use fd for finding.", "From global: Use rg for searching."].join("\n\n")
    );
  });

  test("keeps every matching context tool section before falling back to global", () => {
    const globalInstructions = `## Tool: bash
From global: Use rg for searching.
`;
    const contextInstructions = `## Tool: bash
From primary repo: Prefer git status --short.

## Tool: bash
From secondary repo: Prefer rg --files before find.
`;

    const result = extractToolInstructions(globalInstructions, contextInstructions, modelString);

    expect(result.bash).toBe(
      [
        "From primary repo: Prefer git status --short.",
        "From secondary repo: Prefer rg --files before find.",
        "From global: Use rg for searching.",
      ].join("\n\n")
    );
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

    // Create a local runtime for tests. It reports workspaceDir as the
    // workspace root so sub-project instruction loading can strip the
    // execution cwd back to the parent checkout, matching production.
    runtime = new LocalRuntime(workspaceDir);
  });

  async function createMultiProjectFixture(): Promise<{
    metadata: WorkspaceMetadata;
    primaryWorkspaceRepoDir: string;
    secondaryWorkspaceRepoDir: string;
  }> {
    const primaryProjectDir = path.join(tempDir, "primary-project");
    const secondaryProjectDir = path.join(tempDir, "secondary-project");
    const primaryWorkspaceRepoDir = path.join(tempDir, "primary-workspace-repo");
    const secondaryWorkspaceRepoDir = path.join(tempDir, "secondary-workspace-repo");

    await fs.mkdir(primaryProjectDir, { recursive: true });
    await fs.mkdir(secondaryProjectDir, { recursive: true });
    await fs.mkdir(primaryWorkspaceRepoDir, { recursive: true });
    await fs.mkdir(secondaryWorkspaceRepoDir, { recursive: true });
    await fs.symlink(primaryWorkspaceRepoDir, path.join(workspaceDir, "primary"));
    await fs.symlink(secondaryWorkspaceRepoDir, path.join(workspaceDir, "secondary"));

    return {
      metadata: {
        id: "test-workspace",
        name: "test-workspace",
        projectName: "primary",
        projectPath: primaryProjectDir,
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
        projects: [
          { projectName: "primary", projectPath: primaryProjectDir },
          { projectName: "secondary", projectPath: secondaryProjectDir },
        ],
      },
      primaryWorkspaceRepoDir,
      secondaryWorkspaceRepoDir,
    };
  }

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
      path.join(workspaceDir, "AGENTS.md"),
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

  test("includes parent project AGENTS.md alongside sub-project AGENTS.md when subProjectPath is set", async () => {
    // Regression: the prompt builder previously read `workspacePath` (the
    // execution path = workspace_root + subProjectRelativePath) as if it were
    // the workspace root, so for sub-project workspaces it joined the
    // sub-project segment a second time and missed the parent AGENTS.md
    // entirely. We now derive the workspace root explicitly from runtime
    // metadata and read both files at the right paths.
    const subProjectDir = path.join(workspaceDir, "packages", "api");
    await fs.mkdir(subProjectDir, { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "AGENTS.md"),
      "# Parent Project\nParent project guidance.\n"
    );
    await fs.writeFile(
      path.join(subProjectDir, "AGENTS.md"),
      "# Sub-project Package API\nSub-project guidance.\n"
    );

    // The runtime must report `workspaceDir` as the workspace path so
    // `resolveWorkspaceRootPath` returns it (LocalRuntime returns its
    // constructor arg from getWorkspacePath).
    const subProjectRuntime = new LocalRuntime(workspaceDir);

    const metadata: WorkspaceMetadata = {
      id: "test-workspace",
      name: "test-workspace",
      projectName: "test-project",
      projectPath: projectDir,
      subProjectPath: path.join(projectDir, "packages", "api"),
      runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    };

    const systemMessage = await buildSystemMessage(
      metadata,
      subProjectRuntime,
      // Callers pass the *execution* path (root + sub-project) here; the
      // function should still resolve the parent AGENTS.md correctly.
      subProjectDir
    );

    const customInstructions = extractTagContent(systemMessage, "custom-instructions") ?? "";
    expect(customInstructions).toContain("Parent project guidance.");
    expect(customInstructions).toContain("Sub-project guidance.");
  });

  test("includes generic instructions from every project repo in a multi-project workspace", async () => {
    const { metadata, primaryWorkspaceRepoDir, secondaryWorkspaceRepoDir } =
      await createMultiProjectFixture();

    await fs.writeFile(
      path.join(primaryWorkspaceRepoDir, "AGENTS.md"),
      `# Primary Instructions
Use the primary project context.
`
    );
    await fs.writeFile(
      path.join(secondaryWorkspaceRepoDir, "AGENTS.md"),
      `# Secondary Instructions
Include the secondary project context too.
`
    );

    const systemMessage = await buildSystemMessage(metadata, runtime, workspaceDir);

    const customInstructions = extractTagContent(systemMessage, "custom-instructions") ?? "";
    expect(customInstructions).toContain("Use the primary project context.");
    expect(customInstructions).toContain("Include the secondary project context too.");
  });

  test("preserves bash tool instructions from every multi-project context source", async () => {
    const { metadata, primaryWorkspaceRepoDir, secondaryWorkspaceRepoDir } =
      await createMultiProjectFixture();

    await fs.writeFile(
      path.join(globalDir, "AGENTS.md"),
      `# Global Instructions
## Tool: bash
From global: this should only apply when context has no bash section.
`
    );
    await fs.writeFile(
      path.join(primaryWorkspaceRepoDir, "AGENTS.md"),
      `# Primary Instructions
## Tool: bash
From primary repo: prefer git status --short.
`
    );
    await fs.writeFile(
      path.join(secondaryWorkspaceRepoDir, "AGENTS.md"),
      `# Secondary Instructions
## Tool: bash
From secondary repo: prefer rg --files before find.
`
    );

    const toolInstructions = await readToolInstructions(
      metadata,
      runtime,
      workspaceDir,
      "anthropic:claude-sonnet-4-20250514"
    );

    expect(toolInstructions.bash).toBe(
      [
        "From primary repo: prefer git status --short.",
        "From secondary repo: prefer rg --files before find.",
        "From global: this should only apply when context has no bash section.",
      ].join("\n\n")
    );
  });

  test("includes model-specific section when regex matches active model", async () => {
    await fs.writeFile(
      path.join(workspaceDir, "AGENTS.md"),
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
      path.join(workspaceDir, "AGENTS.md"),
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
        path.join(workspaceDir, "AGENTS.md"),
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

      expect(systemMessage).toContain("From agent: Be terse.");
      expect(systemMessage).toContain("From AGENTS.md: Be verbose.");
      expect(systemMessage.indexOf("From agent: Be terse.")).toBeLessThan(
        systemMessage.indexOf("From AGENTS.md: Be verbose.")
      );
    });

    test("falls back to AGENTS.md when agentSystemPrompt has no matching model section", async () => {
      await fs.writeFile(
        path.join(workspaceDir, "AGENTS.md"),
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
        await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), scenario.mdContent);

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

  describe("sub-project workspaces look like regular projects", () => {
    // Sub-project workspaces share the parent project's checkout but cwd into
    // a descendant directory. From the agent's perspective they should be
    // indistinguishable from a single-project workspace rooted at that cwd:
    // no parent-repo callout in the prompt, no inherited parent AGENTS.md,
    // no special "sub-project" framing in tool descriptions.
    async function setupSubProjectFixture(): Promise<{
      subProjectMetadata: WorkspaceMetadata;
      regularMetadata: WorkspaceMetadata;
      subProjectCwd: string;
      parentRoot: string;
    }> {
      const subProjectAbs = path.join(workspaceDir, "packages", "api");
      await fs.mkdir(subProjectAbs, { recursive: true });

      const subProjectMetadata: WorkspaceMetadata = {
        id: "test-workspace",
        name: "test-workspace",
        projectName: "test-project",
        projectPath: workspaceDir,
        subProjectPath: subProjectAbs,
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
      };

      // Regular single-project workspace whose project path IS the sub-project
      // directory. Used as the reference oracle: the sub-project workspace's
      // prompt at the same cwd must match this byte-for-byte in <environment>.
      const regularMetadata: WorkspaceMetadata = {
        id: "test-workspace",
        name: "test-workspace",
        projectName: "test-project",
        projectPath: subProjectAbs,
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
      };

      return {
        subProjectMetadata,
        regularMetadata,
        subProjectCwd: subProjectAbs,
        parentRoot: workspaceDir,
      };
    }

    test("environment block is identical to a regular single-project workspace at the same cwd", async () => {
      // Core invariant: presence of `subProjectPath` in metadata must not
      // change the <environment> block. The agent sees the same description
      // and lines whether the workspace is configured as a sub-project or as
      // a regular project rooted at that directory.
      const { subProjectMetadata, regularMetadata, subProjectCwd } = await setupSubProjectFixture();

      const subProjectMessage = await buildSystemMessage(
        subProjectMetadata,
        runtime,
        subProjectCwd
      );
      const regularMessage = await buildSystemMessage(regularMetadata, runtime, subProjectCwd);

      const subEnvironment = extractTagContent(subProjectMessage, "environment");
      const regularEnvironment = extractTagContent(regularMessage, "environment");
      expect(subEnvironment).toBe(regularEnvironment);
    });

    test("environment block does not mention sub-project framing or relative-path nudges", async () => {
      // Regression guard against the rejected direction (PR #3244 v1) where
      // the prompt called out "the `packages/api` sub-project of the X at Y"
      // and added a relative-paths preamble. The agent should see the cwd as
      // a regular project root with no parent-repo context. (The parentRoot
      // is a path prefix of subProjectCwd, so checking for it directly is
      // ambiguous — the byte-equality test above already proves the env
      // block contains no parent-specific framing.)
      const { subProjectMetadata, subProjectCwd } = await setupSubProjectFixture();

      const systemMessage = await buildSystemMessage(subProjectMetadata, runtime, subProjectCwd);
      const environment = extractTagContent(systemMessage, "environment") ?? "";

      expect(environment).not.toContain("sub-project");
      expect(environment).not.toMatch(/Prefer paths relative to/);
    });

    test("AGENTS.md is concatenated parent → sub-project with H1 path-source headings", async () => {
      // Sub-projects inherit parent conventions: parent AGENTS.md is glued
      // before the sub-project's own AGENTS.md so the agent sees a single
      // combined block. Each segment opens with an H1 heading whose body
      // is the source path relative to the cwd (e.g. `` # `../../AGENTS.md` ``
      // or `` # `./AGENTS.md` ``) so the agent can disambiguate which root
      // any relative path references in each segment should resolve
      // against. The H1 also bounds scoped `## Tool:` / `## Model:`
      // sections inside the segment, preventing them from spanning across
      // the segment join into the next segment's narrative.
      //
      // We deliberately avoid the rejected v1 framing of `# Project context
      // (root: ...)` / `# Sub-project context (root: ...)` — the H1 here is
      // just a path note, not a structural callout dressing the sub-project
      // up as a special feature.
      const { subProjectMetadata, subProjectCwd, parentRoot } = await setupSubProjectFixture();

      await fs.writeFile(
        path.join(parentRoot, "AGENTS.md"),
        "PARENT_MARKER: parent project conventions.\n"
      );
      await fs.writeFile(
        path.join(subProjectCwd, "AGENTS.md"),
        "SUB_MARKER: sub-project specific conventions.\n"
      );

      const systemMessage = await buildSystemMessage(subProjectMetadata, runtime, subProjectCwd);
      const customInstructions = extractTagContent(systemMessage, "custom-instructions") ?? "";

      expect(customInstructions).toContain("PARENT_MARKER");
      expect(customInstructions).toContain("SUB_MARKER");
      // `packages/api` is two levels deep, so the parent AGENTS.md is
      // `../../AGENTS.md` from the cwd.
      expect(customInstructions).toContain("# `../../AGENTS.md`");
      expect(customInstructions).toContain("# `./AGENTS.md`");
      // Each H1 must precede its corresponding content.
      expect(customInstructions.indexOf("# `../../AGENTS.md`")).toBeLessThan(
        customInstructions.indexOf("PARENT_MARKER")
      );
      expect(customInstructions.indexOf("# `./AGENTS.md`")).toBeLessThan(
        customInstructions.indexOf("SUB_MARKER")
      );
      // Parent first so general rules anchor before the more specific
      // sub-project overrides.
      expect(customInstructions.indexOf("PARENT_MARKER")).toBeLessThan(
        customInstructions.indexOf("SUB_MARKER")
      );
      // Regression guard against the rejected v1 verbose framing.
      expect(customInstructions).not.toContain("# Project context (root:");
      expect(customInstructions).not.toContain("# Sub-project context (root:");
    });

    test("relative-path heading depth tracks the sub-project nesting depth", async () => {
      // A single-segment sub-project (`api` instead of `packages/api`) only
      // needs one `../` level. Verifies the depth computation rather than
      // hard-coding the fixture's two-level structure.
      const subProjectAbs = path.join(workspaceDir, "api");
      await fs.mkdir(subProjectAbs, { recursive: true });
      const metadata: WorkspaceMetadata = {
        id: "test-workspace",
        name: "test-workspace",
        projectName: "test-project",
        projectPath: workspaceDir,
        subProjectPath: subProjectAbs,
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
      };

      await fs.writeFile(
        path.join(workspaceDir, "AGENTS.md"),
        "DEPTH_TEST_PARENT_MARKER: depth=1 parent.\n"
      );

      const systemMessage = await buildSystemMessage(metadata, runtime, subProjectAbs);
      const customInstructions = extractTagContent(systemMessage, "custom-instructions") ?? "";

      expect(customInstructions).toContain("# `../AGENTS.md`");
      expect(customInstructions).not.toContain("# `../../AGENTS.md`");
      expect(customInstructions).toContain("DEPTH_TEST_PARENT_MARKER");
    });

    test("only-parent AGENTS.md is loaded when sub-project has none", async () => {
      // If only the parent has AGENTS.md, sub-project workspaces should
      // still inherit it — and the H1 path heading lets the agent know
      // it's reading the parent's, not its own.
      const { subProjectMetadata, subProjectCwd, parentRoot } = await setupSubProjectFixture();
      await fs.writeFile(
        path.join(parentRoot, "AGENTS.md"),
        "PARENT_ONLY_MARKER: only parent conventions.\n"
      );

      const systemMessage = await buildSystemMessage(subProjectMetadata, runtime, subProjectCwd);
      const customInstructions = extractTagContent(systemMessage, "custom-instructions") ?? "";

      expect(customInstructions).toContain("PARENT_ONLY_MARKER");
      expect(customInstructions).toContain("# `../../AGENTS.md`");
      expect(customInstructions).not.toContain("# `./AGENTS.md`");
    });

    test("only-sub-project AGENTS.md is loaded when parent has none", async () => {
      // Symmetric: a sub-project with its own AGENTS.md but no parent
      // AGENTS.md should still load the sub-project's own with the matching
      // `./AGENTS.md` heading.
      const { subProjectMetadata, subProjectCwd } = await setupSubProjectFixture();
      await fs.writeFile(
        path.join(subProjectCwd, "AGENTS.md"),
        "SUB_ONLY_MARKER: only sub-project conventions.\n"
      );

      const systemMessage = await buildSystemMessage(subProjectMetadata, runtime, subProjectCwd);
      const customInstructions = extractTagContent(systemMessage, "custom-instructions") ?? "";

      expect(customInstructions).toContain("SUB_ONLY_MARKER");
      expect(customInstructions).toContain("# `./AGENTS.md`");
      expect(customInstructions).not.toContain("# `../../AGENTS.md`");
    });

    test("regular non-sub-project workspaces emit no path-source heading", async () => {
      // Non-sub-project workspaces preserve historical behavior: the cwd's
      // AGENTS.md is loaded verbatim with no path-source heading or
      // comment. Otherwise we'd be subtly changing the prompt for every
      // regular project workspace.
      const { regularMetadata, subProjectCwd } = await setupSubProjectFixture();
      await fs.writeFile(
        path.join(subProjectCwd, "AGENTS.md"),
        "REGULAR_MARKER: regular project conventions.\n"
      );

      const systemMessage = await buildSystemMessage(regularMetadata, runtime, subProjectCwd);
      const customInstructions = extractTagContent(systemMessage, "custom-instructions") ?? "";

      expect(customInstructions).toContain("REGULAR_MARKER");
      expect(customInstructions).not.toContain("# `");
      expect(customInstructions).not.toContain("<!--");
    });

    test("path-source comment is injected inside scoped Tool: / Model: sections so they survive extraction", async () => {
      // Codex-flagged regression (PR #3244): `extractToolSection` /
      // `extractModelSection` pull the body of a `## Tool: bash` /
      // `## Model: …` section out of the segment, but the top-level
      // `<!-- ../../AGENTS.md -->` comment lives BEFORE the section and
      // isn't part of the extracted body. Without injecting the comment
      // inside each scoped section, scoped tool/model instructions lose
      // the parent-vs-subproject provenance — defeating the purpose of
      // the comment for any path-sensitive guidance authored under a
      // scoped heading.
      //
      // The injection must also play nicely with
      // `stripScopedInstructionSections`, which deletes the entire
      // scoped section from <custom-instructions>: the inner comment
      // disappears with it (no leftover comment alone), while the
      // top-level comment for the surviving narrative still anchors
      // the segment.
      const { subProjectMetadata, subProjectCwd, parentRoot } = await setupSubProjectFixture();

      await fs.writeFile(
        path.join(parentRoot, "AGENTS.md"),
        `Parent narrative.

## Tool: bash
PARENT_BASH_RULE: parent's bash convention.

## Model: anthropic:claude-sonnet-4-20250514
PARENT_MODEL_RULE: parent model preference.
`
      );
      await fs.writeFile(
        path.join(subProjectCwd, "AGENTS.md"),
        `Sub-project narrative.

## Tool: bash
SUB_BASH_RULE: sub-project's bash convention.

## Model: anthropic:claude-sonnet-4-20250514
SUB_MODEL_RULE: sub-project model override.
`
      );

      const modelString = "anthropic:claude-sonnet-4-20250514";
      const toolInstructions = await readToolInstructions(
        subProjectMetadata,
        runtime,
        subProjectCwd,
        modelString
      );

      const bash = toolInstructions.bash ?? "";
      // Both bash bodies must appear in the per-tool extraction with their
      // respective path-source comments.
      expect(bash).toContain("PARENT_BASH_RULE");
      expect(bash).toContain("<!-- ../../AGENTS.md -->");
      expect(bash).toContain("SUB_BASH_RULE");
      expect(bash).toContain("<!-- ./AGENTS.md -->");
      // Each comment precedes its corresponding rule so the agent reads
      // "this rule comes from this path" linearly.
      expect(bash.indexOf("<!-- ../../AGENTS.md -->")).toBeLessThan(
        bash.indexOf("PARENT_BASH_RULE")
      );
      expect(bash.indexOf("<!-- ./AGENTS.md -->")).toBeLessThan(bash.indexOf("SUB_BASH_RULE"));

      const systemMessage = await buildSystemMessage(
        subProjectMetadata,
        runtime,
        subProjectCwd,
        undefined,
        modelString
      );

      // Codex-flagged regression (PR #3244): when both parent and sub-project
      // define matching `## Model: ...` sections, both bodies must appear in
      // the per-model section (the previous singular `extractModelSection`
      // returned only the parent's, silently dropping the sub-project's
      // override). Sub-project body comes second so its rule overrides the
      // parent's via order of presentation.
      const sonnetSection =
        extractTagContent(systemMessage, "model-anthropic-claude-sonnet-4-20250514") ?? "";
      expect(sonnetSection).toContain("PARENT_MODEL_RULE");
      expect(sonnetSection).toContain("SUB_MODEL_RULE");
      expect(sonnetSection).toContain("<!-- ../../AGENTS.md -->");
      expect(sonnetSection).toContain("<!-- ./AGENTS.md -->");
      expect(sonnetSection.indexOf("PARENT_MODEL_RULE")).toBeLessThan(
        sonnetSection.indexOf("SUB_MODEL_RULE")
      );

      // Sanity check: <custom-instructions> still strips scoped sections
      // (including the inner comment) so the bash/model rules don't leak
      // into the unscoped instructions block.
      const customInstructions = extractTagContent(systemMessage, "custom-instructions") ?? "";
      expect(customInstructions).not.toContain("PARENT_BASH_RULE");
      expect(customInstructions).not.toContain("SUB_BASH_RULE");
      expect(customInstructions).not.toContain("PARENT_MODEL_RULE");
      expect(customInstructions).not.toContain("SUB_MODEL_RULE");
      // Top-level H1 path headings survive (they're outside scoped sections,
      // and they bound the scoped sections to their own segment so the
      // parent's `## Model: ...` can't sweep the sub-project's narrative
      // into its strip range).
      expect(customInstructions).toContain("# `../../AGENTS.md`");
      expect(customInstructions).toContain("# `./AGENTS.md`");
      // Inner HTML comments inside scoped sections must NOT leak into the
      // <custom-instructions> block: they're stripped along with their
      // section.
      expect(customInstructions).not.toContain("<!-- ../../AGENTS.md -->");
      expect(customInstructions).not.toContain("<!-- ./AGENTS.md -->");
    });

    test("does not inject path-source comments inside fenced code examples", async () => {
      // Codex-flagged regression (PR #3244): a scoped-looking line inside a
      // fenced code block (e.g. an AGENTS.md authored with a `markdown`
      // documentation example showing how to structure scoped sections)
      // must NOT get a path-source comment injected. The downstream
      // markdown parser used by stripScopedInstructionSections /
      // extractToolSection correctly skips fenced content, so injecting
      // there would only corrupt the documented example without serving
      // any provenance purpose.
      const { subProjectMetadata, subProjectCwd, parentRoot } = await setupSubProjectFixture();

      // Use a string template with explicit newlines so the inner triple-
      // backticks survive being embedded in this JS source file.
      const parentAgents = [
        "Parent narrative.",
        "",
        "Here's an example of how to author scoped sections:",
        "",
        "```markdown",
        "## Tool: bash",
        "EXAMPLE_FENCE_CONTENT: example body inside the fence.",
        "```",
        "",
        "## Tool: bash",
        "PARENT_BASH_RULE: parent's real bash convention.",
        "",
      ].join("\n");

      await fs.writeFile(path.join(parentRoot, "AGENTS.md"), parentAgents);

      const modelString = "anthropic:claude-sonnet-4-20250514";
      const systemMessage = await buildSystemMessage(
        subProjectMetadata,
        runtime,
        subProjectCwd,
        undefined,
        modelString
      );
      const customInstructions = extractTagContent(systemMessage, "custom-instructions") ?? "";

      // The fenced example is preserved verbatim in <custom-instructions>
      // (stripScopedInstructionSections doesn't strip fenced content).
      expect(customInstructions).toContain("EXAMPLE_FENCE_CONTENT");
      // Critically, no `<!-- ../../AGENTS.md -->` comment must appear
      // between the fenced `## Tool: bash` line and the example body.
      const fenceStart = customInstructions.indexOf("```markdown");
      expect(fenceStart).toBeGreaterThanOrEqual(0);
      const fenceEnd = customInstructions.indexOf("```", fenceStart + 3);
      expect(fenceEnd).toBeGreaterThan(fenceStart);
      const fencedRegion = customInstructions.slice(fenceStart, fenceEnd);
      expect(fencedRegion).not.toContain("<!--");

      // Sanity check: the REAL `## Tool: bash` section (outside the fence)
      // still carries the provenance comment into the per-tool extraction.
      const toolInstructions = await readToolInstructions(
        subProjectMetadata,
        runtime,
        subProjectCwd,
        modelString
      );
      const bash = toolInstructions.bash ?? "";
      expect(bash).toContain("PARENT_BASH_RULE");
      expect(bash).toContain("<!-- ../../AGENTS.md -->");
      // The fenced example body must NOT be in the tool extraction either —
      // it lived inside a fenced code block that the markdown parser ignores.
      expect(bash).not.toContain("EXAMPLE_FENCE_CONTENT");
    });

    test("treats lines with info strings as still-inside-the-fence per CommonMark §4.5", async () => {
      // Codex-flagged regression (PR #3244): a closing fence in CommonMark
      // must carry NO info string — only optional trailing whitespace. An
      // inner line like `` ```ts `` (info string "ts") inside an outer
      // `` ```markdown `` fence is NOT a valid closer; markdown-it keeps
      // the outer fence open. A naive scanner that closes on any matching
      // marker would prematurely "close" the outer fence at `` ```ts ``,
      // then the next real `` ``` `` would open a fresh fence, and any
      // `## Tool: …` lines in between would erroneously receive injected
      // provenance comments — corrupting the documented example.
      const { subProjectMetadata, subProjectCwd, parentRoot } = await setupSubProjectFixture();

      const parentAgents = [
        "Parent narrative.",
        "",
        "Here's how to nest fences in a markdown example:",
        "",
        "````markdown",
        "## Tool: bash",
        "EXAMPLE_OUTER_BODY: outer body before nested fence.",
        "",
        "```ts",
        "console.log('inner ts content');",
        "```",
        "",
        "## Tool: foo",
        "EXAMPLE_INNER_BODY: still inside the outer markdown fence.",
        "````",
        "",
        "## Tool: bash",
        "PARENT_BASH_RULE: real, non-fenced bash convention.",
        "",
      ].join("\n");

      await fs.writeFile(path.join(parentRoot, "AGENTS.md"), parentAgents);

      const modelString = "anthropic:claude-sonnet-4-20250514";
      const systemMessage = await buildSystemMessage(
        subProjectMetadata,
        runtime,
        subProjectCwd,
        undefined,
        modelString
      );
      const customInstructions = extractTagContent(systemMessage, "custom-instructions") ?? "";

      // The outer fenced example must be present verbatim — both the
      // outer body before the inner ```ts opener AND the inner body
      // after the inner ``` closer (which is itself still inside the
      // outer fence per CommonMark).
      expect(customInstructions).toContain("EXAMPLE_OUTER_BODY");
      expect(customInstructions).toContain("EXAMPLE_INNER_BODY");

      // Critically, no provenance comment must appear anywhere inside
      // the outer fenced region. We anchor on the outer ````markdown
      // opener and the closing ```` — everything between them must be
      // free of `<!--` markers.
      const outerStart = customInstructions.indexOf("````markdown");
      expect(outerStart).toBeGreaterThanOrEqual(0);
      const outerEnd = customInstructions.indexOf("````", outerStart + 4);
      expect(outerEnd).toBeGreaterThan(outerStart);
      const outerFencedRegion = customInstructions.slice(outerStart, outerEnd);
      expect(outerFencedRegion).not.toContain("<!--");

      // Sanity check: the REAL `## Tool: bash` section (after the outer
      // fence closes) still carries the provenance comment in the
      // per-tool extraction. The example bodies must not leak in.
      const toolInstructions = await readToolInstructions(
        subProjectMetadata,
        runtime,
        subProjectCwd,
        modelString
      );
      const bash = toolInstructions.bash ?? "";
      expect(bash).toContain("PARENT_BASH_RULE");
      expect(bash).toContain("<!-- ../../AGENTS.md -->");
      expect(bash).not.toContain("EXAMPLE_OUTER_BODY");
      expect(bash).not.toContain("EXAMPLE_INNER_BODY");
    });

    test("injects provenance comment for ATX headings with up to 3 leading spaces (CommonMark §4.2)", async () => {
      // Codex-flagged regression (PR #3244): CommonMark §4.2 lets ATX
      // headings start with 1–3 spaces of indentation and still be parsed
      // as headings. markdown-it (and therefore extractToolSection /
      // stripScopedInstructionSections) recognizes these as scoped
      // sections, so the scanner here must too — otherwise the indented
      // heading's body would survive into the per-tool prompt without the
      // path-source comment, defeating the provenance hint for any
      // AGENTS.md authored with that style.
      const { subProjectMetadata, parentRoot, subProjectCwd } = await setupSubProjectFixture();

      const parentAgents = [
        "Parent narrative.",
        "",
        "  ## Tool: bash",
        "INDENTED_BASH_RULE: parent's indented bash convention.",
        "",
        "   ## Model: anthropic:claude-sonnet-4-20250514",
        "INDENTED_MODEL_RULE: parent's indented model preference.",
        "",
      ].join("\n");

      await fs.writeFile(path.join(parentRoot, "AGENTS.md"), parentAgents);

      const modelString = "anthropic:claude-sonnet-4-20250514";
      const toolInstructions = await readToolInstructions(
        subProjectMetadata,
        runtime,
        subProjectCwd,
        modelString
      );
      const bash = toolInstructions.bash ?? "";
      expect(bash).toContain("INDENTED_BASH_RULE");
      expect(bash).toContain("<!-- ../../AGENTS.md -->");
      expect(bash.indexOf("<!-- ../../AGENTS.md -->")).toBeLessThan(
        bash.indexOf("INDENTED_BASH_RULE")
      );

      const systemMessage = await buildSystemMessage(
        subProjectMetadata,
        runtime,
        subProjectCwd,
        undefined,
        modelString
      );
      const sonnetSection =
        extractTagContent(systemMessage, "model-anthropic-claude-sonnet-4-20250514") ?? "";
      expect(sonnetSection).toContain("INDENTED_MODEL_RULE");
      expect(sonnetSection).toContain("<!-- ../../AGENTS.md -->");
      expect(sonnetSection.indexOf("<!-- ../../AGENTS.md -->")).toBeLessThan(
        sonnetSection.indexOf("INDENTED_MODEL_RULE")
      );
    });

    test("falls back to cwd-only AGENTS.md when sub-project metadata is stale", async () => {
      // If subProjectPath doesn't sit under projectPath (corrupted persisted
      // state, or a cwd that doesn't end with the expected suffix), we
      // can't safely derive the parent root. Degrade to reading just the
      // cwd's AGENTS.md — historical behavior — with no path-source comment
      // since there's only one source.
      const { subProjectMetadata, subProjectCwd, parentRoot } = await setupSubProjectFixture();
      const stale = { ...subProjectMetadata, subProjectPath: "/elsewhere/api" };

      await fs.writeFile(
        path.join(parentRoot, "AGENTS.md"),
        "PARENT_MARKER: should not be inherited from stale metadata.\n"
      );
      await fs.writeFile(
        path.join(subProjectCwd, "AGENTS.md"),
        "SUB_MARKER: should still appear.\n"
      );

      const systemMessage = await buildSystemMessage(stale, runtime, subProjectCwd);
      const customInstructions = extractTagContent(systemMessage, "custom-instructions") ?? "";

      expect(customInstructions).not.toContain("PARENT_MARKER");
      expect(customInstructions).toContain("SUB_MARKER");
      expect(customInstructions).not.toContain("# `");
      expect(customInstructions).not.toContain("<!--");
    });
  });
});
