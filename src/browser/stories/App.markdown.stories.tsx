/**
 * Markdown rendering stories (tables, code blocks)
 */

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { STABLE_TIMESTAMP, createUserMessage, createAssistantMessage } from "./mockFactory";
import { expect, waitFor } from "@storybook/test";
import { waitForChatMessagesLoaded } from "./storyPlayHelpers";

import { setupSimpleChatStory } from "./storyHelpers";

export default {
  ...appMeta,
  title: "App/Markdown",
};

// ═══════════════════════════════════════════════════════════════════════════════
// CONTENT FIXTURES
// ═══════════════════════════════════════════════════════════════════════════════

const TABLE_CONTENT = `Here are various markdown table examples:

## Simple Table

| Column 1 | Column 2 | Column 3 |
|----------|----------|----------|
| Value A  | Value B  | Value C  |
| Value D  | Value E  | Value F  |

## Table with Alignments

| Left | Center | Right |
|:-----|:------:|------:|
| L    | C      | R     |
| Text | Text   | Text  |

## Code in Tables

| Feature | Status | Notes |
|---------|--------|-------|
| \`markdown\` | ✅ Done | Full GFM |
| **Bold** | ✅ Done | Works |

## Wide Table

| Config Key | Default | Description | Env Var |
|------------|---------|-------------|---------|
| \`api.timeout\` | 30000 | Timeout ms | \`API_TIMEOUT\` |
| \`cache.enabled\` | true | Enable cache | \`CACHE_ENABLED\` |`;

// Bug repro: SQL with $__timeFilter causes "__" to appear at end of code block
const SQL_WITH_DOUBLE_UNDERSCORE = `👍 Glad it's working. For reference, the final query:

\`\`\`sql
SELECT 
  TIMESTAMP_TRUNC(timestamp, DAY) as time,
  COUNT(DISTINCT distinct_id) as dau
FROM \`mux-telemetry.posthog.events\`
WHERE 
  event NOT LIKE "$%"
  AND $__timeFilter(timestamp)
GROUP BY time
ORDER BY time
\`\`\`
`;

const SINGLE_LINE_CODE = `Here's a one-liner:

\`\`\`bash
npm install mux
\`\`\`

And another:

\`\`\`typescript
const x = 42;
\`\`\``;

const CODE_CONTENT = `Here's the implementation:

\`\`\`typescript
import { verifyToken } from '../auth/jwt';

export async function getUser(req: Request, res: Response) {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token || !verifyToken(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const user = await db.users.findById(req.params.id);
  res.json(user);
}
\`\`\`

And the test:

\`\`\`typescript
describe('getUser', () => {
  it('should return 401 without token', async () => {
    const res = await request(app).get('/users/1');
    expect(res.status).toBe(401);
  });
});
\`\`\`

Text code blocks (regression: no phantom trailing blank line after highlighting):

\`\`\`text
https://github.com/coder/mux/pull/new/chat-autocomplete-b24r
\`\`\`

Code blocks without language (regression: avoid extra vertical spacing):

\`\`\`
65d02772b 🤖 feat: Settings-driven model selector with visibility controls
\`\`\``;

// ═══════════════════════════════════════════════════════════════════════════════
// STORIES
// ═══════════════════════════════════════════════════════════════════════════════

/** Markdown tables in chat */
export const Tables: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-tables",
          messages: [
            createUserMessage("msg-1", "Show me some table examples", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 100000,
            }),
            createAssistantMessage("msg-2", TABLE_CONTENT, {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 90000,
            }),
          ],
        })
      }
    />
  ),
};

