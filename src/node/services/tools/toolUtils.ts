import assert from "node:assert/strict";

import type { z } from "zod";

import { getErrorMessage } from "@/common/utils/errors";
import type { ToolConfiguration } from "@/common/utils/tools/tools";
import { recordAgentWorkflowRunReference } from "@/node/services/agentWorkflowRunReferences";
import { log } from "@/node/services/log";
import type { TaskService } from "@/node/services/taskService";

export function requireWorkspaceId(config: ToolConfiguration, toolName: string): string {
  assert(config.workspaceId, `${toolName} requires workspaceId`);
  return config.workspaceId;
}

export function requireTaskService(config: ToolConfiguration, toolName: string): TaskService {
  assert(config.taskService, `${toolName} requires taskService`);
  return config.taskService;
}

export function parseToolResult<TSchema>(
  schema: z.ZodType<TSchema>,
  value: unknown,
  toolName: string
): TSchema {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${toolName} tool result validation failed: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function dedupeStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

/**
 * Persist agent provenance for a workflow run that outlives the current turn (background
 * start/resume, or a foreground run that backgrounded itself). TaskService reads these
 * references back so the run stays rediscoverable and its terminal result re-engages the agent.
 * Best-effort by design: failing the tool would strand a run that already started successfully,
 * and the history scan fallback can still re-establish provenance for the current context epoch.
 */
export async function recordBackgroundWorkflowRunReference(
  config: ToolConfiguration,
  runId: string,
  createdAtMs: number
): Promise<void> {
  const workspaceSessionDir = config.workspaceSessionDir;
  if (workspaceSessionDir == null || workspaceSessionDir.length === 0) {
    log.warn("Skipping agent workflow run reference without workspace session dir", { runId });
    return;
  }

  try {
    await recordAgentWorkflowRunReference({ workspaceSessionDir, runId, createdAtMs });
  } catch (error: unknown) {
    log.warn("Failed to record agent workflow run reference", {
      runId,
      error: getErrorMessage(error),
    });
  }
}
