export const PROJECT_CHAT_VERSION = 1 as const;
export const PROJECT_CHAT_AGENT_ID = "orchestrator" as const;
export const PROJECT_CHAT_SESSION_ID_PREFIX = "project-session_" as const;
const PROJECT_CHAT_SESSION_ID_PATTERN = /^project-session_[0-9a-f]{10}$/;

/** Project Chat IDs become directory names, so persisted values must match generated stable IDs. */
export function isProjectSessionId(sessionId: string): boolean {
  return PROJECT_CHAT_SESSION_ID_PATTERN.test(sessionId);
}
