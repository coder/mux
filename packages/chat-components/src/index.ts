/**
 * @coder/mux-chat-components
 *
 * Shared chat components for rendering Mux conversations.
 * Used by Mux desktop app and mux.md viewer.
 */

// Types
export type {
  // Message types
  MuxMessage,
  MuxTextPart,
  MuxReasoningPart,
  MuxImagePart,
  MuxToolPart,
  MuxMessagePart,
  MuxMetadata,
  // Displayed message types
  DisplayedMessage,
  DisplayedUserMessage,
  DisplayedAssistantMessage,
  DisplayedToolMessage,
  DisplayedReasoningMessage,
  DisplayedStreamErrorMessage,
  DisplayedHistoryHiddenMessage,
  DisplayedInitMessage,
  DisplayedPlanMessage,
  // Shared conversation format
  SharedConversation,
  SharedConversationMetadata,
} from "./types";

// Contexts
export {
  ChatHostContextProvider,
  useChatHostContext,
  createReadOnlyContext,
  CHAT_UI_FEATURE_IDS,
  type ChatHostContextValue,
  type ChatHostActions,
  type ChatUiSupport,
  type ChatUiFeatureId,
} from "./contexts/ChatHostContext";

export {
  ThemeProvider,
  useTheme,
  THEME_OPTIONS,
  type ThemeMode,
} from "./contexts/ThemeContext";

// Components
export { MessageRenderer } from "./components/Messages/MessageRenderer";
export { MessageWindow, type ButtonConfig } from "./components/Messages/MessageWindow";
export { UserMessage } from "./components/Messages/UserMessage";
export { AssistantMessage } from "./components/Messages/AssistantMessage";
export { ReasoningMessage } from "./components/Messages/ReasoningMessage";
export { MarkdownRenderer } from "./components/Messages/MarkdownRenderer";
export { GenericToolCall } from "./components/tools/GenericToolCall";

// Utilities
export { cn } from "./utils/cn";

// CSS import path (for documentation)
// Consumers should import: import "@coder/mux-chat-components/styles"
