/**
 * Background bash tool stories - covers all background process UI states
 */

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import {
  STABLE_TIMESTAMP,
  createUserMessage,
  createAssistantMessage,
  createBashTool,
  createBackgroundBashTool,
  createBashOutputTool,
  createBashOutputErrorTool,
  createBashBackgroundListTool,
  createBashBackgroundTerminateTool,
} from "./mockFactory";
import { setupSimpleChatStory } from "./storyHelpers";

export default {
  ...appMeta,
  title: "App/Background Bash",
};

/** Background process spawn and output retrieval flow */
export const SpawnAndOutput: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            createUserMessage("msg-1", "Run the dev server in the background", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 300000,
            }),
            createAssistantMessage(
              "msg-2",
              "I'll start the dev server in the background so it keeps running.",
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 290000,
                toolCalls: [
                  createBackgroundBashTool(
                    "call-1",
                    "npm run dev",
                    "bash_1",
                    "Dev Server"
                  ),
                ],
              }
            ),
            createUserMessage("msg-3", "Check if it's running", {
              historySequence: 3,
              timestamp: STABLE_TIMESTAMP - 280000,
            }),
            createAssistantMessage("msg-4", "Let me check the dev server output.", {
              historySequence: 4,
              timestamp: STABLE_TIMESTAMP - 270000,
              toolCalls: [
                createBashOutputTool(
                  "call-2",
                  "bash_1",
                  "  VITE v5.0.0  ready in 320 ms\n\n  ➜  Local:   http://localhost:5173/\n  ➜  Network: use --host to expose",
                  "running"
                ),
              ],
            }),
          ],
        })
      }
    />
  ),
};

/** Process that exits successfully */
export const ProcessExitedSuccess: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            createUserMessage("msg-1", "Run the build in background", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 200000,
            }),
            createAssistantMessage("msg-2", "Starting the build process.", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 190000,
              toolCalls: [
                createBackgroundBashTool("call-1", "npm run build", "bash_2"),
              ],
            }),
            createUserMessage("msg-3", "Check the build status", {
              historySequence: 3,
              timestamp: STABLE_TIMESTAMP - 100000,
            }),
            createAssistantMessage("msg-4", "The build completed successfully.", {
              historySequence: 4,
              timestamp: STABLE_TIMESTAMP - 90000,
              toolCalls: [
                createBashOutputTool(
                  "call-2",
                  "bash_2",
                  "vite v5.0.0 building for production...\n✓ 1423 modules transformed.\ndist/index.html                  0.46 kB │ gzip:  0.30 kB\ndist/assets/index-DiwrgTda.css  15.23 kB │ gzip:  3.45 kB\ndist/assets/index-BqeWHuN2.js  142.67 kB │ gzip: 45.23 kB\n✓ built in 2.34s",
                  "exited",
                  0
                ),
              ],
            }),
          ],
        })
      }
    />
  ),
};

/** Process that exits with error */
export const ProcessExitedError: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            createUserMessage("msg-1", "Run the tests in background", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 200000,
            }),
            createAssistantMessage("msg-2", "Running tests in background.", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 190000,
              toolCalls: [createBackgroundBashTool("call-1", "npm test", "bash_3")],
            }),
            createUserMessage("msg-3", "How did the tests go?", {
              historySequence: 3,
              timestamp: STABLE_TIMESTAMP - 100000,
            }),
            createAssistantMessage("msg-4", "The tests failed with some errors.", {
              historySequence: 4,
              timestamp: STABLE_TIMESTAMP - 90000,
              toolCalls: [
                createBashOutputTool(
                  "call-2",
                  "bash_3",
                  "FAIL src/utils.test.ts\n  ✕ should parse dates correctly (5 ms)\n  ✕ should handle edge cases (3 ms)\n\nTest Suites: 1 failed, 1 total\nTests:       2 failed, 2 total",
                  "exited",
                  1
                ),
              ],
            }),
          ],
        })
      }
    />
  ),
};

/** Process not found error */
export const ProcessNotFound: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            createUserMessage("msg-1", "Check bash_99", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 100000,
            }),
            createAssistantMessage("msg-2", "Let me check that process.", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 90000,
              toolCalls: [
                createBashOutputErrorTool("call-1", "bash_99", "Process not found: bash_99"),
              ],
            }),
          ],
        })
      }
    />
  ),
};

/** Output with filter applied */
export const FilteredOutput: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            createUserMessage("msg-1", "Show only error lines from the server", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 100000,
            }),
            createAssistantMessage("msg-2", "Filtering for error lines.", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 90000,
              toolCalls: [
                createBashOutputTool(
                  "call-1",
                  "bash_1",
                  "[ERROR] Failed to connect to database\n[ERROR] Retry attempt 1 failed\n[ERROR] Retry attempt 2 failed",
                  "running",
                  undefined,
                  "ERROR"
                ),
              ],
            }),
          ],
        })
      }
    />
  ),
};

