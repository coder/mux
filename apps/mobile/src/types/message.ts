export type DisplayedMessage =
  | {
      type: "user";
      id: string;
      historyId: string;
      content: string;
      imageParts?: Array<{ url: string; mediaType?: string }>;
      historySequence: number;
      timestamp?: number;
    }
  | {
      type: "assistant";
      id: string;
      historyId: string;
      content: string;
      historySequence: number;
      streamSequence?: number;
      isStreaming: boolean;
      isPartial: boolean;
      isLastPartOfMessage?: boolean;
      isCompacted: boolean;
      model?: string;
      timestamp?: number;
      tokens?: number;
    }
  | {
      type: "tool";
      id: string;
      historyId: string;
      toolCallId: string;
      toolName: string;
      args: unknown;
      result?: unknown;
      status: "pending" | "executing" | "completed" | "failed" | "interrupted";
      isPartial: boolean;
      historySequence: number;
      streamSequence?: number;
      isLastPartOfMessage?: boolean;
      timestamp?: number;
    }
  | {
      type: "reasoning";
      id: string;
      historyId: string;
      content: string;
      historySequence: number;
      streamSequence?: number;
      isStreaming: boolean;
      isPartial: boolean;
      isLastPartOfMessage?: boolean;
      timestamp?: number;
      tokens?: number;
    }
  | {
      type: "stream-error";
      id: string;
      historyId: string;
      error: string;
      errorType: string;
      historySequence: number;
      timestamp?: number;
      model?: string;
      errorCount?: number;
    }
  | {
      type: "history-hidden";
      id: string;
      hiddenCount: number;
      historySequence: number;
    }
  | {
      type: "workspace-init";
      id: string;
      historySequence: number;
      status: "running" | "success" | "error";
      hookPath: string;
      lines: string[];
      exitCode: number | null;
      timestamp: number;
    };
