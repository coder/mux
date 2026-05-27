import { waitFor, within } from "@storybook/test";

import type { AppStory } from "@/browser/stories/meta.js";
import { appMeta, AppWithMocks } from "@/browser/stories/meta.js";
import { setupSimpleChatStory } from "@/browser/stories/helpers/chatSetup";
import { createAssistantMessage, createUserMessage } from "@/browser/stories/mocks/messages";
import { createProposePlanTool } from "@/browser/stories/mocks/tools";
import { STABLE_TIMESTAMP } from "@/browser/stories/mocks/workspaces";

const meta = { ...appMeta, title: "App/Chat/Tools/ProposePlan" };
export default meta;

const PLAN_TOC_CHROMATIC_VIEWPORT = { width: 1600, height: 900 } as const;
const PLAN_TOC_CHROMATIC_MODES = {
  "dark-wide": { theme: "dark", viewport: PLAN_TOC_CHROMATIC_VIEWPORT },
} as const;

function isChromaticRuntime(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const chromaticRuntimeFlag = (window as Window & { chromatic?: boolean }).chromatic;
  return /Chromatic/i.test(window.navigator.userAgent) || chromaticRuntimeFlag === true;
}

/**
 * Story showing a propose_plan tool call with Plan UI.
 * Tests the plan card rendering with icon action buttons at the bottom.
 */
export const ProposePlan: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-plan",
          messages: [
            createUserMessage("msg-1", "Help me refactor the authentication module", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 300000,
            }),
            createAssistantMessage(
              "msg-2",
              "I'll create a plan for refactoring the authentication module.",
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 290000,
                toolCalls: [
                  createProposePlanTool(
                    "call-plan-1",
                    `# Authentication Module Refactor

## Overview

Refactor the authentication system to improve security and maintainability.

## Tasks

1. **Extract JWT utilities** - Move token generation and validation to dedicated module
2. **Add refresh token support** - Implement secure refresh token rotation
3. **Improve password hashing** - Upgrade to Argon2id with proper salt rounds
4. **Add rate limiting** - Implement per-IP and per-user rate limits
5. **Session management** - Add Redis-backed session store

## Implementation Order

\`\`\`mermaid
graph TD
    A[Extract JWT utils] --> B[Add refresh tokens]
    B --> C[Improve hashing]
    C --> D[Add rate limiting]
    D --> E[Session management]
\`\`\`

## Success Criteria

- All existing tests pass
- New tests for refresh token flow
- Security audit passes
- Performance benchmarks maintained`
                  ),
                ],
              }
            ),
          ],
        })
      }
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Shows the ProposePlanToolCall component with a completed plan. " +
          "The plan card displays with the title in the header and icon action buttons " +
          "(Copy, Start Here, Show Text) at the bottom, matching the AssistantMessage aesthetic.",
      },
    },
  },
};

/**
 * Same as ProposePlan but with agent mode set to "plan".
 * Shows the Implement button (no Continue in Auto).
 */
export const ProposePlanInPlanMode: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        window.localStorage.setItem("agentId:ws-plan-mode", JSON.stringify("plan"));

        return setupSimpleChatStory({
          workspaceId: "ws-plan-mode",
          messages: [
            createUserMessage("msg-1", "Help me refactor the authentication module", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 300000,
            }),
            createAssistantMessage(
              "msg-2",
              "I'll create a plan for refactoring the authentication module.",
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 290000,
                toolCalls: [
                  createProposePlanTool(
                    "call-plan-1",
                    `# Authentication Module Refactor

## Overview

Refactor the authentication system to improve security and maintainability.

## Tasks

1. **Extract JWT utilities** - Move token generation and validation to dedicated module
2. **Add refresh token support** - Implement secure refresh token rotation
3. **Improve password hashing** - Upgrade to Argon2id with proper salt rounds
4. **Add rate limiting** - Implement per-IP and per-user rate limits
5. **Session management** - Add Redis-backed session store

## Implementation Order

\`\`\`mermaid
graph TD
    A[Extract JWT utils] --> B[Add refresh tokens]
    B --> C[Improve hashing]
    C --> D[Add rate limiting]
    D --> E[Session management]
\`\`\`

## Success Criteria

- All existing tests pass
- New tests for refresh token flow
- Security audit passes
- Performance benchmarks maintained`
                  ),
                ],
              }
            ),
          ],
        });
      }}
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          'Same as ProposePlan but with agent mode set to "plan". ' +
          "Shows the Implement button instead of Continue in Auto.",
      },
    },
  },
};

/**
 * Mobile viewport version of ProposePlan.
 *
 * Verifies that on narrow screens the primary plan actions (Implement / Continue in Auto)
 * render as shortcut icons in the left action row (instead of right-aligned buttons).
 */
