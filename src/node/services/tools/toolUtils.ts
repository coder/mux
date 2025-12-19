import assert from "node:assert/strict";

import type { z } from "zod";

import type { ToolConfiguration } from "@/common/utils/tools/tools";
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