/** Single-line code blocks - copy button should be compact */
export const SingleLineCodeBlocks: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-single-line",
          messages: [
            createUserMessage("msg-1", "Show me single-line code", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 100000,
            }),
            createAssistantMessage("msg-2", SINGLE_LINE_CODE, {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 90000,
            }),
          ],
        })
      }
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await waitForChatMessagesLoaded(canvasElement);

    // Wait for code blocks to render with highlighting
    const codeWrappers = await waitFor(
      () => {
        const candidates = Array.from(canvasElement.querySelectorAll(".code-block-wrapper"));
        if (candidates.length < 2) {
          throw new Error("Not all code blocks rendered yet");
        }
        return candidates as HTMLElement[];
      },
      { timeout: 5000 }
    );

    // Verify the first code block wrapper has only one line
    const lineNumbers = codeWrappers[0].querySelectorAll(".line-number");
    await expect(lineNumbers.length).toBe(1);

    // Verify the single-line class is applied for compact styling
    await expect(codeWrappers[0].classList.contains("code-block-single-line")).toBe(true);

    // Force copy buttons visible for screenshot (normally shown on hover)
    for (const wrapper of codeWrappers) {
      const copyButton = wrapper.querySelector<HTMLElement>(".code-copy-button");
      if (copyButton) {
        copyButton.style.opacity = "1";
      }
    }
  },
};

/** SQL with double underscores in code block - tests for bug where __ leaks to end */
export const SqlWithDoubleUnderscore: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-sql-underscore",
          messages: [
            createUserMessage("msg-1", "Show me the SQL query", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 100000,
            }),
            createAssistantMessage("msg-2", SQL_WITH_DOUBLE_UNDERSCORE, {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 90000,
            }),
          ],
        })
      }
    />
  ),
};

/** Code blocks with syntax highlighting */
export const CodeBlocks: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-code",
          messages: [
            createUserMessage("msg-1", "Show me the code", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 100000,
            }),
            createAssistantMessage("msg-2", CODE_CONTENT, {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 90000,
            }),
          ],
        })
      }
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await waitForChatMessagesLoaded(canvasElement);

    // Wait for ALL code blocks with language hints to be highlighted.
    // CODE_CONTENT has 3 language-tagged blocks (2× typescript, 1× text) that use async Shiki.
    // Waiting for all prevents flaky snapshots from partial highlighting state.
    await waitFor(
      () => {
        const candidates = canvasElement.querySelectorAll(".code-block-wrapper");
        if (candidates.length < 3) {
          throw new Error(`Expected 3 code-block-wrappers, found ${candidates.length}`);
        }
        // Each must have highlighted spans (Shiki wraps tokens in spans)
        for (const wrapper of candidates) {
          if (!wrapper.querySelector(".code-line span")) {
            throw new Error("Not all code blocks highlighted yet");
          }
        }
      },
      { timeout: 5000 }
    );

    // Highlighting changes code block height, triggering ResizeObserver → coalesced RAF scroll.
    // Wait 2 RAFs: one for the coalesced scroll to fire, one for layout to settle.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    const url = "https://github.com/coder/mux/pull/new/chat-autocomplete-b24r";
    const container = await waitFor(
      () => {
        const found = Array.from(canvasElement.querySelectorAll(".code-block-container")).find(
          (c) => c.textContent?.includes(url)
        );
        if (!found) throw new Error("URL code block not found");
        return found;
      },
      { timeout: 5000 }
    );

    const noLangLine = "65d02772b 🤖 feat: Settings-driven model selector with visibility controls";

    const codeEl = await waitFor(
      () => {
        const candidates = Array.from(
          canvasElement.querySelectorAll(".markdown-content pre > code")
        );
        const found = candidates.find((el) => el.textContent?.includes(noLangLine));
        if (!found) {
          throw new Error("No-language code block not found");
        }
        return found;
      },
      { timeout: 5000 }
    );

    const style = window.getComputedStyle(codeEl);
    await expect(style.marginTop).toBe("0px");
    await expect(style.marginBottom).toBe("0px");
    // Regression: Shiki can emit a visually-empty trailing line (<span></span>), which would render
    // as a phantom extra line in our line-numbered code blocks.
    await expect(container.querySelectorAll(".line-number").length).toBe(1);
  },
};
