import { Err, Ok, type Result } from "@/common/types/result";
import { validateWorkspaceName } from "@/common/utils/validation/workspaceValidation";
import { buildWorkspaceNameWithSuffix } from "@/common/utils/workspaceNaming";
import { findNextForkSuffix, generateForkNameWithSuffix } from "@/node/services/forkNameGenerator";

export type WorkspaceNameCollisionStrategy =
  | { type: "error" }
  | { type: "random-suffix"; maxAttempts: number }
  | { type: "numeric-suffix" };

export interface WorkspaceNameResolution {
  name: string;
  suffix?: number;
}

function generateRandomSuffix(): string {
  return Math.random().toString(36).substring(2, 6);
}

function validateResolvedName(name: string): Result<string> {
  const validation = validateWorkspaceName(name);
  if (!validation.valid) {
    return Err(validation.error ?? "Invalid workspace name");
  }
  return Ok(name);
}

/**
 * Resolve a workspace name using a collision strategy and shared validation rules.
 */
export function resolveWorkspaceName(
  requestedName: string,
  existingNames: Set<string>,
  strategy: WorkspaceNameCollisionStrategy
): Result<WorkspaceNameResolution> {
  const validation = validateWorkspaceName(requestedName);
  if (!validation.valid) {
    return Err(validation.error ?? "Invalid workspace name");
  }

  if (strategy.type === "numeric-suffix") {
    const suffix = findNextForkSuffix(requestedName, existingNames);
    const candidate = generateForkNameWithSuffix(requestedName, suffix);
    const resolved = validateResolvedName(candidate);
    if (!resolved.success) {
      return Err(resolved.error);
    }
    return Ok({ name: resolved.data, suffix });
  }

  if (!existingNames.has(requestedName)) {
    return Ok({ name: requestedName });
  }

  if (strategy.type === "error") {
    return Err(`Workspace with name "${requestedName}" already exists`);
  }

  const attemptedNames = new Set(existingNames);
  for (let attempt = 0; attempt < strategy.maxAttempts; attempt++) {
    const suffix = generateRandomSuffix();
    const candidate = buildWorkspaceNameWithSuffix(requestedName, suffix);
    if (attemptedNames.has(candidate)) {
      continue;
    }
    attemptedNames.add(candidate);
    const resolved = validateResolvedName(candidate);
    if (!resolved.success) {
      return Err(resolved.error);
    }
    return Ok({ name: resolved.data });
  }

  return Err(`Unable to resolve unique workspace name for "${requestedName}"`);
}
