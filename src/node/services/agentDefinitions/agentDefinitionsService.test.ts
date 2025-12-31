import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import { AgentIdSchema } from "@/common/orpc/schemas";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { DisposableTempDir } from "@/node/services/tempDir";
import {
  discoverAgentDefinitions,
  readAgentDefinition,
  resolveAgentBody,
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
});
