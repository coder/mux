import { shouldRunIntegrationTests, createTestEnvironment, cleanupTestEnvironment } from "./setup";
import { IPC_CHANNELS } from "../../src/common/constants/ipc-constants";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

describeIntegration("Window title IPC", () => {
  test.concurrent(
    "should update window title via IPC",
    async () => {
      const env = await createTestEnvironment();

      try {
        // Initial title should be set
        expect(env.mockWindow.setTitle).toBeDefined();

        // Call setTitle via IPC
        await env.mockIpcRenderer.invoke(
          IPC_CHANNELS.WINDOW_SET_TITLE,
          "test-workspace - test-project - mux"
        );

        // Verify setTitle was called on the window
        expect(env.mockWindow.setTitle).toHaveBeenCalledWith("test-workspace - test-project - mux");
      } finally {
        await cleanupTestEnvironment(env);
      }
    },
    10000
  );

  test.concurrent(
    "should handle empty/default title",
    async () => {
      const env = await createTestEnvironment();

      try {
        // Set to default title
        await env.mockIpcRenderer.invoke(IPC_CHANNELS.WINDOW_SET_TITLE, "mux");

        // Verify setTitle was called with default
        expect(env.mockWindow.setTitle).toHaveBeenCalledWith("mux");
      } finally {
        await cleanupTestEnvironment(env);
      }
    },
    10000
  );
});
