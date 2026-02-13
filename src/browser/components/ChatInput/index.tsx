import React, { useState, useRef, useCallback, useEffect, useId, useMemo } from "react";
import {
  CommandSuggestions,
  COMMAND_SUGGESTION_KEYS,
  FILE_SUGGESTION_KEYS,
} from "../CommandSuggestions";
import type { Toast } from "../ChatInputToast";
import { ConnectionStatusToast } from "../ConnectionStatusToast";
import { ChatInputToast } from "../ChatInputToast";
import type { SendMessageError } from "@/common/types/errors";
import { createErrorToast } from "../ChatInputToasts";
import { ConfirmationModal } from "../ConfirmationModal";
import type { ParsedCommand } from "@/browser/utils/slashCommands/types";
import { parseCommand } from "@/browser/utils/slashCommands/parser";
import {
  readPersistedState,
  usePersistedState,
  updatePersistedState,
} from "@/browser/hooks/usePersistedState";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import { useAgent } from "@/browser/contexts/AgentContext";
import { ThinkingSliderComponent } from "../ThinkingSlider";
import {
  getAllowedRuntimeModesForUi,
  isParsedRuntimeAllowedByPolicy,
} from "@/browser/utils/policyUi";
import { usePolicy } from "@/browser/contexts/PolicyContext";
import { useAPI } from "@/browser/contexts/API";
import { useThinkingLevel } from "@/browser/hooks/useThinkingLevel";
import { migrateGatewayModel } from "@/browser/hooks/useGatewayModels";
import { useSendMessageOptions } from "@/browser/hooks/useSendMessageOptions";
import { setWorkspaceModelWithOrigin } from "@/browser/utils/modelChange";
import {
  clearPendingWorkspaceAiSettings,
  markPendingWorkspaceAiSettings,
} from "@/browser/utils/workspaceAiSettingsSync";
import {
  getModelKey,
  getThinkingLevelKey,
  getWorkspaceAISettingsByAgentKey,
  getInputKey,
  getInputAttachmentsKey,
  AGENT_AI_DEFAULTS_KEY,
  VIM_ENABLED_KEY,
  RUNTIME_ENABLEMENT_KEY,
  getProjectScopeId,
  getPendingScopeId,
  getDraftScopeId,
  getPendingWorkspaceSendErrorKey,
  getWorkspaceLastReadKey,
} from "@/common/constants/storage";
import {
  prepareCompactionMessage,
  processSlashCommand,
  type SlashCommandContext,
} from "@/browser/utils/chatCommands";
import { Button } from "../ui/button";
import { CUSTOM_EVENTS } from "@/common/constants/events";
import { findAtMentionAtCursor } from "@/common/utils/atMentions";
import {
  getSlashCommandSuggestions,
  type SlashSuggestion,
} from "@/browser/utils/slashCommands/suggestions";
import { Tooltip, TooltipTrigger, TooltipContent, HelpIndicator } from "../ui/tooltip";
import { AgentModePicker } from "../AgentModePicker";
import { ContextUsageIndicatorButton } from "../ContextUsageIndicatorButton";
import { useWorkspaceUsage } from "@/browser/stores/WorkspaceStore";
import { useProviderOptions } from "@/browser/hooks/useProviderOptions";
import { useProvidersConfig } from "@/browser/hooks/useProvidersConfig";
import { useAutoCompactionSettings } from "@/browser/hooks/useAutoCompactionSettings";
import { useIdleCompactionHours } from "@/browser/hooks/useIdleCompactionHours";
import { calculateTokenMeterData } from "@/common/utils/tokens/tokenMeterUtils";
import {
  matchesKeybind,
  formatKeybind,
  KEYBINDS,
  isEditableElement,
} from "@/browser/utils/ui/keybinds";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { ModelSelector, type ModelSelectorRef } from "../ModelSelector";
import { useModelsFromSettings } from "@/browser/hooks/useModelsFromSettings";
import { SendHorizontal } from "lucide-react";
import { VimTextArea } from "../VimTextArea";
import { ChatAttachments, type ChatAttachment } from "../ChatAttachments";
import {
  extractAttachmentsFromClipboard,
  extractAttachmentsFromDrop,
  chatAttachmentsToFileParts,
  processAttachmentFiles,
} from "@/browser/utils/attachmentsHandling";
import type { PendingUserMessage } from "@/browser/utils/chatEditing";

import type { AgentSkillDescriptor } from "@/common/types/agentSkill";
import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";
import { coerceThinkingLevel, type ThinkingLevel } from "@/common/types/thinking";
import { DEFAULT_RUNTIME_ENABLEMENT, normalizeRuntimeEnablement } from "@/common/types/runtime";
import { resolveThinkingInput } from "@/common/utils/thinking/policy";
import {
  type MuxMessageMetadata,
  type ReviewNoteDataForDisplay,
  prepareUserMessageForSend,
} from "@/common/types/message";
import type { Review } from "@/common/types/review";
import {
  getModelCapabilities,
  getModelCapabilitiesResolved,
} from "@/common/utils/ai/modelCapabilities";
import { KNOWN_MODELS, MODEL_ABBREVIATION_EXAMPLES } from "@/common/constants/knownModels";
import { useTelemetry } from "@/browser/hooks/useTelemetry";
import { trackCommandUsed } from "@/common/telemetry";
import type { FilePart, SendMessageOptions } from "@/common/orpc/types";

import { CreationCenterContent } from "./CreationCenterContent";
import { cn } from "@/common/lib/utils";
import type { ChatInputProps, ChatInputAPI } from "./types";
import { CreationControls } from "./CreationControls";
import { CodexOauthWarningBanner } from "./CodexOauthWarningBanner";
import { useCreationWorkspace } from "./useCreationWorkspace";
import { useCoderWorkspace } from "@/browser/hooks/useCoderWorkspace";
import { useTutorial } from "@/browser/contexts/TutorialContext";
import { usePowerMode } from "@/browser/contexts/PowerModeContext";
import { useVoiceInput } from "@/browser/hooks/useVoiceInput";
import { VoiceInputButton } from "./VoiceInputButton";
import {
  estimatePersistedChatAttachmentsChars,
  readPersistedChatAttachments,
} from "./draftAttachmentsStorage";
import { RecordingOverlay } from "./RecordingOverlay";
import { AttachedReviewsPanel } from "./AttachedReviewsPanel";
import {
  buildSkillInvocationMetadata,
  parseCommandWithSkillInvocation,
  validateCreationRuntime,
  filePartsToChatAttachments,
  type SkillResolutionTarget,
} from "./utils";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";

// localStorage quotas are environment-dependent and relatively small.
// Be conservative here so we can warn the user before writes start failing.

const PDF_MEDIA_TYPE = "application/pdf";

function getBaseMediaType(mediaType: string): string {
  return mediaType.toLowerCase().trim().split(";")[0];
}

function estimateBase64DataUrlBytes(dataUrl: string): number | null {
  if (!dataUrl.startsWith("data:")) return null;

  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) return null;

  const header = dataUrl.slice("data:".length, commaIndex);
  if (!header.includes(";base64")) return null;

  const base64 = dataUrl.slice(commaIndex + 1);
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}
const MAX_PERSISTED_ATTACHMENT_DRAFT_CHARS = 4_000_000;

export type { ChatInputProps, ChatInputAPI };

