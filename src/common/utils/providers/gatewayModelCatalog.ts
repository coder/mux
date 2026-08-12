import type { ProviderModelEntry } from "@/common/orpc/types";

import { normalizeCopilotModelId } from "@/common/utils/copilot/modelRouting";
import { maybeGetProviderModelEntryId } from "@/common/utils/providers/modelEntries";

export function isProviderModelAccessibleFromAuthoritativeCatalog(
  provider: string,
  modelId: string,
  models: ProviderModelEntry[] | undefined
): boolean {
  // Coder's models list is the AI Bridge catalog discovered at login (always
  // overwritten, including with an empty list; users may append manual
  // entries). The bridge only serves models its upstreams expose, so routing
  // any other model through Coder would fail at the bridge instead of falling
  // back to a configured direct provider — treat the stored list as
  // exhaustive and fail closed when it is missing.
  if (provider === "coder") {
    if (!Array.isArray(models)) {
      return false;
    }
    for (const entry of models) {
      const configuredModelId = maybeGetProviderModelEntryId(entry);
      if (configuredModelId != null && configuredModelId === modelId) {
        return true;
      }
    }
    return false;
  }

  // Most provider config model lists are user-managed custom entries, not exhaustive
  // server catalogs. GitHub Copilot is the other exception because OAuth refresh
  // stores the full model catalog returned by Copilot's /models endpoint.
  if (provider !== "github-copilot") {
    return true;
  }

  if (!Array.isArray(models) || models.length === 0) {
    return true;
  }

  const normalizedModelId = normalizeCopilotModelId(modelId);
  let foundValidEntry = false;
  for (const entry of models) {
    const configuredModelId = maybeGetProviderModelEntryId(entry);
    if (configuredModelId == null) {
      continue;
    }

    foundValidEntry = true;
    if (normalizeCopilotModelId(configuredModelId) === normalizedModelId) {
      return true;
    }
  }

  return !foundValidEntry;
}

export function isGatewayModelAccessibleFromAuthoritativeCatalog(
  gateway: string,
  modelId: string,
  models: ProviderModelEntry[] | undefined
): boolean {
  return isProviderModelAccessibleFromAuthoritativeCatalog(gateway, modelId, models);
}
