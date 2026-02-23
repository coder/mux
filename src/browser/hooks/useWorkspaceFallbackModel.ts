import { usePersistedState } from "./usePersistedState";
import { migrateGatewayModel } from "./useGatewayModels";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { DEFAULT_MODEL_KEY, getModelKey } from "@/common/constants/storage";

/**
 * Resolves the effective model for a workspace by combining the global default
 * model preference with the workspace-scoped preference.
 *
 * This subscribes to both storage keys with `{ listener: true }` so changes
 * (including backend-seeded values on fresh origins) propagate immediately.
 */
export function useWorkspaceFallbackModel(workspaceId: string): string {
  // Subscribe to the global default model preference so backend-seeded values
  // apply immediately on fresh origins (e.g., when switching ports).
  const [defaultModelPref] = usePersistedState<string>(
    DEFAULT_MODEL_KEY,
    WORKSPACE_DEFAULTS.model,
    {
      listener: true,
    }
  );
  const defaultModel = migrateGatewayModel(defaultModelPref).trim() || WORKSPACE_DEFAULTS.model;

  // Workspace-scoped model preference. If unset, fall back to the global default model.
  // Note: we intentionally *don't* pass defaultModel as the usePersistedState initialValue;
  // initialValue is sticky and would lock in the fallback before startup seeding.
  const [preferredModel] = usePersistedState<string | null>(getModelKey(workspaceId), null, {
    listener: true,
  });

  if (typeof preferredModel === "string" && preferredModel.trim().length > 0) {
    return migrateGatewayModel(preferredModel.trim());
  }
  return defaultModel;
}
