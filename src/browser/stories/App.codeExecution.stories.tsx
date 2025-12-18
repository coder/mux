/**
 * Code Execution (PTC) tool stories for UI iteration
 */

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import {
  STABLE_TIMESTAMP,
  createUserMessage,
  createAssistantMessage,
  createCodeExecutionTool,
  createPendingCodeExecutionTool,
} from "./mockFactory";
import { setupSimpleChatStory } from "./storyHelpers";

export default {
  ...appMeta,
  title: "App/CodeExecution",
};

const SAMPLE_CODE = `// Read a file and make an edit
const content = await mux.file_read({ filePath: "src/config.ts" });
console.log("Read file with", content.lines_read, "lines");

await mux.file_edit_replace_string({
  file_path: "src/config.ts",
  old_string: "debug: false",
  new_string: "debug: true"
});

await mux.bash({
  script: "echo 'Config updated!'",
  timeout_secs: 5,
  run_in_background: false,
  display_name: "Echo"
});

return "Done!";`;

/** Completed code execution with nested tools and console output */
export const Completed: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            createUserMessage("msg-1", "Update the config to enable debug mode", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 60000,
            }),
            createAssistantMessage("msg-2", "I'll update the config file to enable debug mode.", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 50000,
              toolCalls: [
                createCodeExecutionTool(
                  "call-1",
                  SAMPLE_CODE,
                  {
                    success: true,
                    result: "Done!",
                    toolCalls: [
                      {
                        toolName: "mux.file_read",
                        args: { filePath: "src/config.ts" },
                        result: { success: true, lines_read: 42 },
                        duration_ms: 15,
                      },
                      {
                        toolName: "mux.file_edit_replace_string",
                        args: {
                          file_path: "src/config.ts",
                          old_string: "debug: false",
                          new_string: "debug: true",
                        },
                        result: { success: true, edits_applied: 1 },
                        duration_ms: 23,
                      },
                      {
                        toolName: "mux.bash",
                        args: {
                          script: "echo 'Config updated!'",
                          timeout_secs: 5,
                          run_in_background: false,
                          display_name: "Echo",
                        },
                        result: { success: true, output: "Config updated!" },
                        duration_ms: 45,
                      },
                    ],
                    consoleOutput: [
                      {
                        level: "log",
                        args: ["Read file with", 42, "lines"],
                        timestamp: Date.now(),
                      },
                    ],
                    duration_ms: 150,
                  },
                  [
                    {
                      toolCallId: "nested-1",
                      toolName: "mux.file_read",
                      input: { filePath: "src/config.ts" },
                      output: {
                        success: true,
                        lines_read: 4,
                        file_size: 55,
                        content: "export const config = {\n  debug: false,\n  port: 3000\n};",
                      },
                      state: "output-available",
                    },
                    {
                      toolCallId: "nested-2",
                      toolName: "mux.file_edit_replace_string",
                      input: {
                        file_path: "src/config.ts",
                        old_string: "debug: false",
                        new_string: "debug: true",
                      },
                      output: {
                        success: true,
                        edits_applied: 1,
                        diff: [
                          "--- src/config.ts",
                          "+++ src/config.ts",
                          "@@ -1,4 +1,4 @@",
                          " export const config = {",
                          "-  debug: false,",
                          "+  debug: true,",
                          "   port: 3000",
                          " };",
                        ].join("\n"),
                      },
                      state: "output-available",
                    },
                    {
                      toolCallId: "nested-3",
                      toolName: "mux.bash",
                      input: {
                        script: "echo 'Config updated!'",
                        timeout_secs: 5,
                        run_in_background: false,
                        display_name: "Echo",
                      },
                      output: {
                        success: true,
                        output: "Config updated!",
                        exitCode: 0,
                        wall_duration_ms: 45,
                      },
                      state: "output-available",
                    },
                  ]
                ),
              ],
            }),
          ],
        })
      }
    />
  ),
};

