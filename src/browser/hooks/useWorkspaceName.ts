import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useAPI } from "@/browser/contexts/API";
import { validateWorkspaceName } from "@/common/utils/validation/workspaceValidation";

export interface UseWorkspaceNameOptions {
  /** The user's message to generate a name for */
  message: string;
  /** Debounce delay in milliseconds (default: 500) */
  debounceMs?: number;
  /** Model to use if preferred small models aren't available */
  fallbackModel?: string;
}

/** State and actions for workspace name generation, suitable for passing to components */
export interface WorkspaceNameState {
  /** The generated or manually entered name */
  name: string;
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
  /** Wait for any pending generation to complete */
  waitForGeneration: () => Promise<string>;
}

/**
 * Hook for managing workspace name generation with debouncing.
 *
 * Automatically generates names as the user types their message,
 * but allows manual override. If the user clears the manual name,
 * auto-generation resumes.
 */
export function useWorkspaceName(options: UseWorkspaceNameOptions): UseWorkspaceNameReturn {
  const { message, debounceMs = 500, fallbackModel } = options;
  const { api } = useAPI();

  const [generatedName, setGeneratedName] = useState("");
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
    promise: Promise<string>;
    resolve: (name: string) => void;
    requestId: number;
  } | null>(null);

  const name = autoGenerate ? generatedName : manualName;

  // Cancel any pending generation and resolve waiters with empty string
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
      generationPromiseRef.current.resolve("");
      generationPromiseRef.current = null;
      setIsGenerating(false);
    }
  }, []);

  const generateName = useCallback(
    async (forMessage: string): Promise<string> => {
      if (!api || !forMessage.trim()) {
        return "";
      }

      const requestId = ++requestIdRef.current;
      setIsGenerating(true);
      setError(null);

      // Create a promise that external callers can wait on
      let resolvePromise: ((name: string) => void) | undefined;
      const promise = new Promise<string>((resolve) => {
        resolvePromise = resolve;
      });
      // TypeScript doesn't understand the Promise executor runs synchronously
      const safeResolve = resolvePromise!;
      generationPromiseRef.current = { promise, resolve: safeResolve, requestId };

      try {
        const result = await api.nameGeneration.generate({
          message: forMessage,
          fallbackModel,
        });

        // Check if this request is still current (wasn't cancelled)
        if (requestId !== requestIdRef.current) {
          // Don't resolve here - cancellation already resolved the promise
          return "";
        }

        if (result.success) {
          const name = result.data.name;
          setGeneratedName(name);
          lastGeneratedForRef.current = forMessage;
          safeResolve(name);
          return name;
        } else {
          const errorMsg =
            result.error.type === "unknown" && "raw" in result.error
              ? result.error.raw
              : `Generation failed: ${result.error.type}`;
          setError(errorMsg);
          safeResolve("");
          return "";
        }
      } catch (err) {
        if (requestId !== requestIdRef.current) {
          return "";
        }
        const errorMsg = err instanceof Error ? err.message : String(err);
        setError(errorMsg);
        safeResolve("");
        return "";
      } finally {
        if (requestId === requestIdRef.current) {
          setIsGenerating(false);
          generationPromiseRef.current = null;
        }
      }
    },
    [api, fallbackModel]
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
      void generateName(msg);
    }, debounceMs);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
        pendingMessageRef.current = "";
      }
    };
  }, [message, autoGenerate, debounceMs, generateName, cancelPendingGeneration]);

  // When auto-generate is toggled, handle name preservation
  const handleSetAutoGenerate = useCallback(
    (enabled: boolean) => {
      if (enabled) {
        // Switching to auto: reset so debounced generation will trigger
        lastGeneratedForRef.current = "";
        setError(null);
      } else {
        // Switching to manual: copy generated name as starting point for editing
        if (generatedName) {
          setManualName(generatedName);
        }
      }
      setAutoGenerate(enabled);
    },
    [generatedName]
  );

  const setName = useCallback((name: string) => {
    setManualName(name);
    // Validate manual input and show errors in real-time
    if (name.trim()) {
      const validation = validateWorkspaceName(name);
      setError(validation.error ?? null);
    } else {
      setError(null);
    }
  }, []);

  const waitForGeneration = useCallback(async (): Promise<string> => {
    // If auto-generate is off, return the manual name (or set error if empty)
    if (!autoGenerate) {
      if (!manualName.trim()) {
        setError("Please enter a workspace name");
        return "";
      }
      return manualName;
    }

    // Always wait for generation to complete on the full message.
    // With voice input, the message can go from empty to complete very quickly,
    // so we must ensure the generated name reflects the total content.

    // If there's a debounced generation pending, trigger it immediately
    // Use the captured message from pendingMessageRef to avoid stale closures
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
      const msg = pendingMessageRef.current;
      pendingMessageRef.current = "";
      if (msg.trim()) {
        return generateName(msg);
      }
    }

    // If generation is in progress, wait for it to complete
    if (generationPromiseRef.current) {
      return generationPromiseRef.current.promise;
    }

    // If we have a name that was generated for the current message, use it
    if (generatedName && lastGeneratedForRef.current === message) {
      return generatedName;
    }

    // Otherwise generate a fresh name for the current message
    if (message.trim()) {
      return generateName(message);
    }

    return "";
  }, [autoGenerate, manualName, generatedName, message, generateName]);

  return useMemo(
    () => ({
      name,
      isGenerating,
      autoGenerate,
      error,
      setAutoGenerate: handleSetAutoGenerate,
      setName,
      waitForGeneration,
    }),
    [name, isGenerating, autoGenerate, error, handleSetAutoGenerate, setName, waitForGeneration]
  );
}
