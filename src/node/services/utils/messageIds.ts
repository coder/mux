/**
 * Centralized message ID generation helpers.
 *
 * Each message type uses a consistent prefix + timestamp + random suffix pattern.
 * Prefixes are preserved for backward compatibility with existing history.
 */

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

/** Compaction summary message IDs: summary-{timestamp}-{random} */
export const createCompactionSummaryMessageId = (): string =>
  `summary-${Date.now()}-${randomSuffix(9)}`;

/** Task report message IDs: task-report-{timestamp}-{random} */
export const createTaskReportMessageId = (): string =>
  `task-report-${Date.now()}-${randomSuffix(9)}`;

/** File @mention block message IDs: file-at-mentions-{timestamp}-{index} */
export const createFileAtMentionMessageId = (timestamp: number, index: number): string =>
  `file-at-mentions-${timestamp}-${index}`;
