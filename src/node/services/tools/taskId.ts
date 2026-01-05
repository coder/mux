import assert from "node:assert/strict";

const BASH_TASK_ID_PREFIX = "bash:";

export function toBashTaskId(processId: string): string {
  assert(typeof processId === "string", "toBashTaskId: processId must be a string");
  const trimmed = processId.trim();
  assert(trimmed.length > 0, "toBashTaskId: processId must be non-empty");
  return `${BASH_TASK_ID_PREFIX}${trimmed}`;
}

export function fromBashTaskId(taskId: string): string | null {
  assert(typeof taskId === "string", "fromBashTaskId: taskId must be a string");
  if (!taskId.startsWith(BASH_TASK_ID_PREFIX)) {
    return null;
  }

  const processId = taskId.slice(BASH_TASK_ID_PREFIX.length).trim();
  return processId.length > 0 ? processId : null;
}

export function isBashTaskId(taskId: string): boolean {
  return fromBashTaskId(taskId) !== null;
}