/** No new output available */
export const NoNewOutput: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            createUserMessage("msg-1", "Any new output?", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 100000,
            }),
            createAssistantMessage("msg-2", "No new output since last check.", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 90000,
              toolCalls: [createBashOutputTool("call-1", "bash_1", "", "running")],
            }),
          ],
        })
      }
    />
  ),
};

/** List multiple background processes */
export const ListProcesses: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            createUserMessage("msg-1", "List all background processes", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 100000,
            }),
            createAssistantMessage("msg-2", "Here are the running background processes.", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 90000,
              toolCalls: [
                createBashBackgroundListTool("call-1", [
                  {
                    process_id: "bash_1",
                    status: "running",
                    script: "npm run dev",
                    uptime_ms: 3600000,
                    display_name: "Dev Server",
                  },
                  {
                    process_id: "bash_2",
                    status: "running",
                    script: "npm run watch:tests",
                    uptime_ms: 1800000,
                  },
                  {
                    process_id: "bash_3",
                    status: "exited",
                    script: "npm run build",
                    uptime_ms: 120000,
                    exitCode: 0,
                  },
                  {
                    process_id: "bash_4",
                    status: "killed",
                    script: "npm run long-task",
                    uptime_ms: 45000,
                    exitCode: 143,
                  },
                ]),
              ],
            }),
          ],
        })
      }
    />
  ),
};

/** Terminate a background process */
export const TerminateProcess: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            createUserMessage("msg-1", "Stop the dev server", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 100000,
            }),
            createAssistantMessage("msg-2", "Terminating the dev server.", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 90000,
              toolCalls: [
                createBashBackgroundTerminateTool("call-1", "bash_1", "Dev Server"),
              ],
            }),
          ],
        })
      }
    />
  ),
};

/** Complete workflow: spawn, check, terminate */
export const CompleteWorkflow: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            createUserMessage("msg-1", "Start a long-running task", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 400000,
            }),
            createAssistantMessage("msg-2", "Starting the task in background.", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 390000,
              toolCalls: [
                createBackgroundBashTool(
                  "call-1",
                  "./scripts/process_data.sh",
                  "bash_5",
                  "Data Processing"
                ),
              ],
            }),
            createUserMessage("msg-3", "Check progress", {
              historySequence: 3,
              timestamp: STABLE_TIMESTAMP - 300000,
            }),
            createAssistantMessage("msg-4", "Here's the current progress.", {
              historySequence: 4,
              timestamp: STABLE_TIMESTAMP - 290000,
              toolCalls: [
                createBashOutputTool(
                  "call-2",
                  "bash_5",
                  "Processing file 1/100...\nProcessing file 2/100...\nProcessing file 3/100...",
                  "running"
                ),
              ],
            }),
            createUserMessage("msg-5", "What processes are running?", {
              historySequence: 5,
              timestamp: STABLE_TIMESTAMP - 200000,
            }),
            createAssistantMessage("msg-6", "Here's the list.", {
              historySequence: 6,
              timestamp: STABLE_TIMESTAMP - 190000,
              toolCalls: [
                createBashBackgroundListTool("call-3", [
                  {
                    process_id: "bash_5",
                    status: "running",
                    script: "./scripts/process_data.sh",
                    uptime_ms: 200000,
                    display_name: "Data Processing",
                  },
                ]),
              ],
            }),
            createUserMessage("msg-7", "Stop it, I found an issue", {
              historySequence: 7,
              timestamp: STABLE_TIMESTAMP - 100000,
            }),
            createAssistantMessage("msg-8", "Terminating the process.", {
              historySequence: 8,
              timestamp: STABLE_TIMESTAMP - 90000,
              toolCalls: [
                createBashBackgroundTerminateTool("call-4", "bash_5", "Data Processing"),
              ],
            }),
          ],
        })
      }
    />
  ),
};

/** Regular bash vs background bash comparison */
export const RegularVsBackground: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            createUserMessage("msg-1", "Run a quick command and a long one", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 200000,
            }),
            createAssistantMessage(
              "msg-2",
              "I'll run the quick one normally and the long one in background.",
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 190000,
                toolCalls: [
                  createBashTool("call-1", "echo 'Hello World'", "Hello World", 0, 3, 12),
                  createBackgroundBashTool(
                    "call-2",
                    "npm run build && npm run test",
                    "bash_6"
                  ),
                ],
              }
            ),
          ],
        })
      }
    />
  ),
};
