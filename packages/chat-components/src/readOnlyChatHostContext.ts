import {
  CHAT_UI_FEATURE_IDS,
  type ChatUiFeatureId,
  type ChatUiSupport,
} from "../../../src/common/constants/chatUiFeatures";
import type { ChatHostContextValue } from "../../../src/browser/contexts/ChatHostContext";

/**
 * Convenience helper for mux.md (and any other read-only hosts).
 *
 * The Mux UI already gates certain affordances behind ChatHostContext uiSupport
 * flags, and all actions are optional. For a viewer, we typically want:
 * - no editing / command palette / foreground bash controls
 * - JSON raw view enabled for debugging
 */
export function createReadOnlyChatHostContext(
  overrides?: Partial<Record<ChatUiFeatureId, ChatUiSupport>>
): ChatHostContextValue {
  const uiSupport = CHAT_UI_FEATURE_IDS.reduce(
    (acc, featureId) => {
      acc[featureId] = "unsupported";
      return acc;
    },
    {} as Record<ChatUiFeatureId, ChatUiSupport>
  );

  // Viewer-friendly defaults
  uiSupport.jsonRawView = "supported";
  uiSupport.imageAttachments = "supported";

  if (overrides) {
    for (const [k, v] of Object.entries(overrides) as Array<[ChatUiFeatureId, ChatUiSupport]>) {
      uiSupport[k] = v;
    }
  }

  return {
    uiSupport,
    actions: {},
  };
}
