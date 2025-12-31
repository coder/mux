import React, {
  Suspense,
  useState,
  useRef,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useDeferredValue,
} from "react";
import { CommandSuggestions, COMMAND_SUGGESTION_KEYS } from "../CommandSuggestions";
import type { Toast } from "../ChatInputToast";
import { ChatInputToast } from "../ChatInputToast";
import { createCommandToast, createErrorToast } from "../ChatInputToasts";
import { parseCommand } from "@/browser/utils/slashCommands/parser";
import {
  readPersistedState,
  usePersistedState,
  updatePersistedState,
} from "@/browser/hooks/usePersistedState";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { useMode } from "@/browser/contexts/ModeContext";
import { useAgent } from "@/browser/contexts/AgentContext";
import { resolveAgentProperty, isPlanLike } from "@/common/utils/agentInheritance";
import { ThinkingSliderComponent } from "../ThinkingSlider";
import { ModelSettings } from "../ModelSettings";
import { useAPI } from "@/browser/contexts/API";
import { useThinkingLevel } from "@/browser/hooks/useThinkingLevel";
import { migrateGatewayModel } from "@/browser/hooks/useGatewayModels";
import { enforceThinkingPolicy } from "@/common/utils/thinking/policy";
import { useSendMessageOptions } from "@/browser/hooks/useSendMessageOptions";
import {
  getModelKey,
  getThinkingLevelKey,
  getWorkspaceAISettingsByModeKey,
  getInputKey,
  getInputImagesKey,
  MODE_AI_DEFAULTS_KEY,
  VIM_ENABLED_KEY,
  getProjectScopeId,
  getPendingScopeId,
} from "@/common/constants/storage";
import {
  handleNewCommand,
  handleCompactCommand,
  handlePlanShowCommand,
  handlePlanOpenCommand,
  forkWorkspace,
  prepareCompactionMessage,
  executeCompaction,
  type CommandHandlerContext,
} from "@/browser/utils/chatCommands";
import { shouldTriggerAutoCompaction } from "@/browser/utils/compaction/shouldTriggerAutoCompaction";
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
import { useAutoCompactionSettings } from "@/browser/hooks/useAutoCompactionSettings";
import { calculateTokenMeterData } from "@/common/utils/tokens/tokenMeterUtils";
import {
  matchesKeybind,
  formatKeybind,
  KEYBINDS,
  isEditableElement,
} from "@/browser/utils/ui/keybinds";
import { ModelSelector, type ModelSelectorRef } from "../ModelSelector";
import { useModelsFromSettings } from "@/browser/hooks/useModelsFromSettings";
import { SendHorizontal, X } from "lucide-react";
import { VimTextArea } from "../VimTextArea";
import { ImageAttachments, type ImageAttachment } from "../ImageAttachments";
import {
  extractImagesFromClipboard,
  extractImagesFromDrop,
  imageAttachmentsToImageParts,
  processImageFiles,
} from "@/browser/utils/imageHandling";

import type { ModeAiDefaults } from "@/common/types/modeAiDefaults";
import { coerceThinkingLevel, type ThinkingLevel } from "@/common/types/thinking";
import type { MuxFrontendMetadata } from "@/common/types/message";
import { prepareUserMessageForSend } from "@/common/types/message";
import { MODEL_ABBREVIATION_EXAMPLES } from "@/common/constants/knownModels";
import { useTelemetry } from "@/browser/hooks/useTelemetry";

import { getTokenCountPromise } from "@/browser/utils/tokenizer/rendererClient";
import { CreationCenterContent } from "./CreationCenterContent";
import { cn } from "@/common/lib/utils";
import { CreationControls } from "./CreationControls";
import { useCreationWorkspace } from "./useCreationWorkspace";
import { useTutorial } from "@/browser/contexts/TutorialContext";
import { useVoiceInput } from "@/browser/hooks/useVoiceInput";
import { VoiceInputButton } from "./VoiceInputButton";
import {
  estimatePersistedImageAttachmentsChars,
  readPersistedImageAttachments,
} from "./draftImagesStorage";
import { RecordingOverlay } from "./RecordingOverlay";
import { ReviewBlockFromData } from "../shared/ReviewBlock";
import initMessage from "@/browser/assets/initMessage.txt?raw";

// localStorage quotas are environment-dependent and relatively small.
// Be conservative here so we can warn the user before writes start failing.
const MAX_PERSISTED_IMAGE_DRAFT_CHARS = 4_000_000;
type TokenCountReader = () => number;

function createTokenCountResource(promise: Promise<number>): TokenCountReader {
  let status: "pending" | "success" | "error" = "pending";
  let value = 0;
  let error: Error | null = null;

  const suspender = promise.then(
    (resolved) => {
      status = "success";
      value = resolved;
    },
    (reason: unknown) => {
      status = "error";
      error = reason instanceof Error ? reason : new Error(String(reason));
    }
  );

  return () => {
    if (status === "pending") {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw suspender;
    }
    if (status === "error") {
      throw error ?? new Error("Unknown tokenizer error");
    }
    return value;
  };
}

// Import types from local types file
import type { ChatInputProps, ChatInputAPI } from "./types";
import type { ImagePart } from "@/common/orpc/types";

function imagePartsToAttachments(imageParts: ImagePart[], idPrefix: string): ImageAttachment[] {
  return imageParts.map((img, index) => ({
    id: `${idPrefix}-${index}`,
    url: img.url,
    mediaType: img.mediaType,
  }));
}
export type { ChatInputProps, ChatInputAPI };

