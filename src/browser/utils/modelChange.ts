import { getModelKey } from "@/common/constants/storage";
import { normalizeGatewayModel } from "@/common/utils/ai/models";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";

export type ModelChangeOrigin = "user" | "agent" | "sync";

interface ExplicitModelChange {
  model: string;
  origin: ModelChangeOrigin;
}

// User request: keep origin tracking in-memory so UI-only warnings don't add persistence complexity.
const pendingExplicitChanges = new Map<string, ExplicitModelChange>();

const normalizeExplicitModel = (model: string): string => normalizeGatewayModel(model).trim();

export function recordWorkspaceModelChange(
  workspaceId: string,
  model: string,
  origin: ModelChangeOrigin
): void {
  if (origin === "sync") return;
  const normalized = normalizeExplicitModel(model);
  pendingExplicitChanges.set(workspaceId, { model: normalized, origin });
}

export function consumeWorkspaceModelChange(
  workspaceId: string,
  model: string
): ModelChangeOrigin | null {
  const entry = pendingExplicitChanges.get(workspaceId);
  const normalized = normalizeExplicitModel(model);
  if (entry?.model !== normalized) return null;
  pendingExplicitChanges.delete(workspaceId);
  return entry.origin;
}

export function setWorkspaceModelWithOrigin(
  workspaceId: string,
  model: string,
  origin: ModelChangeOrigin
): void {
  recordWorkspaceModelChange(workspaceId, model, origin);
  updatePersistedState(getModelKey(workspaceId), model);
}
