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
import { usePersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { useMode } from "@/browser/contexts/ModeContext";
import { ThinkingSliderComponent } from "../ThinkingSlider";
import { ModelSettings } from "../ModelSettings";
import { useAPI } from "@/browser/contexts/API";
import { useSendMessageOptions } from "@/browser/hooks/useSendMessageOptions";
import {
  getModelKey,
  getInputKey,
  VIM_ENABLED_KEY,
  getProjectScopeId,
  getPendingScopeId,
} from "@/common/constants/storage";
import {
  handleNewCommand,
  handleCompactCommand,
  forkWorkspace,
  prepareCompactionMessage,
  executeCompaction,
  type CommandHandlerContext,
} from "@/browser/utils/chatCommands";
import { shouldTriggerAutoCompaction } from "@/browser/utils/compaction/shouldTriggerAutoCompaction";
import { CUSTOM_EVENTS } from "@/common/constants/events";
import {
  getSlashCommandSuggestions,
  type SlashSuggestion,
} from "@/browser/utils/slashCommands/suggestions";
import { TooltipWrapper, Tooltip, HelpIndicator } from "../Tooltip";
import { ModeSelector } from "../ModeSelector";
import {
  matchesKeybind,
  formatKeybind,
  KEYBINDS,
  isEditableElement,
} from "@/browser/utils/ui/keybinds";
import { ModelSelector, type ModelSelectorRef } from "../ModelSelector";
import { useModelLRU } from "@/browser/hooks/useModelLRU";
import { SendHorizontal } from "lucide-react";
import { VimTextArea } from "../VimTextArea";
import { ImageAttachments, type ImageAttachment } from "../ImageAttachments";
import {
  extractImagesFromClipboard,
  extractImagesFromDrop,
  processImageFiles,
} from "@/browser/utils/imageHandling";

import type { ThinkingLevel } from "@/common/types/thinking";
import type { MuxFrontendMetadata } from "@/common/types/message";
import { MODEL_ABBREVIATION_EXAMPLES } from "@/common/constants/knownModels";
import { useTelemetry } from "@/browser/hooks/useTelemetry";
import { setTelemetryEnabled } from "@/common/telemetry";
import { getTokenCountPromise } from "@/browser/utils/tokenizer/rendererClient";
import { CreationCenterContent } from "./CreationCenterContent";
import { cn } from "@/common/lib/utils";
import { CreationControls } from "./CreationControls";
import { useCreationWorkspace } from "./useCreationWorkspace";
import { useTutorial } from "@/browser/contexts/TutorialContext";
import { useVoiceInput } from "@/browser/hooks/useVoiceInput";
import { VoiceInputButton } from "./VoiceInputButton";
import { RecordingOverlay } from "./RecordingOverlay";

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

export type { ChatInputProps, ChatInputAPI };

export const ChatInput: React.FC<ChatInputProps> = (props) => {
  const { api } = useAPI();
  const { variant } = props;

  // Extract workspace-specific props with defaults
  const disabled = props.disabled ?? false;
  const editingMessage = variant === "workspace" ? props.editingMessage : undefined;
  const isCompacting = variant === "workspace" ? (props.isCompacting ?? false) : false;
  const canInterrupt = variant === "workspace" ? (props.canInterrupt ?? false) : false;

  // Storage keys differ by variant
  const storageKeys = (() => {
    if (variant === "creation") {
      return {
        inputKey: getInputKey(getPendingScopeId(props.projectPath)),
        modelKey: getModelKey(getProjectScopeId(props.projectPath)),
      };
    }
    return {
      inputKey: getInputKey(props.workspaceId),
      modelKey: getModelKey(props.workspaceId),
    };
  })();

  const [input, setInput] = usePersistedState(storageKeys.inputKey, "", { listener: true });
  const [isSending, setIsSending] = useState(false);
  const [showCommandSuggestions, setShowCommandSuggestions] = useState(false);
  const [commandSuggestions, setCommandSuggestions] = useState<SlashSuggestion[]>([]);
  const [providerNames, setProviderNames] = useState<string[]>([]);
  const [toast, setToast] = useState<Toast | null>(null);
  const [imageAttachments, setImageAttachments] = useState<ImageAttachment[]>([]);
  const handleToastDismiss = useCallback(() => {
    setToast(null);
  }, []);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const modelSelectorRef = useRef<ModelSelectorRef>(null);

  // Draft state combines text input and image attachments
  // Use these helpers to avoid accidentally losing images when modifying text
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
    [setInput]
  );
  const preEditDraftRef = useRef<DraftState>({ text: "", images: [] });
  const [mode, setMode] = useMode();
  const { recentModels, addModel, defaultModel, setDefaultModel } = useModelLRU();
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
      setToast({ id: Date.now().toString(), type: "error", message: error });
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
  // Extract model for convenience (don't create separate state - use hook as single source of truth)
  const preferredModel = sendMessageOptions.model;
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
  const hasTypedText = input.trim().length > 0;
  const hasImages = imageAttachments.length > 0;
  const canSend = (hasTypedText || hasImages) && !disabled && !isSending;
  // Setter for model - updates localStorage directly so useSendMessageOptions picks it up
  const setPreferredModel = useCallback(
    (model: string) => {
      addModel(model); // Update LRU
      updatePersistedState(storageKeys.modelKey, model); // Update workspace or project-specific
    },
    [storageKeys.modelKey, addModel]
  );

  // Creation-specific state (hook always called, but only used when variant === "creation")
  // This avoids conditional hook calls which violate React rules
  const creationState = useCreationWorkspace(
    variant === "creation"
      ? {
          projectPath: props.projectPath,
          onWorkspaceCreated: props.onWorkspaceCreated,
        }
      : {
          // Dummy values for workspace variant (never used)
          projectPath: "",
          // eslint-disable-next-line @typescript-eslint/no-empty-function
          onWorkspaceCreated: () => {},
        }
  );

  // When entering creation mode (or when the default model changes), reset the
  // project-scoped model to the explicit default so manual picks don't bleed
  // into subsequent creation flows.
  useEffect(() => {
    if (variant === "creation" && defaultModel) {
      updatePersistedState(storageKeys.modelKey, defaultModel);
    }
  }, [variant, defaultModel, storageKeys.modelKey]);

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
  const restoreImages = useCallback((images: ImagePart[]) => {
    const attachments: ImageAttachment[] = images.map((img, index) => ({
      id: `restored-${Date.now()}-${index}`,
      url: img.url,
      mediaType: img.mediaType,
    }));
    setImageAttachments(attachments);
  }, []);

  // Provide API to parent via callback
  useEffect(() => {
    if (props.onReady) {
      props.onReady({
        focus: focusMessageInput,
        restoreText,
        appendText,
        prependText,
        restoreImages,
      });
    }
  }, [
    props.onReady,
    focusMessageInput,
    restoreText,
    appendText,
    prependText,
    restoreImages,
    props,
  ]);

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
      }
    };

    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => {
      window.removeEventListener("keydown", handleGlobalKeyDown);
    };
  }, [focusMessageInput]);

  // When entering editing mode, save current draft and populate with message content
  useEffect(() => {
    if (editingMessage) {
      preEditDraftRef.current = getDraft();
      setDraft({ text: editingMessage.content, images: [] });
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

  // Watch input for slash commands
  useEffect(() => {
    const suggestions = getSlashCommandSuggestions(input, { providerNames });
    setCommandSuggestions(suggestions);
    setShowCommandSuggestions(suggestions.length > 0);
  }, [input, providerNames]);

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
  useEffect(() => {
    let isMounted = true;

    const checkOpenAIKey = async () => {
      try {
        const config = await api?.providers.getConfig();
        if (isMounted) {
          setOpenAIKeySet(config?.openai?.apiKeySet ?? false);
        }
      } catch (error) {
        console.error("Failed to check OpenAI API key:", error);
      }
    };

    void checkOpenAIKey();

    return () => {
      isMounted = false;
    };
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
  }, [appendText, restoreText, restoreImages]);

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
      };

      setToast({
        id: Date.now().toString(),
        type: "success",
        message: `Thinking effort set to ${levelDescriptions[level]}`,
      });
    };

    window.addEventListener(CUSTOM_EVENTS.THINKING_LEVEL_TOAST, handler as EventListener);
    return () =>
      window.removeEventListener(CUSTOM_EVENTS.THINKING_LEVEL_TOAST, handler as EventListener);
  }, [variant, props, setToast]);

  // Voice input: command palette toggle + global recording keybinds
  useEffect(() => {
    if (!voiceInput.shouldShowUI) return;

    const handleToggle = () => {
      if (!voiceInput.isApiKeySet) {
        setToast({
          id: Date.now().toString(),
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
  }, [voiceInput, setToast]);

  // Auto-focus chat input when workspace changes (workspace only)
  const workspaceIdForFocus = variant === "workspace" ? props.workspaceId : null;
  useEffect(() => {
    if (variant !== "workspace") return;

    // Small delay to ensure DOM is ready and other components have settled
    const timer = setTimeout(() => {
      focusMessageInput();
    }, 100);
    return () => clearTimeout(timer);
  }, [variant, workspaceIdForFocus, focusMessageInput]);

  // Handle paste events to extract images
  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const imageFiles = extractImagesFromClipboard(items);
    if (imageFiles.length === 0) return;

    e.preventDefault(); // Prevent default paste behavior for images

    void processImageFiles(imageFiles).then((attachments) => {
      setImageAttachments((prev) => [...prev, ...attachments]);
    });
  }, []);

  // Handle removing an image attachment
  const handleRemoveImage = useCallback((id: string) => {
    setImageAttachments((prev) => prev.filter((img) => img.id !== id));
  }, []);

  // Handle drag over to allow drop
  const handleDragOver = useCallback((e: React.DragEvent<HTMLTextAreaElement>) => {
    // Check if drag contains files
    if (e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);

  // Handle drop to extract images
  const handleDrop = useCallback((e: React.DragEvent<HTMLTextAreaElement>) => {
    e.preventDefault();

    const imageFiles = extractImagesFromDrop(e.dataTransfer);
    if (imageFiles.length === 0) return;

    void processImageFiles(imageFiles).then((attachments) => {
      setImageAttachments((prev) => [...prev, ...attachments]);
    });
  }, []);

  // Handle command selection
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
      // Creation variant: simple message send + workspace creation
      setIsSending(true);
      // Convert image attachments to image parts
      const creationImageParts = imageAttachments.map((img) => ({
        url: img.url,
        mediaType: img.mediaType,
      }));
      const ok = await creationState.handleSend(
        messageText,
        creationImageParts.length > 0 ? creationImageParts : undefined
      );
      if (ok) {
        setInput("");
        setImageAttachments([]);
        if (inputRef.current) {
          inputRef.current.style.height = "36px";
        }
      }
      setIsSending(false);
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
            inputRef.current.style.height = "36px";
          }
          await props.onTruncateHistory(1.0);
          setToast({
            id: Date.now().toString(),
            type: "success",
            message: "Chat history cleared",
          });
          return;
        }

        // Handle /truncate command
        if (parsed.type === "truncate") {
          setInput("");
          if (inputRef.current) {
            inputRef.current.style.height = "36px";
          }
          await props.onTruncateHistory(parsed.percentage);
          setToast({
            id: Date.now().toString(),
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
            setToast({
              id: Date.now().toString(),
              type: "success",
              message: `Provider ${parsed.provider} updated`,
            });
          } catch (error) {
            console.error("Failed to update provider config:", error);
            setToast({
              id: Date.now().toString(),
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
          setToast({
            id: Date.now().toString(),
            type: "success",
            message: `Model changed to ${parsed.modelString}`,
          });
          return;
        }

        // Handle /vim command
        if (parsed.type === "vim-toggle") {
          setInput(""); // Clear input immediately
          setVimEnabled((prev) => !prev);
          return;
        }

        // Handle /telemetry command
        if (parsed.type === "telemetry-set") {
          setInput(""); // Clear input immediately
          setTelemetryEnabled(parsed.enabled);
          setToast({
            id: Date.now().toString(),
            type: "success",
            message: `Telemetry ${parsed.enabled ? "enabled" : "disabled"}`,
          });
          return;
        }

        // Handle /compact command
        if (parsed.type === "compact") {
          if (!api) {
            setToast({
              id: Date.now().toString(),
              type: "error",
              message: "Not connected to server",
            });
            return;
          }
          const context: CommandHandlerContext = {
            api: api,
            workspaceId: props.workspaceId,
            sendMessageOptions,
            editMessageId: editingMessage?.id,
            setInput,
            setImageAttachments,
            setIsSending,
            setToast,
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
          if (!api) {
            setToast({
              id: Date.now().toString(),
              type: "error",
              message: "Not connected to server",
            });
            return;
          }
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
              setToast({
                id: Date.now().toString(),
                type: "error",
                title: "Fork Failed",
                message: errorMsg,
              });
              setInput(messageText); // Restore input on error
            } else {
              setToast({
                id: Date.now().toString(),
                type: "success",
                message: `Forked to workspace "${parsed.newName}"`,
              });
            }
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : "Failed to fork workspace";
            console.error("Fork error:", error);
            setToast({
              id: Date.now().toString(),
              type: "error",
              title: "Fork Failed",
              message: errorMsg,
            });
            setInput(messageText); // Restore input on error
          }

          setIsSending(false);
          return;
        }

        // Handle /new command
        if (parsed.type === "new") {
          if (!api) {
            setToast({
              id: Date.now().toString(),
              type: "error",
              message: "Not connected to server",
            });
            return;
          }
          const context: CommandHandlerContext = {
            api: api,
            workspaceId: props.workspaceId,
            sendMessageOptions,
            setInput,
            setImageAttachments,
            setIsSending,
            setToast,
          };

          const result = await handleNewCommand(parsed, context);
          if (!result.clearInput) {
            setInput(messageText); // Restore input on error
          }
          return;
        }

        // Handle all other commands - show display toast
        const commandToast = createCommandToast(parsed);
        if (commandToast) {
          setToast(commandToast);
          return;
        }
      }

      // Regular message - send directly via API
      if (!api) {
        setToast({
          id: Date.now().toString(),
          type: "error",
          message: "Not connected to server",
        });
        return;
      }
      setIsSending(true);

      // Save current state for restoration on error
      const previousImageAttachments = [...imageAttachments];

      // Auto-compaction check (workspace variant only)
      // Check if we should auto-compact before sending this message
      // Result is computed in parent (AIView) and passed down to avoid duplicate calculation
      if (
        variant === "workspace" &&
        shouldTriggerAutoCompaction(props.autoCompactionCheck, isCompacting, !!editingMessage)
      ) {
        // Prepare image parts for the continue message
        const imageParts = imageAttachments.map((img) => ({
          url: img.url,
          mediaType: img.mediaType,
        }));

        // Clear input immediately for responsive UX
        setInput("");
        setImageAttachments([]);

        try {
          const result = await executeCompaction({
            api,
            workspaceId: props.workspaceId,
            continueMessage: {
              text: messageText,
              imageParts,
              model: sendMessageOptions.model,
            },
            sendMessageOptions,
          });

          if (!result.success) {
            // Restore on error
            setInput(messageText);
            setImageAttachments(previousImageAttachments);
            setToast({
              id: Date.now().toString(),
              type: "error",
              title: "Auto-Compaction Failed",
              message: result.error ?? "Failed to start auto-compaction",
            });
          } else {
            setToast({
              id: Date.now().toString(),
              type: "success",
              message: `Context threshold reached - auto-compacting...`,
            });
            props.onMessageSent?.();
          }
        } catch (error) {
          // Restore on unexpected error
          setInput(messageText);
          setImageAttachments(previousImageAttachments);
          setToast({
            id: Date.now().toString(),
            type: "error",
            title: "Auto-Compaction Failed",
            message:
              error instanceof Error ? error.message : "Unexpected error during auto-compaction",
          });
        } finally {
          setIsSending(false);
        }

        return; // Skip normal send
      }

      try {
        // Prepare image parts if any
        const imageParts = imageAttachments.map((img, index) => {
          // Validate before sending to help with debugging
          if (!img.url || typeof img.url !== "string") {
            console.error(
              `Image attachment [${index}] has invalid url:`,
              typeof img.url,
              img.url?.slice(0, 50)
            );
          }
          if (!img.url?.startsWith("data:")) {
            console.error(
              `Image attachment [${index}] url is not a data URL:`,
              img.url?.slice(0, 100)
            );
          }
          if (!img.mediaType || typeof img.mediaType !== "string") {
            console.error(
              `Image attachment [${index}] has invalid mediaType:`,
              typeof img.mediaType,
              img.mediaType
            );
          }
          return {
            url: img.url,
            mediaType: img.mediaType,
          };
        });

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

        // Clear input and images immediately for responsive UI
        // These will be restored if the send operation fails
        setInput("");
        setImageAttachments([]);
        // Reset textarea height
        if (inputRef.current) {
          inputRef.current.style.height = "36px";
        }

        const result = await api.workspace.sendMessage({
          workspaceId: props.workspaceId,
          message: actualMessageText,
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
          // Restore input and images on error so user can try again
          setInput(messageText);
          setImageAttachments(previousImageAttachments);
        } else {
          // Track telemetry for successful message send
          telemetry.messageSent(sendMessageOptions.model, mode, actualMessageText.length);

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
        setInput(messageText);
        setImageAttachments(previousImageAttachments);
      } finally {
        setIsSending(false);
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
    // Handle cancel for creation variant
    if (variant === "creation" && matchesKeybind(e, KEYBINDS.CANCEL) && props.onCancel) {
      e.preventDefault();
      props.onCancel();
      return;
    }

    // Handle voice input toggle (Ctrl+D / Cmd+D)
    if (matchesKeybind(e, KEYBINDS.TOGGLE_VOICE_INPUT) && voiceInput.shouldShowUI) {
      e.preventDefault();
      if (!voiceInput.isApiKeySet) {
        setToast({
          id: Date.now().toString(),
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

    // Handle open model selector
    if (matchesKeybind(e, KEYBINDS.OPEN_MODEL_SELECTOR)) {
      e.preventDefault();
      modelSelectorRef.current?.open();
      return;
    }

    // Handle cancel edit (Escape) - workspace only
    // In vim mode, escape first goes to normal mode; escapeInNormalMode callback handles cancel
    // In non-vim mode, escape directly cancels edit
    if (matchesKeybind(e, KEYBINDS.CANCEL_EDIT)) {
      if (variant === "workspace" && editingMessage && props.onCancelEdit && !vimEnabled) {
        e.preventDefault();
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

    // Don't handle keys if command suggestions are visible
    if (
      showCommandSuggestions &&
      commandSuggestions.length > 0 &&
      COMMAND_SUGGESTION_KEYS.includes(e.key)
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
      return `Type your first message to create a workspace... (${formatKeybind(KEYBINDS.SEND_MESSAGE)} to send, Esc to cancel)`;
    }

    // Workspace variant placeholders
    if (editingMessage) {
      const cancelHint = vimEnabled
        ? `${formatKeybind(KEYBINDS.CANCEL_EDIT)}×2 to cancel`
        : `${formatKeybind(KEYBINDS.CANCEL_EDIT)} to cancel`;
      return `Edit your message... (${cancelHint}, ${formatKeybind(KEYBINDS.SEND_MESSAGE)} to send)`;
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
    hints.push(`${formatKeybind(KEYBINDS.OPEN_MODEL_SELECTOR)} to change model`);
    hints.push(`/vim to toggle Vim mode (${vimEnabled ? "on" : "off"})`);

    return `Type a message... (${hints.join(", ")})`;
  })();

  // Wrapper for creation variant to enable full-height flex layout
  const Wrapper = variant === "creation" ? "div" : React.Fragment;
  const wrapperProps = variant === "creation" ? { className: "flex h-full flex-1 flex-col" } : {};

  return (
    <Wrapper {...wrapperProps}>
      {/* Creation center content (shows while loading or idle) */}
      {variant === "creation" && (
        <CreationCenterContent
          projectName={props.projectName}
          isSending={creationState.isSending || isSending}
          inputPreview={creationState.isSending || isSending ? input : undefined}
        />
      )}

      {/* Input section - dim when creating workspace */}
      <div
        className={cn(
          "bg-separator border-border-light relative flex flex-col gap-1 border-t px-[15px] pt-[5px] pb-[15px]",
          variant === "creation" && (creationState.isSending || isSending) && "opacity-50"
        )}
        data-component="ChatInputSection"
      >
        <div className="mx-auto w-full max-w-4xl">
          {/* Creation toast */}
          {variant === "creation" && (
            <ChatInputToast
              toast={creationState.toast}
              onDismiss={() => creationState.setToast(null)}
            />
          )}

          {/* Workspace toast */}
          {variant === "workspace" && (
            <ChatInputToast toast={toast} onDismiss={handleToastDismiss} />
          )}

          {/* Command suggestions - workspace only */}
          {variant === "workspace" && (
            <CommandSuggestions
              suggestions={commandSuggestions}
              onSelectSuggestion={handleCommandSelect}
              onDismiss={() => setShowCommandSuggestions(false)}
              isVisible={showCommandSuggestions}
              ariaLabel="Slash command suggestions"
              listId={commandListId}
            />
          )}

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
                  mode={mode}
                  onChange={setInput}
                  onKeyDown={handleKeyDown}
                  onPaste={handlePaste}
                  onDragOver={handleDragOver}
                  onDrop={handleDrop}
                  onEscapeInNormalMode={handleEscapeInNormalMode}
                  suppressKeys={showCommandSuggestions ? COMMAND_SUGGESTION_KEYS : undefined}
                  placeholder={placeholder}
                  disabled={!editingMessage && (disabled || isSending)}
                  aria-label={editingMessage ? "Edit your last message" : "Message Claude"}
                  aria-autocomplete="list"
                  aria-controls={
                    showCommandSuggestions && commandSuggestions.length > 0
                      ? commandListId
                      : undefined
                  }
                  aria-expanded={showCommandSuggestions && commandSuggestions.length > 0}
                />
                {/* Floating voice input button inside textarea */}
                <div className="absolute right-2 bottom-2">
                  <VoiceInputButton
                    state={voiceInput.state}
                    isApiKeySet={voiceInput.isApiKeySet}
                    shouldShowUI={voiceInput.shouldShowUI}
                    requiresSecureContext={voiceInput.requiresSecureContext}
                    onToggle={voiceInput.toggle}
                    disabled={disabled || isSending}
                    mode={mode}
                  />
                </div>
              </>
            )}
          </div>

          {/* Image attachments */}
          <ImageAttachments images={imageAttachments} onRemove={handleRemoveImage} />

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
                  value={preferredModel}
                  onChange={setPreferredModel}
                  recentModels={recentModels}
                  onComplete={() => inputRef.current?.focus()}
                  defaultModel={defaultModel}
                  onSetDefaultModel={setDefaultModel}
                />
                <TooltipWrapper inline>
                  <HelpIndicator>?</HelpIndicator>
                  <Tooltip className="tooltip" align="left" width="wide">
                    <strong>Click to edit</strong> or use{" "}
                    {formatKeybind(KEYBINDS.OPEN_MODEL_SELECTOR)}
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
                  </Tooltip>
                </TooltipWrapper>
              </div>

              {/* Thinking Slider - slider hidden on narrow containers, label always clickable */}
              <div
                className="flex items-center [&_.thinking-slider]:[@container(max-width:550px)]:hidden"
                data-component="ThinkingSliderGroup"
              >
                <ThinkingSliderComponent modelString={preferredModel} />
              </div>

              <div className="ml-4 flex items-center" data-component="ModelSettingsGroup">
                <ModelSettings model={preferredModel || ""} />
              </div>

              {preferredModel && (
                <div className={hasTypedText ? "block" : "hidden"}>
                  <Suspense
                    fallback={
                      <div
                        className="text-muted flex items-center gap-1 text-xs"
                        data-component="TokenEstimate"
                      >
                        <span>Calculating tokens…</span>
                      </div>
                    }
                  >
                    <TokenCountDisplay reader={tokenCountReader} />
                  </Suspense>
                </div>
              )}

              <div
                className="ml-auto flex items-center gap-2"
                data-component="ModelControls"
                data-tutorial="mode-selector"
              >
                <ModeSelector mode={mode} onChange={setMode} />
                <TooltipWrapper inline>
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
                  <Tooltip className="tooltip" align="center">
                    Send message ({formatKeybind(KEYBINDS.SEND_MESSAGE)})
                  </Tooltip>
                </TooltipWrapper>
              </div>
            </div>

            {/* Creation controls - second row for creation variant */}
            {variant === "creation" && (
              <CreationControls
                branches={creationState.branches}
                trunkBranch={creationState.trunkBranch}
                onTrunkBranchChange={creationState.setTrunkBranch}
                runtimeMode={creationState.runtimeMode}
                sshHost={creationState.sshHost}
                onRuntimeChange={creationState.setRuntimeOptions}
                disabled={creationState.isSending || isSending}
              />
            )}
          </div>
        </div>
      </div>
    </Wrapper>
  );
};

const TokenCountDisplay: React.FC<{ reader: TokenCountReader }> = ({ reader }) => {
  const tokens = reader();
  if (!tokens) {
    return null;
  }
  return (
    <div className="text-muted flex items-center gap-1 text-xs" data-component="TokenEstimate">
      <span>{tokens.toLocaleString()} tokens</span>
    </div>
  );
};
