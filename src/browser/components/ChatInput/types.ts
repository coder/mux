import type { ImagePart } from "@/common/types/ipc";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";

export interface ChatInputAPI {
  focus: () => void;
  restoreText: (text: string) => void;
  appendText: (text: string) => void;
  restoreImages: (images: ImagePart[]) => void;
}

// Workspace variant: full functionality for existing workspaces
export interface ChatInputWorkspaceVariant {
  variant: "workspace";
  workspaceId: string;
  onMessageSent?: () => void;
  onTruncateHistory: (percentage?: number) => Promise<void>;
  onProviderConfig?: (provider: string, keyPath: string[], value: string) => Promise<void>;
  onModelChange?: (model: string) => void;
  isCompacting?: boolean;
  editingMessage?: { id: string; content: string };
  onCancelEdit?: () => void;
  onEditLastUserMessage?: () => void;
  canInterrupt?: boolean;
  disabled?: boolean;
  onReady?: (api: ChatInputAPI) => void;
}

// Creation variant: simplified for first message / workspace creation
export interface ChatInputCreationVariant {
  variant: "creation";
  projectPath: string;
  projectName: string;
  onWorkspaceCreated: (metadata: FrontendWorkspaceMetadata) => void;
  onCancel?: () => void;
  disabled?: boolean;
  onReady?: (api: ChatInputAPI) => void;
}

export type ChatInputProps = ChatInputWorkspaceVariant | ChatInputCreationVariant;
