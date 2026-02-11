import type { ChatMessage, ChatState, TuiAction, TuiState } from "./tuiTypes";

function createInitialChatState(): ChatState {
  return {
    messages: [],
    streamingBuffer: "",
    isStreaming: false,
    isCaughtUp: false,
    activeToolCalls: new Map(),
  };
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) {
    return 0;
  }

  if (index < 0) {
    return 0;
  }

  if (index >= length) {
    return length - 1;
  }

  return index;
}

export const initialChatState: ChatState = createInitialChatState();

export const initialState: TuiState = {
  focus: "sidebar-projects",
  selectedProjectIndex: 0,
  selectedWorkspaceIndex: 0,
  projects: [],
  workspaces: [],
  workspaceActivity: {},
  activeWorkspaceId: null,
  activeProjectPath: null,
  activeProjectName: null,
  chat: createInitialChatState(),
  loading: false,
  error: null,
};

function buildAssistantMessage(content: string): ChatMessage {
  return {
    role: "assistant",
    content,
  };
}

export function tuiReducer(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case "SET_FOCUS":
      return {
        ...state,
        focus: action.focus,
      };
    case "SET_PROJECTS":
      return {
        ...state,
        projects: action.projects,
        selectedProjectIndex: clampIndex(state.selectedProjectIndex, action.projects.length),
      };
    case "SET_WORKSPACES":
      return {
        ...state,
        workspaces: action.workspaces,
        selectedWorkspaceIndex: clampIndex(state.selectedWorkspaceIndex, action.workspaces.length),
      };
    case "SET_WORKSPACE_ACTIVITY":
      return {
        ...state,
        workspaceActivity: action.activity,
      };
    case "SELECT_PROJECT":
      return {
        ...state,
        selectedProjectIndex: clampIndex(action.index, state.projects.length),
        selectedWorkspaceIndex: 0,
      };
    case "SELECT_WORKSPACE":
      return {
        ...state,
        selectedWorkspaceIndex: clampIndex(action.index, state.workspaces.length),
      };
    case "OPEN_WORKSPACE":
      return {
        ...state,
        activeWorkspaceId: action.workspaceId,
        activeProjectPath: action.projectPath,
        activeProjectName: action.projectName,
      };
    case "CLOSE_WORKSPACE":
      return {
        ...state,
        focus: "sidebar-workspaces",
        activeWorkspaceId: null,
        activeProjectPath: null,
        activeProjectName: null,
        chat: createInitialChatState(),
      };
    case "SET_LOADING":
      return {
        ...state,
        loading: action.loading,
      };
    case "SET_ERROR":
      return {
        ...state,
        error: action.error,
      };
    case "CHAT_CAUGHT_UP":
      return {
        ...state,
        chat: {
          ...state.chat,
          isCaughtUp: true,
        },
      };
    case "CHAT_ADD_MESSAGE":
      return {
        ...state,
        chat: {
          ...state.chat,
          messages: [...state.chat.messages, action.message],
        },
      };
    case "CHAT_STREAM_START":
      return {
        ...state,
        chat: {
          ...state.chat,
          isStreaming: true,
          streamingBuffer: "",
        },
      };
    case "CHAT_STREAM_DELTA":
      return {
        ...state,
        chat: {
          ...state.chat,
          streamingBuffer: state.chat.streamingBuffer + action.delta,
        },
      };
    case "CHAT_STREAM_END": {
      const assistantMessage = state.chat.streamingBuffer
        ? buildAssistantMessage(state.chat.streamingBuffer)
        : null;
      const activeToolCalls = new Map(
        Array.from(state.chat.activeToolCalls.entries()).filter(([, toolCall]) => {
          // Keep only running calls between streams so finished call results don't accumulate forever.
          return toolCall.status === "running";
        })
      );

      return {
        ...state,
        chat: {
          ...state.chat,
          messages: assistantMessage
            ? [...state.chat.messages, assistantMessage]
            : state.chat.messages,
          isStreaming: false,
          streamingBuffer: "",
          activeToolCalls,
        },
      };
    }
    case "CHAT_STREAM_ABORT":
      return {
        ...state,
        chat: {
          ...state.chat,
          isStreaming: false,
          streamingBuffer: "",
          activeToolCalls: new Map(),
        },
      };
    case "CHAT_TOOL_CALL_START": {
      const activeToolCalls = new Map(state.chat.activeToolCalls);
      activeToolCalls.set(action.toolCallId, {
        toolName: action.toolName,
        status: "running",
      });
      return {
        ...state,
        chat: {
          ...state.chat,
          activeToolCalls,
        },
      };
    }
    case "CHAT_TOOL_CALL_END": {
      const activeToolCalls = new Map(state.chat.activeToolCalls);
      const existing = activeToolCalls.get(action.toolCallId);

      if (existing) {
        activeToolCalls.set(action.toolCallId, {
          ...existing,
          status: "completed",
          result: action.result,
        });
      }

      return {
        ...state,
        chat: {
          ...state.chat,
          activeToolCalls,
        },
      };
    }
    case "CHAT_RESET":
      return {
        ...state,
        chat: createInitialChatState(),
      };
    default:
      return state;
  }
}
