import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { DisposableTempDir } from "@/node/services/tempDir";

import {
  ADVISOR_SCAFFOLD_TEMPLATE,
  discoverAdvisors,
  discoverAdvisorsDiagnostics,
  filterAdvisorsForAgent,
  scaffoldProjectAdvisor,
  toAdvisorDescriptor,
} from "./advisorsService";

const MODEL = "anthropic:claude-opus-4-5";

async function writeAdvisor(
  root: string,
  name: string,
  options: { description?: string; model?: string; body?: string; extraFrontmatter?: string } = {}
): Promise<void> {
  const advisorDir = path.join(root, name);
  await fs.mkdir(advisorDir, { recursive: true });
  const description = options.description ?? `Use for ${name}.`;
  const model = options.model ?? MODEL;
  const extras = options.extraFrontmatter ? `\n${options.extraFrontmatter}` : "";
  const body = options.body ?? "";
  const content = `---\ndescription: ${description}\nmodel: ${model}${extras}\n---\n${body}`;
  await fs.writeFile(path.join(advisorDir, "ADVISOR.md"), content, "utf-8");
}

describe("advisorsService", () => {
  test("returns an empty list when no advisor directories exist", async () => {
    using tempDir = new DisposableTempDir("advisors-empty");
    const projectPath = path.join(tempDir.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const advisors = await discoverAdvisors(new LocalRuntime(projectPath), projectPath, {
      roots: {
        projectRoot: path.join(projectPath, ".mux", "advisors"),
        globalRoot: path.join(tempDir.path, "global-empty"),
      },
    });
    expect(advisors).toEqual([]);
  });

  test("project advisor overrides global advisor with the same name", async () => {
    using project = new DisposableTempDir("advisors-project");
    using global = new DisposableTempDir("advisors-global");

    const projectRoot = path.join(project.path, ".mux", "advisors");
    const globalRoot = global.path;

    await writeAdvisor(globalRoot, "foo", { description: "from global" });
    await writeAdvisor(projectRoot, "foo", { description: "from project" });

    const advisors = await discoverAdvisors(new LocalRuntime(project.path), project.path, {
      roots: { projectRoot, globalRoot },
    });

    expect(advisors).toHaveLength(1);
    expect(advisors[0].scope).toBe("project");
    expect(advisors[0].frontmatter.description).toBe("from project");
  });

  test("includes both project and global advisors when names differ", async () => {
    using project = new DisposableTempDir("advisors-mixed-project");
    using global = new DisposableTempDir("advisors-mixed-global");

    const projectRoot = path.join(project.path, ".mux", "advisors");
    const globalRoot = global.path;

    await writeAdvisor(projectRoot, "code-review");
    await writeAdvisor(globalRoot, "ml-fellow");

    const advisors = await discoverAdvisors(new LocalRuntime(project.path), project.path, {
      roots: { projectRoot, globalRoot },
    });

    const names = advisors.map((a) => a.directoryName).sort();
    expect(names).toEqual(["code-review", "ml-fellow"]);
    const scopes = Object.fromEntries(advisors.map((a) => [a.directoryName, a.scope]));
    expect(scopes["code-review"]).toBe("project");
    expect(scopes["ml-fellow"]).toBe("global");
  });

  test("malformed ADVISOR.md surfaces in diagnostics without crashing the list", async () => {
    using project = new DisposableTempDir("advisors-diagnostics");
    const projectRoot = path.join(project.path, ".mux", "advisors");

    // valid sibling so we can confirm the list keeps going
    await writeAdvisor(projectRoot, "good");

    // bad: missing required `model` field
    const badDir = path.join(projectRoot, "bad");
    await fs.mkdir(badDir, { recursive: true });
    await fs.writeFile(
      path.join(badDir, "ADVISOR.md"),
      "---\ndescription: Missing model.\n---\n",
      "utf-8"
    );

    const { advisors, invalidAdvisors } = await discoverAdvisorsDiagnostics(
      new LocalRuntime(project.path),
      project.path,
      {
        roots: { projectRoot, globalRoot: path.join(project.path, "no-such-global") },
      }
    );

    expect(advisors.map((a) => a.directoryName)).toEqual(["good"]);
    expect(invalidAdvisors).toHaveLength(1);
    expect(invalidAdvisors[0].directoryName).toBe("bad");
    expect(invalidAdvisors[0].message).toMatch(/model/i);
  });

  test("skips directory names that don't match the AdvisorName regex", async () => {
    using project = new DisposableTempDir("advisors-bad-name");
    const projectRoot = path.join(project.path, ".mux", "advisors");

    await writeAdvisor(projectRoot, "good");
    // Uppercase / underscore is not allowed — should be flagged but not loaded.
    const badDir = path.join(projectRoot, "Bad_Name");
    await fs.mkdir(badDir, { recursive: true });
    await fs.writeFile(
      path.join(badDir, "ADVISOR.md"),
      `---\ndescription: x\nmodel: ${MODEL}\n---\n`,
      "utf-8"
    );

    const { advisors, invalidAdvisors } = await discoverAdvisorsDiagnostics(
      new LocalRuntime(project.path),
      project.path,
      {
        roots: { projectRoot, globalRoot: path.join(project.path, "no-such-global") },
      }
    );

    expect(advisors.map((a) => a.directoryName)).toEqual(["good"]);
    expect(invalidAdvisors.map((i) => i.directoryName)).toContain("Bad_Name");
  });

  test("filterAdvisorsForAgent gates by the agents frontmatter field", async () => {
    using project = new DisposableTempDir("advisors-agent-filter");
    const projectRoot = path.join(project.path, ".mux", "advisors");

    await writeAdvisor(projectRoot, "everyone");
    await writeAdvisor(projectRoot, "exec-only", { extraFrontmatter: "agents: [exec]" });
    await writeAdvisor(projectRoot, "plan-only", { extraFrontmatter: "agents: [plan]" });

    const advisors = await discoverAdvisors(new LocalRuntime(project.path), project.path, {
      roots: { projectRoot, globalRoot: path.join(project.path, "no-such-global") },
    });

    const execVisible = filterAdvisorsForAgent(advisors, "exec").map((a) => a.directoryName);
    const planVisible = filterAdvisorsForAgent(advisors, "plan").map((a) => a.directoryName);

    expect(execVisible.sort()).toEqual(["everyone", "exec-only"]);
    expect(planVisible.sort()).toEqual(["everyone", "plan-only"]);
  });

  test("toAdvisorDescriptor strips the body and exposes frontmatter knobs", async () => {
    using project = new DisposableTempDir("advisors-descriptor");
    const projectRoot = path.join(project.path, ".mux", "advisors");
    await writeAdvisor(projectRoot, "code-review", {
      description: "PR review specialist.",
      body: "Should not appear in descriptor.",
      extraFrontmatter: "thinking: high\nagents: [exec]",
    });

    const advisors = await discoverAdvisors(new LocalRuntime(project.path), project.path, {
      roots: { projectRoot, globalRoot: path.join(project.path, "no-such-global") },
    });
    expect(advisors).toHaveLength(1);

    const descriptor = toAdvisorDescriptor(advisors[0]);
    expect(descriptor).toMatchObject({
      name: "code-review",
      description: "PR review specialist.",
      scope: "project",
      model: MODEL,
      thinking: "high",
      agents: ["exec"],
    });
    expect((descriptor as { body?: string }).body).toBeUndefined();
  });

  test("scaffoldProjectAdvisor writes the template and refuses to overwrite", async () => {
    using project = new DisposableTempDir("advisors-scaffold");
    const projectPath = project.path;
    const runtime = new LocalRuntime(projectPath);

    const first = await scaffoldProjectAdvisor(runtime, projectPath, "ml-fellow");
    expect(first.sourcePath).toContain(path.join(".mux", "advisors", "ml-fellow", "ADVISOR.md"));
    const content = await fs.readFile(first.sourcePath, "utf-8");
    expect(content).toBe(ADVISOR_SCAFFOLD_TEMPLATE);

    let secondError: Error | null = null;
    try {
      await scaffoldProjectAdvisor(runtime, projectPath, "ml-fellow");
    } catch (err) {
      secondError = err as Error;
    }
    expect(secondError).not.toBeNull();
    expect(secondError?.message).toMatch(/refusing to overwrite/i);
  });

  test("scaffoldProjectAdvisor rejects invalid advisor names", async () => {
    using project = new DisposableTempDir("advisors-scaffold-bad-name");
    const runtime = new LocalRuntime(project.path);

    let error: Error | null = null;
    try {
      await scaffoldProjectAdvisor(runtime, project.path, "Bad_Name");
    } catch (err) {
      error = err as Error;
    }
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/Invalid advisor name/);
  });
});
