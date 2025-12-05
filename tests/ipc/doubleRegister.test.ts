import { shouldRunIntegrationTests, createTestEnvironment, cleanupTestEnvironment } from "./setup";
import { resolveOrpcClient } from "./helpers";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

describeIntegration("Service double registration", () => {
  test.concurrent(
    "should not throw when register() is called multiple times",
    async () => {
      const env = await createTestEnvironment();

      try {
        // First setMainWindow already happened in createTestEnvironment()
        // Second call simulates window recreation (e.g., macOS activate event)
        expect(() => {
          env.services.windowService.setMainWindow(env.mockWindow);
        }).not.toThrow();

        // Verify handlers still work after second registration using ORPC client
        const client = resolveOrpcClient(env);
        const projectsList = await client.projects.list();
        expect(Array.isArray(projectsList)).toBe(true);
      } finally {
        await cleanupTestEnvironment(env);
      }
    },
    10000
  );

  test.concurrent(
    "should allow multiple register() calls without errors",
    async () => {
      const env = await createTestEnvironment();

      try {
        // Multiple calls should be safe (window can be recreated on macOS)
        for (let i = 0; i < 3; i++) {
          expect(() => {
            env.services.windowService.setMainWindow(env.mockWindow);
          }).not.toThrow();
        }

        // Verify handlers still work via ORPC client
        const client = resolveOrpcClient(env);
        const projectsList = await client.projects.list();
        expect(Array.isArray(projectsList)).toBe(true);

        const workspaces = await client.workspace.list();
        expect(Array.isArray(workspaces)).toBe(true);
      } finally {
        await cleanupTestEnvironment(env);
      }
    },
    10000
  );
});