const ChatInputInner: React.FC<ChatInputProps> = (props) => {
  const { api } = useAPI();
  const { variant } = props;
  const [thinkingLevel] = useThinkingLevel();
  const atMentionProjectPath = variant === "creation" ? props.projectPath : null;
  const workspaceId = variant === "workspace" ? props.workspaceId : null;

  // Extract workspace-specific props with defaults
  const disabled = props.disabled ?? false;
  const editingMessage = variant === "workspace" ? props.editingMessage : undefined;
  const isCompacting = variant === "workspace" ? (props.isCompacting ?? false) : false;
  const canInterrupt = variant === "workspace" ? (props.canInterrupt ?? false) : false;
  const hasQueuedCompaction =
    variant === "workspace" ? (props.hasQueuedCompaction ?? false) : false;
  // runtimeType for telemetry - defaults to "worktree" if not provided
  const runtimeType = variant === "workspace" ? (props.runtimeType ?? "worktree") : "worktree";

  // Storage keys differ by variant
  const storageKeys = (() => {
    if (variant === "creation") {
      const pendingScopeId = getPendingScopeId(props.projectPath);
      return {
        inputKey: getInputKey(pendingScopeId),
        imagesKey: getInputImagesKey(pendingScopeId),
        modelKey: getModelKey(getProjectScopeId(props.projectPath)),
      };
    }
    return {
      inputKey: getInputKey(props.workspaceId),
      imagesKey: getInputImagesKey(props.workspaceId),
      modelKey: getModelKey(props.workspaceId),
    };
  })();

  const [input, setInput] = usePersistedState(storageKeys.inputKey, "", { listener: true });
  const [isSending, setIsSending] = useState(false);
  const [hideReviewsDuringSend, setHideReviewsDuringSend] = useState(false);
  const [showAtMentionSuggestions, setShowAtMentionSuggestions] = useState(false);
  const [atMentionSuggestions, setAtMentionSuggestions] = useState<SlashSuggestion[]>([]);
  const atMentionDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const atMentionRequestIdRef = useRef(0);
  const lastAtMentionScopeIdRef = useRef<string | null>(null);
  const lastAtMentionQueryRef = useRef<string | null>(null);
  const lastAtMentionInputRef = useRef<string>(input);
  const [showCommandSuggestions, setShowCommandSuggestions] = useState(false);

  const [commandSuggestions, setCommandSuggestions] = useState<SlashSuggestion[]>([]);
  const [providerNames, setProviderNames] = useState<string[]>([]);
  const [toast, setToast] = useState<Toast | null>(null);
  const pushToast = useCallback(
    (nextToast: Omit<Toast, "id">) => {
      setToast({ id: Date.now().toString(), ...nextToast });
    },
    [setToast]
  );
  const handleToastDismiss = useCallback(() => {
    setToast(null);
  }, []);

  const imageDraftTooLargeToastKeyRef = useRef<string | null>(null);

  const [imageAttachments, setImageAttachmentsState] = useState<ImageAttachment[]>(() => {
    return readPersistedImageAttachments(storageKeys.imagesKey);
  });
  const persistImageAttachments = useCallback(
    (nextImages: ImageAttachment[]) => {
      if (nextImages.length === 0) {
        imageDraftTooLargeToastKeyRef.current = null;
        updatePersistedState<ImageAttachment[] | undefined>(storageKeys.imagesKey, undefined);
        return;
      }

      const estimatedChars = estimatePersistedImageAttachmentsChars(nextImages);
      if (estimatedChars > MAX_PERSISTED_IMAGE_DRAFT_CHARS) {
        // Clear persisted value to avoid restoring stale images on restart.
        updatePersistedState<ImageAttachment[] | undefined>(storageKeys.imagesKey, undefined);

        if (imageDraftTooLargeToastKeyRef.current !== storageKeys.imagesKey) {
          imageDraftTooLargeToastKeyRef.current = storageKeys.imagesKey;
          pushToast({
            type: "error",
            message:
              "This draft image is too large to save. It will be lost when you switch workspaces or restart.",
            duration: 5000,
          });
        }
        return;
      }

      imageDraftTooLargeToastKeyRef.current = null;
      updatePersistedState<ImageAttachment[] | undefined>(storageKeys.imagesKey, nextImages);
    },
    [storageKeys.imagesKey, pushToast]
  );

  // Keep image drafts in sync when the storage scope changes (e.g. switching creation projects).
  useEffect(() => {
    imageDraftTooLargeToastKeyRef.current = null;
    setImageAttachmentsState(readPersistedImageAttachments(storageKeys.imagesKey));
  }, [storageKeys.imagesKey]);
  const setImageAttachments = useCallback(
    (value: ImageAttachment[] | ((prev: ImageAttachment[]) => ImageAttachment[])) => {
      setImageAttachmentsState((prev) => {
        const next = value instanceof Function ? value(prev) : value;
        persistImageAttachments(next);
        return next;
      });
    },
    [persistImageAttachments]
  );
  // Attached reviews come from parent via props (persisted in pendingReviews state)
  const attachedReviews = variant === "workspace" ? (props.attachedReviews ?? []) : [];
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const modelSelectorRef = useRef<ModelSelectorRef>(null);
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

  // Draft state combines text input and image attachments
  // Reviews are managed separately via props (persisted in pendingReviews state)
  interface DraftState {
    text: string;
    images: ImageAttachment[];
  }
  const getDraft = useCallback(
    (): DraftState => ({ text: input, images: imageAttachments }),
    [input, imageAttachments]
  );
  const setDraft = useCallback(
    (draft: DraftState) => {
      setInput(draft.text);
      setImageAttachments(draft.images);
    },
    [setInput, setImageAttachments]
  );
  const preEditDraftRef = useRef<DraftState>({ text: "", images: [] });
  const { open } = useSettings();
  const { selectedWorkspace } = useWorkspaceContext();
  const [mode] = useMode();
  const { agentId, agents } = useAgent();

  // Get the active agent's uiColor for focus border styling (respects inheritance)
  // Falls back to plan/exec mode colors based on agent's tool policy
  const focusBorderColor = useMemo(() => {
    if (!agentId) {
      return "var(--color-exec-mode)";
    }
    const color = resolveAgentProperty(agentId, "uiColor", agents);
    if (color) return color;
    // Fallback: use plan color if agent has propose_plan, otherwise exec
    return isPlanLike(agentId, agents) ? "var(--color-plan-mode)" : "var(--color-exec-mode)";
  }, [agentId, agents]);
  const {
    models,
    customModels,
    hiddenModels,
    hideModel,
    unhideModel,
    ensureModelInSettings,
    defaultModel,
    setDefaultModel,
  } = useModelsFromSettings();

  const [modeAiDefaults] = usePersistedState<ModeAiDefaults>(
    MODE_AI_DEFAULTS_KEY,
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

  // Track if OpenAI API key is configured for voice input
  const [openAIKeySet, setOpenAIKeySet] = useState(false);

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
    openAIKeySet,
    useRecordingKeybinds: true,
    api,
  });

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
  // - preferredModel: gateway-transformed model for API calls
  // - baseModel: canonical format for UI display and policy checks (e.g., ThinkingSlider)
  const preferredModel = sendMessageOptions.model;
  const baseModel = sendMessageOptions.baseModel;

  // Context usage indicator data (workspace variant only)
  const workspaceIdForUsage = variant === "workspace" ? props.workspaceId : "";
  const usage = useWorkspaceUsage(workspaceIdForUsage);
  const { options: providerOptions } = useProviderOptions();
  const use1M = providerOptions.anthropic?.use1MContext ?? false;
  const lastUsage = usage?.liveUsage ?? usage?.lastContextUsage;
  const usageModel = lastUsage?.model ?? null;
  const contextUsageData = useMemo(() => {
    return lastUsage
      ? calculateTokenMeterData(lastUsage, usageModel ?? "unknown", use1M, false)
      : { segments: [], totalTokens: 0, totalPercentage: 0 };
  }, [lastUsage, usageModel, use1M]);
  const { threshold: autoCompactThreshold, setThreshold: setAutoCompactThreshold } =
    useAutoCompactionSettings(workspaceIdForUsage, usageModel);
  const autoCompactionProps = useMemo(
    () => ({ threshold: autoCompactThreshold, setThreshold: setAutoCompactThreshold }),
    [autoCompactThreshold, setAutoCompactThreshold]
  );

  const setPreferredModel = useCallback(
    (model: string) => {
      type WorkspaceAISettingsByModeCache = Partial<
        Record<string, { model: string; thinkingLevel: ThinkingLevel }>
      >;

      const canonicalModel = migrateGatewayModel(model);
      ensureModelInSettings(canonicalModel); // Ensure model exists in Settings
      updatePersistedState(storageKeys.modelKey, canonicalModel); // Update workspace or project-specific

      if (variant !== "workspace" || !workspaceId) {
        return;
      }

      const effectiveThinkingLevel = enforceThinkingPolicy(canonicalModel, thinkingLevel);

      const normalizedAgentId =
        typeof agentId === "string" && agentId.trim().length > 0
          ? agentId.trim().toLowerCase()
          : mode;

      updatePersistedState<WorkspaceAISettingsByModeCache>(
        getWorkspaceAISettingsByModeKey(workspaceId),
        (prev) => {
          const record: WorkspaceAISettingsByModeCache =
            prev && typeof prev === "object" ? prev : {};
          return {
            ...record,
            [normalizedAgentId]: { model: canonicalModel, thinkingLevel: effectiveThinkingLevel },
          };
        },
        {}
      );

      // Workspace variant: persist to backend for cross-device consistency.
      // Only persist when the active agent matches the base mode so custom-agent overrides
      // don't clobber exec/plan defaults that other agents inherit.
      if (!api || normalizedAgentId !== mode) {
        return;
      }

      api.workspace
        .updateModeAISettings({
          workspaceId,
          mode,
          aiSettings: { model: canonicalModel, thinkingLevel: effectiveThinkingLevel },
        })
        .catch(() => {
          // Best-effort only. If offline or backend is old, sendMessage will persist.
        });
    },
    [
      api,
      agentId,
      mode,
      storageKeys.modelKey,
      ensureModelInSettings,
      thinkingLevel,
      variant,
      workspaceId,
    ]
  );
  const deferredModel = useDeferredValue(preferredModel);
  const deferredInput = useDeferredValue(input);
  const tokenCountPromise = useMemo(() => {
    if (!deferredModel || deferredInput.trim().length === 0 || deferredInput.startsWith("/")) {
      return Promise.resolve(0);
    }
    if (!api) return Promise.resolve(0);
    return getTokenCountPromise(api, deferredModel, deferredInput);
  }, [api, deferredModel, deferredInput]);
  const tokenCountReader = useMemo(
    () => createTokenCountResource(tokenCountPromise),
    [tokenCountPromise]
  );

  // Model cycling candidates. Prefer the user's custom model list (as configured in Settings).
  // If no custom models are configured, fall back to the full suggested list.
  const cycleModels = useMemo(
    () => (customModels.length > 0 ? customModels : models),
    [customModels, models]
  );

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
  // Creation-specific state (hook always called, but only used when variant === "creation")
  // This avoids conditional hook calls which violate React rules
  const creationState = useCreationWorkspace(
    variant === "creation"
      ? {
          projectPath: props.projectPath,
          onWorkspaceCreated: props.onWorkspaceCreated,
          message: input,
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
  const hasTypedText = input.trim().length > 0;
  const hasImages = imageAttachments.length > 0;
  const hasReviews = attachedReviews.length > 0;
  const canSend = (hasTypedText || hasImages || hasReviews) && !disabled && !isSendInFlight;

  const creationProjectPath = variant === "creation" ? props.projectPath : "";

  // Creation variant: keep the project-scoped model/thinking in sync with global per-mode defaults
  // so switching Plan/Exec uses the configured defaults (and respects "inherit" semantics).
  useEffect(() => {
    if (variant !== "creation") {
      return;
    }

    const scopeId = getProjectScopeId(creationProjectPath);
    const modelKey = getModelKey(scopeId);
    const thinkingKey = getThinkingLevelKey(scopeId);

    const fallbackModel = defaultModel;

    const existingModel = readPersistedState<string>(modelKey, fallbackModel);
    const candidateModel = modeAiDefaults[mode]?.modelString ?? existingModel;
    const resolvedModel =
      typeof candidateModel === "string" && candidateModel.trim().length > 0
        ? candidateModel
        : fallbackModel;

    const existingThinking = readPersistedState<ThinkingLevel>(thinkingKey, "off");
    const candidateThinking = modeAiDefaults[mode]?.thinkingLevel ?? existingThinking ?? "off";
    const resolvedThinking = coerceThinkingLevel(candidateThinking) ?? "off";
    const effectiveThinking = enforceThinkingPolicy(resolvedModel, resolvedThinking);

    if (existingModel !== resolvedModel) {
      updatePersistedState(modelKey, resolvedModel);
    }

    if (existingThinking !== effectiveThinking) {
      updatePersistedState(thinkingKey, effectiveThinking);
    }
  }, [creationProjectPath, defaultModel, mode, modeAiDefaults, variant]);

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

  // Method to restore images to input (used by queued message edit)
  const restoreImages = useCallback(
    (images: ImagePart[]) => {
      setImageAttachments(imagePartsToAttachments(images, `restored-${Date.now()}`));
    },
    [setImageAttachments]
  );

  const onReady = props.onReady;

  // Provide API to parent via callback
  useEffect(() => {
    if (onReady) {
      onReady({
        focus: focusMessageInput,
        restoreText,
        appendText,
        prependText,
        restoreImages,
      });
    }
  }, [onReady, focusMessageInput, restoreText, appendText, prependText, restoreImages]);

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
      const images = editingMessage.imageParts
        ? imagePartsToAttachments(editingMessage.imageParts, `edit-${editingMessage.id}`)
        : [];
      setDraft({ text: editingMessage.content, images });
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
  }, [editingMessage]);

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

    // Prefer slash command suggestions when the input is a command.
    if (input.trimStart().startsWith("/")) {
      // Invalidate any in-flight completion request.
      atMentionRequestIdRef.current++;
      lastAtMentionScopeIdRef.current = null;
      lastAtMentionQueryRef.current = null;
      setAtMentionSuggestions([]);
      setShowAtMentionSuggestions(false);
      return;
    }

    const cursor = inputRef.current?.selectionStart ?? input.length;
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
            .map((p) => ({
              id: `file:${p}`,
              display: p,
              description: "File",
              replacement: `@${p}`,
            }));

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
    const suggestions = getSlashCommandSuggestions(input, { providerNames, variant });
    setCommandSuggestions(suggestions);
    setShowCommandSuggestions(suggestions.length > 0);
  }, [input, providerNames, variant]);

  // Load provider names for suggestions
  useEffect(() => {
    let isMounted = true;

    const loadProviders = async () => {
      try {
        const names = await api?.providers.list();
        if (isMounted && Array.isArray(names)) {
          setProviderNames(names);
        }
      } catch (error) {
        console.error("Failed to load provider list:", error);
      }
    };

    void loadProviders();

    return () => {
      isMounted = false;
    };
  }, [api]);

  // Check if OpenAI API key is configured (for voice input)
  // Subscribe to config changes so key status updates immediately when set in Settings
  useEffect(() => {
    if (!api) return;
    const abortController = new AbortController();
    const signal = abortController.signal;

    const checkOpenAIKey = async () => {
      try {
        const config = await api.providers.getConfig();
        if (!signal.aborted) {
          setOpenAIKeySet(config?.openai?.apiKeySet ?? false);
        }
      } catch {
        // Ignore errors fetching config
      }
    };

    // Initial fetch
    void checkOpenAIKey();

    // Subscribe to provider config changes via oRPC
    (async () => {
      try {
        const iterator = await api.providers.onConfigChanged(undefined, { signal });
        for await (const _ of iterator) {
          if (signal.aborted) break;
          void checkOpenAIKey();
        }
      } catch {
        // Subscription cancelled via abort signal - expected on cleanup
      }
    })();

    return () => abortController.abort();
  }, [api]);

  // Allow external components (e.g., CommandPalette, Queued message edits) to insert text
  useEffect(() => {
    const handler = (e: Event) => {
      const customEvent = e as CustomEvent<{
        text: string;
        mode?: "append" | "replace";
        imageParts?: ImagePart[];
      }>;

      const { text, mode = "append", imageParts } = customEvent.detail;

      if (mode === "replace") {
        if (editingMessage) {
          return;
        }
        restoreText(text);
      } else {
        appendText(text);
      }

      if (imageParts && imageParts.length > 0) {
        restoreImages(imageParts);
      }
    };
    window.addEventListener(CUSTOM_EVENTS.INSERT_TO_CHAT_INPUT, handler as EventListener);
    return () =>
      window.removeEventListener(CUSTOM_EVENTS.INSERT_TO_CHAT_INPUT, handler as EventListener);
  }, [appendText, restoreText, restoreImages, editingMessage]);

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
        xhigh: "Extra High — extended deep thinking",
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
      if (!voiceInput.isApiKeySet) {
        pushToast({
          type: "error",
          message: "Voice input requires OpenAI API key. Configure in Settings → Providers.",
        });
        return;
      }
      voiceInput.toggle();
    };

    window.addEventListener(CUSTOM_EVENTS.TOGGLE_VOICE_INPUT, handleToggle as EventListener);
    return () => {
      window.removeEventListener(CUSTOM_EVENTS.TOGGLE_VOICE_INPUT, handleToggle as EventListener);
    };
  }, [voiceInput, pushToast]);

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

  // Handle paste events to extract images
  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      const imageFiles = extractImagesFromClipboard(items);
      if (imageFiles.length === 0) return;

      // When editing an existing message, we only allow changing the text.
      // Don't preventDefault here so any clipboard text can still paste normally.
      if (editingMessage) {
        pushToast({ type: "error", message: "Images cannot be changed while editing a message." });
        return;
      }

      e.preventDefault(); // Prevent default paste behavior for images

      void processImageFiles(imageFiles).then((attachments) => {
        setImageAttachments((prev) => [...prev, ...attachments]);
      });
    },
    [editingMessage, pushToast, setImageAttachments]
  );

  // Handle removing an image attachment
  const handleRemoveImage = useCallback(
    (id: string) => {
      setImageAttachments((prev) => prev.filter((img) => img.id !== id));
    },
    [setImageAttachments]
  );

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

  // Handle drop to extract images
  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLTextAreaElement>) => {
      e.preventDefault();

      const imageFiles = extractImagesFromDrop(e.dataTransfer);
      if (imageFiles.length === 0) return;

      if (editingMessage) {
        pushToast({ type: "error", message: "Images cannot be changed while editing a message." });
        return;
      }

      void processImageFiles(imageFiles).then((attachments) => {
        setImageAttachments((prev) => [...prev, ...attachments]);
      });
    },
    [editingMessage, pushToast, setImageAttachments]
  );

  // Handle suggestion selection

  const handleAtMentionSelect = useCallback(
    (suggestion: SlashSuggestion) => {
      const cursor = inputRef.current?.selectionStart ?? input.length;
      const match = findAtMentionAtCursor(input, cursor);
      if (!match) {
        return;
      }

      const next =
        input.slice(0, match.startIndex) + suggestion.replacement + input.slice(match.endIndex);

      setInput(next);
      setAtMentionSuggestions([]);
      setShowAtMentionSuggestions(false);

      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el || el.disabled) {
          return;
        }

        el.focus();
        const newCursor = match.startIndex + suggestion.replacement.length;
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

    // Route to creation handler for creation variant
    if (variant === "creation") {
      // Handle /init command in creation variant - populate input with init message
      if (messageText.startsWith("/")) {
        const parsed = parseCommand(messageText);
        if (parsed?.type === "init") {
          setInput(initMessage);
          focusMessageInput();
          return;
        }
      }

      // Creation variant: simple message send + workspace creation
      const creationImageParts = imageAttachmentsToImageParts(imageAttachments);
      const ok = await creationState.handleSend(
        messageText,
        creationImageParts.length > 0 ? creationImageParts : undefined
      );
      if (ok) {
        setInput("");
        setImageAttachments([]);
        // Height is managed by VimTextArea's useLayoutEffect - clear inline style
        // to let CSS min-height take over
        if (inputRef.current) {
          inputRef.current.style.height = "";
        }
      }
      return;
    }

    // Workspace variant: full command handling + message send
    if (variant !== "workspace") return; // Type guard

    try {
      // Parse command
      const parsed = parseCommand(messageText);

      if (parsed) {
        // Handle /clear command
        if (parsed.type === "clear") {
          setInput("");
          if (inputRef.current) {
            inputRef.current.style.height = "";
          }
          await props.onTruncateHistory(1.0);
          pushToast({ type: "success", message: "Chat history cleared" });
          return;
        }

        // Handle /truncate command
        if (parsed.type === "truncate") {
          setInput("");
          if (inputRef.current) {
            inputRef.current.style.height = "";
          }
          await props.onTruncateHistory(parsed.percentage);
          pushToast({
            type: "success",
            message: `Chat history truncated by ${Math.round(parsed.percentage * 100)}%`,
          });
          return;
        }

        // Handle /providers set command
        if (parsed.type === "providers-set" && props.onProviderConfig) {
          setIsSending(true);
          setInput(""); // Clear input immediately

          try {
            await props.onProviderConfig(parsed.provider, parsed.keyPath, parsed.value);
            // Success - show toast
            pushToast({
              type: "success",
              message: `Provider ${parsed.provider} updated`,
            });
          } catch (error) {
            console.error("Failed to update provider config:", error);
            pushToast({
              type: "error",
              message: error instanceof Error ? error.message : "Failed to update provider",
            });
            setInput(messageText); // Restore input on error
          } finally {
            setIsSending(false);
          }
          return;
        }

        // Handle /model command
        if (parsed.type === "model-set") {
          setInput(""); // Clear input immediately
          setPreferredModel(parsed.modelString);
          props.onModelChange?.(parsed.modelString);
          pushToast({ type: "success", message: `Model changed to ${parsed.modelString}` });
          return;
        }

        if (parsed.type === "mcp-open") {
          setInput("");
          open("project");
          return;
        }

        if (parsed.type === "vim-toggle") {
          setInput(""); // Clear input immediately
          setVimEnabled((prev) => !prev);
          return;
        }

        // Handle /init command - populate input with init message
        if (parsed.type === "init") {
          setInput(initMessage);
          focusMessageInput();
          return;
        }

        // Handle other non-API commands (help, invalid args, etc)
        const commandToast = createCommandToast(parsed);
        if (commandToast) {
          setToast(commandToast);
          return;
        }

        if (!api) {
          pushToast({ type: "error", message: "Not connected to server" });
          return;
        }

        const commandHandlerContextBase: CommandHandlerContext = {
          api,
          workspaceId: props.workspaceId,
          sendMessageOptions,
          setInput,
          setImageAttachments,
          setIsSending,
          setToast,
        };

        if (
          parsed.type === "mcp-add" ||
          parsed.type === "mcp-edit" ||
          parsed.type === "mcp-remove"
        ) {
          if (!selectedWorkspace?.projectPath) {
            pushToast({ type: "error", message: "Select a workspace to manage MCP servers" });
            return;
          }

          setIsSending(true);
          setInput("");
          try {
            const projectPath = selectedWorkspace.projectPath;
            const result =
              parsed.type === "mcp-add" || parsed.type === "mcp-edit"
                ? await api.projects.mcp.add({
                    projectPath,
                    name: parsed.name,
                    command: parsed.command,
                  })
                : await api.projects.mcp.remove({ projectPath, name: parsed.name });

            if (!result.success) {
              pushToast({
                type: "error",
                message: result.error ?? "Failed to update MCP servers",
              });
              setInput(messageText);
            } else {
              const successMessage =
                parsed.type === "mcp-add"
                  ? `Added MCP server ${parsed.name}`
                  : parsed.type === "mcp-edit"
                    ? `Updated MCP server ${parsed.name}`
                    : `Removed MCP server ${parsed.name}`;
              pushToast({ type: "success", message: successMessage });
            }
          } catch (error) {
            console.error("Failed to update MCP servers", error);
            pushToast({
              type: "error",
              message: error instanceof Error ? error.message : "Failed to update MCP servers",
            });
            setInput(messageText);
          } finally {
            setIsSending(false);
          }

          return;
        }

        // Handle /compact command
        if (parsed.type === "compact") {
          const context: CommandHandlerContext = {
            ...commandHandlerContextBase,
            editMessageId: editingMessage?.id,
            onCancelEdit: props.onCancelEdit,
          };

          const result = await handleCompactCommand(parsed, context);
          if (!result.clearInput) {
            setInput(messageText); // Restore input on error
          }
          return;
        }

        // Handle /fork command
        if (parsed.type === "fork") {
          setInput(""); // Clear input immediately
          setIsSending(true);

          try {
            const forkResult = await forkWorkspace({
              client: api,
              sourceWorkspaceId: props.workspaceId,
              newName: parsed.newName,
              startMessage: parsed.startMessage,
              sendMessageOptions,
            });

            if (!forkResult.success) {
              const errorMsg = forkResult.error ?? "Failed to fork workspace";
              console.error("Failed to fork workspace:", errorMsg);
              pushToast({ type: "error", title: "Fork Failed", message: errorMsg });
              setInput(messageText); // Restore input on error
            } else {
              pushToast({
                type: "success",
                message: `Forked to workspace "${parsed.newName}"`,
              });
            }
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : "Failed to fork workspace";
            console.error("Fork error:", error);
            pushToast({ type: "error", title: "Fork Failed", message: errorMsg });
            setInput(messageText); // Restore input on error
          }

          setIsSending(false);
          return;
        }

        // Handle /new command
        if (parsed.type === "new") {
          const context = commandHandlerContextBase;

          const result = await handleNewCommand(parsed, context);
          if (!result.clearInput) {
            setInput(messageText); // Restore input on error
          }
          return;
        }

        // Handle /plan command
        if (parsed.type === "plan-show" || parsed.type === "plan-open") {
          const context = commandHandlerContextBase;

          const handler =
            parsed.type === "plan-show" ? handlePlanShowCommand : handlePlanOpenCommand;
          const result = await handler(context);
          if (!result.clearInput) {
            setInput(messageText); // Restore input on error
          }
          return;
        }
        // Handle /idle command
        if (parsed.type === "idle-compaction") {
          if (!api) {
            setToast({
              id: Date.now().toString(),
              type: "error",
              message: "Not connected to server",
            });
            return;
          }
          if (!selectedWorkspace?.projectPath) {
            setToast({
              id: Date.now().toString(),
              type: "error",
              message: "No project selected",
            });
            return;
          }
          setInput(""); // Clear input immediately

          try {
            const result = await api.projects.idleCompaction.set({
              projectPath: selectedWorkspace.projectPath,
              hours: parsed.hours,
            });

            if (!result.success) {
              setToast({
                id: Date.now().toString(),
                type: "error",
                message: result.error ?? "Failed to update setting",
              });
              setInput(messageText); // Restore input on error
            } else {
              setToast({
                id: Date.now().toString(),
                type: "success",
                message: parsed.hours
                  ? `Idle compaction set to ${parsed.hours} hours`
                  : "Idle compaction disabled",
              });
            }
          } catch (error) {
            setToast({
              id: Date.now().toString(),
              type: "error",
              message: error instanceof Error ? error.message : "Failed to update setting",
            });
            setInput(messageText); // Restore input on error
          }
          return;
        }
      }

      // Regular message - send directly via API
      if (!api) {
        pushToast({ type: "error", message: "Not connected to server" });
        return;
      }
      setIsSending(true);

      // Save current draft state for restoration on error
      const preSendDraft = getDraft();

      // Auto-compaction check (workspace variant only)
      // Check if we should auto-compact before sending this message
      // Result is computed in parent (AIView) and passed down to avoid duplicate calculation
      if (
        variant === "workspace" &&
        shouldTriggerAutoCompaction(
          props.autoCompactionCheck,
          isCompacting,
          !!editingMessage,
          hasQueuedCompaction
        )
      ) {
        // Prepare image parts for the continue message
        const imageParts = imageAttachments.map((img) => ({
          url: img.url,
          mediaType: img.mediaType,
        }));

        // Prepare reviews data for the continue message (orthogonal to compaction)
        // Review.data is already ReviewNoteData shape
        const reviewsData =
          attachedReviews.length > 0 ? attachedReviews.map((r) => r.data) : undefined;

        // Capture review IDs for marking as checked on success
        const sentReviewIds = attachedReviews.map((r) => r.id);

        // Clear input immediately for responsive UX
        setInput("");
        setImageAttachments([]);
        setHideReviewsDuringSend(true);

        try {
          const result = await executeCompaction({
            api,
            workspaceId: props.workspaceId,
            continueMessage: {
              text: messageText,
              imageParts,
              model: sendMessageOptions.model,
              reviews: reviewsData,
            },
            sendMessageOptions,
          });

          if (!result.success) {
            // Restore on error
            setDraft(preSendDraft);
            pushToast({
              type: "error",
              title: "Auto-Compaction Failed",
              message: result.error ?? "Failed to start auto-compaction",
            });
          } else {
            // Mark reviews as checked on success
            if (sentReviewIds.length > 0) {
              props.onCheckReviews?.(sentReviewIds);
            }
            pushToast({
              type: "success",
              message: "Context threshold reached - auto-compacting...",
            });
            props.onMessageSent?.();
          }
        } catch (error) {
          // Restore on unexpected error
          setDraft(preSendDraft);
          pushToast({
            type: "error",
            title: "Auto-Compaction Failed",
            message:
              error instanceof Error ? error.message : "Unexpected error during auto-compaction",
          });
        } finally {
          setIsSending(false);
          setHideReviewsDuringSend(false);
        }

        return; // Skip normal send
      }

      try {
        // Prepare image parts if any
        const imageParts = imageAttachmentsToImageParts(imageAttachments, { validate: true });

        // When editing a /compact command, regenerate the actual summarization request
        let actualMessageText = messageText;
        let muxMetadata: MuxFrontendMetadata | undefined;
        let compactionOptions = {};

        if (editingMessage && messageText.startsWith("/")) {
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
              continueMessage: parsed.continueMessage
                ? { text: parsed.continueMessage }
                : undefined,
              model: parsed.model,
              sendMessageOptions,
            });
            actualMessageText = regeneratedText;
            muxMetadata = metadata;
            compactionOptions = sendOptions;
          }
        }

        // Process reviews into message text and metadata using shared utility
        // Review.data is already ReviewNoteData shape
        const reviewsData =
          attachedReviews.length > 0 ? attachedReviews.map((r) => r.data) : undefined;
        const { finalText: finalMessageText, metadata: reviewMetadata } = prepareUserMessageForSend(
          { text: actualMessageText, reviews: reviewsData },
          muxMetadata
        );
        muxMetadata = reviewMetadata;

        // Capture review IDs before clearing (for marking as checked on success)
        const sentReviewIds = attachedReviews.map((r) => r.id);

        // Clear input, images, and hide reviews immediately for responsive UI
        // Text/images are restored if send fails; reviews remain "attached" in state
        // so they'll reappear naturally on failure (we only call onCheckReviews on success)
        setInput("");
        setImageAttachments([]);
        setHideReviewsDuringSend(true);
        // Clear inline height style - VimTextArea's useLayoutEffect will handle sizing
        if (inputRef.current) {
          inputRef.current.style.height = "";
        }

        const result = await api.workspace.sendMessage({
          workspaceId: props.workspaceId,
          message: finalMessageText,
          options: {
            ...sendMessageOptions,
            ...compactionOptions,
            editMessageId: editingMessage?.id,
            imageParts: imageParts.length > 0 ? imageParts : undefined,
            muxMetadata,
          },
        });

        if (!result.success) {
          // Log error for debugging
          console.error("Failed to send message:", result.error);
          // Show error using enhanced toast
          setToast(createErrorToast(result.error));
          // Restore draft on error so user can try again
          setDraft(preSendDraft);
        } else {
          // Track telemetry for successful message send
          telemetry.messageSent(
            props.workspaceId,
            sendMessageOptions.model,
            mode,
            finalMessageText.length,
            runtimeType,
            sendMessageOptions.thinkingLevel ?? "off"
          );

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
      } finally {
        setIsSending(false);
        setHideReviewsDuringSend(false);
      }
    } finally {
      // Always restore focus at the end
      setTimeout(() => {
        inputRef.current?.focus();
      }, 0);
    }
  };

  // Handler for Escape in vim normal mode - cancels edit if editing
  const handleEscapeInNormalMode = () => {
    if (variant === "workspace" && editingMessage && props.onCancelEdit) {
      setDraft(preEditDraftRef.current);
      props.onCancelEdit();
      inputRef.current?.blur();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Handle voice input toggle (Ctrl+D / Cmd+D)
    if (matchesKeybind(e, KEYBINDS.TOGGLE_VOICE_INPUT) && voiceInput.shouldShowUI) {
      e.preventDefault();
      if (!voiceInput.isApiKeySet) {
        pushToast({
          type: "error",
          message: "Voice input requires OpenAI API key. Configure in Settings → Providers.",
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
      voiceInput.isApiKeySet &&
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
        e.stopPropagation(); // Prevent global handler from interrupting stream
        setDraft(preEditDraftRef.current);
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

    // Don't handle keys if suggestions are visible
    if (
      COMMAND_SUGGESTION_KEYS.includes(e.key) &&
      ((showCommandSuggestions && commandSuggestions.length > 0) ||
        (showAtMentionSuggestions && atMentionSuggestions.length > 0))
    ) {
      return; // Let CommandSuggestions handle it
    }

    // Handle send message (Shift+Enter for newline is default behavior)
    if (matchesKeybind(e, KEYBINDS.SEND_MESSAGE)) {
      e.preventDefault();
      void handleSend();
    }
  };

  // Build placeholder text based on current state
  const placeholder = (() => {
    // Creation variant has simple placeholder
    if (variant === "creation") {
      return `Type your first message to create a workspace... (${formatKeybind(KEYBINDS.SEND_MESSAGE)} to send, ${formatKeybind(KEYBINDS.CANCEL)} to cancel)`;
    }

    // Workspace variant placeholders
    if (editingMessage) {
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
      const interruptKeybind = vimEnabled
        ? KEYBINDS.INTERRUPT_STREAM_VIM
        : KEYBINDS.INTERRUPT_STREAM_NORMAL;
      return `Compacting... (${formatKeybind(interruptKeybind)} cancel | ${formatKeybind(KEYBINDS.SEND_MESSAGE)} to queue)`;
    }

    // Build hints for normal input
    const hints: string[] = [];
    if (canInterrupt) {
      const interruptKeybind = vimEnabled
        ? KEYBINDS.INTERRUPT_STREAM_VIM
        : KEYBINDS.INTERRUPT_STREAM_NORMAL;
      hints.push(`${formatKeybind(interruptKeybind)} to interrupt`);
    }
    hints.push(`${formatKeybind(KEYBINDS.SEND_MESSAGE)} to ${canInterrupt ? "queue" : "send"}`);
    hints.push(`Click model to choose, ${formatKeybind(KEYBINDS.CYCLE_MODEL)} to cycle`);
    hints.push(`/vim to toggle Vim mode (${vimEnabled ? "on" : "off"})`);

    return `Type a message... (${hints.join(", ")})`;
  })();

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
            : "bg-separator border-border-light border-t px-[15px] pt-[5px] pb-[15px]"
        )}
        data-component="ChatInputSection"
        data-autofocus-state="done"
      >
        <div className={cn("w-full", variant !== "creation" && "mx-auto max-w-4xl")}>
          {/* Toast - show shared toast (slash commands) or variant-specific toast */}
          <ChatInputToast
            toast={toast ?? (variant === "creation" ? creationState.toast : null)}
            onDismiss={() => {
              handleToastDismiss();
              if (variant === "creation") {
                creationState.setToast(null);
              }
            }}
          />

          {/* Attached reviews preview - show styled blocks with remove/edit buttons */}
          {/* Hide during send to avoid duplicate display with the sent message */}
          {variant === "workspace" && attachedReviews.length > 0 && !hideReviewsDuringSend && (
            <div className="border-border max-h-[50vh] space-y-2 overflow-y-auto border-b px-1.5 py-1.5">
              {/* Header with count and clear all button */}
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted font-medium">
                  {attachedReviews.length} review{attachedReviews.length !== 1 && "s"} attached
                </span>
                {props.onDetachAllReviews && attachedReviews.length > 1 && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={props.onDetachAllReviews}
                        className="text-muted hover:text-error flex items-center gap-1 text-xs transition-colors"
                      >
                        <X className="size-3" />
                        Clear all
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>Remove all reviews from message</TooltipContent>
                  </Tooltip>
                )}
              </div>
              {attachedReviews.map((review) => (
                <ReviewBlockFromData
                  key={review.id}
                  data={review.data}
                  onComplete={
                    props.onCheckReview ? () => props.onCheckReview!(review.id) : undefined
                  }
                  onDetach={
                    props.onDetachReview ? () => props.onDetachReview!(review.id) : undefined
                  }
                  onDelete={
                    props.onDeleteReview ? () => props.onDeleteReview!(review.id) : undefined
                  }
                  onEditComment={
                    props.onUpdateReviewNote
                      ? (newNote) => props.onUpdateReviewNote!(review.id, newNote)
                      : undefined
                  }
                />
              ))}
            </div>
          )}

          {/* Creation header controls - shown above textarea for creation variant */}
          {variant === "creation" && (
            <CreationControls
              branches={creationState.branches}
              branchesLoaded={creationState.branchesLoaded}
              trunkBranch={creationState.trunkBranch}
              onTrunkBranchChange={creationState.setTrunkBranch}
              runtimeMode={creationState.runtimeMode}
              defaultRuntimeMode={creationState.defaultRuntimeMode}
              sshHost={creationState.sshHost}
              onRuntimeModeChange={creationState.setRuntimeMode}
              onSetDefaultRuntime={creationState.setDefaultRuntimeMode}
              onSshHostChange={creationState.setSshHost}
              disabled={isSendInFlight}
              projectName={props.projectName}
              nameState={creationState.nameState}
              isNonGitRepo={creationState.branchesLoaded && creationState.branches.length === 0}
            />
          )}

          {/* File path suggestions (@src/foo.ts) */}
          <CommandSuggestions
            suggestions={atMentionSuggestions}
            onSelectSuggestion={handleAtMentionSelect}
            onDismiss={() => setShowAtMentionSuggestions(false)}
            isVisible={showAtMentionSuggestions}
            ariaLabel="File path suggestions"
            listId={atMentionListId}
            anchorRef={variant === "creation" ? inputRef : undefined}
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

          <div className="relative flex items-end" data-component="ChatInputControls">
            {/* Recording/transcribing overlay - replaces textarea when active */}
            {voiceInput.state !== "idle" ? (
              <RecordingOverlay
                state={voiceInput.state}
                mode={mode}
                mediaRecorder={voiceInput.mediaRecorder}
                onStop={voiceInput.toggle}
              />
            ) : (
              <>
                <VimTextArea
                  ref={inputRef}
                  value={input}
                  isEditing={!!editingMessage}
                  focusBorderColor={focusBorderColor}
                  onChange={setInput}
                  onKeyDown={handleKeyDown}
                  onPaste={handlePaste}
                  onKeyUp={handleAtMentionCursorActivity}
                  onMouseUp={handleAtMentionCursorActivity}
                  onSelect={handleAtMentionCursorActivity}
                  onDragOver={handleDragOver}
                  onDrop={handleDrop}
                  onEscapeInNormalMode={handleEscapeInNormalMode}
                  suppressKeys={
                    showCommandSuggestions || showAtMentionSuggestions
                      ? COMMAND_SUGGESTION_KEYS
                      : undefined
                  }
                  placeholder={placeholder}
                  disabled={!editingMessage && (disabled || isSendInFlight)}
                  aria-label={editingMessage ? "Edit your last message" : "Message Claude"}
                  aria-autocomplete="list"
                  aria-controls={
                    showCommandSuggestions && commandSuggestions.length > 0
                      ? commandListId
                      : showAtMentionSuggestions && atMentionSuggestions.length > 0
                        ? atMentionListId
                        : undefined
                  }
                  aria-expanded={
                    (showCommandSuggestions && commandSuggestions.length > 0) ||
                    (showAtMentionSuggestions && atMentionSuggestions.length > 0)
                  }
                  className={variant === "creation" ? "min-h-24" : undefined}
                />
                {/* Token count - positioned to left of mic */}
                {preferredModel && hasTypedText && (
                  <div className="absolute right-8 bottom-2">
                    <Suspense fallback={<span className="text-muted/50 text-xs">…</span>}>
                      <TokenCountDisplay reader={tokenCountReader} />
                    </Suspense>
                  </div>
                )}
                {/* Floating voice input button inside textarea */}
                <div className="absolute right-2 bottom-2">
                  <VoiceInputButton
                    state={voiceInput.state}
                    isApiKeySet={voiceInput.isApiKeySet}
                    shouldShowUI={voiceInput.shouldShowUI}
                    requiresSecureContext={voiceInput.requiresSecureContext}
                    onToggle={voiceInput.toggle}
                    disabled={disabled || isSendInFlight}
                    mode={mode}
                  />
                </div>
              </>
            )}
          </div>

          {/* Image attachments */}
          <ImageAttachments
            images={imageAttachments}
            onRemove={editingMessage ? undefined : handleRemoveImage}
          />

          <div className="flex flex-col gap-0.5" data-component="ChatModeToggles">
            {/* Editing indicator - workspace only */}
            {variant === "workspace" && editingMessage && (
              <div className="text-edit-mode text-[11px] font-medium">
                Editing message ({formatKeybind(KEYBINDS.CANCEL_EDIT)}
                {vimEnabled ? "×2" : ""} to cancel)
              </div>
            )}

            <div className="@container flex flex-wrap items-center gap-x-3 gap-y-1">
              {/* Model Selector - always visible */}
              <div
                className="flex items-center"
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
                  onHideModel={hideModel}
                  hiddenModels={hiddenModels}
                  onUnhideModel={unhideModel}
                  onOpenSettings={() => open("models")}
                />
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

              {/* Thinking Slider - slider hidden on narrow containers, label always clickable */}
              <div
                className="flex items-center [&_.thinking-slider]:[@container(max-width:550px)]:hidden"
                data-component="ThinkingSliderGroup"
              >
                <ThinkingSliderComponent modelString={baseModel} />
              </div>

              <div className="ml-4 flex items-center" data-component="ModelSettingsGroup">
                <ModelSettings model={baseModel || ""} />
              </div>

              <div
                className="ml-auto flex items-center gap-2"
                data-component="ModelControls"
                data-tutorial="mode-selector"
              >
                {variant === "workspace" && (
                  <ContextUsageIndicatorButton
                    data={contextUsageData}
                    autoCompaction={autoCompactionProps}
                  />
                )}
                <AgentModePicker onComplete={() => inputRef.current?.focus()} />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => void handleSend()}
                      disabled={!canSend}
                      aria-label="Send message"
                      className={cn(
                        "inline-flex items-center gap-1 rounded-sm border border-border-light px-1.5 py-0.5 text-[11px] font-medium text-white transition-colors duration-200 disabled:opacity-50",
                        mode === "plan"
                          ? "bg-plan-mode hover:bg-plan-mode-hover disabled:hover:bg-plan-mode"
                          : "bg-exec-mode hover:bg-exec-mode-hover disabled:hover:bg-exec-mode"
                      )}
                    >
                      <SendHorizontal className="h-3.5 w-3.5" strokeWidth={2.5} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent align="center">
                    Send message ({formatKeybind(KEYBINDS.SEND_MESSAGE)})
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Wrapper>
  );
};

export const ChatInput = React.memo(ChatInputInner);
ChatInput.displayName = "ChatInput";

const TokenCountDisplay: React.FC<{ reader: TokenCountReader }> = ({ reader }) => {
  const tokens = reader();
  if (!tokens) {
    return null;
  }
  return (
    <span className="text-muted/50 text-xs" data-component="TokenEstimate">
      {tokens.toLocaleString()} tokens
    </span>
  );
};
