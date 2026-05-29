import type { Meta, StoryObj } from "@storybook/react-vite";
import { lightweightMeta } from "@/browser/stories/meta.js";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { UserMessageContent } from "./UserMessageContent";

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Messages/MarkdownRenderer",
  component: MarkdownRenderer,
} satisfies Meta<typeof MarkdownRenderer>;

export default meta;

type Story = StoryObj<typeof meta>;

function AssistantMarkdownCanvas(props: { content: string }) {
  return (
    <div className="bg-background flex min-h-screen justify-center p-6">
      <div className="w-full max-w-3xl overflow-x-hidden">
        <MarkdownRenderer content={props.content} />
      </div>
    </div>
  );
}

function UserMarkdownCanvas(props: { content: string }) {
  return (
    <div className="bg-background flex min-h-screen justify-center p-6">
      <div className="w-full max-w-3xl overflow-x-hidden px-4 py-3">
        <UserMessageContent content={props.content} variant="sent" />
      </div>
    </div>
  );
}

const TABLE_CONTENT = `Here are markdown table examples:

## Simple table

| Column 1 | Column 2 | Column 3 |
|----------|----------|----------|
| Value A  | Value B  | Value C  |
| Value D  | Value E  | Value F  |

## Alignment table

| Left | Center | Right |
|:-----|:------:|------:|
| L    | C      | R     |
| Text | Text   | Text  |

## Code in table cells

| Feature | Status | Notes |
|---------|--------|-------|
| \`markdown\` | ✅ Done | Full GFM |
| **Bold** | ✅ Done | Works |`;

const CODE_BLOCK_CONTENT = `Single-line block:

\`\`\`bash
npm install mux
\`\`\`

Multi-line block:

\`\`\`typescript
import { verifyToken } from "../auth/jwt";

export async function getUser(req: Request, res: Response) {
  const token = req.headers.authorization?.split(" ")[1];

  if (!token || !verifyToken(token)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  return res.json({ ok: true });
}
\`\`\``;

const BLOCKQUOTE_CONTENT = `Simple quote:

> This is a simple blockquote.

Quote with inline formatting:

> **Important:** Inline \`code\`, **bold**, and *italic* should render correctly.

Nested quote:

> Outer quote
>
> > Inner quote
>
> Outer quote again.`;

const LONG_LINE_CONTENT = `Long lines should stay inside the message container.

\`\`\`
const reallyLongVariableName = someFunction(argumentOne, argumentTwo, argumentThree, argumentFour, argumentFive, argumentSix, argumentSeven, argumentEight, argumentNine, argumentTen);
\`\`\`

This is a very long paragraph without manual line breaks that should wrap within the message content area instead of forcing horizontal overflow in the surrounding layout.`;

/** Markdown tables */
export const Tables: Story = {
  render: () => <AssistantMarkdownCanvas content={TABLE_CONTENT} />,
};

/** Code blocks with both single-line and multi-line examples */
export const CodeBlocks: Story = {
  render: () => <AssistantMarkdownCanvas content={CODE_BLOCK_CONTENT} />,
};

/** Blockquotes with nested and inline-formatted content */
export const Blockquotes: Story = {
  render: () => <AssistantMarkdownCanvas content={BLOCKQUOTE_CONTENT} />,
};

/** Long-line rendering in user message markdown content */
export const LongLines: Story = {
  render: () => <UserMarkdownCanvas content={LONG_LINE_CONTENT} />,
};
