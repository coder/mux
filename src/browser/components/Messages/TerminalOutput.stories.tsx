import type { Meta, StoryObj } from "@storybook/react-vite";
import { TerminalOutput } from "./TerminalOutput";

const meta = {
  title: "Messages/TerminalOutput",
  component: TerminalOutput,
  parameters: {
    layout: "padded",
    backgrounds: {
      default: "dark",
      values: [{ name: "dark", value: "#1e1e1e" }],
    },
    controls: {
      exclude: ["className"],
    },
  },
  tags: ["autodocs"],
  argTypes: {
    output: {
      control: "text",
      description: "Terminal output text",
    },
    isError: {
      control: "boolean",
      description: "Whether the output represents an error",
    },
  },
} satisfies Meta<typeof TerminalOutput>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SuccessOutput: Story = {
  args: {
    output:
      "$ npm install\nadded 324 packages in 4.2s\n\n42 packages are looking for funding\n  run `npm fund` for details",
    isError: false,
  },
};

export const ErrorOutput: Story = {
  args: {
    output:
      "Error: Command failed with exit code 1\n  at ChildProcess.exithandler (node:child_process:419:12)\n  at ChildProcess.emit (node:events:513:28)",
    isError: true,
  },
};

export const LongOutput: Story = {
  args: {
    output: `Running tests...

✓ components/Tooltip.test.tsx (12 tests)
✓ components/StatusIndicator.test.tsx (8 tests)
✓ components/ToggleGroup.test.tsx (6 tests)
✓ components/Modal.test.tsx (10 tests)
✓ utils/format.test.ts (15 tests)
✓ utils/validation.test.ts (20 tests)
✓ hooks/useThinkingLevel.test.ts (5 tests)
✓ hooks/useWorkspace.test.ts (12 tests)

Test Files  8 passed (8)
     Tests  88 passed (88)
  Start at  12:34:56
  Duration  2.45s (transform 123ms, setup 0ms, collect 456ms, tests 1.87s)`,
    isError: false,
  },
};

export const CompilationError: Story = {
  args: {
    output: `src/components/Example.tsx:42:15
  TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.
    40 |   const result = calculate(value);
    41 |   if (result > 0) {
  > 42 |     return format(result.toString());
       |               ^^^^^^^^^^^^^^^^^^^^^^^
    43 |   }
    44 |   return null;`,
    isError: true,
  },
};

export const GitOutput: Story = {
  args: {
    output: `$ git status
On branch feature/new-component
Your branch is up to date with 'origin/feature/new-component'.

Changes not staged for commit:
  (use "git add <file>..." to update what will be committed)
  (use "git restore <file>..." to discard changes in working directory)
        modified:   src/components/NewComponent.tsx
        modified:   src/components/NewComponent.stories.tsx

Untracked files:
  (use "git add <file>..." to include in what will be committed)
        src/components/AnotherComponent.tsx

no changes added to commit (use "git add" and/or "git commit -a")`,
    isError: false,
  },
};

export const WithANSI: Story = {
  args: {
    output: `[32m✓[0m All tests passed
[33m⚠[0m 2 warnings detected
[31m✗[0m 1 deprecation warning

Run time: [36m2.45s[0m`,
    isError: false,
  },
};

export const EmptyOutput: Story = {
  args: {
    output: "",
    isError: false,
  },
};

export const SingleLine: Story = {
  args: {
    output: "Server started successfully on port 3000",
    isError: false,
  },
};
