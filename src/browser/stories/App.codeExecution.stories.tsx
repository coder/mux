/**
 * Storybook stories for code_execution tool UI states.
 *
 * These stories intentionally render the tool card directly via lightweightMeta
 * so UI iteration stays focused on tool behavior without full app bootstrapping.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { within } from "@storybook/test";
import type { ComponentProps } from "react";
import { BackgroundBashProvider } from "@/browser/contexts/BackgroundBashContext";
import { CodeExecutionToolCall as CodeExecutionToolCallCard } from "@/browser/features/Tools/CodeExecutionToolCall";
import type {
  CodeExecutionResult,
  NestedToolCall,
} from "@/browser/features/Tools/Shared/codeExecutionTypes";
import { lightweightMeta } from "./meta.js";

const meta = {
  ...lightweightMeta,
  title: "App/CodeExecution",
  component: CodeExecutionToolCallCard,
} satisfies Meta<typeof CodeExecutionToolCallCard>;

export default meta;

type Story = StoryObj<typeof meta>;

const STABLE_TIMESTAMP = 1_700_000_000_000;

const STORYBOOK_WORKSPACE_ID = "storybook-code-execution";

async function assertCodeExecutionCardRenders(canvasElement: HTMLElement, expectedText: string) {
  const canvas = within(canvasElement);
  await canvas.findByText("Code Execution");
  await canvas.findByText(expectedText);
}

const SAMPLE_CODE = `// Read a file and make an edit
const content = await mux.file_read({ path: "src/config.ts" });
console.log("Read file with", content.lines_read, "lines");

await mux.file_edit_replace_string({
  path: "src/config.ts",
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

const ANALYSIS_CODE = `// Analysis script with various syntax elements
const data = mux.file_read({ path: "data.json" });
const parsed = JSON.parse(data.content);

function analyze(items) {
  return items.map(item => ({
    name: item.name,
    score: item.value * 1.5,
  }));
}

const results = analyze(parsed.items);
console.log("Processed", results.length, "items");
return results;`;

function renderCodeExecutionCard(props: ComponentProps<typeof CodeExecutionToolCallCard>) {
  return (
    <BackgroundBashProvider workspaceId={STORYBOOK_WORKSPACE_ID}>
      <div className="bg-background flex min-h-screen items-start p-6">
        <div className="w-full max-w-3xl">
          <CodeExecutionToolCallCard {...props} />
        </div>
      </div>
    </BackgroundBashProvider>
  );
}

const completedResult: CodeExecutionResult = {
  success: true,
  result: "Done!",
  toolCalls: [
    {
      toolName: "file_read",
      args: { path: "src/config.ts" },
      result: { success: true, lines_read: 42 },
      duration_ms: 15,
    },
    {
      toolName: "file_edit_replace_string",
      args: {
        path: "src/config.ts",
        old_string: "debug: false",
        new_string: "debug: true",
      },
      result: { success: true, edits_applied: 1 },
      duration_ms: 23,
    },
    {
      toolName: "bash",
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
      timestamp: STABLE_TIMESTAMP - 100,
    },
    {
      level: "warn",
      args: ["Replacing string in config"],
      timestamp: STABLE_TIMESTAMP - 50,
    },
    {
      level: "log",
      args: ["Config updated successfully"],
      timestamp: STABLE_TIMESTAMP,
    },
  ],
  duration_ms: 150,
};

const completedNestedCalls: NestedToolCall[] = [
  {
    toolCallId: "nested-1",
    toolName: "file_read",
    input: { path: "src/config.ts" },
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
    toolName: "file_edit_replace_string",
    input: {
      path: "src/config.ts",
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
    toolName: "bash",
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
];

const failedResult: CodeExecutionResult = {
  success: false,
  error: "Tool execution failed: file not found",
  toolCalls: [
    {
      toolName: "bash",
      args: { script: "cat /nonexistent" },
      error: "file not found",
      duration_ms: 12,
    },
  ],
  consoleOutput: [],
  duration_ms: 50,
};

/** Completed code execution with nested tools and console output */
export const Completed: Story = {
  render: () =>
    renderCodeExecutionCard({
      args: { code: SAMPLE_CODE },
      result: completedResult,
      status: "completed",
      nestedCalls: completedNestedCalls,
    }),
  play: async ({ canvasElement }) => {
    await assertCodeExecutionCardRenders(canvasElement, "echo 'Config updated!'");
  },
};

