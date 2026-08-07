import type { ComponentType } from "react";

import { setupSimpleChatStory } from "./chatSetup";
import { collapseLeftSidebar, collapseRightSidebar } from "./uiState";
import {
  createAssistantMessage,
  createSubagentReportMessage,
  createUserMessage,
} from "../mocks/messages";
import { createTaskSendMessageTool, createTaskTool } from "../mocks/tools";
import { STABLE_TIMESTAMP } from "../mocks/workspaces";

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
  createAssistantMessage("report-wait-paused", "", {
    historySequence: 3,
    timestamp: STABLE_TIMESTAMP - 140_000,
    toolCalls: [
      createTaskTool("wait-for-report", {
        subagent_type: "explore",
        prompt: "Review the message rendering path and report important findings.",
        title: "Trace report presentation",
        run_in_background: false,
        taskId: "18c2511cea",
        status: "running",
        interruption: {
          reason: "progress_report_received",
          sourceTaskId: "18c2511cea",
          report: {
            agentType: "explore",
            model: "anthropic:claude-opus-5",
            thinkingLevel: "high",
            title: "Current report presentation traced across the parent transcript",
            reportMarkdown:
              "Parent-side reports currently expose the model-facing envelope. A dedicated renderer can preserve **markdown**, paths like `src/browser/features/Messages/UserMessage.tsx`, and status without the raw protocol.",
          },
        },
      }),
    ],
  }),
  createAssistantMessage("report-guidance", "", {
    historySequence: 4,
    timestamp: STABLE_TIMESTAMP - 90_000,
    toolCalls: [
      createTaskSendMessageTool("guide-reporting-child", {
        task_id: "18c2511cea",
        message: "Good finding. Keep the scope on report presentation and verify the phone layout.",
      }),
    ],
  }),
  createSubagentReportMessage("report-complete", {
    historySequence: 5,
    timestamp: STABLE_TIMESTAMP - 60_000,
    taskId: "18c2511cea",
    agentType: "explore",
    // Omit status to cover report envelopes persisted before incremental updates existed.
    model: "anthropic:claude-opus-5",
    thinkingLevel: "high",
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
      historySequence: 6,
      timestamp: STABLE_TIMESTAMP - 50_000,
    }
  ),
] as const;

export function setupSubagentReportStory() {
  collapseLeftSidebar();
  collapseRightSidebar();
  return setupSimpleChatStory({
    workspaceId: "ws-subagent-report-presentation",
    workspaceName: "subagent-reports",
    projectName: "mux",
    messages: [...REPORT_MESSAGES],
  });
}

export function PhoneSubagentReportDecorator(Story: ComponentType) {
  return (
    <div style={{ width: 390, height: 844, overflow: "hidden" }}>
      <Story />
    </div>
  );
}
