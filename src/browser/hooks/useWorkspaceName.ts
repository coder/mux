import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useAPI } from "@/browser/contexts/API";

export interface UseWorkspaceNameOptions {
  /** The user's message to generate a name for */
  message: string;
  /** Debounce delay in milliseconds (default: 500) */
  debounceMs?: number;
  /** User's selected model to try after preferred models (for Ollama/Bedrock/custom providers) */
  userModel?: string;
}

/** Generated workspace identity (name + title) */
export interface WorkspaceIdentity {
  /** Short git-safe name with suffix (e.g., "plan-a1b2") */
  name: string;
  /** Human-readable title (e.g., "Fix plan mode over SSH") */
  title: string;
}

/** State and actions for workspace name generation, suitable for passing to components */
export interface WorkspaceNameState {
  /** The generated or manually entered name (shown in CreationControls UI) */
  name: string;
  /** The generated title (only available when auto-generation is enabled) */
  title: string | null;
  /** Whether name generation is in progress */
  isGenerating: boolean;
  /** Whether auto-generation is enabled */
  autoGenerate: boolean;
  /** Error message if generation failed */
  error: string | null;
  /** Set whether auto-generation is enabled */
  setAutoGenerate: (enabled: boolean) => void;
  /** Set manual name (for when auto-generate is off) */
  setName: (name: string) => void;
}

export interface UseWorkspaceNameReturn extends WorkspaceNameState {
  /** Wait for any pending generation to complete, returns both name and title */
  waitForGeneration: () => Promise<WorkspaceIdentity | null>;
}

/**
 * Hook for managing workspace name generation with debouncing.
 *
 * Automatically generates names as the user types their message,
 * but allows manual override. If the user clears the manual name,
 * auto-generation resumes.
 */
