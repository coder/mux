export interface WorkspaceMetadata {
  id: string;
  name: string;
  projectName: string;
  projectPath: string;
  createdAt?: string;
  runtimeConfig?: Record<string, unknown>;
}

export interface FrontendWorkspaceMetadata extends WorkspaceMetadata {
  namedWorkspacePath: string;
}

export type WorkspaceChatEvent =
  | import("./message").DisplayedMessage
  | { type: "delete"; historySequences: number[] }
  | { type: "caught-up" }
  | { type: "stream-error"; messageId: string; error: string; errorType: string }
  | { type: string; [key: string]: unknown };
