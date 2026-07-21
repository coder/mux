/** Full-app visual coverage for sub-agent progress and terminal report presentation. */

import type { ComponentType } from "react";

import { appMeta, AppWithMocks, PIXEL_DUAL_THEME, type AppStory } from "./meta.js";
import { setupSimpleChatStory } from "./helpers/chatSetup";
import { collapseLeftSidebar, collapseRightSidebar } from "./helpers/uiState";
import {
  createAssistantMessage,
  createSubagentReportMessage,
  createUserMessage,
} from "./mocks/messages";
import { STABLE_TIMESTAMP } from "./mocks/workspaces";

export default {
  ...appMeta,
  title: "App/SubagentReports",
};

const REPORT_MESSAGES = [
  createUserMessage("report-user", "Review the message rendering path and flag any UX gaps.", {
    historySequence: 1,
    timestamp: STABLE_TIMESTAMP - 180_000,
  }),
  createAssistantMessage(
    "report-assistant",
    "I delegated the rendering trace and asked the sub-agent to report important findings as they land.",
    {
      historySequence: 2,
      timestamp: STABLE_TIMESTAMP - 170_000,
    }
  ),
  createSubagentReportMessage("report-progress", {
    historySequence: 3,
    timestamp: STABLE_TIMESTAMP - 120_000,
    taskId: "18c2511cea",
    agentType: "explore",
    status: "in_progress",
    title: "Current report presentation traced across the parent transcript",
    reportMarkdown:
      "Parent-side reports currently expose the model-facing envelope. A dedicated renderer can preserve **markdown**, paths like `src/browser/features/Messages/UserMessage.tsx`, and status without the raw protocol.",
  }),
  createSubagentReportMessage("report-complete", {
    historySequence: 4,
    timestamp: STABLE_TIMESTAMP - 60_000,
    taskId: "18c2511cea",
    agentType: "explore",
    // Omit status to cover report envelopes persisted before incremental updates existed.
    title: "Presentation recommendation complete",
    reportMarkdown: [
      "## Recommendation",
      "",
      "- Render reports as trusted sub-agent findings, not ordinary user input.",
      "- Keep structured workflow data available without letting it dominate the transcript.",
    ].join("\n"),
    structuredOutput: {
      affectedFiles: [
        "src/browser/features/Messages/UserMessage.tsx",
        "src/browser/features/Messages/SubagentReportMessageContent.tsx",
      ],
      mobileVerified: true,
    },
  }),
  createAssistantMessage(
    "report-integrated",
    "I’ll incorporate both findings into the final implementation and keep the structured details available for inspection.",
    {
      historySequence: 5,
      timestamp: STABLE_TIMESTAMP - 50_000,
    }
  ),
] as const;

function setupReportStory() {
  collapseLeftSidebar();
  collapseRightSidebar();
  return setupSimpleChatStory({
    workspaceId: "ws-subagent-report-presentation",
    workspaceName: "subagent-reports",
    projectName: "mux",
    messages: [...REPORT_MESSAGES],
  });
}

function PhoneDecorator(Story: ComponentType) {
  return (
    <div style={{ width: 390, height: 844, overflow: "hidden" }}>
      <Story />
    </div>
  );
}

/** Incremental, completed legacy, and structured sub-agent report states. */
export const Desktop: AppStory = {
  // Pixel owns this visual-only desktop matrix. The full App cold-start can exceed the
  // Storybook test-runner's 30-second smoke timeout before any assertions begin.
  tags: ["!test"],
  render: () => <AppWithMocks setup={setupReportStory} />,
  parameters: {
    ...appMeta.parameters,
    pixel: { matrix: PIXEL_DUAL_THEME },
  },
  // Pixel captures the complete desktop composition. Keep interaction assertions on the pinned
  // phone story below because the Storybook test-runner's cold desktop app load can exhaust its
  // per-story timeout before a desktop play function begins, while production behavior is covered
  // by MessageRenderer.test.tsx.
};

/** Phone-width contract for long titles, markdown paths, and structured-output controls. */
export const Phone: AppStory = {
  // The fixed-width decorator + pinned Pixel phone viewport are the static breakpoint contract.
  // Production rendering behavior is covered by MessageRenderer.test.tsx.
  tags: ["!test"],
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  render: () => <AppWithMocks setup={setupReportStory} />,
  decorators: [PhoneDecorator],
  parameters: {
    ...appMeta.parameters,
    pixel: {
      matrix: { themes: ["dark", "light"], viewports: ["phone"] },
    },
  },
};
