/**
 * Centralized message ID generation helpers.
 *
 * Each message type uses a consistent prefix + timestamp + random suffix pattern.
 * Prefixes are preserved for backward compatibility with existing history.
 */

import { MCP_PROMPT_SNAPSHOT_MESSAGE_ID_PREFIX } from "@/common/types/message";

const randomSuffix = (len = 9) =>
  Math.random()
    .toString(36)
    .substring(2, 2 + len);

/** User message IDs: user-{timestamp}-{random} */
export const createUserMessageId = (): string => `user-${Date.now()}-${randomSuffix(9)}`;

/** Assistant message IDs: assistant-{timestamp}-{random} */
export const createAssistantMessageId = (): string => `assistant-${Date.now()}-${randomSuffix(9)}`;

/** File snapshot message IDs: file-snapshot-{timestamp}-{random} */
export const createFileSnapshotMessageId = (): string =>
  `file-snapshot-${Date.now()}-${randomSuffix(7)}`;

/** Agent skill snapshot message IDs: agent-skill-snapshot-{timestamp}-{random} */
export const createAgentSkillSnapshotMessageId = (): string =>
  `agent-skill-snapshot-${Date.now()}-${randomSuffix(7)}`;

export const createMcpPromptSnapshotMessageId = (): string =>
  `${MCP_PROMPT_SNAPSHOT_MESSAGE_ID_PREFIX}${Date.now()}-${randomSuffix(7)}`;

/** Compaction summary message IDs: summary-{timestamp}-{random} */
export const createCompactionSummaryMessageId = (): string =>
  `summary-${Date.now()}-${randomSuffix(9)}`;

/** Context reset boundary IDs: context-reset-{timestamp}-{random} */
export const createContextResetBoundaryMessageId = (): string =>
  `context-reset-${Date.now()}-${randomSuffix(9)}`;

/** Task report message IDs: task-report-{timestamp}-{random} */
export const createTaskReportMessageId = (): string =>
  `task-report-${Date.now()}-${randomSuffix(9)}`;

/** Task terminal-failure message IDs: task-failure-{timestamp}-{random} */
export const createTaskFailureMessageId = (): string =>
  `task-failure-${Date.now()}-${randomSuffix(9)}`;

export const FILE_CHANGE_NOTIFICATION_MESSAGE_ID_PREFIX = "file-change-";

/** External file-change notification message IDs: file-change-{timestamp}-{random} */
export const createFileChangeNotificationMessageId = (): string =>
  `${FILE_CHANGE_NOTIFICATION_MESSAGE_ID_PREFIX}${Date.now()}-${randomSuffix(9)}`;
