import type { ImagePart } from "@/common/orpc/types";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { TelemetryRuntimeType } from "@/common/telemetry/payload";
import type { AutoCompactionCheckResult } from "@/browser/utils/compaction/autoCompactionCheck";
import type { Review } from "@/common/types/review";

export interface ChatInputAPI {
  focus: () => void;
  restoreText: (text: string) => void;
  appendText: (text: string) => void;
  prependText: (text: string) => void;
  restoreImages: (images: ImagePart[]) => void;
}

// Workspace variant: full functionality for existing workspaces
export interface ChatInputWorkspaceVariant {
  variant: "workspace";
  workspaceId: string;
  /** Runtime type for the workspace (for telemetry) - no sensitive details like SSH host */
  runtimeType?: TelemetryRuntimeType;
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
  autoCompactionCheck?: AutoCompactionCheckResult; // Computed in parent (AIView) to avoid duplicate calculation
  /** Reviews currently attached to chat (from useReviews hook) */
  attachedReviews?: Review[];
  /** Detach a review from chat input (sets status to pending) */
  onDetachReview?: (reviewId: string) => void;
  /** Detach all attached reviews from chat input */
  onDetachAllReviews?: () => void;
  /** Mark reviews as checked after sending */
  onCheckReviews?: (reviewIds: string[]) => void;
  /** Update a review's comment/note */
  onUpdateReviewNote?: (reviewId: string, newNote: string) => void;
}

// Creation variant: simplified for first message / workspace creation
export interface ChatInputCreationVariant {
  variant: "creation";
  projectPath: string;
  projectName: string;
  onWorkspaceCreated: (metadata: FrontendWorkspaceMetadata) => void;
  onProviderConfig?: (provider: string, keyPath: string[], value: string) => Promise<void>;
  onModelChange?: (model: string) => void;
  disabled?: boolean;
  onReady?: (api: ChatInputAPI) => void;
}

export type ChatInputProps = ChatInputWorkspaceVariant | ChatInputCreationVariant;
