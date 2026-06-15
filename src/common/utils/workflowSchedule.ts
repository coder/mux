import { ProjectWorkflowScheduleSchema } from "@/common/schemas/project";
import { WorkspaceWorkflowScheduleSchema } from "@/common/orpc/schemas/workspace";
import type { ProjectWorkflowSchedule } from "@/common/types/project";
import type { WorkspaceWorkflowSchedule } from "@/common/types/workspace";

export function parsePersistedWorkflowSchedule(
  value: unknown
): WorkspaceWorkflowSchedule | undefined {
  const parsed = WorkspaceWorkflowScheduleSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function parsePersistedProjectWorkflowSchedule(
  value: unknown
): ProjectWorkflowSchedule | undefined {
  const parsed = ProjectWorkflowScheduleSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function isWorkflowScheduleDue(
  schedule: { lastRunStartedAt?: string | null; intervalMs: number },
  now: number
): boolean {
  if (schedule.lastRunStartedAt == null) {
    return true;
  }

  const lastStarted = Date.parse(schedule.lastRunStartedAt);
  return !Number.isFinite(lastStarted) || now - lastStarted >= schedule.intervalMs;
}
