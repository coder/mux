/**
 * Markdown rendering stories (tables, code blocks)
 */

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { STABLE_TIMESTAMP, createUserMessage, createAssistantMessage } from "./mockFactory";
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
};
