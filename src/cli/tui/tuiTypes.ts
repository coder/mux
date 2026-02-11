import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@/node/orpc/router";
import type { WorkspaceChatMessage } from "@/common/orpc/types";

export type APIClient = RouterClient<AppRouter>;

// Preserve a direct link to the shared chat message type for upcoming screen implementations.
export type TuiWorkspaceChatMessage = WorkspaceChatMessage;

// Navigation screens
export type Screen =
  | { type: "projects" }
  | { type: "workspaces"; projectPath: string; projectName: string }
  | { type: "chat"; workspaceId: string; projectPath: string; projectName: string }
  | { type: "createProject" }
  | { type: "createWorkspace"; projectPath: string; projectName: string };

// Project metadata (from api.projects.list)
export interface TuiProject {
  path: string;
  name: string;
}

// Workspace metadata (simplified from WorkspaceMetadata)
export interface TuiWorkspace {
  id: string;
  name: string;
  title?: string;
  projectPath: string;
  projectName: string;
}

// Chat state
export interface ChatState {
  messages: ChatMessage[];
  streamingBuffer: string;
  isStreaming: boolean;
  isCaughtUp: boolean;
  activeToolCalls: Map<string, ActiveToolCall>;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCallSummary[];
}

export interface ActiveToolCall {
  toolName: string;
  status: string;
}

export interface ToolCallSummary {
  toolName: string;
  result?: string;
}

// TUI global state
export interface TuiState {
  screen: Screen;
  projects: TuiProject[];
  workspaces: TuiWorkspace[];
  chat: ChatState;
  loading: boolean;
  error: string | null;
}

// Actions
export type TuiAction =
  | { type: "NAVIGATE"; screen: Screen }
  | { type: "SET_PROJECTS"; projects: TuiProject[] }
  | { type: "SET_WORKSPACES"; workspaces: TuiWorkspace[] }
  | { type: "SET_LOADING"; loading: boolean }
  | { type: "SET_ERROR"; error: string | null }
  | { type: "CHAT_CAUGHT_UP" }
  | { type: "CHAT_ADD_MESSAGE"; message: ChatMessage }
  | { type: "CHAT_STREAM_START" }
  | { type: "CHAT_STREAM_DELTA"; delta: string }
  | { type: "CHAT_STREAM_END" }
  | { type: "CHAT_STREAM_ABORT" }
  | { type: "CHAT_TOOL_CALL_START"; toolCallId: string; toolName: string }
  | { type: "CHAT_TOOL_CALL_END"; toolCallId: string }
  | { type: "CHAT_RESET" };

// Options passed from CLI flags
export interface TuiOptions {
  model: string;
  agentId: string;
}
