import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import { AgentIdSchema } from "@/common/orpc/schemas";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { DisposableTempDir } from "@/node/services/tempDir";
import { discoverAgentDefinitions, readAgentDefinition } from "./agentDefinitionsService";

async function writeAgent(root: string, id: string, name: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  const content = `---
name: ${name}
ui:
  selectable: true
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
});
