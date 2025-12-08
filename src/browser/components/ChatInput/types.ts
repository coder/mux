import type { ImagePart } from "@/common/orpc/types";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { TelemetryRuntimeType } from "@/common/telemetry/payload";
import type { AutoCompactionCheckResult } from "@/browser/utils/compaction/autoCompactionCheck";
import type { PendingReview } from "@/common/types/review";

export interface ChatInputAPI {
  focus: () => void;
  restoreText: (text: string) => void;
  appendText: (text: string) => void;
  prependText: (text: string) => void;
  restoreImages: (images: ImagePart[]) => void;
  /** Attach a review by ID (shows in preview, included when sending) */
  attachReview: (reviewId: string) => void;
  /** Detach a review by ID */
  detachReview: (reviewId: string) => void;
  /** Get currently attached review IDs */
  getAttachedReviews: () => string[];
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
  /** Called after reviews are sent in a message - allows parent to mark them as checked */
  onReviewsSent?: (reviewIds: string[]) => void;
  /** Called when attached reviews change (for syncing with banner) */
  onAttachedReviewsChange?: (reviewIds: string[]) => void;
  /** Get a pending review by ID (for resolving attached review IDs to data) */
  getReview?: (id: string) => PendingReview | undefined;
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
