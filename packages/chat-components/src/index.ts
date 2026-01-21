/**
 * @coder/mux-chat-components
 *
 * Shared chat components for rendering Mux conversations.
 *
 * Goal: maximize reuse between the Mux desktop app and mux.md viewer.
 * This package intentionally re-exports Mux's existing chat rendering code
 * (Messages/, tools/, Markdown, DiffRenderer, etc.) instead of maintaining a
 * parallel implementation.
 */

// ============================================================================
// Types
// ============================================================================

export type { DisplayedMessage, MuxMessage } from "../../../src/common/types/message";

export type { SharedConversation, SharedConversationMetadata } from "./sharedConversation";

// ============================================================================
// Contexts
// ============================================================================

export {
  ChatHostContextProvider,
  useChatHostContext,
  type ChatHostActions,
  type ChatHostContextValue,
} from "../../../src/browser/contexts/ChatHostContext";

export {
  THEME_OPTIONS,
  ThemeProvider,
  useTheme,
  type ThemeMode,
} from "../../../src/browser/contexts/ThemeContext";

export { createReadOnlyChatHostContext } from "./readOnlyChatHostContext";

// ============================================================================
// Chat rendering components (re-exported from Mux)
// ============================================================================

export { MessageRenderer } from "../../../src/browser/components/Messages/MessageRenderer";
export {
  MessageWindow,
  type ButtonConfig,
} from "../../../src/browser/components/Messages/MessageWindow";
export { UserMessage } from "../../../src/browser/components/Messages/UserMessage";
export { AssistantMessage } from "../../../src/browser/components/Messages/AssistantMessage";
export { ToolMessage } from "../../../src/browser/components/Messages/ToolMessage";
export { ReasoningMessage } from "../../../src/browser/components/Messages/ReasoningMessage";
export { MarkdownCore } from "../../../src/browser/components/Messages/MarkdownCore";
export { MarkdownRenderer } from "../../../src/browser/components/Messages/MarkdownRenderer";
export { markdownComponents } from "../../../src/browser/components/Messages/MarkdownComponents";
export { Mermaid } from "../../../src/browser/components/Messages/Mermaid";

// Shared renderers
export { DiffRenderer } from "../../../src/browser/components/shared/DiffRenderer";

// ============================================================================
// Tools (re-exported from Mux)
// ============================================================================

export { getToolComponent } from "../../../src/browser/components/tools/shared/getToolComponent";
export * from "../../../src/browser/components/tools/shared/ToolPrimitives";
