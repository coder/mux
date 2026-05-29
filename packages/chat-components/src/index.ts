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

export { MessageRenderer } from "../../../src/browser/features/Messages/MessageRenderer";
export {
  MessageWindow,
  type ButtonConfig,
} from "../../../src/browser/features/Messages/MessageWindow";
export { UserMessage } from "../../../src/browser/features/Messages/UserMessage";
export { AssistantMessage } from "../../../src/browser/features/Messages/AssistantMessage";
export { ToolMessage } from "../../../src/browser/features/Messages/ToolMessage";
export { ReasoningMessage } from "../../../src/browser/features/Messages/ReasoningMessage";
export { MarkdownCore } from "../../../src/browser/features/Messages/MarkdownCore";
export { MarkdownRenderer } from "../../../src/browser/features/Messages/MarkdownRenderer";
export { markdownComponents } from "../../../src/browser/features/Messages/MarkdownComponents";
export { Mermaid } from "../../../src/browser/features/Messages/Mermaid";

// Shared renderers
export { DiffRenderer } from "../../../src/browser/features/Shared/DiffRenderer";

// ============================================================================
// Tools (re-exported from Mux)
// ============================================================================

export { getToolComponent } from "../../../src/browser/features/Tools/Shared/getToolComponent";
export * from "../../../src/browser/features/Tools/Shared/ToolPrimitives";
