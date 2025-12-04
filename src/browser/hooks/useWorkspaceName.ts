import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useAPI } from "@/browser/contexts/API";

export interface UseWorkspaceNameOptions {
  /** The user's message to generate a name for */
  message: string;
  /** Debounce delay in milliseconds (default: 500) */
  debounceMs?: number;
}

export interface UseWorkspaceNameReturn {
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
  const { message, debounceMs = 500 } = options;
  const { api } = useAPI();

  const [generatedName, setGeneratedName] = useState("");
  const [manualName, setManualName] = useState("");
  const [autoGenerate, setAutoGenerate] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track the message that was used for the last successful generation
  const lastGeneratedForRef = useRef<string>("");
  // Promise that resolves when current generation completes
  const generationPromiseRef = useRef<{
    promise: Promise<string>;
    resolve: (name: string) => void;
  } | null>(null);
  // Debounce timer
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Generation request counter for cancellation
  const requestIdRef = useRef(0);

  const name = autoGenerate ? generatedName : manualName;

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
      generationPromiseRef.current = { promise, resolve: safeResolve };

      try {
        const result = await api.nameGeneration.generate({
          message: forMessage,
        });

        // Check if this request is still current
        if (requestId !== requestIdRef.current) {
          return "";
        }

        if (result.success) {
          const generatedName = result.data.name;
          setGeneratedName(generatedName);
          lastGeneratedForRef.current = forMessage;
          safeResolve(generatedName);
          return generatedName;
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
    [api]
  );

  // Debounced generation effect
  useEffect(() => {
    // Clear any pending debounce timer
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }

    // Don't generate if:
    // - Auto-generation is disabled
    // - Message is empty
    // - Already generated for this message
    if (!autoGenerate || !message.trim() || lastGeneratedForRef.current === message) {
      return;
    }

    // Cancel any in-flight request
    requestIdRef.current++;

    // Debounce the generation
    debounceTimerRef.current = setTimeout(() => {
      void generateName(message);
    }, debounceMs);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [message, autoGenerate, debounceMs, generateName]);

  // When auto-generate is toggled on, trigger generation
  const handleSetAutoGenerate = useCallback(
    (enabled: boolean) => {
      setAutoGenerate(enabled);
      if (enabled) {
        // Reset so debounced generation will trigger
        lastGeneratedForRef.current = "";
        setError(null);
      }
    },
    []
  );

  const setName = useCallback((name: string) => {
    setManualName(name);
    setError(null);
  }, []);

  const waitForGeneration = useCallback(async (): Promise<string> => {
    // If auto-generate is off, return the manual name
    if (!autoGenerate) {
      return manualName;
    }

    // If we already have a generated name and nothing is pending, return it
    if (generatedName && !isGenerating && !debounceTimerRef.current) {
      return generatedName;
    }

    // Helper to wait for pending generation with optional timeout
    const waitForPending = async (timeoutMs?: number): Promise<string> => {
      // If there's a debounced generation pending, trigger it now
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
        return generateName(message);
      }

      // If generation is in progress, wait for it (with optional timeout)
      if (generationPromiseRef.current) {
        if (timeoutMs !== undefined) {
          const timeout = new Promise<string>((resolve) =>
            setTimeout(() => resolve(""), timeoutMs)
          );
          return Promise.race([generationPromiseRef.current.promise, timeout]);
        }
        return generationPromiseRef.current.promise;
      }

      // Generate if we don't have a name yet
      if (!generatedName && message.trim()) {
        return generateName(message);
      }

      return "";
    };

    // If we have no name, we must wait fully for generation
    if (!generatedName) {
      return waitForPending();
    }

    // We have a name but generation might be pending - wait up to 2s for potential update
    const pending = isGenerating || debounceTimerRef.current;
    if (pending) {
      const result = await waitForPending(2000);
      // Use result if we got one, otherwise fall back to existing name
      return result || generatedName;
    }

    return generatedName;
  }, [autoGenerate, manualName, generatedName, isGenerating, message, generateName]);

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
