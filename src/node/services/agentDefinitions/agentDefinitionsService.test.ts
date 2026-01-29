import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import { AgentIdSchema } from "@/common/orpc/schemas";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { DisposableTempDir } from "@/node/services/tempDir";
import { getBuiltInAgentDefinitions } from "./builtInAgentDefinitions";
import {
  discoverAgentDefinitions,
  readAgentDefinition,
  resolveAgentBody,
  resolveAgentFrontmatter,
} from "./agentDefinitionsService";

async function writeAgent(root: string, id: string, name: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  const content = `---
name: ${name}
policy:
  base: exec
---
Body
`;
  await fs.writeFile(path.join(root, `${id}.md`), content, "utf-8");
}

describe("agentDefinitionsService", () => {
  test("project agents override global agents", async () => {
    using project = new DisposableTempDir("agent-defs-project");
    using global = new DisposableTempDir("agent-defs-global");

    const projectAgentsRoot = path.join(project.path, ".mux", "agents");
    const globalAgentsRoot = global.path;

    await writeAgent(globalAgentsRoot, "foo", "Foo (global)");
    await writeAgent(projectAgentsRoot, "foo", "Foo (project)");
    await writeAgent(globalAgentsRoot, "bar", "Bar (global)");

    const roots = { projectRoot: projectAgentsRoot, globalRoot: globalAgentsRoot };
    const runtime = new LocalRuntime(project.path);

    const agents = await discoverAgentDefinitions(runtime, project.path, { roots });

    const foo = agents.find((a) => a.id === "foo");
    expect(foo).toBeDefined();
    expect(foo!.scope).toBe("project");
    expect(foo!.name).toBe("Foo (project)");

    const bar = agents.find((a) => a.id === "bar");
    expect(bar).toBeDefined();
    expect(bar!.scope).toBe("global");
  });

  test("readAgentDefinition resolves project before global", async () => {
    using project = new DisposableTempDir("agent-defs-project");
    using global = new DisposableTempDir("agent-defs-global");

    const projectAgentsRoot = path.join(project.path, ".mux", "agents");
    const globalAgentsRoot = global.path;

    await writeAgent(globalAgentsRoot, "foo", "Foo (global)");
    await writeAgent(projectAgentsRoot, "foo", "Foo (project)");

    const roots = { projectRoot: projectAgentsRoot, globalRoot: globalAgentsRoot };
    const runtime = new LocalRuntime(project.path);

    const agentId = AgentIdSchema.parse("foo");
    const pkg = await readAgentDefinition(runtime, project.path, agentId, { roots });

    expect(pkg.scope).toBe("project");
    expect(pkg.frontmatter.name).toBe("Foo (project)");
  });

  test("resolveAgentBody appends by default (new default), replaces when prompt.append is false", async () => {
    using tempDir = new DisposableTempDir("agent-body-test");
    const agentsRoot = path.join(tempDir.path, ".mux", "agents");
    await fs.mkdir(agentsRoot, { recursive: true });

    // Create base agent
    await fs.writeFile(
      path.join(agentsRoot, "base.md"),
      `---
name: Base
tools:
  add:
    - .*
---
Base instructions.
`,
      "utf-8"
    );

    // Create child agent that appends (default behavior)
    await fs.writeFile(
      path.join(agentsRoot, "child.md"),
      `---
name: Child
base: base
---
Child additions.
`,
      "utf-8"
    );

    // Create another child that explicitly replaces
    await fs.writeFile(
      path.join(agentsRoot, "replacer.md"),
      `---
name: Replacer
base: base
prompt:
  append: false
---
Replaced body.
`,
      "utf-8"
    );

    const roots = { projectRoot: agentsRoot, globalRoot: agentsRoot };
    const runtime = new LocalRuntime(tempDir.path);

    // Child without explicit prompt settings should append (new default)
    const childBody = await resolveAgentBody(runtime, tempDir.path, "child", { roots });
    expect(childBody).toContain("Base instructions.");
    expect(childBody).toContain("Child additions.");

    // Child with prompt.append: false should replace (explicit opt-out)
    const replacerBody = await resolveAgentBody(runtime, tempDir.path, "replacer", { roots });
    expect(replacerBody).toBe("Replaced body.\n");
    expect(replacerBody).not.toContain("Base instructions");
  });

  test("Ask agent instructs to trust Explore sub-agent reports", () => {
    const ask = getBuiltInAgentDefinitions().find((a) => a.id === "ask");
    expect(ask).toBeDefined();
    expect(ask!.frontmatter.ui?.color).toBe("var(--color-ask-mode)");

    expect(ask!.body).toContain("Trust Explore sub-agent reports as authoritative for repo facts");
    expect(ask!.body).toContain("ambiguous or contradicts other evidence");
  });

  test("same-name override: project agent with base: self extends built-in/global, not itself", async () => {
    using project = new DisposableTempDir("agent-same-name");
    using global = new DisposableTempDir("agent-same-name-global");

    const projectAgentsRoot = path.join(project.path, ".mux", "agents");
    const globalAgentsRoot = global.path;

    await fs.mkdir(projectAgentsRoot, { recursive: true });
    await fs.mkdir(globalAgentsRoot, { recursive: true });

    // Global "foo" agent (simulates built-in or global config)
    await fs.writeFile(
      path.join(globalAgentsRoot, "foo.md"),
      `---
name: Foo
tools:
  add:
    - .*
---
Global foo instructions.
`,
      "utf-8"
    );

    // Project-local "foo" agent that extends the global one via base: foo
    // This should NOT cause a circular dependency (would previously infinite loop)
    await fs.writeFile(
      path.join(projectAgentsRoot, "foo.md"),
      `---
name: Foo
base: foo
---
Project-specific additions.
`,
      "utf-8"
    );

    const roots = { projectRoot: projectAgentsRoot, globalRoot: globalAgentsRoot };
    const runtime = new LocalRuntime(project.path);

    // Verify project agent is discovered
    const agents = await discoverAgentDefinitions(runtime, project.path, { roots });
    const foo = agents.find((a) => a.id === "foo");
    expect(foo).toBeDefined();
    expect(foo!.scope).toBe("project");
    expect(foo!.base).toBe("foo"); // Points to itself by name

    // Verify body resolution correctly inherits from global (not self)
    const body = await resolveAgentBody(runtime, project.path, "foo", { roots });
    expect(body).toContain("Global foo instructions.");
    expect(body).toContain("Project-specific additions.");
  });

  test("readAgentDefinition with skipScopesAbove skips higher-priority scopes", async () => {
    using project = new DisposableTempDir("agent-skip-scope");
    using global = new DisposableTempDir("agent-skip-scope-global");

    const projectAgentsRoot = path.join(project.path, ".mux", "agents");
    const globalAgentsRoot = global.path;

    await fs.mkdir(projectAgentsRoot, { recursive: true });
    await fs.mkdir(globalAgentsRoot, { recursive: true });

    await fs.writeFile(
      path.join(globalAgentsRoot, "test.md"),
      `---
name: Test Global
---
Global body.
`,
      "utf-8"
    );

    await fs.writeFile(
      path.join(projectAgentsRoot, "test.md"),
      `---
name: Test Project
---
Project body.
`,
      "utf-8"
    );

    const roots = { projectRoot: projectAgentsRoot, globalRoot: globalAgentsRoot };
    const runtime = new LocalRuntime(project.path);

    // Without skip: project takes precedence
    const normalPkg = await readAgentDefinition(runtime, project.path, "test", { roots });
    expect(normalPkg.scope).toBe("project");
    expect(normalPkg.frontmatter.name).toBe("Test Project");

    // With skipScopesAbove: "project" → skip project, return global
    const skippedPkg = await readAgentDefinition(runtime, project.path, "test", {
      roots,
      skipScopesAbove: "project",
    });
    expect(skippedPkg.scope).toBe("global");
    expect(skippedPkg.frontmatter.name).toBe("Test Global");
  });

  test("resolveAgentFrontmatter inherits omitted fields from base chain (same-name override)", async () => {
    using project = new DisposableTempDir("agent-frontmatter-project");
    using global = new DisposableTempDir("agent-frontmatter-global");

    const projectAgentsRoot = path.join(project.path, ".mux", "agents");
    const globalAgentsRoot = global.path;

    await fs.mkdir(projectAgentsRoot, { recursive: true });
    await fs.mkdir(globalAgentsRoot, { recursive: true });

    await fs.writeFile(
      path.join(globalAgentsRoot, "foo.md"),
      `---
name: Foo Base
description: Base description
ui:
  hidden: true
  color: red
  requires:
    - plan
subagent:
  runnable: true
  append_prompt: Base subagent prompt
  skip_init_hook: true
ai:
  model: base-model
  thinkingLevel: high
tools:
  add:
    - baseAdd
  remove:
    - baseRemove
---
Base body.
`,
      "utf-8"
    );

    await fs.writeFile(
      path.join(projectAgentsRoot, "foo.md"),
      `---
name: Foo Project
base: foo
ui:
  color: blue
---
Project body.
`,
      "utf-8"
    );

    const roots = { projectRoot: projectAgentsRoot, globalRoot: globalAgentsRoot };
    const runtime = new LocalRuntime(project.path);

    const frontmatter = await resolveAgentFrontmatter(runtime, project.path, "foo", { roots });

    expect(frontmatter.description).toBe("Base description");
    expect(frontmatter.ui?.hidden).toBe(true);
    expect(frontmatter.ui?.color).toBe("blue");
    expect(frontmatter.ui?.requires).toEqual(["plan"]);
    expect(frontmatter.subagent?.runnable).toBe(true);
    expect(frontmatter.subagent?.append_prompt).toBe("Base subagent prompt");
    expect(frontmatter.subagent?.skip_init_hook).toBe(true);
    expect(frontmatter.ai?.model).toBe("base-model");
    expect(frontmatter.ai?.thinkingLevel).toBe("high");
    expect(frontmatter.tools?.add).toEqual(["baseAdd"]);
    expect(frontmatter.tools?.remove).toEqual(["baseRemove"]);
  });

  test("resolveAgentFrontmatter preserves explicit falsy overrides", async () => {
    using tempDir = new DisposableTempDir("agent-frontmatter-falsy");
    const agentsRoot = path.join(tempDir.path, ".mux", "agents");
    await fs.mkdir(agentsRoot, { recursive: true });

    await fs.writeFile(
      path.join(agentsRoot, "base.md"),
      `---
name: Base
ui:
  hidden: true
subagent:
  runnable: true
  skip_init_hook: true
---
`,
      "utf-8"
    );

    await fs.writeFile(
      path.join(agentsRoot, "child.md"),
      `---
name: Child
base: base
ui:
  hidden: false
subagent:
  runnable: false
  skip_init_hook: false
---
`,
      "utf-8"
    );

    const roots = { projectRoot: agentsRoot, globalRoot: agentsRoot };
    const runtime = new LocalRuntime(tempDir.path);

    const frontmatter = await resolveAgentFrontmatter(runtime, tempDir.path, "child", { roots });

    expect(frontmatter.ui?.hidden).toBe(false);
    expect(frontmatter.subagent?.runnable).toBe(false);
    expect(frontmatter.subagent?.skip_init_hook).toBe(false);
  });

  test("resolveAgentFrontmatter concatenates tools.add/tools.remove (base first)", async () => {
    using tempDir = new DisposableTempDir("agent-frontmatter-tools");
    const agentsRoot = path.join(tempDir.path, ".mux", "agents");
    await fs.mkdir(agentsRoot, { recursive: true });

    await fs.writeFile(
      path.join(agentsRoot, "base.md"),
      `---
name: Base
tools:
  add:
    - a
  remove:
    - b
---
`,
      "utf-8"
    );

    await fs.writeFile(
      path.join(agentsRoot, "child.md"),
      `---
name: Child
base: base
tools:
  add:
    - c
  remove:
    - d
---
`,
      "utf-8"
    );

    const roots = { projectRoot: agentsRoot, globalRoot: agentsRoot };
    const runtime = new LocalRuntime(tempDir.path);

    const frontmatter = await resolveAgentFrontmatter(runtime, tempDir.path, "child", { roots });

    expect(frontmatter.tools?.add).toEqual(["a", "c"]);
    expect(frontmatter.tools?.remove).toEqual(["b", "d"]);
  });

  test("resolveAgentFrontmatter detects cycles", async () => {
    using tempDir = new DisposableTempDir("agent-frontmatter-cycle");
    const agentsRoot = path.join(tempDir.path, ".mux", "agents");
    await fs.mkdir(agentsRoot, { recursive: true });

    await fs.writeFile(
      path.join(agentsRoot, "a.md"),
      `---
name: A
base: b
---
`,
      "utf-8"
    );

    await fs.writeFile(
      path.join(agentsRoot, "b.md"),
      `---
name: B
base: a
---
`,
      "utf-8"
    );

    const roots = { projectRoot: agentsRoot, globalRoot: agentsRoot };
    const runtime = new LocalRuntime(tempDir.path);

    expect(resolveAgentFrontmatter(runtime, tempDir.path, "a", { roots })).rejects.toThrow(
      "Circular agent inheritance detected"
    );
  });
});
