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

export const initialChatState: ChatState = createInitialChatState();

export const initialState: TuiState = {
  screen: { type: "projects" },
  projects: [],
  workspaces: [],
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
    case "NAVIGATE": {
      const isLeavingChat = state.screen.type === "chat" && action.screen.type !== "chat";
      return {
        ...state,
        screen: action.screen,
        chat: isLeavingChat ? createInitialChatState() : state.chat,
      };
    }
    case "SET_PROJECTS":
      return {
        ...state,
        projects: action.projects,
      };
    case "SET_WORKSPACES":
      return {
        ...state,
        workspaces: action.workspaces,
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
      return {
        ...state,
        chat: {
          ...state.chat,
          messages: assistantMessage
            ? [...state.chat.messages, assistantMessage]
            : state.chat.messages,
          isStreaming: false,
          streamingBuffer: "",
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
      activeToolCalls.delete(action.toolCallId);
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
