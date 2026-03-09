import type { AppStory } from "@/browser/stories/meta.js";
import { appMeta, AppWithMocks } from "@/browser/stories/meta.js";
import { setupSimpleChatStory } from "@/browser/stories/storyHelpers.js";
import {
  STABLE_TIMESTAMP,
  createUserMessage,
  createAssistantMessage,
  createProposePlanTool,
  createStatusTool,
} from "@/browser/stories/mockFactory";
import {
  PLAN_AUTO_ROUTING_STATUS_EMOJI,
  PLAN_AUTO_ROUTING_STATUS_MESSAGE,
} from "@/common/constants/planAutoRoutingStatus";

const meta = { ...appMeta, title: "App/Chat/Tools/ProposePlan" };
export default meta;

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
 * Shows Implement + Start Orchestrator buttons (no Continue in Auto).
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
          "Shows Implement and Start Orchestrator buttons instead of Continue in Auto.",
      },
    },
  },
};

/**
 * Captures the handoff pause after a plan is presented and before the executor stream starts.
 *
 * This reproduces the visual state where the sidebar shows "Deciding execution strategy…"
 * while the proposed plan remains visible in the conversation.
 */
export const ProposePlanAutoRoutingDecisionGap: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-plan-auto-routing-gap",
          workspaceName: "feature/plan-auto-routing",
          messages: [
            createUserMessage(
              "msg-1",
              "Plan and implement a safe migration rollout for auth tokens.",
              {
                historySequence: 1,
                timestamp: STABLE_TIMESTAMP - 240000,
              }
            ),
            createAssistantMessage("msg-2", "Here is the implementation plan.", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 230000,
              toolCalls: [
                createProposePlanTool(
                  "call-plan-1",
                  `# Auth Token Migration Rollout

## Goals

- Migrate token validation to the new signing service.
- Maintain compatibility during rollout.
- Keep rollback simple and low risk.

## Steps

1. Add dual-read token validation behind a feature flag.
2. Ship telemetry for token verification outcomes.
3. Enable new validator for 10% of traffic.
4. Ramp to 100% after stability checks.
5. Remove legacy validator once metrics stay healthy.

## Rollback

- Disable the rollout flag to return to legacy validation immediately.
- Keep telemetry running to confirm recovery.`
                ),
              ],
            }),
            createAssistantMessage("msg-3", "Selecting the right executor for this plan.", {
              historySequence: 3,
              timestamp: STABLE_TIMESTAMP - 220000,
              toolCalls: [
                createStatusTool(
                  "call-status-1",
                  PLAN_AUTO_ROUTING_STATUS_EMOJI,
                  PLAN_AUTO_ROUTING_STATUS_MESSAGE
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
          "Chromatic regression story for the plan auto-routing gap: after `propose_plan` succeeds, " +
          "the sidebar stays in a working state with a 'Deciding execution strategy…' status before executor kickoff.",
      },
    },
  },
};

/**
 * Mobile viewport version of ProposePlan.
 *
 * Verifies that on narrow screens the primary plan actions (Implement / Start Orchestrator)
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
          "Renders ProposePlan at an iPhone-sized viewport to verify that Implement / Start Orchestrator " +
          "appear as shortcut icons in the left action row (preventing right-side overflow on small screens).",
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