const ChatInputInner: React.FC<ChatInputProps> = (props) => {
  const { api } = useAPI();
  const policyState = usePolicy();
  const effectivePolicy =
    policyState.status.state === "enforced" ? (policyState.policy ?? null) : null;
  const runtimePolicy = useMemo(
    () => getAllowedRuntimeModesForUi(effectivePolicy),
    [effectivePolicy]
  );
  const { variant } = props;
  const creationProjectPath = variant === "creation" ? props.projectPath : "";
  const creationDraftId = variant === "creation" ? props.pendingDraftId : null;
  const [thinkingLevel] = useThinkingLevel();
  const atMentionProjectPath = variant === "creation" ? props.projectPath : null;
  const workspaceId = variant === "workspace" ? props.workspaceId : null;

  // Extract workspace-specific props with defaults
  const disabled = props.disabled ?? false;
  const editingMessage = variant === "workspace" ? props.editingMessage : undefined;
  const isStreamStarting = variant === "workspace" ? (props.isStreamStarting ?? false) : false;
  const isCompacting = variant === "workspace" ? (props.isCompacting ?? false) : false;
  const [isMobileTouch, setIsMobileTouch] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 768px) and (pointer: coarse)").matches
  );
  useEffect(() => {
    if (typeof window === "undefined") return;

    const mobileTouchMediaQuery = window.matchMedia("(max-width: 768px) and (pointer: coarse)");
    const handleMobileTouchChange = () => {
      setIsMobileTouch(mobileTouchMediaQuery.matches);
    };

    handleMobileTouchChange();
    mobileTouchMediaQuery.addEventListener("change", handleMobileTouchChange);
    return () => {
      mobileTouchMediaQuery.removeEventListener("change", handleMobileTouchChange);
    };
  }, []);
  // runtimeType for telemetry - defaults to "worktree" if not provided
  const runtimeType = variant === "workspace" ? (props.runtimeType ?? "worktree") : "worktree";

  // Callback for model changes (both variants support this)
  const onModelChange = props.onModelChange;

  // Storage keys differ by variant
  const storageKeys = (() => {
    if (variant === "creation") {
      const pendingScopeId =
        typeof props.pendingDraftId === "string" && props.pendingDraftId.trim().length > 0
          ? getDraftScopeId(props.projectPath, props.pendingDraftId)
          : getPendingScopeId(props.projectPath);
      return {
        inputKey: getInputKey(pendingScopeId),
        attachmentsKey: getInputAttachmentsKey(pendingScopeId),
        modelKey: getModelKey(getProjectScopeId(props.projectPath)),
      };
    }
    return {
      inputKey: getInputKey(props.workspaceId),
      attachmentsKey: getInputAttachmentsKey(props.workspaceId),
      modelKey: getModelKey(props.workspaceId),
    };
  })();

  // User request: keep creation runtime controls synced with Settings enablement toggles.
  const [rawRuntimeEnablement] = usePersistedState(
    RUNTIME_ENABLEMENT_KEY,
    DEFAULT_RUNTIME_ENABLEMENT,
    { listener: true }
  );
  const runtimeEnablement = normalizeRuntimeEnablement(rawRuntimeEnablement);

  const [input, setInput] = usePersistedState(storageKeys.inputKey, "", { listener: true });

  // Keep a stable reference to the latest input value so event handlers don't need to rebind
  // on same-length edits (e.g. selection-replace) to know the previous value.
  const latestInputValueRef = useRef(input);
  latestInputValueRef.current = input;
  // Track concurrent sends with a counter (not boolean) to handle queued follow-ups correctly.
  // When a follow-up is queued during stream-start, it resolves immediately but shouldn't
  // clear the "in flight" state until all sends complete.
  const [sendingCount, setSendingCount] = useState(0);
  const isSending = sendingCount > 0;
  const [hideReviewsDuringSend, setHideReviewsDuringSend] = useState(false);
  const [showAtMentionSuggestions, setShowAtMentionSuggestions] = useState(false);
  const [atMentionSuggestions, setAtMentionSuggestions] = useState<SlashSuggestion[]>([]);
  const agentSkillsRequestIdRef = useRef(0);
  const atMentionDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const atMentionRequestIdRef = useRef(0);
  const lastAtMentionScopeIdRef = useRef<string | null>(null);
  const lastAtMentionQueryRef = useRef<string | null>(null);
  const lastAtMentionInputRef = useRef<string>(input);
  const [showCommandSuggestions, setShowCommandSuggestions] = useState(false);

  const [commandSuggestions, setCommandSuggestions] = useState<SlashSuggestion[]>([]);
  const [agentSkillDescriptors, setAgentSkillDescriptors] = useState<AgentSkillDescriptor[]>([]);
  const [toast, setToast] = useState<Toast | null>(null);
  // State for destructive command confirmation modal
  const [pendingDestructiveCommand, setPendingDestructiveCommand] = useState<{
    type: "clear" | "truncate";
    percentage?: number;
  } | null>(null);
  const pushToast = useCallback(
    (nextToast: Omit<Toast, "id">) => {
      setToast({ id: Date.now().toString(), ...nextToast });
    },
    [setToast]
  );
  // Subscribe to pending send errors from creation flow. Uses listener: true so
  // late failures (e.g., slow devcontainer startup) still surface a toast.
  const pendingErrorKey =
    variant === "workspace" && workspaceId ? getPendingWorkspaceSendErrorKey(workspaceId) : null;
  const [pendingError, setPendingError] = usePersistedState<SendMessageError | null>(
    pendingErrorKey ?? "__unused__",
    null,
    { listener: true }
  );
  useEffect(() => {
    if (!pendingErrorKey || !pendingError) return;
    setToast(createErrorToast(pendingError));
    setPendingError(null);
  }, [pendingErrorKey, pendingError, setPendingError]);

  const handleToastDismiss = useCallback(() => {
    setToast(null);
  }, []);

  const attachmentDraftTooLargeToastKeyRef = useRef<string | null>(null);

  const [attachments, setAttachmentsState] = useState<ChatAttachment[]>(() => {
    return readPersistedChatAttachments(storageKeys.attachmentsKey);
  });
  // Reviews restored from edits/queued drafts override attached review state while active.
  const [draftReviews, setDraftReviews] = useState<ReviewNoteDataForDisplay[] | null>(null);
  const persistAttachments = useCallback(
    (nextAttachments: ChatAttachment[]) => {
      if (nextAttachments.length === 0) {
        attachmentDraftTooLargeToastKeyRef.current = null;
        updatePersistedState<ChatAttachment[] | undefined>(storageKeys.attachmentsKey, undefined);
        return;
      }

      const estimatedChars = estimatePersistedChatAttachmentsChars(nextAttachments);
      if (estimatedChars > MAX_PERSISTED_ATTACHMENT_DRAFT_CHARS) {
        // Clear persisted value to avoid restoring stale attachments on restart.
        updatePersistedState<ChatAttachment[] | undefined>(storageKeys.attachmentsKey, undefined);

        if (attachmentDraftTooLargeToastKeyRef.current !== storageKeys.attachmentsKey) {
          attachmentDraftTooLargeToastKeyRef.current = storageKeys.attachmentsKey;
          pushToast({
            type: "error",
            message:
              "This draft attachment is too large to save. It will be lost when you switch workspaces or restart.",
            duration: 5000,
          });
        }
        return;
      }

      attachmentDraftTooLargeToastKeyRef.current = null;
      updatePersistedState<ChatAttachment[] | undefined>(
        storageKeys.attachmentsKey,
        nextAttachments
      );
    },
    [storageKeys.attachmentsKey, pushToast]
  );

  // Keep attachment drafts in sync when the storage scope changes (e.g. switching creation projects).
  useEffect(() => {
    attachmentDraftTooLargeToastKeyRef.current = null;
    setAttachmentsState(readPersistedChatAttachments(storageKeys.attachmentsKey));
  }, [storageKeys.attachmentsKey]);
  const setAttachments = useCallback(
    (value: ChatAttachment[] | ((prev: ChatAttachment[]) => ChatAttachment[])) => {
      setAttachmentsState((prev) => {
        const next = value instanceof Function ? value(prev) : value;
        persistAttachments(next);
        return next;
      });
    },
    [persistAttachments]
  );
  // Attached reviews come from parent via props (persisted in pendingReviews state).
  // draftReviews takes precedence when restoring or editing message drafts.
  const attachedReviews = variant === "workspace" ? (props.attachedReviews ?? []) : [];
  // Creation sends can resolve after navigation; guard draft clears on unmounted inputs.
  const isMountedRef = useRef(true);
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const modelSelectorRef = useRef<ModelSelectorRef>(null);
  const powerMode = usePowerMode();
  const [atMentionCursorNonce, setAtMentionCursorNonce] = useState(0);
  const lastAtMentionCursorRef = useRef<number | null>(null);
  const handleAtMentionCursorActivity = useCallback(() => {
    const el = inputRef.current;
    if (!el) {
      return;
    }

    const nextCursor = el.selectionStart ?? input.length;
    if (lastAtMentionCursorRef.current === nextCursor) {
      return;
    }

    lastAtMentionCursorRef.current = nextCursor;
    setAtMentionCursorNonce((n) => n + 1);
  }, [input.length]);

  const handleInputChange = useCallback(
    (next: string, caretFromEvent?: number) => {
      if (powerMode.enabled) {
        const prev = latestInputValueRef.current;
        const delta = next.length - prev.length;

        if (next !== prev) {
          // Power Mode positioning depends on the textarea's post-layout size/position.
          // On backspace/delete the textarea can shrink (auto-resize) which shifts the caret
          // downward; if we measure immediately we can get a stale bounding rect and the
          // fireworks appear out-of-sync with the cursor.
          const intensity = delta > 0 ? Math.min(6, delta) : delta < 0 ? Math.min(6, -delta) : 1;
          const kind = delta < 0 ? "delete" : "insert";
          // Capture the caret index now (before rAF) so bursts queued within the same frame
          // don't all measure the latest caret position and appear "ahead" during fast typing.
          const caretIndex = caretFromEvent ?? inputRef.current?.selectionStart ?? next.length;

          requestAnimationFrame(() => {
            const el = inputRef.current;
            if (!el) {
              return;
            }

            const emit = () => powerMode.burstFromTextarea(el, intensity, kind, caretIndex);

            // When the textarea is scrollable, scrollTop may settle one frame after
            // the layout shift, so defer measurement to a second rAF.
            if (el.scrollHeight > el.clientHeight) {
              requestAnimationFrame(emit);
              return;
            }

            emit();
          });
        }
      }

      setInput(next);
    },
    [powerMode, setInput]
  );

  // Draft state combines text input and attachments.
  // Reviews are sourced separately via attachedReviews unless draftReviews overrides them.
  interface DraftState {
    text: string;
    attachments: ChatAttachment[];
  }
  const getDraft = useCallback(
    (): DraftState => ({ text: input, attachments }),
    [input, attachments]
  );
  const setDraft = useCallback(
    (draft: DraftState) => {
      setInput(draft.text);
      setAttachments(draft.attachments);
    },
    [setInput, setAttachments]
  );
  const preEditDraftRef = useRef<DraftState>({ text: "", attachments: [] });
  const preEditReviewsRef = useRef<ReviewNoteDataForDisplay[] | null>(null);
  const { open } = useSettings();
  const { selectedWorkspace, beginWorkspaceCreation, updateWorkspaceDraftSection } =
    useWorkspaceContext();
  const { agentId, currentAgent } = useAgent();

  // Use current agent's uiColor, or neutral border until agents load
  const focusBorderColor = currentAgent?.uiColor ?? "var(--color-border-light)";
  const {
    models,
    hiddenModelsForSelector,
    ensureModelInSettings,
    defaultModel,
    setDefaultModel,
    codexOauthSet,
  } = useModelsFromSettings();

  const [agentAiDefaults] = usePersistedState<AgentAiDefaults>(
    AGENT_AI_DEFAULTS_KEY,
    {},
    {
      listener: true,
    }
  );
  const atMentionListId = useId();
  const commandListId = useId();
  const telemetry = useTelemetry();
  const [vimEnabled, setVimEnabled] = usePersistedState<boolean>(VIM_ENABLED_KEY, false, {
    listener: true,
  });
  const { startSequence: startTutorial } = useTutorial();

  // Track transcription provider prerequisites from Settings → Providers.
  const [openAIKeySet, setOpenAIKeySet] = useState(false);
  const [openAIProviderEnabled, setOpenAIProviderEnabled] = useState(true);
  const [muxGatewayCouponSet, setMuxGatewayCouponSet] = useState(false);
  const [muxGatewayEnabled, setMuxGatewayEnabled] = useState(true);
  const isTranscriptionAvailable =
    (openAIProviderEnabled && openAIKeySet) || (muxGatewayEnabled && muxGatewayCouponSet);

  // Voice input - appends transcribed text to input
  const voiceInput = useVoiceInput({
    onTranscript: (text) => {
      setInput((prev) => {
        const separator = prev.length > 0 && !prev.endsWith(" ") ? " " : "";
        return prev + separator + text;
      });
    },
    onError: (error) => {
      pushToast({ type: "error", message: error });
    },
    onSend: () => void handleSend(),
    isTranscriptionAvailable,
    useRecordingKeybinds: true,
    api,
  });

  const voiceInputUnavailableMessage =
    "Voice input requires a Mux Gateway login or an OpenAI API key. Configure in Settings → Providers.";

  // Start creation tutorial when entering creation mode
  useEffect(() => {
    if (variant === "creation") {
      // Small delay to ensure UI is rendered
      const timer = setTimeout(() => {
        startTutorial("creation");
      }, 600);
      return () => clearTimeout(timer);
    }
  }, [variant, startTutorial]);

  // Get current send message options from shared hook (must be at component top level)
  // For creation variant, use project-scoped key; for workspace, use workspace ID
  const sendMessageOptions = useSendMessageOptions(
    variant === "workspace" ? props.workspaceId : getProjectScopeId(props.projectPath)
  );
  // Extract models for convenience (don't create separate state - use hook as single source of truth)
  // - preferredModel: canonical model used for backend routing
  // - baseModel: canonical format for UI display and policy checks (e.g., ThinkingSlider)
  const preferredModel = sendMessageOptions.model;
  const baseModel = sendMessageOptions.baseModel;

  // Context usage indicator data (workspace variant only)
  const workspaceIdForUsage = variant === "workspace" ? props.workspaceId : "";
  const usage = useWorkspaceUsage(workspaceIdForUsage);
  const { has1MContext } = useProviderOptions();
  const { config: providersConfig } = useProvidersConfig();
  const lastUsage = usage?.liveUsage ?? usage?.lastContextUsage;
  // Token counts come from usage metadata, but context limits/1M eligibility should
  // follow the currently selected model unless a stream is actively running.
  const activeUsageModel = usage?.liveUsage?.model ?? null;
  const contextDisplayModel = activeUsageModel ?? baseModel;
  const use1M = has1MContext(contextDisplayModel);
  const contextUsageData = useMemo(() => {
    return lastUsage
      ? calculateTokenMeterData(lastUsage, contextDisplayModel, use1M, false, providersConfig)
      : { segments: [], totalTokens: 0, totalPercentage: 0 };
  }, [lastUsage, contextDisplayModel, use1M, providersConfig]);
  const { threshold: autoCompactThreshold, setThreshold: setAutoCompactThreshold } =
    useAutoCompactionSettings(workspaceIdForUsage, contextDisplayModel);
  const autoCompactionProps = useMemo(
    () => ({ threshold: autoCompactThreshold, setThreshold: setAutoCompactThreshold }),
    [autoCompactThreshold, setAutoCompactThreshold]
  );

  // Idle compaction settings (per-project, persisted to backend for idleCompactionService)
  const { hours: idleCompactionHours, setHours: setIdleCompactionHours } = useIdleCompactionHours({
    projectPath: selectedWorkspace?.projectPath ?? null,
  });
  const idleCompactionProps = useMemo(
    () => ({
      hours: idleCompactionHours,
      setHours: setIdleCompactionHours,
    }),
    [idleCompactionHours, setIdleCompactionHours]
  );

  const setPreferredModel = useCallback(
    (model: string) => {
      type WorkspaceAISettingsByAgentCache = Partial<
        Record<string, { model: string; thinkingLevel: ThinkingLevel }>
      >;

      const canonicalModel = migrateGatewayModel(model);
      ensureModelInSettings(canonicalModel); // Ensure model exists in Settings

      if (onModelChange) {
        // Notify parent of model change (for context switch warning + persisted model metadata).
        // Called before early returns so warnings work even offline or with custom agents.
        onModelChange(canonicalModel);
      } else {
        const scopeId =
          variant === "creation" ? getProjectScopeId(creationProjectPath) : workspaceId;
        if (scopeId) {
          setWorkspaceModelWithOrigin(scopeId, canonicalModel, "user");
        }
      }

      if (variant !== "workspace" || !workspaceId) {
        return;
      }

      const normalizedAgentId =
        typeof agentId === "string" && agentId.trim().length > 0
          ? agentId.trim().toLowerCase()
          : "exec";

      updatePersistedState<WorkspaceAISettingsByAgentCache>(
        getWorkspaceAISettingsByAgentKey(workspaceId),
        (prev) => {
          const record: WorkspaceAISettingsByAgentCache =
            prev && typeof prev === "object" ? prev : {};
          return {
            ...record,
            [normalizedAgentId]: { model: canonicalModel, thinkingLevel },
          };
        },
        {}
      );

      // Workspace variant: persist to backend for cross-device consistency.
      if (!api) {
        return;
      }

      markPendingWorkspaceAiSettings(workspaceId, normalizedAgentId, {
        model: canonicalModel,
        thinkingLevel,
      });

      api.workspace
        .updateAgentAISettings({
          workspaceId,
          agentId: normalizedAgentId,
          aiSettings: { model: canonicalModel, thinkingLevel },
        })
        .then((result) => {
          if (!result.success) {
            clearPendingWorkspaceAiSettings(workspaceId, normalizedAgentId);
          }
        })
        .catch(() => {
          clearPendingWorkspaceAiSettings(workspaceId, normalizedAgentId);
          // Best-effort only. If offline or backend is old, sendMessage will persist.
        });
    },
    [
      api,
      agentId,
      creationProjectPath,
      ensureModelInSettings,
      onModelChange,
      thinkingLevel,
      variant,
      workspaceId,
    ]
  );

  // Model cycling candidates: all visible models (custom + built-in, minus hidden).
  const cycleModels = models;

  const cycleToNextModel = useCallback(() => {
    if (cycleModels.length < 2) {
      return;
    }

    const currentIndex = cycleModels.indexOf(baseModel);
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % cycleModels.length;
    const nextModel = cycleModels[nextIndex];
    if (nextModel) {
      setPreferredModel(nextModel);
    }
  }, [baseModel, cycleModels, setPreferredModel]);

  const openModelSelector = useCallback(() => {
    modelSelectorRef.current?.open();
  }, []);
  // Section selection state for creation variant (must be before useCreationWorkspace)
  const { projects } = useProjectContext();
  const pendingSectionId = variant === "creation" ? (props.pendingSectionId ?? null) : null;
  const creationProject = variant === "creation" ? projects.get(props.projectPath) : undefined;
  const hasCreationRuntimeOverrides =
    creationProject?.runtimeOverridesEnabled === true ||
    Boolean(creationProject?.runtimeEnablement) ||
    creationProject?.defaultRuntime !== undefined;
  // Keep workspace creation in sync with Settings → Runtimes project overrides.
  const creationRuntimeEnablement =
    variant === "creation" && hasCreationRuntimeOverrides
      ? normalizeRuntimeEnablement(creationProject?.runtimeEnablement)
      : runtimeEnablement;
  const creationSections = creationProject?.sections ?? [];

  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(() => pendingSectionId);
  const [hasAttemptedCreateSend, setHasAttemptedCreateSend] = useState(false);

  // Keep local selection in sync with the URL-driven pending section (sidebar "+" button).
  useEffect(() => {
    if (variant !== "creation") {
      return;
    }

    setSelectedSectionId(pendingSectionId);
  }, [pendingSectionId, variant]);

  // If the section disappears (e.g. deleted in another window), avoid creating a workspace
  // with a dangling sectionId.
  useEffect(() => {
    if (variant !== "creation") {
      return;
    }

    if (!creationProject || !selectedSectionId) {
      return;
    }

    const stillExists = (creationProject.sections ?? []).some(
      (section) => section.id === selectedSectionId
    );
    if (!stillExists) {
      setSelectedSectionId(null);
    }
  }, [creationProject, selectedSectionId, variant]);

  const handleCreationSectionChange = useCallback(
    (sectionId: string | null) => {
      setSelectedSectionId(sectionId);

      if (variant !== "creation") {
        return;
      }

      if (typeof creationDraftId === "string" && creationDraftId.trim().length > 0) {
        updateWorkspaceDraftSection(creationProjectPath, creationDraftId, sectionId);
        return;
      }

      beginWorkspaceCreation(
        creationProjectPath,
        typeof sectionId === "string" && sectionId.trim().length > 0 ? sectionId : undefined
      );
    },
    [
      beginWorkspaceCreation,
      creationDraftId,
      creationProjectPath,
      updateWorkspaceDraftSection,
      variant,
    ]
  );

  // Creation-specific state (hook always called, but only used when variant === "creation")
  // This avoids conditional hook calls which violate React rules
  const creationState = useCreationWorkspace(
    variant === "creation"
      ? {
          projectPath: props.projectPath,
          onWorkspaceCreated: props.onWorkspaceCreated,
          message: input,
          sectionId: selectedSectionId,
          draftId: props.pendingDraftId,
          userModel: preferredModel,
        }
      : {
          // Dummy values for workspace variant (never used)
          projectPath: "",
          // eslint-disable-next-line @typescript-eslint/no-empty-function
          onWorkspaceCreated: () => {},
          message: "",
        }
  );

  const isSendInFlight = variant === "creation" ? creationState.isSending : isSending;
  const sendInFlightBlocksInput =
    variant === "workspace" ? isSendInFlight && !isStreamStarting : isSendInFlight;

  // Coder workspace state - config is owned by selectedRuntime.coder, this hook manages async data
  const currentRuntime = creationState.selectedRuntime;
  const coderState = useCoderWorkspace({
    coderConfig: currentRuntime.mode === "ssh" ? (currentRuntime.coder ?? null) : null,
    onCoderConfigChange: (config) => {
      if (currentRuntime.mode !== "ssh") return;
      // Compute host from workspace name for "existing" mode.
      // For "new" mode, workspaceName is omitted/undefined and backend derives it later.
      const computedHost = config?.workspaceName
        ? `${config.workspaceName}.coder`
        : currentRuntime.host;
      creationState.setSelectedRuntime({
        mode: "ssh",
        host: computedHost,
        coder: config ?? undefined,
      });
    },
  });

  const creationRuntimeError =
    variant === "creation"
      ? validateCreationRuntime(creationState.selectedRuntime, coderState.presets.length)
      : null;

  const creationRuntimePolicyError =
    variant === "creation" &&
    effectivePolicy?.runtimes != null &&
    !isParsedRuntimeAllowedByPolicy(effectivePolicy, creationState.selectedRuntime)
      ? creationState.selectedRuntime.mode === "ssh" &&
        !creationState.selectedRuntime.coder &&
        runtimePolicy.allowSshHost === false &&
        runtimePolicy.allowSshCoder
        ? "Host SSH runtimes are disabled by policy. Select the Coder runtime instead."
        : "Selected runtime is disabled by policy."
      : null;

  const runtimeFieldError =
    variant === "creation" && hasAttemptedCreateSend ? (creationRuntimeError?.mode ?? null) : null;

  const creationControlsProps =
    variant === "creation"
      ? ({
          branches: creationState.branches,
          branchesLoaded: creationState.branchesLoaded,
          trunkBranch: creationState.trunkBranch,
          onTrunkBranchChange: creationState.setTrunkBranch,
          selectedRuntime: creationState.selectedRuntime,
          coderConfigFallback: creationState.coderConfigFallback,
          sshHostFallback: creationState.sshHostFallback,
          defaultRuntimeMode: creationState.defaultRuntimeMode,
          onSelectedRuntimeChange: creationState.setSelectedRuntime,
          onSetDefaultRuntime: creationState.setDefaultRuntimeChoice,
          disabled: isSendInFlight,
          projectPath: props.projectPath,
          projectName: props.projectName,
          nameState: creationState.nameState,
          runtimeAvailabilityState: creationState.runtimeAvailabilityState,
          runtimeEnablement: creationRuntimeEnablement,
          sections: creationSections,
          selectedSectionId,
          onSectionChange: handleCreationSectionChange,
          allowedRuntimeModes: runtimePolicy.allowedModes,
          allowSshHost: runtimePolicy.allowSshHost,
          allowSshCoder: runtimePolicy.allowSshCoder,
          runtimePolicyError: creationRuntimePolicyError,
          coderInfo: coderState.coderInfo,
          runtimeFieldError,
          // Pass coderProps when CLI is available/outdated, Coder is enabled, or still checking (so "Checking…" UI renders)
          coderProps:
            coderState.coderInfo === null ||
            coderState.enabled ||
            coderState.coderInfo?.state !== "unavailable"
              ? {
                  enabled: coderState.enabled,
                  onEnabledChange: coderState.setEnabled,
                  coderInfo: coderState.coderInfo,
                  coderConfig: coderState.coderConfig,
                  onCoderConfigChange: coderState.setCoderConfig,
                  templates: coderState.templates,
                  templatesError: coderState.templatesError,
                  presets: coderState.presets,
                  presetsError: coderState.presetsError,
                  existingWorkspaces: coderState.existingWorkspaces,
                  workspacesError: coderState.workspacesError,
                  loadingTemplates: coderState.loadingTemplates,
                  loadingPresets: coderState.loadingPresets,
                  loadingWorkspaces: coderState.loadingWorkspaces,
                }
              : undefined,
        } satisfies React.ComponentProps<typeof CreationControls>)
      : null;
  const hasTypedText = input.trim().length > 0;
  const hasImages = attachments.length > 0;
  const reviewOverrideActive = draftReviews !== null;
  const draftReviewItems = draftReviews ?? [];
  const reviewData = reviewOverrideActive
    ? draftReviewItems.length > 0
      ? draftReviewItems
      : undefined
    : attachedReviews.length > 0
      ? attachedReviews.map((review) => review.data)
      : undefined;
  const reviewIdsForCheck = reviewOverrideActive ? [] : attachedReviews.map((review) => review.id);
  const reviewPanelItems: Review[] = reviewOverrideActive
    ? draftReviewItems.map((data, index) => ({
        id: `draft-review-${index}`,
        data,
        status: "attached",
        createdAt: 0,
      }))
    : attachedReviews;
  const hasReviews = reviewOverrideActive
    ? draftReviewItems.length > 0
    : attachedReviews.length > 0;
  // Disable send while Coder presets are loading (user could bypass preset validation)
  const policyBlocksCreateSend = variant === "creation" && creationRuntimePolicyError != null;
  const coderPresetsLoading =
    coderState.enabled && !coderState.coderConfig?.existingWorkspace && coderState.loadingPresets;
  const canSend =
    (hasTypedText || hasImages || hasReviews) &&
    !disabled &&
    !sendInFlightBlocksInput &&
    !coderPresetsLoading &&
    !policyBlocksCreateSend;

  // User request: this sync effect runs on mount and when defaults/config change.
  // Only treat *real* agent changes as explicit (origin "agent"); everything else is "sync".
  const prevCreationAgentIdRef = useRef<string | null>(null);
  const prevCreationScopeIdRef = useRef<string | null>(null);
  // Creation variant: keep the project-scoped model/thinking in sync with global agent defaults
  // so switching agents uses the configured defaults (and respects "inherit" semantics).
  useEffect(() => {
    if (variant !== "creation") {
      // Reset tracking on variant transitions so creation entry never counts as an explicit switch.
      prevCreationAgentIdRef.current = null;
      prevCreationScopeIdRef.current = null;
      return;
    }

    const scopeId = getProjectScopeId(creationProjectPath);
    const modelKey = getModelKey(scopeId);
    const thinkingKey = getThinkingLevelKey(scopeId);

    const fallbackModel = defaultModel;

    const normalizedAgentId =
      typeof agentId === "string" && agentId.trim().length > 0
        ? agentId.trim().toLowerCase()
        : "exec";

    const isExplicitAgentSwitch =
      prevCreationAgentIdRef.current !== null &&
      prevCreationScopeIdRef.current === scopeId &&
      prevCreationAgentIdRef.current !== normalizedAgentId;

    // Update refs for the next run (even if no model changes).
    prevCreationAgentIdRef.current = normalizedAgentId;
    prevCreationScopeIdRef.current = scopeId;

    const existingModel = readPersistedState<string>(modelKey, fallbackModel);
    const candidateModel = agentAiDefaults[normalizedAgentId]?.modelString ?? existingModel;
    const resolvedModel =
      typeof candidateModel === "string" && candidateModel.trim().length > 0
        ? candidateModel
        : fallbackModel;

    const existingThinking = readPersistedState<ThinkingLevel>(thinkingKey, "off");
    const candidateThinking =
      agentAiDefaults[normalizedAgentId]?.thinkingLevel ?? existingThinking ?? "off";
    const resolvedThinking = coerceThinkingLevel(candidateThinking) ?? "off";

    if (existingModel !== resolvedModel) {
      setWorkspaceModelWithOrigin(scopeId, resolvedModel, isExplicitAgentSwitch ? "agent" : "sync");
    }

    if (existingThinking !== resolvedThinking) {
      updatePersistedState(thinkingKey, resolvedThinking);
    }
  }, [agentAiDefaults, agentId, creationProjectPath, defaultModel, variant]);

  // Expose ChatInput auto-focus completion for Storybook/tests.
  const chatInputSectionRef = useRef<HTMLDivElement | null>(null);
  const setChatInputAutoFocusState = useCallback((state: "pending" | "done") => {
    chatInputSectionRef.current?.setAttribute("data-autofocus-state", state);
  }, []);

  const focusMessageInput = useCallback(() => {
    const element = inputRef.current;
    if (!element || element.disabled) {
      return;
    }

    element.focus();

    requestAnimationFrame(() => {
      const cursor = element.value.length;
      element.selectionStart = cursor;
      element.selectionEnd = cursor;
      element.style.height = "auto";
      element.style.height = Math.min(element.scrollHeight, window.innerHeight * 0.5) + "px";
    });
  }, []);

  const applyDraftFromPending = useCallback(
    (pending: PendingUserMessage, attachmentKeyPrefix: string) => {
      setDraft({
        text: pending.content,
        attachments: filePartsToChatAttachments(pending.fileParts, attachmentKeyPrefix),
      });
    },
    [setDraft]
  );

  // Restore a full pending draft (text + attachments + reviews), e.g. queued message edits.
  const restoreDraft = useCallback(
    (pending: PendingUserMessage) => {
      applyDraftFromPending(pending, `restored-${Date.now()}`);
      setDraftReviews(pending.reviews);
      focusMessageInput();
    },
    [applyDraftFromPending, focusMessageInput, setDraftReviews]
  );

  const restorePreEditDraft = useCallback(() => {
    setDraft(preEditDraftRef.current);
    setDraftReviews(preEditReviewsRef.current);
  }, [setDraft, setDraftReviews]);

  // Method to restore text to input (used by compaction cancel)
  const restoreText = useCallback(
    (text: string) => {
      setInput(() => text);
      focusMessageInput();
    },
    [focusMessageInput, setInput]
  );

  // Method to append text to input (used by Code Review notes)
  const appendText = useCallback(
    (text: string) => {
      setInput((prev) => {
        // Add blank line before if there's existing content
        const separator = prev.trim() ? "\n\n" : "";
        return prev + separator + text;
      });
      // Don't focus - user wants to keep reviewing
    },
    [setInput]
  );

  // Method to prepend text to input (used by manual compact trigger)
  const prependText = useCallback(
    (text: string) => {
      setInput((prev) => text + prev);
      focusMessageInput();
    },
    [focusMessageInput, setInput]
  );

  const handleSendRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const send = useCallback(() => {
    return handleSendRef.current();
  }, []);

  const onReady = props.onReady;

  // Provide API to parent via callback
  useEffect(() => {
    if (onReady) {
      onReady({
        focus: focusMessageInput,
        send,
        restoreText,
        restoreDraft,
        appendText,
        prependText,
      });
    }
  }, [onReady, focusMessageInput, send, restoreText, restoreDraft, appendText, prependText]);

  useEffect(() => {
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      if (isEditableElement(event.target)) {
        return;
      }

      if (matchesKeybind(event, KEYBINDS.FOCUS_INPUT_I)) {
        event.preventDefault();
        focusMessageInput();
        return;
      }

      if (matchesKeybind(event, KEYBINDS.FOCUS_INPUT_A)) {
        event.preventDefault();
        focusMessageInput();
        return;
      }

      if (matchesKeybind(event, KEYBINDS.CYCLE_MODEL)) {
        event.preventDefault();
        focusMessageInput();
        cycleToNextModel();
      }
    };

    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => {
      window.removeEventListener("keydown", handleGlobalKeyDown);
    };
  }, [cycleToNextModel, focusMessageInput, openModelSelector]);

  // When entering editing mode, save current draft and populate with message content
  useEffect(() => {
    if (editingMessage) {
      preEditDraftRef.current = getDraft();
      preEditReviewsRef.current = draftReviews;
      applyDraftFromPending(editingMessage.pending, `edit-${editingMessage.id}`);
      setDraftReviews(editingMessage.pending.reviews);
      // Auto-resize textarea and focus
      setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.style.height = "auto";
          inputRef.current.style.height =
            Math.min(inputRef.current.scrollHeight, window.innerHeight * 0.5) + "px";
          inputRef.current.focus();
        }
      }, 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only run when editingMessage changes
  }, [editingMessage, applyDraftFromPending]);

  // Watch input/cursor for @file mentions
  useEffect(() => {
    if (atMentionDebounceRef.current) {
      clearTimeout(atMentionDebounceRef.current);
      atMentionDebounceRef.current = null;
    }

    const inputChanged = lastAtMentionInputRef.current !== input;
    lastAtMentionInputRef.current = input;

    const atMentionScopeId = variant === "workspace" ? workspaceId : atMentionProjectPath;

    if (!api || !atMentionScopeId) {
      // Invalidate any in-flight completion request.
      atMentionRequestIdRef.current++;
      lastAtMentionScopeIdRef.current = null;
      lastAtMentionQueryRef.current = null;
      setAtMentionSuggestions([]);
      setShowAtMentionSuggestions(false);
      return;
    }

    const cursor = Math.min(inputRef.current?.selectionStart ?? input.length, input.length);
    const match = findAtMentionAtCursor(input, cursor);

    if (!match) {
      // Invalidate any in-flight completion request.
      atMentionRequestIdRef.current++;
      lastAtMentionScopeIdRef.current = null;
      lastAtMentionQueryRef.current = null;
      setAtMentionSuggestions([]);
      setShowAtMentionSuggestions(false);
      return;
    }

    // If the user is moving the caret and we aren't already showing suggestions, don't re-open.
    if (!inputChanged && !showAtMentionSuggestions) {
      return;
    }

    // Avoid refetching on caret movement within the same token/query.
    if (
      !inputChanged &&
      lastAtMentionScopeIdRef.current === atMentionScopeId &&
      lastAtMentionQueryRef.current === match.query
    ) {
      return;
    }

    lastAtMentionScopeIdRef.current = atMentionScopeId;
    lastAtMentionQueryRef.current = match.query;

    const requestId = ++atMentionRequestIdRef.current;
    const runRequest = () => {
      void (async () => {
        try {
          const result =
            variant === "workspace"
              ? await api.workspace.getFileCompletions({
                  workspaceId: atMentionScopeId,
                  query: match.query,
                  limit: 20,
                })
              : await api.projects.getFileCompletions({
                  projectPath: atMentionScopeId,
                  query: match.query,
                  limit: 20,
                });

          if (atMentionRequestIdRef.current !== requestId) {
            return;
          }

          const nextSuggestions = result.paths
            // File @mentions are whitespace-delimited (extractAtMentions uses /@(\S+)/), so
            // suggestions containing spaces would be inserted incorrectly (e.g. "@foo bar.ts").
            .filter((p) => !/\s/.test(p))
            .map((p) => {
              // Determine file type from extension or mark as directory
              const getFileType = (path: string): string => {
                if (path.endsWith("/")) return "Directory";
                const lastDot = path.lastIndexOf(".");
                const lastSlash = path.lastIndexOf("/");
                // Only use extension if it's after the last slash (in the filename)
                if (lastDot > lastSlash && lastDot < path.length - 1) {
                  return path.slice(lastDot + 1).toUpperCase();
                }
                return "File";
              };
              return {
                id: `file:${p}`,
                display: p,
                description: getFileType(p),
                replacement: `@${p}`,
              };
            });

          setAtMentionSuggestions(nextSuggestions);
          setShowAtMentionSuggestions(nextSuggestions.length > 0);
        } catch {
          if (atMentionRequestIdRef.current === requestId) {
            setAtMentionSuggestions([]);
            setShowAtMentionSuggestions(false);
          }
        }
      })();
    };

    // Our backend autocomplete is cheap (indexed) and cached, so update suggestions on every
    // character rather than waiting for a debounce window.
    runRequest();
  }, [
    api,
    input,
    showAtMentionSuggestions,
    variant,
    workspaceId,
    atMentionProjectPath,
    atMentionCursorNonce,
  ]);

  // Watch input for slash commands
  useEffect(() => {
    const suggestions = getSlashCommandSuggestions(input, {
      agentSkills: agentSkillDescriptors,
      variant,
    });
    setCommandSuggestions(suggestions);
    setShowCommandSuggestions(suggestions.length > 0);
  }, [input, agentSkillDescriptors, variant]);

  // Load agent skills for suggestions
  useEffect(() => {
    let isMounted = true;
    const requestId = ++agentSkillsRequestIdRef.current;

    const loadAgentSkills = async () => {
      if (!api) {
        if (isMounted && agentSkillsRequestIdRef.current === requestId) {
          setAgentSkillDescriptors([]);
        }
        return;
      }

      const discoveryInput =
        variant === "workspace" && workspaceId
          ? {
              workspaceId,
              disableWorkspaceAgents: sendMessageOptions.disableWorkspaceAgents,
            }
          : variant === "creation" && atMentionProjectPath
            ? { projectPath: atMentionProjectPath }
            : null;

      if (!discoveryInput) {
        if (isMounted && agentSkillsRequestIdRef.current === requestId) {
          setAgentSkillDescriptors([]);
        }
        return;
      }

      try {
        const skills = await api.agentSkills.list(discoveryInput);
        if (!isMounted || agentSkillsRequestIdRef.current !== requestId) {
          return;
        }
        if (Array.isArray(skills)) {
          setAgentSkillDescriptors(skills);
        }
      } catch (error) {
        console.error("Failed to load agent skills:", error);
        if (!isMounted || agentSkillsRequestIdRef.current !== requestId) {
          return;
        }
        setAgentSkillDescriptors([]);
      }
    };

    void loadAgentSkills();

    return () => {
      isMounted = false;
    };
  }, [api, variant, workspaceId, atMentionProjectPath, sendMessageOptions.disableWorkspaceAgents]);

  // Voice input: track transcription provider availability (subscribe to provider config changes)
  useEffect(() => {
    if (!api) return;

    const abortController = new AbortController();
    const { signal } = abortController;

    // Some oRPC iterators don't eagerly close on abort alone.
    // Ensure we `return()` them so backend subscriptions clean up EventEmitter listeners.
    let iterator: AsyncIterator<unknown> | null = null;

    const checkTranscriptionConfig = async () => {
      try {
        const config = await api.providers.getConfig();
        if (!signal.aborted) {
          setOpenAIKeySet(config?.openai?.apiKeySet ?? false);
          setOpenAIProviderEnabled(config?.openai?.isEnabled ?? true);
          setMuxGatewayCouponSet(config?.["mux-gateway"]?.couponCodeSet ?? false);
          setMuxGatewayEnabled(config?.["mux-gateway"]?.isEnabled ?? true);
        }
      } catch {
        // Ignore errors fetching config
      }
    };

    // Initial fetch
    void checkTranscriptionConfig();

    // Subscribe to provider config changes via oRPC
    (async () => {
      try {
        const subscribedIterator = await api.providers.onConfigChanged(undefined, { signal });

        if (signal.aborted) {
          void subscribedIterator.return?.();
          return;
        }

        iterator = subscribedIterator;

        for await (const _ of subscribedIterator) {
          if (signal.aborted) break;
          void checkTranscriptionConfig();
        }
      } catch {
        // Subscription cancelled via abort signal - expected on cleanup
      }
    })();

    return () => {
      abortController.abort();
      void iterator?.return?.();
    };
  }, [api]);

  // Allow external components (e.g., CommandPalette, Queued message edits) to insert text
  useEffect(() => {
    const handler = (e: Event) => {
      const customEvent = e as CustomEvent<{
        text: string;
        mode?: "append" | "replace";
        fileParts?: FilePart[];
        reviews?: ReviewNoteDataForDisplay[];
      }>;

      const { text, mode = "append", fileParts, reviews } = customEvent.detail;
      const hasFileParts = !!fileParts && fileParts.length > 0;
      const hasReviews = !!reviews && reviews.length > 0;

      if (mode === "replace") {
        if (editingMessage) {
          return;
        }
        if (hasFileParts || hasReviews) {
          restoreDraft({
            content: text,
            fileParts: fileParts ?? [],
            reviews: reviews ?? [],
          });
        } else {
          restoreText(text);
        }
      } else if (hasFileParts || hasReviews) {
        const currentText = getDraft().text;
        const separator = currentText.trim() ? "\n\n" : "";
        const nextText = currentText + separator + text;
        applyDraftFromPending(
          {
            content: nextText,
            fileParts: fileParts ?? [],
            reviews: reviews ?? [],
          },
          `restored-${Date.now()}`
        );
      } else {
        appendText(text);
      }
    };
    window.addEventListener(CUSTOM_EVENTS.UPDATE_CHAT_INPUT, handler as EventListener);
    return () =>
      window.removeEventListener(CUSTOM_EVENTS.UPDATE_CHAT_INPUT, handler as EventListener);
  }, [appendText, restoreText, restoreDraft, applyDraftFromPending, getDraft, editingMessage]);

  // Allow external components to open the Model Selector
  useEffect(() => {
    const handler = () => {
      // Open the inline ModelSelector and let it take focus itself
      modelSelectorRef.current?.open();
    };
    window.addEventListener(CUSTOM_EVENTS.OPEN_MODEL_SELECTOR, handler as EventListener);
    return () =>
      window.removeEventListener(CUSTOM_EVENTS.OPEN_MODEL_SELECTOR, handler as EventListener);
  }, []);

  // Show toast when thinking level is changed via command palette (workspace only)
  useEffect(() => {
    if (variant !== "workspace") return;

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceId: string; level: ThinkingLevel }>).detail;
      if (detail?.workspaceId !== props.workspaceId || !detail.level) {
        return;
      }

      const level = detail.level;
      const levelDescriptions: Record<ThinkingLevel, string> = {
        off: "Off — fastest responses",
        low: "Low — adds light reasoning",
        medium: "Medium — balanced reasoning",
        high: "High — maximum reasoning depth",
        xhigh: "Max — deepest possible reasoning",
        max: "Max — deepest possible reasoning",
      };

      pushToast({
        type: "success",
        message: `Thinking effort set to ${levelDescriptions[level]}`,
      });
    };

    window.addEventListener(CUSTOM_EVENTS.THINKING_LEVEL_TOAST, handler as EventListener);
    return () =>
      window.removeEventListener(CUSTOM_EVENTS.THINKING_LEVEL_TOAST, handler as EventListener);
  }, [variant, props, pushToast]);

  // Voice input: command palette toggle + global recording keybinds
  useEffect(() => {
    if (!voiceInput.shouldShowUI) return;

    const handleToggle = () => {
      if (!voiceInput.isAvailable) {
        pushToast({
          type: "error",
          message: voiceInputUnavailableMessage,
        });
        return;
      }
      voiceInput.toggle();
    };

    window.addEventListener(CUSTOM_EVENTS.TOGGLE_VOICE_INPUT, handleToggle as EventListener);
    return () => {
      window.removeEventListener(CUSTOM_EVENTS.TOGGLE_VOICE_INPUT, handleToggle as EventListener);
    };
  }, [voiceInput, pushToast, voiceInputUnavailableMessage]);

  // Auto-focus chat input when workspace changes (workspace only).
  const workspaceIdForFocus = variant === "workspace" ? props.workspaceId : null;
  useEffect(() => {
    if (variant !== "workspace") return;

    const maxFrames = 10;
    setChatInputAutoFocusState("pending");

    let cancelled = false;
    let rafId: number | null = null;
    let attempts = 0;

    const step = () => {
      if (cancelled) return;

      attempts += 1;

      const input = inputRef.current;
      const active = document.activeElement;

      if (
        active instanceof HTMLElement &&
        active !== document.body &&
        active !== document.documentElement
      ) {
        const isWithinChatInput = !!chatInputSectionRef.current?.contains(active);
        const isInput = !!input && active === input;
        if (!isWithinChatInput && !isInput) {
          setChatInputAutoFocusState("done");
          return;
        }
      }

      focusMessageInput();

      const isFocused = !!input && document.activeElement === input;
      const isDone = isFocused || attempts >= maxFrames;

      if (isDone) {
        setChatInputAutoFocusState("done");
        return;
      }

      rafId = requestAnimationFrame(step);
    };

    rafId = requestAnimationFrame(step);

    return () => {
      cancelled = true;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
      setChatInputAutoFocusState("done");
    };
  }, [variant, workspaceIdForFocus, focusMessageInput, setChatInputAutoFocusState]);

  // Handle paste events to extract attachments
  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      const attachmentFiles = extractAttachmentsFromClipboard(items);
      if (attachmentFiles.length === 0) return;

      // When editing an existing message, we only allow changing the text.
      // Don't preventDefault here so any clipboard text can still paste normally.
      if (editingMessage) {
        pushToast({
          type: "error",
          message: "Attachments cannot be added while editing a message.",
        });
        return;
      }

      e.preventDefault(); // Prevent default paste behavior for attachments

      processAttachmentFiles(attachmentFiles)
        .then((nextAttachments) => {
          setAttachments((prev) => [...prev, ...nextAttachments]);
        })
        .catch((error) => {
          console.error("Failed to process pasted attachment:", error);
          pushToast({
            type: "error",
            message: error instanceof Error ? error.message : "Failed to process attachment",
          });
        });
    },
    [editingMessage, pushToast, setAttachments]
  );

  // Handle removing an attachment
  const handleRemoveAttachment = useCallback(
    (id: string) => {
      setAttachments((prev) => prev.filter((img) => img.id !== id));
    },
    [setAttachments]
  );

  // Shared slash command execution for creation + workspace inputs.
  const commandWorkspaceId = variant === "workspace" ? props.workspaceId : undefined;
  const commandProjectPath =
    variant === "creation" ? props.projectPath : (selectedWorkspace?.projectPath ?? null);
  const commandOnCancelEdit = variant === "workspace" ? props.onCancelEdit : undefined;

  // Keep this helper as a plain function so command wiring stays readable without a giant
  // dependency list; the React Compiler already handles memoization.
  const executeParsedCommand = async (
    parsed: ParsedCommand | null,
    restoreInput: string,
    options?: { skipConfirmation?: boolean }
  ): Promise<boolean> => {
    if (!parsed) {
      return false;
    }

    // /<model-alias> ... is a *send modifier* (one-shot model override), not a command with its own
    // side effects. Let the normal send flow handle it so post-send behavior can't drift.
    if (parsed.type === "model-oneshot") {
      if (variant !== "workspace") {
        setToast({
          id: Date.now().toString(),
          type: "error",
          message: "Model one-shot is only available in workspace view",
        });
        return true;
      }
      return false;
    }

    const isDestructive = parsed.type === "clear" || parsed.type === "truncate";
    if (isDestructive && variant === "workspace" && !options?.skipConfirmation) {
      setPendingDestructiveCommand({
        type: parsed.type,
        percentage: parsed.type === "truncate" ? parsed.percentage : undefined,
      });
      return true;
    }

    const reviewsData = reviewData;
    // Prepare file parts for commands that need to send messages with attachments
    const commandFileParts = chatAttachmentsToFileParts(attachments, { validate: true });
    const commandContext: SlashCommandContext = {
      api,
      variant,
      workspaceId: commandWorkspaceId,
      projectPath: commandProjectPath,
      openSettings: open,
      sendMessageOptions,
      setInput,
      setAttachments,
      setSendingState: (increment: boolean) => setSendingCount((c) => c + (increment ? 1 : -1)),
      setToast,
      setPreferredModel,
      setVimEnabled,
      onTruncateHistory: variant === "workspace" ? props.onTruncateHistory : undefined,
      resetInputHeight: () => {
        if (inputRef.current) {
          inputRef.current.style.height = "";
        }
      },
      editMessageId: editingMessage?.id,
      onCancelEdit: commandOnCancelEdit,
      reviews: reviewsData,
      fileParts: commandFileParts.length > 0 ? commandFileParts : undefined,
      onMessageSent: variant === "workspace" ? props.onMessageSent : undefined,
      onCheckReviews: variant === "workspace" ? props.onCheckReviews : undefined,
      attachedReviewIds: reviewIdsForCheck,
    };

    const result = await processSlashCommand(parsed, commandContext);

    if (!result.clearInput) {
      setInput(restoreInput);
    } else {
      setDraftReviews(null);
      if (variant === "workspace" && parsed.type === "compact") {
        if (reviewIdsForCheck.length > 0) {
          props.onCheckReviews?.(reviewIdsForCheck);
        }
        props.onMessageSent?.();
      }
    }

    return true;
  };

  // Handle destructive command confirmation
  const handleDestructiveCommandConfirm = async () => {
    if (!pendingDestructiveCommand || variant !== "workspace") return;

    const parsedCommand: ParsedCommand =
      pendingDestructiveCommand.type === "clear"
        ? { type: "clear" }
        : {
            type: "truncate",
            percentage: pendingDestructiveCommand.percentage ?? 0,
          };

    setPendingDestructiveCommand(null);
    await executeParsedCommand(parsedCommand, input, { skipConfirmation: true });
  };

  const handleDestructiveCommandCancel = useCallback(() => {
    setPendingDestructiveCommand(null);
  }, []);

  // Handle drag over to allow drop
  const handleDragOver = useCallback(
    (e: React.DragEvent<HTMLTextAreaElement>) => {
      // Check if drag contains files
      if (e.dataTransfer.types.includes("Files")) {
        e.preventDefault();
        e.dataTransfer.dropEffect = editingMessage ? "none" : "copy";
      }
    },
    [editingMessage]
  );

  // Handle drop to extract attachments
  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLTextAreaElement>) => {
      e.preventDefault();

      const attachmentFiles = extractAttachmentsFromDrop(e.dataTransfer);
      if (attachmentFiles.length === 0) return;

      if (editingMessage) {
        pushToast({
          type: "error",
          message: "Attachments cannot be added while editing a message.",
        });
        return;
      }

      processAttachmentFiles(attachmentFiles)
        .then((nextAttachments) => {
          setAttachments((prev) => [...prev, ...nextAttachments]);
        })
        .catch((error) => {
          console.error("Failed to process dropped attachment:", error);
          pushToast({
            type: "error",
            message: error instanceof Error ? error.message : "Failed to process attachment",
          });
        });
    },
    [editingMessage, pushToast, setAttachments]
  );

  // Handle suggestion selection

  const handleAtMentionSelect = useCallback(
    (suggestion: SlashSuggestion) => {
      const cursor = Math.min(inputRef.current?.selectionStart ?? input.length, input.length);
      const match = findAtMentionAtCursor(input, cursor);
      if (!match) {
        return;
      }

      // Add trailing space so user can continue typing naturally
      const next =
        input.slice(0, match.startIndex) +
        suggestion.replacement +
        " " +
        input.slice(match.endIndex);

      setInput(next);
      setAtMentionSuggestions([]);
      setShowAtMentionSuggestions(false);

      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el || el.disabled) {
          return;
        }

        el.focus();
        // +1 for the trailing space we added
        const newCursor = match.startIndex + suggestion.replacement.length + 1;
        el.selectionStart = newCursor;
        el.selectionEnd = newCursor;
      });
    },
    [input, setInput]
  );
  const handleCommandSelect = useCallback(
    (suggestion: SlashSuggestion) => {
      setInput(suggestion.replacement);
      setShowCommandSuggestions(false);
      inputRef.current?.focus();
    },
    [setInput]
  );

  const handleSend = async () => {
    if (!canSend) {
      return;
    }

    const messageText = input.trim();
    const skillDiscovery: SkillResolutionTarget | null =
      variant === "creation"
        ? atMentionProjectPath
          ? { kind: "project", projectPath: atMentionProjectPath }
          : null
        : variant === "workspace" && workspaceId
          ? {
              kind: "workspace",
              workspaceId,
              disableWorkspaceAgents: sendMessageOptions.disableWorkspaceAgents,
            }
          : null;
    const { parsed, skillInvocation } = await parseCommandWithSkillInvocation({
      messageText,
      agentSkillDescriptors,
      api,
      discovery: skillDiscovery,
    });

    // Route to creation handler for creation variant
    if (variant === "creation") {
      const commandHandled = await executeParsedCommand(parsed, input);
      if (commandHandled) {
        return;
      }

      let creationMessageTextForSend = messageText;
      let creationOptionsOverride: Partial<SendMessageOptions> | undefined;

      if (skillInvocation) {
        if (!api) {
          pushToast({ type: "error", message: "Not connected to server" });
          return;
        }

        creationMessageTextForSend = skillInvocation.userText;
        creationOptionsOverride = {
          muxMetadata: buildSkillInvocationMetadata(messageText, skillInvocation.descriptor),
          // In the creation flow, skills are discovered from the project path. If the skill is
          // project-scoped (often untracked in git), it may not exist in the new worktree.
          // Force project-path discovery for this send so resolution matches suggestions.
          ...(skillInvocation.descriptor.scope === "project"
            ? { disableWorkspaceAgents: true }
            : {}),
        };
      }

      setHasAttemptedCreateSend(true);

      const runtimeError = validateCreationRuntime(
        creationState.selectedRuntime,
        coderState.presets.length
      );
      if (runtimeError) {
        return;
      }

      // Creation variant: simple message send + workspace creation
      const creationFileParts = chatAttachmentsToFileParts(attachments);
      const creationResult = await creationState.handleSend(
        creationMessageTextForSend,
        creationFileParts.length > 0 ? creationFileParts : undefined,
        creationOptionsOverride
      );

      if (creationResult.success) {
        if (isMountedRef.current) {
          setInput("");
          setAttachments([]);
          // Height is managed by VimTextArea's useLayoutEffect - clear inline style
          // to let CSS min-height take over
          if (inputRef.current) {
            inputRef.current.style.height = "";
          }
        }
      }
      return;
    }

    // Workspace variant: full command handling + message send
    if (variant !== "workspace") return; // Type guard

    try {
      const modelOneShot = parsed?.type === "model-oneshot" ? parsed : null;
      const commandHandled = modelOneShot ? false : await executeParsedCommand(parsed, input);
      if (commandHandled) {
        return;
      }

      const modelOverride = modelOneShot?.modelString;

      // Regular message (or /<model-alias> one-shot override) - send directly via API
      const messageTextForSend = modelOneShot?.message ?? skillInvocation?.userText ?? messageText;
      const skillMuxMetadata = skillInvocation
        ? buildSkillInvocationMetadata(messageText, skillInvocation.descriptor)
        : undefined;

      if (!api) {
        pushToast({ type: "error", message: "Not connected to server" });
        return;
      }
      setSendingCount((c) => c + 1);

      const policyModel = modelOverride ?? baseModel;

      // Preflight: if the message includes PDFs, ensure the selected model can accept them.
      const pdfAttachments = attachments.filter(
        (attachment) => getBaseMediaType(attachment.mediaType) === PDF_MEDIA_TYPE
      );
      if (pdfAttachments.length > 0) {
        const caps = getModelCapabilitiesResolved(policyModel, providersConfig);
        if (caps && !caps.supportsPdfInput) {
          const pdfCapableKnownModels = Object.values(KNOWN_MODELS)
            .map((m) => m.id)
            .filter((model) => getModelCapabilities(model)?.supportsPdfInput);
          const pdfCapableExamples = pdfCapableKnownModels.slice(0, 3);
          const examplesSuffix =
            pdfCapableKnownModels.length > pdfCapableExamples.length ? ", and others." : ".";

          pushToast({
            type: "error",
            title: "PDF not supported",
            message:
              `Model ${policyModel} does not support PDF input.` +
              (pdfCapableExamples.length > 0
                ? ` Try e.g.: ${pdfCapableExamples.join(", ")}${examplesSuffix}`
                : " Choose a model with PDF support."),
          });
          setSendingCount((c) => c - 1);
          return;
        }

        if (caps?.maxPdfSizeMb !== undefined) {
          const maxBytes = caps.maxPdfSizeMb * 1024 * 1024;
          for (const attachment of pdfAttachments) {
            const bytes = estimateBase64DataUrlBytes(attachment.url);
            if (bytes !== null && bytes > maxBytes) {
              const actualMb = (bytes / (1024 * 1024)).toFixed(1);
              pushToast({
                type: "error",
                title: "PDF too large",
                message: `${attachment.filename ?? "PDF"} is ${actualMb}MB, but ${policyModel} allows up to ${caps.maxPdfSizeMb}MB per PDF.`,
              });
              setSendingCount((c) => c - 1);
              return;
            }
          }
        }
      }
      // Save current draft state for restoration on error
      const preSendDraft = getDraft();
      const preSendReviews = draftReviews;

      try {
        // Prepare file parts if any
        const fileParts = chatAttachmentsToFileParts(attachments, { validate: true });
        const sendFileParts = editingMessage
          ? fileParts
          : fileParts.length > 0
            ? fileParts
            : undefined;

        // Prepare reviews data (used for both compaction continueMessage and normal send)
        const reviewsData = reviewData;

        // When editing a /compact command, regenerate the actual summarization request
        let actualMessageText = messageTextForSend;
        let muxMetadata: MuxMessageMetadata | undefined = skillMuxMetadata;
        let compactionOptions: Partial<SendMessageOptions> = {};

        if (editingMessage && actualMessageText.startsWith("/")) {
          const parsed = parseCommand(messageText);
          if (parsed?.type === "compact") {
            const {
              messageText: regeneratedText,
              metadata,
              sendOptions,
            } = prepareCompactionMessage({
              api,
              workspaceId: props.workspaceId,
              maxOutputTokens: parsed.maxOutputTokens,
              // Include current attachments + reviews in followUpContent so they're queued
              // after compaction completes, not just attached to the compaction request.
              followUpContent:
                parsed.continueMessage || sendFileParts?.length || reviewsData?.length
                  ? {
                      text: parsed.continueMessage ?? "",
                      fileParts: sendFileParts,
                      reviews: reviewsData,
                    }
                  : undefined,
              model: parsed.model,
              sendMessageOptions,
            });
            actualMessageText = regeneratedText;
            muxMetadata = metadata;
            compactionOptions = sendOptions;
          }
        }

        const { finalText: finalMessageText, metadata: reviewMetadata } = prepareUserMessageForSend(
          { text: actualMessageText, reviews: reviewsData },
          muxMetadata
        );
        // When editing /compact, compactionOptions already includes the base sendMessageOptions.
        // Avoid duplicating additionalSystemInstructions.
        const additionalSystemInstructions =
          compactionOptions.additionalSystemInstructions ??
          sendMessageOptions.additionalSystemInstructions;

        muxMetadata = reviewMetadata;

        const effectiveModel = modelOverride ?? compactionOptions.model ?? sendMessageOptions.model;
        // For one-shot overrides, store the original input as rawCommand so the
        // command prefix (e.g., "/opus+high") stays visible in the user message.
        const oneshotCommandPrefix = modelOneShot
          ? messageText
              .trim()
              .slice(0, messageText.trim().length - modelOneShot.message.length)
              .trimEnd()
          : undefined;
        muxMetadata = muxMetadata
          ? {
              ...muxMetadata,
              requestedModel: effectiveModel,
              ...(oneshotCommandPrefix
                ? { rawCommand: messageText.trim(), commandPrefix: oneshotCommandPrefix }
                : {}),
            }
          : {
              type: "normal",
              requestedModel: effectiveModel,
              ...(oneshotCommandPrefix
                ? { rawCommand: messageText.trim(), commandPrefix: oneshotCommandPrefix }
                : {}),
            };

        // Capture review IDs before clearing (for marking as checked on success)
        const sentReviewIds = reviewIdsForCheck;

        // Clear input, images, and hide reviews immediately for responsive UI
        // Text/images are restored if send fails; reviews remain "attached" in state
        // so they'll reappear naturally on failure (we only call onCheckReviews on success)
        setInput("");
        setDraftReviews(null);
        setAttachments([]);
        setHideReviewsDuringSend(true);
        // Clear inline height style - VimTextArea's useLayoutEffect will handle sizing
        if (inputRef.current) {
          inputRef.current.style.height = "";
        }

        // One-shot models/thinking shouldn't update the persisted session defaults.
        // Resolve thinking level: numeric indices are model-relative (0 = model's lowest allowed level)
        const rawThinkingOverride = modelOneShot?.thinkingLevel;
        const thinkingOverride =
          rawThinkingOverride != null
            ? resolveThinkingInput(rawThinkingOverride, policyModel)
            : undefined;
        const sendOptions = {
          ...sendMessageOptions,
          ...compactionOptions,
          ...(modelOverride ? { model: modelOverride } : {}),
          ...(thinkingOverride ? { thinkingLevel: thinkingOverride } : {}),
          ...(modelOneShot ? { skipAiSettingsPersistence: true } : {}),
          additionalSystemInstructions,
          editMessageId: editingMessage?.id,
          fileParts: sendFileParts,
          muxMetadata,
        };

        const result = await api.workspace.sendMessage({
          workspaceId: props.workspaceId,
          message: finalMessageText,
          options: sendOptions,
        });

        if (!result.success) {
          // Log error for debugging
          console.error("Failed to send message:", result.error);
          // Show error using enhanced toast
          setToast(createErrorToast(result.error));
          // Restore draft on error so user can try again
          setDraft(preSendDraft);
          setDraftReviews(preSendReviews);
        } else {
          // Track telemetry for successful message send
          telemetry.messageSent(
            props.workspaceId,
            effectiveModel,
            sendMessageOptions.agentId ?? agentId ?? WORKSPACE_DEFAULTS.agentId,
            finalMessageText.length,
            runtimeType,
            sendMessageOptions.thinkingLevel ?? "off"
          );

          if (modelOneShot) {
            trackCommandUsed("model");
          }

          // Mark workspace as read after sending a message.
          // This prevents the unread indicator from showing when the user
          // just interacted with the workspace (their own message bumps recencyTimestamp,
          // but since they initiated it, they've "read" the workspace).
          updatePersistedState(getWorkspaceLastReadKey(props.workspaceId), Date.now());

          // Mark attached reviews as completed (checked)
          if (sentReviewIds.length > 0) {
            props.onCheckReviews?.(sentReviewIds);
          }

          // Exit editing mode if we were editing
          if (editingMessage && props.onCancelEdit) {
            props.onCancelEdit();
          }
          props.onMessageSent?.();
        }
      } catch (error) {
        // Handle unexpected errors
        console.error("Unexpected error sending message:", error);
        setToast(
          createErrorToast({
            type: "unknown",
            raw: error instanceof Error ? error.message : "Failed to send message",
          })
        );
        // Restore draft on error
        setDraft(preSendDraft);
        setDraftReviews(preSendReviews);
      } finally {
        setSendingCount((c) => c - 1);
        setHideReviewsDuringSend(false);
      }
    } finally {
      // Always restore focus at the end
      setTimeout(() => {
        inputRef.current?.focus();
      }, 0);
    }
  };

  // Keep the imperative API pointing at the latest send handler.
  handleSendRef.current = handleSend;

  // Handler for Escape in vim normal mode - cancels edit if editing
  const handleEscapeInNormalMode = () => {
    if (variant === "workspace" && editingMessage && props.onCancelEdit) {
      restorePreEditDraft();
      props.onCancelEdit();
      inputRef.current?.blur();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Handle voice input toggle (Ctrl+D / Cmd+D)
    if (matchesKeybind(e, KEYBINDS.TOGGLE_VOICE_INPUT) && voiceInput.shouldShowUI) {
      e.preventDefault();
      if (!voiceInput.isAvailable) {
        pushToast({
          type: "error",
          message: voiceInputUnavailableMessage,
        });
        return;
      }
      voiceInput.toggle();
      return;
    }

    // Space on empty input starts voice recording (ignore key repeat from holding)
    if (
      e.key === " " &&
      !e.repeat &&
      input.trim() === "" &&
      voiceInput.shouldShowUI &&
      voiceInput.isAvailable &&
      voiceInput.state === "idle"
    ) {
      e.preventDefault();
      voiceInput.start();
      return;
    }

    // Cycle models (Ctrl+/)
    if (matchesKeybind(e, KEYBINDS.CYCLE_MODEL)) {
      e.preventDefault();
      cycleToNextModel();
      return;
    }

    // Handle cancel edit (Escape) - workspace only
    // In vim mode, escape first goes to normal mode; escapeInNormalMode callback handles cancel
    // In non-vim mode, escape directly cancels edit
    if (matchesKeybind(e, KEYBINDS.CANCEL_EDIT)) {
      if (variant === "workspace" && editingMessage && props.onCancelEdit && !vimEnabled) {
        e.preventDefault();
        stopKeyboardPropagation(e);
        restorePreEditDraft();
        props.onCancelEdit();
        const isFocused = document.activeElement === inputRef.current;
        if (isFocused) {
          inputRef.current?.blur();
        }
        return;
      }
    }

    // Handle up arrow on empty input - edit last user message (workspace only)
    if (
      variant === "workspace" &&
      e.key === "ArrowUp" &&
      !editingMessage &&
      input.trim() === "" &&
      props.onEditLastUserMessage
    ) {
      e.preventDefault();
      props.onEditLastUserMessage();
      return;
    }

    // Note: ESC handled by VimTextArea (for mode transitions) and CommandSuggestions (for dismissal)

    const hasCommandSuggestionMenu = showCommandSuggestions && commandSuggestions.length > 0;
    const hasAtMentionSuggestionMenu = showAtMentionSuggestions && atMentionSuggestions.length > 0;

    // Don't handle keys if suggestions are visible.
    // Enter/Tab/arrows/Escape are handled by CommandSuggestions for both slash and @mention menus.
    if (
      (hasCommandSuggestionMenu && COMMAND_SUGGESTION_KEYS.includes(e.key)) ||
      (hasAtMentionSuggestionMenu && FILE_SUGGESTION_KEYS.includes(e.key))
    ) {
      return; // Let CommandSuggestions handle it
    }

    // Handle send message (Shift+Enter for newline is default behavior)
    if (matchesKeybind(e, KEYBINDS.SEND_MESSAGE)) {
      // Mobile keyboards should keep Enter for newlines; sending remains button-driven.
      if (isMobileTouch) {
        return;
      }
      e.preventDefault();
      void handleSend();
    }
  };

  const interruptKeybind = vimEnabled
    ? KEYBINDS.INTERRUPT_STREAM_VIM
    : KEYBINDS.INTERRUPT_STREAM_NORMAL;

  // Build placeholder text based on current state
  const placeholder = (() => {
    // Creation view keeps the onboarding prompt; workspace stays concise for the inline hints.
    if (variant === "creation") {
      return "Type your first message to create a workspace...";
    }

    // Workspace variant placeholders
    if (editingMessage) {
      if (isMobileTouch) {
        return "Edit your message...";
      }
      const cancelHint = vimEnabled
        ? `${formatKeybind(KEYBINDS.CANCEL_EDIT)}×2 to cancel`
        : `${formatKeybind(KEYBINDS.CANCEL_EDIT)} to cancel`;
      return `Edit your message... (${cancelHint}, ${formatKeybind(KEYBINDS.SEND_MESSAGE)} to send)`;
    }
    if (disabled) {
      const disabledReason = props.disabledReason;
      if (typeof disabledReason === "string" && disabledReason.trim().length > 0) {
        return disabledReason;
      }
    }
    if (isCompacting) {
      if (isMobileTouch) {
        return "Compacting...";
      }
      return `Compacting... (${formatKeybind(interruptKeybind)} cancel | ${formatKeybind(KEYBINDS.SEND_MESSAGE)} to queue)`;
    }

    // Keep placeholder minimal; shortcut hints are rendered below the input.
    return "Type a message...";
  })();

  const activeToast = toast ?? (variant === "creation" ? creationState.toast : null);

  // No wrapper needed - parent controls layout for both variants
  const Wrapper = React.Fragment;
  const wrapperProps = {};

  return (
    <Wrapper {...wrapperProps}>
      {/* Loading overlay during workspace creation */}
      {variant === "creation" && (
        <CreationCenterContent
          projectName={props.projectName}
          isSending={isSendInFlight}
          workspaceName={isSendInFlight ? creationState.creatingWithIdentity?.name : undefined}
          workspaceTitle={isSendInFlight ? creationState.creatingWithIdentity?.title : undefined}
        />
      )}

      {/* Input section - centered card for creation, bottom bar for workspace */}
      <div
        ref={chatInputSectionRef}
        className={cn(
          "relative flex flex-col gap-1",
          variant === "creation"
            ? "bg-separator w-full max-w-3xl rounded-lg border border-border-light px-6 py-5 shadow-lg"
            : "bg-separator border-border-light border-t px-[15px] pt-[5px] pb-[max(8px,min(env(safe-area-inset-bottom,0px),40px))] mb-[calc(-1*min(env(safe-area-inset-bottom,0px),40px))]"
        )}
        data-component="ChatInputSection"
        data-autofocus-state="done"
      >
        <div className={cn("w-full", variant !== "creation" && "mx-auto max-w-4xl")}>
          {/* Toasts (overlay) */}
          <div className="pointer-events-none absolute right-[15px] bottom-full left-[15px] z-[1000] mb-2 flex flex-col gap-2 [&>*]:pointer-events-auto">
            <ConnectionStatusToast wrap={false} />
            <ChatInputToast
              toast={activeToast}
              wrap={false}
              onDismiss={() => {
                handleToastDismiss();
                if (variant === "creation") {
                  creationState.setToast(null);
                }
              }}
            />
          </div>

          {/* Attached reviews preview - show styled blocks with remove/edit buttons */}
          {/* Hide during send to avoid duplicate display with the sent message */}
          {variant === "workspace" && !hideReviewsDuringSend && (
            <AttachedReviewsPanel
              reviews={reviewPanelItems}
              onDetachAll={reviewOverrideActive ? undefined : props.onDetachAllReviews}
              onDetach={reviewOverrideActive ? undefined : props.onDetachReview}
              onCheck={reviewOverrideActive ? undefined : props.onCheckReview}
              onDelete={reviewOverrideActive ? undefined : props.onDeleteReview}
              onUpdateNote={reviewOverrideActive ? undefined : props.onUpdateReviewNote}
            />
          )}

          {/* Creation header controls - shown above textarea for creation variant */}
          {creationControlsProps && <CreationControls {...creationControlsProps} />}

          <CodexOauthWarningBanner
            activeModel={baseModel}
            codexOauthSet={codexOauthSet}
            onOpenProviders={() => open("providers", { expandProvider: "openai" })}
          />

          {/* File path suggestions (@src/foo.ts) */}
          <CommandSuggestions
            suggestions={atMentionSuggestions}
            onSelectSuggestion={handleAtMentionSelect}
            onDismiss={() => setShowAtMentionSuggestions(false)}
            isVisible={showAtMentionSuggestions}
            ariaLabel="File path suggestions"
            listId={atMentionListId}
            anchorRef={variant === "creation" ? inputRef : undefined}
            highlightQuery={lastAtMentionQueryRef.current ?? ""}
            isFileSuggestion
          />

          {/* Slash command suggestions - available in both variants */}
          {/* In creation mode, use portal (anchorRef) to escape overflow:hidden containers */}
          <CommandSuggestions
            suggestions={commandSuggestions}
            onSelectSuggestion={handleCommandSelect}
            onDismiss={() => setShowCommandSuggestions(false)}
            isVisible={showCommandSuggestions}
            ariaLabel="Slash command suggestions"
            listId={commandListId}
            anchorRef={variant === "creation" ? inputRef : undefined}
          />

          <div className="relative flex items-end pb-1" data-component="ChatInputControls">
            {/* Recording/transcribing overlay - replaces textarea when active */}
            {voiceInput.state !== "idle" ? (
              <RecordingOverlay
                state={voiceInput.state}
                agentColor={focusBorderColor}
                mediaRecorder={voiceInput.mediaRecorder}
                onStop={voiceInput.toggle}
              />
            ) : (
              <>
                {/* Give the input more vertical room so the shortcut hints sit above the footer. */}
                <VimTextArea
                  ref={inputRef}
                  data-escape-interrupts-stream="true"
                  value={input}
                  isEditing={!!editingMessage}
                  focusBorderColor={focusBorderColor}
                  onChange={handleInputChange}
                  onKeyDown={handleKeyDown}
                  onPaste={handlePaste}
                  onKeyUp={handleAtMentionCursorActivity}
                  onMouseUp={handleAtMentionCursorActivity}
                  onSelect={handleAtMentionCursorActivity}
                  onDragOver={handleDragOver}
                  onDrop={handleDrop}
                  onEscapeInNormalMode={handleEscapeInNormalMode}
                  suppressKeys={
                    showAtMentionSuggestions
                      ? FILE_SUGGESTION_KEYS
                      : showCommandSuggestions
                        ? COMMAND_SUGGESTION_KEYS
                        : undefined
                  }
                  placeholder={placeholder}
                  disabled={!editingMessage && (disabled || sendInFlightBlocksInput)}
                  aria-label={editingMessage ? "Edit your last message" : "Message Claude"}
                  aria-autocomplete="list"
                  aria-controls={
                    showAtMentionSuggestions && atMentionSuggestions.length > 0
                      ? atMentionListId
                      : showCommandSuggestions && commandSuggestions.length > 0
                        ? commandListId
                        : undefined
                  }
                  aria-expanded={
                    (showCommandSuggestions && commandSuggestions.length > 0) ||
                    (showAtMentionSuggestions && atMentionSuggestions.length > 0)
                  }
                  className={variant === "creation" ? "min-h-28" : "min-h-16"}
                />
                {/* Keep shortcuts visible in both creation + workspace without bloating the footer or crowding it. */}
                {input.trim() === "" && !editingMessage && (
                  <div className="mobile-hide-shortcut-hints text-muted pointer-events-none absolute right-12 bottom-3 left-2 flex items-center gap-4 text-[11px]">
                    <span>
                      <span className="font-mono">{formatKeybind(KEYBINDS.FOCUS_CHAT)}</span>
                      <span> - focus chat</span>
                    </span>
                    <span>
                      <span className="font-mono">{formatKeybind(KEYBINDS.CYCLE_MODEL)}</span>
                      <span> - change model</span>
                    </span>
                    <span>
                      <span className="font-mono">{formatKeybind(KEYBINDS.CYCLE_AGENT)}</span>
                      <span> - change agent</span>
                    </span>
                  </div>
                )}

                {/* Floating voice input button inside textarea */}
                <div className="absolute right-2 bottom-2">
                  <VoiceInputButton
                    state={voiceInput.state}
                    isAvailable={voiceInput.isAvailable}
                    shouldShowUI={voiceInput.shouldShowUI}
                    requiresSecureContext={voiceInput.requiresSecureContext}
                    onToggle={voiceInput.toggle}
                    disabled={disabled || sendInFlightBlocksInput}
                    agentColor={focusBorderColor}
                  />
                </div>
              </>
            )}
          </div>

          {/* Attachments */}
          <ChatAttachments attachments={attachments} onRemove={handleRemoveAttachment} />

          <div className="flex flex-col gap-0.5" data-component="ChatModeToggles">
            {/* Editing indicator - workspace only */}
            {variant === "workspace" && editingMessage && (
              <div className="text-edit-mode text-[11px] font-medium">
                Editing message{" "}
                <span className="mobile-hide-shortcut-hints">
                  ({formatKeybind(KEYBINDS.CANCEL_EDIT)}
                  {vimEnabled ? "×2" : ""} to cancel)
                </span>
              </div>
            )}

            <div className="@container flex min-w-[340px] flex-nowrap items-center gap-1.5">
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                <div
                  className="flex min-w-0 items-center gap-1.5"
                  data-component="ModelSelectorGroup"
                  data-tutorial="model-selector"
                >
                  <ModelSelector
                    ref={modelSelectorRef}
                    value={baseModel}
                    onChange={setPreferredModel}
                    models={models}
                    onComplete={() => inputRef.current?.focus()}
                    defaultModel={defaultModel}
                    onSetDefaultModel={setDefaultModel}
                    hiddenModels={hiddenModelsForSelector}
                    onOpenSettings={() => open("models")}
                    className="w-[clamp(5.5rem,28vw,8rem)] min-w-0"
                  />
                  <div className="hidden [@container(min-width:500px)]:[@media(hover:hover)_and_(pointer:fine)]:block">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <HelpIndicator>?</HelpIndicator>
                      </TooltipTrigger>
                      <TooltipContent align="start" className="max-w-80 whitespace-normal">
                        <strong>Click to edit</strong>
                        <br />
                        <strong>{formatKeybind(KEYBINDS.CYCLE_MODEL)}</strong> to cycle models
                        <br />
                        <br />
                        <strong>Abbreviations:</strong>
                        {MODEL_ABBREVIATION_EXAMPLES.map((ex) => (
                          <React.Fragment key={ex.abbrev}>
                            <br />• <code>/model {ex.abbrev}</code> - {ex.displayName}
                          </React.Fragment>
                        ))}
                        <br />
                        <br />
                        <strong>Full format:</strong>
                        <br />
                        <code>/model provider:model-name</code>
                        <br />
                        (e.g., <code>/model anthropic:claude-sonnet-4-5</code>)
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </div>

                {/* On narrow layouts, hide the thinking paddles to prevent control overlap. */}
                <div
                  className="flex shrink-0 items-center [@container(max-width:420px)]:[&_[data-thinking-paddle]]:hidden"
                  data-component="ThinkingSliderGroup"
                >
                  <ThinkingSliderComponent modelString={baseModel} />
                </div>
              </div>

              <div
                className="flex min-w-0 items-center justify-end gap-1.5"
                data-component="ModelControls"
                data-tutorial="mode-selector"
              >
                {variant === "workspace" && (
                  <ContextUsageIndicatorButton
                    data={contextUsageData}
                    autoCompaction={autoCompactionProps}
                    idleCompaction={idleCompactionProps}
                    model={contextDisplayModel}
                  />
                )}

                <div className="min-w-0 [@container(max-width:340px)]:hidden">
                  <AgentModePicker
                    className="min-w-0"
                    onComplete={() => inputRef.current?.focus()}
                  />
                </div>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      onClick={() => void handleSend()}
                      disabled={!canSend}
                      aria-label="Send message"
                      size="xs"
                      variant="ghost"
                      className={cn(
                        "text-muted hover:text-foreground hover:bg-hover inline-flex items-center justify-center rounded-sm px-1.5 py-0.5 font-medium transition-colors duration-200 disabled:opacity-50",
                        // Touch: wider tap target, keep icon centered.
                        "[@media(hover:none)_and_(pointer:coarse)]:h-9 [@media(hover:none)_and_(pointer:coarse)]:w-11 [@media(hover:none)_and_(pointer:coarse)]:px-0 [@media(hover:none)_and_(pointer:coarse)]:py-0 [@media(hover:none)_and_(pointer:coarse)]:text-sm"
                      )}
                    >
                      <SendHorizontal
                        className="h-3.5 w-3.5 [@media(hover:none)_and_(pointer:coarse)]:h-4 [@media(hover:none)_and_(pointer:coarse)]:w-4"
                        strokeWidth={2.5}
                      />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent align="center">
                    Send message{" "}
                    <span className="mobile-hide-shortcut-hints">
                      ({formatKeybind(KEYBINDS.SEND_MESSAGE)})
                    </span>
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Confirmation modal for destructive commands */}
      <ConfirmationModal
        isOpen={pendingDestructiveCommand !== null}
        title={
          pendingDestructiveCommand?.type === "clear"
            ? "Clear Chat History?"
            : `Truncate ${Math.round((pendingDestructiveCommand?.percentage ?? 0) * 100)}% of Chat History?`
        }
        description={
          pendingDestructiveCommand?.type === "clear"
            ? "This will remove all messages from the conversation."
            : `This will remove approximately ${Math.round((pendingDestructiveCommand?.percentage ?? 0) * 100)}% of the oldest messages.`
        }
        warning="This action cannot be undone."
        confirmLabel={pendingDestructiveCommand?.type === "clear" ? "Clear" : "Truncate"}
        onConfirm={handleDestructiveCommandConfirm}
        onCancel={handleDestructiveCommandCancel}
      />
    </Wrapper>
  );
};

export const ChatInput = React.memo(ChatInputInner);
ChatInput.displayName = "ChatInput";
