import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@/node/orpc/router";
import type { WorkspaceChatMessage } from "@/common/orpc/types";

export type APIClient = RouterClient<AppRouter>;

export type TuiWorkspaceChatMessage = WorkspaceChatMessage;

// Focus determines which pane consumes keyboard input.
export type FocusArea =
  | "sidebar-projects"
  | "sidebar-workspaces"
  | "chat"
  | "create-project"
  | "create-workspace";

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

export interface WorkspaceActivity {
  streaming: boolean;
  recency: number;
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
  // Sidebar
  focus: FocusArea;
  selectedProjectIndex: number;
  selectedWorkspaceIndex: number;
  projects: TuiProject[];
  workspaces: TuiWorkspace[];
  workspaceActivity: Record<string, WorkspaceActivity>;

  // Active workspace shown in the main panel
  activeWorkspaceId: string | null;
  activeProjectPath: string | null;
  activeProjectName: string | null;

  // Chat
  chat: ChatState;

  // Status
  loading: boolean;
  error: string | null;
}

// Actions
export type TuiAction =
  | { type: "SET_FOCUS"; focus: FocusArea }
  | { type: "SET_PROJECTS"; projects: TuiProject[] }
  | { type: "SET_WORKSPACES"; workspaces: TuiWorkspace[] }
  | { type: "SET_WORKSPACE_ACTIVITY"; activity: Record<string, WorkspaceActivity> }
  | { type: "SELECT_PROJECT"; index: number }
  | { type: "SELECT_WORKSPACE"; index: number }
  | {
      type: "OPEN_WORKSPACE";
      workspaceId: string;
      projectPath: string;
      projectName: string;
    }
  | { type: "CLOSE_WORKSPACE" }
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