export const ProposePlanMobile: AppStory = {
  ...ProposePlan,
  parameters: {
    ...ProposePlan.parameters,
    viewport: { defaultViewport: "mobile1" },
    docs: {
      description: {
        story:
          "Renders ProposePlan at an iPhone-sized viewport to verify that Implement / Continue in Auto " +
          "appear as shortcut icons in the left action row (preventing right-side overflow on small screens).",
      },
    },
  },
};

/**
 * Wide-viewport story that exercises the sticky plan TOC.
 *
 * The TOC lives in an absolutely-positioned `<aside>` outside the centered
 * `max-w-4xl` transcript column, and is gated by a container query on the
 * transcript scrollport. At desktop (1280px) viewport the gate stays closed;
 * the `wide` viewport (1600px) gives the scrollport enough room to reveal
 * the TOC alongside the plan.
 */
export const ProposePlanWithTableOfContents: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-plan-toc",
          messages: [
            createUserMessage("msg-1", "Plan a multi-section refactor with deep structure.", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 300000,
            }),
            createAssistantMessage("msg-2", "Here is the plan with a navigable outline:", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 290000,
              toolCalls: [
                createProposePlanTool(
                  "call-plan-toc",
                  `# Authentication Module Refactor

## Overview

Refactor the auth system to improve security, maintainability, and observability.

## Tasks

### Extract JWT utilities

Move token generation and validation to a dedicated module.

### Add refresh token support

Implement secure refresh token rotation.

### Improve password hashing

Upgrade to Argon2id with proper salt rounds.

### Add rate limiting

Implement per-IP and per-user rate limits.

## Implementation Order

\`\`\`mermaid
graph TD
    A[Extract JWT utils] --> B[Add refresh tokens]
    B --> C[Improve hashing]
    C --> D[Add rate limiting]
\`\`\`

## Rollout

### Staging soak

Two-week staging soak with synthetic traffic.

### Production cutover

Blue/green cutover with automatic rollback on auth-error spikes.

## Success Criteria

- All existing tests pass
- New tests for refresh token flow
- Security audit passes
- Performance benchmarks maintained`
                ),
              ],
            }),
          ],
        })
      }
    />
  ),
  globals: {
    viewport: { value: "wide", isRotated: false },
  },
  play: async ({ canvasElement }) => {
    const shouldAssertFullToc =
      isChromaticRuntime() || window.innerWidth >= PLAN_TOC_CHROMATIC_VIEWPORT.width;
    if (!shouldAssertFullToc) {
      return;
    }

    const canvas = within(canvasElement);
    const toc = await canvas.findByTestId("plan-toc-nav");
    await waitFor(() => {
      // User rationale: this story exists to snapshot the full sticky TOC. Make
      // Chromatic fail loudly if a viewport/mode regression captures only the compact hint.
      if (window.getComputedStyle(toc).display === "none" || toc.getClientRects().length === 0) {
        throw new Error("Expected the full plan TOC to be visible in the wide Storybook story");
      }
    });
  },
  parameters: {
    viewport: { defaultViewport: "wide" },
    chromatic: {
      ...(appMeta.parameters?.chromatic ?? {}),
      modes: PLAN_TOC_CHROMATIC_MODES,
    },
    docs: {
      description: {
        story:
          "Wide-viewport rendering of a multi-section plan. The sticky " +
          '"Contents" navigation appears in the left gutter beside the plan ' +
          "card, anchored to the plan's vertical bounds via `position: sticky` " +
          "inside an absolutely-positioned `<aside>`. " +
          "Visibility is purely CSS-driven (container query + visibility class) " +
          "so toggling the plan tool expanded/collapsed produces no layout jank.",
      },
    },
  },
};

/**
 * Story showing a propose_plan with a code block containing long horizontal content.
 * Tests that code blocks wrap correctly instead of overflowing the container.
 */
export const ProposePlanWithLongCodeBlock: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-plan-overflow",
          messages: [
            createUserMessage("msg-1", "The CI is failing with this error, can you help?", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP,
            }),
            createAssistantMessage("msg-2", "I see the issue. Here's my plan to fix it:", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP,
              toolCalls: [
                createProposePlanTool(
                  "call-plan-1",
                  `# Fix CI Pipeline Failure

## Problem

The deployment step is failing due to a configuration mismatch:

\`\`\`json
{"error":"ConfigurationError","message":"Environment variable AWS_REGION is required but not set","stack":"at validateConfig (deploy.js:42)","context":{"requiredVars":["AWS_REGION","AWS_ACCESS_KEY_ID","AWS_SECRET_ACCESS_KEY"],"missingVars":["AWS_REGION"]}}
\`\`\`

## Solution

1. Add the missing \`AWS_REGION\` environment variable to the CI configuration
2. Update the deployment script to provide better error messages
3. Add a pre-flight check to catch missing variables earlier`
                ),
              ],
            }),
          ],
        })
      }
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Tests that code blocks within plans wrap correctly instead of overflowing. " +
          "The long JSON error line should wrap within the plan card.",
      },
    },
  },
};
