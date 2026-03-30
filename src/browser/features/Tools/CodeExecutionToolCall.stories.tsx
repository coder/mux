import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ComponentProps, ReactNode } from "react";
import { BackgroundBashProvider } from "@/browser/contexts/BackgroundBashContext";
import { CodeExecutionToolCall } from "@/browser/features/Tools/CodeExecutionToolCall";
import type {
  CodeExecutionResult,
  NestedToolCall,
} from "@/browser/features/Tools/Shared/codeExecutionTypes";
import { lightweightMeta } from "@/browser/stories/meta.js";

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Tools/CodeExecution",
  component: CodeExecutionToolCall,
} satisfies Meta<typeof CodeExecutionToolCall>;

export default meta;

type Story = StoryObj<typeof meta>;

const STORYBOOK_WORKSPACE_ID = "storybook-code-execution";
const STABLE_TIMESTAMP = 1_700_000_000_000;

const SAMPLE_CODE = `const content = await mux.file_read({ path: "src/config.ts" });
console.log("Read file with", content.lines_read, "lines");

await mux.file_edit_replace_string({
  path: "src/config.ts",
  old_string: "debug: false",
  new_string: "debug: true"
});

return "Done!";`;

const SYNTAX_HIGHLIGHT_CODE = `type Result = { name: string; score: number };

function analyze(items: Array<{ name: string; value: number }>): Result[] {
  return items
    .filter((item) => item.value > 0)
    .map((item) => ({ name: item.name, score: item.value * 1.5 }));
}

const data = [{ name: "alpha", value: 10 }, { name: "beta", value: 0 }];
const results = analyze(data);
console.log("Processed", results.length, "items");
return results;`;

function StoryShell(props: { children: ReactNode }) {
  return (
    <BackgroundBashProvider workspaceId={STORYBOOK_WORKSPACE_ID}>
      <div className="bg-background p-6">
        <div className="w-full max-w-3xl">{props.children}</div>
      </div>
    </BackgroundBashProvider>
  );
}

function renderCard(props: ComponentProps<typeof CodeExecutionToolCall>) {
  return (
    <StoryShell>
      <CodeExecutionToolCall {...props} />
    </StoryShell>
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
  ],
  consoleOutput: [
    {
      level: "log",
      args: ["Read file with", 42, "lines"],
      timestamp: STABLE_TIMESTAMP,
    },
  ],
  duration_ms: 120,
};

const completedNestedCalls: NestedToolCall[] = [
  {
    toolCallId: "nested-1",
    toolName: "file_read",
    input: { path: "src/config.ts" },
    output: { success: true, lines_read: 42, file_size: 1024 },
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
    output: { success: true, edits_applied: 1 },
    state: "output-available",
  },
];

/** completed execution with successful nested tool calls */
export const Completed: Story = {
  render: () =>
    renderCard({
      args: { code: SAMPLE_CODE },
      result: completedResult,
      status: "completed",
      nestedCalls: completedNestedCalls,
    }),
};

/** executing state with one completed nested call and one in-progress call */
export const Executing: Story = {
  render: () =>
    renderCard({
      args: { code: SAMPLE_CODE },
      status: "executing",
      nestedCalls: [
        {
          toolCallId: "nested-1",
          toolName: "file_read",
          input: { path: "src/config.ts" },
          output: { success: true, lines_read: 42, file_size: 1024 },
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

/** failed execution showing error result */
export const Failed: Story = {
  render: () =>
    renderCard({
      args: { code: `await mux.file_read({ path: "missing.ts" });` },
      result: {
        success: false,
        error: "Tool execution failed: ENOENT: no such file or directory, open 'missing.ts'",
        toolCalls: [
          {
            toolName: "file_read",
            args: { path: "missing.ts" },
            error: "ENOENT: no such file or directory",
            duration_ms: 8,
          },
        ],
        consoleOutput: [],
        duration_ms: 20,
      },
      status: "failed",
      nestedCalls: [
        {
          toolCallId: "nested-1",
          toolName: "file_read",
          input: { path: "missing.ts" },
          output: { error: "ENOENT: no such file or directory" },
          state: "output-available",
        },
      ],
    }),
};

/** completed execution with no tool calls to showcase code syntax highlighting */
export const SyntaxHighlighting: Story = {
  render: () =>
    renderCard({
      args: { code: SYNTAX_HIGHLIGHT_CODE },
      result: {
        success: true,
        result: [{ name: "alpha", score: 15 }],
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
