import { type ServiceTier } from "@/common/config/schemas/providersConfig";
import { getServiceTierKey } from "@/common/constants/storage";
import { usePersistedState } from "./usePersistedState";

/**
 * Chat-specific (per workspace/project scope) service-tier override.
 *
 * `null` means "no override" — the provider/global default applies. Backed by
 * localStorage (keyed by scope) with cross-component sync so the chat-input bolt
 * and the send path stay in agreement without prop drilling.
 *
 * Unlike thinking level, this is intentionally NOT persisted to backend metadata:
 * the tier rides along with each send via `providerOptions.openai.serviceTier`,
 * so localStorage is the single source of truth (mirroring the other provider
 * option toggles like Anthropic 1M context).
 *
 * @param scopeId workspaceId (workspace view) or a project scope id (creation view)
 * @returns `[serviceTier, setServiceTier]` tuple
 */
export function useServiceTier(scopeId: string) {
  const [serviceTier, setServiceTier] = usePersistedState<ServiceTier | null>(
    getServiceTierKey(scopeId),
    null,
    { listener: true }
  );
  return [serviceTier, setServiceTier] as const;
}