/** Code execution in progress with some completed nested tools */
export const Executing: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            createUserMessage("msg-1", "Update the config to enable debug mode", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 60000,
            }),
            createAssistantMessage("msg-2", "I'll update the config file to enable debug mode.", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 50000,
              toolCalls: [
                createPendingCodeExecutionTool("call-1", SAMPLE_CODE, [
                  {
                    toolCallId: "nested-1",
                    toolName: "mux.file_read",
                    input: { filePath: "src/config.ts" },
                    output: {
                      success: true,
                      lines_read: 42,
                      content: "export const config = {...};",
                    },
                    state: "output-available",
                  },
                  {
                    toolCallId: "nested-2",
                    toolName: "mux.file_edit_replace_string",
                    input: {
                      file_path: "src/config.ts",
                      old_string: "debug: false",
                      new_string: "debug: true",
                    },
                    state: "input-available", // Still executing
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

/** Code execution with no nested tools yet (just started) */
export const JustStarted: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            createUserMessage("msg-1", "Update the config", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 60000,
            }),
            createAssistantMessage("msg-2", "I'll update the config.", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 50000,
              toolCalls: [createPendingCodeExecutionTool("call-1", SAMPLE_CODE, [])],
            }),
          ],
        })
      }
    />
  ),
};

/** Code execution that failed with an error */
export const Failed: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            createUserMessage("msg-1", "Run some code", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 60000,
            }),
            createAssistantMessage("msg-2", "I'll run that code.", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 50000,
              toolCalls: [
                createCodeExecutionTool(
                  "call-1",
                  `const result = await mux.bash({ script: "cat /nonexistent" });`,
                  {
                    success: false,
                    error: "Tool execution failed: file not found",
                    toolCalls: [
                      {
                        toolName: "mux.bash",
                        args: { script: "cat /nonexistent" },
                        error: "file not found",
                        duration_ms: 12,
                      },
                    ],
                    consoleOutput: [],
                    duration_ms: 50,
                  },
                  [
                    {
                      toolCallId: "nested-1",
                      toolName: "mux.bash",
                      input: {
                        script: "cat /nonexistent",
                        timeout_secs: 30,
                        run_in_background: false,
                        display_name: "Cat",
                      },
                      output: {
                        success: false,
                        error: "file not found",
                        exitCode: 1,
                        wall_duration_ms: 12,
                      },
                      state: "output-available",
                    },
                  ]
                ),
              ],
            }),
          ],
        })
      }
    />
  ),
};

/** Code execution returning JSON result (pretty-printed) */
export const WithJsonResult: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            createUserMessage("msg-1", "Get the user data", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 60000,
            }),
            createAssistantMessage("msg-2", "Fetching user data.", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 50000,
              toolCalls: [
                createCodeExecutionTool(
                  "call-1",
                  `const users = await mux.file_read({ filePath: "data/users.json" });
return JSON.parse(users.content);`,
                  {
                    success: true,
                    result: {
                      users: [
                        { id: 1, name: "Alice", email: "alice@example.com", role: "admin" },
                        { id: 2, name: "Bob", email: "bob@example.com", role: "user" },
                        { id: 3, name: "Charlie", email: "charlie@example.com", role: "user" },
                      ],
                      total: 3,
                      page: 1,
                      hasMore: false,
                    },
                    toolCalls: [],
                    consoleOutput: [],
                    duration_ms: 25,
                  },
                  []
                ),
              ],
            }),
          ],
        })
      }
    />
  ),
};

/** Code execution with lots of console output */
export const WithConsoleOutput: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            createUserMessage("msg-1", "Run the script", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 60000,
            }),
            createAssistantMessage("msg-2", "Running the script now.", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 50000,
              toolCalls: [
                createCodeExecutionTool(
                  "call-1",
                  `console.log("Starting...");
console.log("Processing items:", [1, 2, 3]);
console.warn("This might take a while");
console.error("Something went wrong but we recovered");
console.log("Done!");`,
                  {
                    success: true,
                    result: undefined,
                    toolCalls: [],
                    consoleOutput: [
                      { level: "log", args: ["Starting..."], timestamp: Date.now() - 100 },
                      {
                        level: "log",
                        args: ["Processing items:", [1, 2, 3]],
                        timestamp: Date.now() - 80,
                      },
                      {
                        level: "warn",
                        args: ["This might take a while"],
                        timestamp: Date.now() - 60,
                      },
                      {
                        level: "error",
                        args: ["Something went wrong but we recovered"],
                        timestamp: Date.now() - 40,
                      },
                      { level: "log", args: ["Done!"], timestamp: Date.now() },
                    ],
                    duration_ms: 100,
                  },
                  []
                ),
              ],
            }),
          ],
        })
      }
    />
  ),
};