/** Code execution in progress with some completed nested tools */
export const Executing: Story = {
  render: () =>
    renderCodeExecutionCard({
      args: { code: SAMPLE_CODE },
      status: "executing",
      nestedCalls: [
        {
          toolCallId: "nested-1",
          toolName: "file_read",
          input: { path: "src/config.ts" },
          output: {
            success: true,
            file_size: 1024,
            lines_read: 42,
            content: "export const config = {...};",
          },
          state: "output-available",
        },
        {
          toolCallId: "nested-2",
          toolName: "file_edit_replace_string",
          input: {
            path: "src/config.ts",
            old_string: "debug: false",
            new_string: "debug: true",
          },
          state: "input-available",
        },
      ],
    }),
};

/** Code execution with no nested tools yet (just started) */
export const JustStarted: Story = {
  render: () =>
    renderCodeExecutionCard({
      args: { code: SAMPLE_CODE },
      status: "executing",
      nestedCalls: [],
    }),
};

/** Code execution that failed with an error */
export const Failed: Story = {
  render: () =>
    renderCodeExecutionCard({
      args: { code: `const result = await mux.bash({ script: "cat /nonexistent" });` },
      result: failedResult,
      status: "failed",
      nestedCalls: [
        {
          toolCallId: "nested-1",
          toolName: "bash",
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
      ],
    }),
  play: async ({ canvasElement }) => {
    await assertCodeExecutionCardRenders(canvasElement, "cat /nonexistent");
  },
};

/** Code execution with no tool calls (pure computation) */
export const NoToolCalls: Story = {
  render: () =>
    renderCodeExecutionCard({
      args: {
        code: `function fib(n) {
  if (n <= 1) return n;
  return fib(n - 1) + fib(n - 2);
}

const results = [];
for (let i = 0; i < 10; i++) {
  results.push(fib(i));
}
return results;`,
      },
      result: {
        success: true,
        result: [0, 1, 1, 2, 3, 5, 8, 13, 21, 34],
        toolCalls: [],
        consoleOutput: [],
        duration_ms: 12,
      },
      status: "completed",
      nestedCalls: [],
    }),
};

/** Code execution with nested tool that threw an error (error-only output shape) */
export const NestedToolError: Story = {
  render: () =>
    renderCodeExecutionCard({
      args: {
        code: `const result = mux.file_read({ path: "nonexistent.ts" });
return result;`,
      },
      result: {
        success: false,
        error: "Tool execution failed",
        consoleOutput: [],
        duration_ms: 10,
        toolCalls: [
          {
            toolName: "file_read",
            args: { path: "nonexistent.ts" },
            result: { error: "ENOENT: no such file or directory" },
            duration_ms: 5,
          },
        ],
      },
      status: "failed",
      nestedCalls: [
        {
          toolCallId: "nested-1",
          toolName: "file_read",
          input: { path: "nonexistent.ts" },
          output: { error: "ENOENT: no such file or directory" },
          state: "output-available",
        },
      ],
    }),
};

/** Code execution that was interrupted (e.g., app restart) */
export const Interrupted: Story = {
  render: () =>
    renderCodeExecutionCard({
      args: { code: SAMPLE_CODE },
      status: "interrupted",
      nestedCalls: [
        {
          toolCallId: "nested-1",
          toolName: "file_read",
          input: { path: "src/config.ts" },
          output: {
            success: true,
            file_size: 1024,
            lines_read: 42,
            content: "export const config = {...};",
          },
          state: "output-available",
        },
        {
          toolCallId: "nested-2",
          toolName: "bash",
          input: {
            script: "sleep 60",
            timeout_secs: 120,
            run_in_background: false,
            display_name: "Long sleep",
          },
          state: "input-available",
        },
      ],
    }),
  play: async ({ canvasElement }) => {
    await assertCodeExecutionCardRenders(canvasElement, "sleep 60");
  },
};

/**
 * Code execution showing the code view (monospace font test).
 *
 * No play step is needed here: when execution completes without nested tool calls,
 * CodeExecutionToolCall auto-switches from "tools" to "code" view.
 */
export const ShowCodeView: Story = {
  render: () =>
    renderCodeExecutionCard({
      args: { code: ANALYSIS_CODE },
      result: {
        success: true,
        result: [{ name: "test", score: 15 }],
        toolCalls: [],
        consoleOutput: [
          {
            level: "log",
            args: ["Processed", 1, "items"],
            timestamp: STABLE_TIMESTAMP,
          },
        ],
        duration_ms: 45,
      },
      status: "completed",
      nestedCalls: [],
    }),
};