export function useWorkspaceName(options: UseWorkspaceNameOptions): UseWorkspaceNameReturn {
  const { message, debounceMs = 500, userModel } = options;
  const { api } = useAPI();

  // Generated identity (name + title) from AI
  const [generatedIdentity, setGeneratedIdentity] = useState<WorkspaceIdentity | null>(null);
  // Manual name (user-editable during creation)
  const [manualName, setManualName] = useState("");
  const [autoGenerate, setAutoGenerate] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track the message that was used for the last successful generation
  const lastGeneratedForRef = useRef<string>("");
  // Debounce timer
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Message pending in debounce timer (captured at schedule time)
  const pendingMessageRef = useRef<string>("");
  // Generation request counter for cancellation
  const requestIdRef = useRef(0);
  // Current in-flight generation promise and its resolver
  const generationPromiseRef = useRef<{
    promise: Promise<WorkspaceIdentity | null>;
    resolve: (identity: WorkspaceIdentity | null) => void;
    requestId: number;
  } | null>(null);

  // Name shown in CreationControls UI: generated name when auto, manual when not
  const name = autoGenerate ? (generatedIdentity?.name ?? "") : manualName;
  // Title is only shown when auto-generation is enabled (manual mode doesn't have generated title)
  const title = autoGenerate ? (generatedIdentity?.title ?? null) : null;

  // Cancel any pending generation and resolve waiters with null
  const cancelPendingGeneration = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
      pendingMessageRef.current = "";
    }
    // Increment request ID to invalidate any in-flight request
    const oldRequestId = requestIdRef.current;
    requestIdRef.current++;
    // Resolve any waiters so they don't hang forever
    if (generationPromiseRef.current?.requestId === oldRequestId) {
      generationPromiseRef.current.resolve(null);
      generationPromiseRef.current = null;
      setIsGenerating(false);
    }
  }, []);

  const generateIdentity = useCallback(
    async (forMessage: string): Promise<WorkspaceIdentity | null> => {
      if (!api || !forMessage.trim()) {
        return null;
      }

      const requestId = ++requestIdRef.current;
      setIsGenerating(true);
      setError(null);

      // Create a promise that external callers can wait on
      let resolvePromise: ((identity: WorkspaceIdentity | null) => void) | undefined;
      const promise = new Promise<WorkspaceIdentity | null>((resolve) => {
        resolvePromise = resolve;
      });
      // TypeScript doesn't understand the Promise executor runs synchronously
      const safeResolve = resolvePromise!;
      generationPromiseRef.current = { promise, resolve: safeResolve, requestId };

      try {
        // Backend handles model selection with intelligent fallback:
        // 1. Tries preferred small/fast models (Haiku, GPT-Mini)
        // 2. Tries gateway/OpenRouter variants
        // 3. Tries user's selected model (for Ollama/Bedrock/custom)
        // 4. Falls back to any available configured model
        const result = await api.nameGeneration.generate({
          message: forMessage,
          userModel,
        });

        // Check if this request is still current (wasn't cancelled)
        if (requestId !== requestIdRef.current) {
          // Don't resolve here - cancellation already resolved the promise
          return null;
        }

        if (result.success) {
          const identity: WorkspaceIdentity = {
            name: result.data.name,
            title: result.data.title,
          };
          setGeneratedIdentity(identity);
          lastGeneratedForRef.current = forMessage;
          safeResolve(identity);
          return identity;
        } else {
          const errorMsg =
            result.error.type === "unknown" && "raw" in result.error
              ? result.error.raw
              : `Generation failed: ${result.error.type}`;
          setError(errorMsg);
          safeResolve(null);
          return null;
        }
      } catch (err) {
        if (requestId !== requestIdRef.current) {
          return null;
        }
        const errorMsg = err instanceof Error ? err.message : String(err);
        setError(errorMsg);
        safeResolve(null);
        return null;
      } finally {
        if (requestId === requestIdRef.current) {
          setIsGenerating(false);
          generationPromiseRef.current = null;
        }
      }
    },
    [api, userModel]
  );

  // Debounced generation effect
  useEffect(() => {
    // Don't generate if:
    // - Auto-generation is disabled
    // - Message is empty
    // - Already generated for this message
    if (!autoGenerate || !message.trim() || lastGeneratedForRef.current === message) {
      // Clear any pending timer since conditions changed
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
        pendingMessageRef.current = "";
      }
      return;
    }

    // Cancel any in-flight request since message changed
    cancelPendingGeneration();

    // Capture message for the debounced callback (avoid stale closure)
    pendingMessageRef.current = message;

    // Debounce the generation
    debounceTimerRef.current = setTimeout(() => {
      const msg = pendingMessageRef.current;
      debounceTimerRef.current = null;
      pendingMessageRef.current = "";
      void generateIdentity(msg);
    }, debounceMs);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
        pendingMessageRef.current = "";
      }
    };
  }, [message, autoGenerate, debounceMs, generateIdentity, cancelPendingGeneration]);

  // When auto-generate is toggled, handle name preservation
  const handleSetAutoGenerate = useCallback(
    (enabled: boolean) => {
      if (enabled) {
        // Switching to auto: reset so debounced generation will trigger
        lastGeneratedForRef.current = "";
        setError(null);
      } else {
        // Switching to manual: copy generated name as starting point for editing
        if (generatedIdentity?.name) {
          setManualName(generatedIdentity.name);
        }
      }
      setAutoGenerate(enabled);
    },
    [generatedIdentity]
  );

  const setNameManual = useCallback((newName: string) => {
    setManualName(newName);
    // Clear error when user starts typing
    setError(null);
  }, []);

  const waitForGeneration = useCallback(async (): Promise<WorkspaceIdentity | null> => {
    // If auto-generate is off, user has provided a manual name
    // Use that name directly with a generated title from the message
    if (!autoGenerate) {
      if (!manualName.trim()) {
        setError("Please enter a workspace name");
        return null;
      }
      // Generate identity for the message to get the title, then override name with manual
      const identity = await generateIdentity(message);
      if (identity) {
        // Use manual name with AI-generated title
        return { name: manualName.trim(), title: identity.title };
      }
      // Fallback: if generation fails, use manual name as title too
      return { name: manualName.trim(), title: manualName.trim() };
    }

    // Always wait for generation to complete on the full message.
    // With voice input, the message can go from empty to complete very quickly,
    // so we must ensure the generated identity reflects the total content.

    // If there's a debounced generation pending, trigger it immediately
    // Use the captured message from pendingMessageRef to avoid stale closures
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
      const msg = pendingMessageRef.current;
      pendingMessageRef.current = "";
      if (msg.trim()) {
        return generateIdentity(msg);
      }
    }

    // If generation is in progress, wait for it to complete
    if (generationPromiseRef.current) {
      return generationPromiseRef.current.promise;
    }

    // If we have an identity that was generated for the current message, use it
    if (generatedIdentity && lastGeneratedForRef.current === message) {
      return generatedIdentity;
    }

    // Otherwise generate a fresh identity for the current message
    if (message.trim()) {
      return generateIdentity(message);
    }

    return null;
  }, [autoGenerate, manualName, generatedIdentity, message, generateIdentity]);

  return useMemo(
    () => ({
      name,
      title,
      isGenerating,
      autoGenerate,
      error,
      setAutoGenerate: handleSetAutoGenerate,
      setName: setNameManual,
      waitForGeneration,
    }),
    [
      name,
      title,
      isGenerating,
      autoGenerate,
      error,
      handleSetAutoGenerate,
      setNameManual,
      waitForGeneration,
    ]
  );
}
