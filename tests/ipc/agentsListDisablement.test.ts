import * as fs from "fs/promises";
import * as path from "path";

import type { TestEnvironment } from "./setup";
import { cleanupTestEnvironment, createTestEnvironment } from "./setup";
import { cleanupTempGitRepo, createTempGitRepo } from "./helpers";

describe("agents.list disabled agents", () => {
  let env: TestEnvironment;
  let repoPath: string;

  beforeAll(async () => {
    env = await createTestEnvironment();
    repoPath = await createTempGitRepo();

    const agentsDir = path.join(repoPath, ".mux", "agents");
    await fs.mkdir(agentsDir, { recursive: true });

    await fs.writeFile(
      path.join(agentsDir, "experimental.md"),
      `---
name: Experimental
disabled: true
---
Experimental agent body.
`,
      "utf-8"
    );

    await fs.writeFile(
      path.join(agentsDir, "normal.md"),
      `---
name: Normal
---
Normal agent body.
`,
      "utf-8"
    );
  });

  afterAll(async () => {
    if (repoPath) {
      await cleanupTempGitRepo(repoPath);
    }
    if (env) {
      await cleanupTestEnvironment(env);
    }
  });

  it("omits disabled-by-frontmatter agents by default, but includes them with includeDisabled", async () => {
    const listDefault = await env.orpc.agents.list({ projectPath: repoPath });
    expect(listDefault.find((a) => a.id === "experimental")).toBeUndefined();
    expect(listDefault.find((a) => a.id === "normal")).toBeTruthy();

    const listWithDisabled = await env.orpc.agents.list({
      projectPath: repoPath,
      includeDisabled: true,
    });
    expect(listWithDisabled.find((a) => a.id === "experimental")).toBeTruthy();
    expect(listWithDisabled.find((a) => a.id === "normal")).toBeTruthy();
  });

  it("respects local enabled/disabled overrides", async () => {
    await env.orpc.config.updateAgentAiDefaults({
      agentAiDefaults: {
        experimental: { enabled: true },
        normal: { enabled: false },
        // Core agent: should remain visible even when explicitly disabled.
        exec: { enabled: false },
      },
    });

    const listDefault = await env.orpc.agents.list({ projectPath: repoPath });
    expect(listDefault.find((a) => a.id === "experimental")).toBeTruthy();
    expect(listDefault.find((a) => a.id === "normal")).toBeUndefined();
    expect(listDefault.find((a) => a.id === "exec")).toBeTruthy();

    const listWithDisabled = await env.orpc.agents.list({
      projectPath: repoPath,
      includeDisabled: true,
    });
    expect(listWithDisabled.find((a) => a.id === "experimental")).toBeTruthy();
    expect(listWithDisabled.find((a) => a.id === "normal")).toBeTruthy();
  });
});
