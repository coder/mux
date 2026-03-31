import type { ProviderModelEntry } from "@/common/orpc/types";

import { getProviderModelEntryId } from "@/common/utils/providers/modelEntries";

export function isGatewayModelAccessibleFromAuthoritativeCatalog(
  gateway: string,
  modelId: string,
  models: ProviderModelEntry[] | undefined
): boolean {
  // Most provider config model lists are user-managed custom entries, not exhaustive
  // server catalogs. GitHub Copilot is the current exception because OAuth refresh
  // stores the full model catalog returned by Copilot's /models endpoint.
  if (gateway !== "github-copilot") {
    return true;
  }

  if (!Array.isArray(models) || models.length === 0) {
    return true;
  }

  return models.some((entry) => getProviderModelEntryId(entry) === modelId);
}
