import type { CalculatePermissionsResult } from "./permissionCalculator";

export function requiresReapproval(
  permissions: CalculatePermissionsResult | null | undefined
): boolean {
  if (!permissions || permissions.driftStatus === "fresh") return false;
  if (permissions.pendingNew.length > 0) return true;
  return permissions.driftStatus === "permissions-changed";
}
