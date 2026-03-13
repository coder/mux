import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { shouldRunIntegrationTests, createTestEnvironment, cleanupTestEnvironment } from "../setup";
import { resolveOrpcClient } from "../helpers";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

describeIntegration("projects.setDisplayName IPC handler", () => {
  test.concurrent("sets and clears project display names", async () => {
    const env = await createTestEnvironment();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-project-display-name-test-"));
    const projectPath = path.join(tempDir, "test-project");
    const client = resolveOrpcClient(env);

    await fs.mkdir(projectPath, { recursive: true });

    try {
      await client.projects.setDisplayName({
        projectPath: `${projectPath}${path.sep}`,
        displayName: "My Display Name",
      });

      let projects = await client.projects.list();
      let projectEntry = projects.find((project) => project[0] === projectPath);

      expect(projectEntry).toBeDefined();
      expect(projectEntry?.[1].displayName).toBe("My Display Name");

      await client.projects.setDisplayName({
        projectPath,
        displayName: null,
      });

      projects = await client.projects.list();
      projectEntry = projects.find((project) => project[0] === projectPath);

      expect(projectEntry).toBeDefined();
      expect(projectEntry?.[1].displayName).toBeUndefined();
    } finally {
      await cleanupTestEnvironment(env);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
