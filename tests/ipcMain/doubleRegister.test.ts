import { shouldRunIntegrationTests, createTestEnvironment, cleanupTestEnvironment } from "./setup";
import { IPC_CHANNELS } from "../../src/common/constants/ipc-constants";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

describeIntegration("IpcMain double registration", () => {
  test.concurrent(
    "should not throw when register() is called multiple times",
    async () => {
      const env = await createTestEnvironment();

      try {
        // First register() already happened in createTestEnvironment()
        // Second call simulates window recreation (e.g., macOS activate event)
        expect(() => {
          env.ipcMain.register(env.mockIpcMain, env.mockWindow);
        }).not.toThrow();

        // Verify handlers still work after second registration
        const projectsList = await env.mockIpcRenderer.invoke(IPC_CHANNELS.PROJECT_LIST);
        expect(projectsList).toBeDefined();
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
            env.ipcMain.register(env.mockIpcMain, env.mockWindow);
          }).not.toThrow();
        }

        // Verify handlers still work
        const projectsList = await env.mockIpcRenderer.invoke(IPC_CHANNELS.PROJECT_LIST);
        expect(projectsList).toBeDefined();
        expect(Array.isArray(projectsList)).toBe(true);

        const listResult = await env.mockIpcRenderer.invoke(IPC_CHANNELS.WORKSPACE_LIST);
        expect(Array.isArray(listResult)).toBe(true);
      } finally {
        await cleanupTestEnvironment(env);
      }
    },
    10000
  );
});
