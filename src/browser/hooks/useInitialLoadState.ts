import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { Result } from "@/common/types/result";
import { getErrorMessage } from "@/common/utils/errors";
import { withTimeout } from "@/common/utils/withTimeout";

export interface InitialLoadHelpers {
  isCurrent: () => boolean;
}

interface InitialLoadOptions {
  load: (helpers: InitialLoadHelpers) => Promise<Result<void, string | null>>;
  timeoutMs?: number;
  timeoutMessage?: string;
}

export interface InitialLoadState {
  loading: boolean;
  loadError: string | null;
  run: () => Promise<void>;
  retry: () => Promise<void>;
  setLoadError: Dispatch<SetStateAction<string | null>>;
}

export function useInitialLoadState(options: InitialLoadOptions): InitialLoadState {
  const { load, timeoutMs, timeoutMessage } = options;
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const attemptRef = useRef(0);

  const run = useCallback(async () => {
    const attempt = attemptRef.current + 1;
    attemptRef.current = attempt;
    setLoading(true);
    setLoadError(null);

    const isCurrent = () => attemptRef.current === attempt;

    let result: Result<void, string | null>;

    try {
      const loadPromise = load({ isCurrent });
      result =
        timeoutMs && timeoutMessage
          ? await withTimeout(loadPromise, timeoutMs, timeoutMessage)
          : await loadPromise;
    } catch (error) {
      if (!isCurrent()) {
        return;
      }
      setLoadError(getErrorMessage(error));
      setLoading(false);
      return;
    }

    if (!isCurrent()) {
      return;
    }

    if (!result.success) {
      if (result.error) {
        setLoadError(result.error);
        setLoading(false);
      }
      return;
    }

    setLoading(false);
  }, [load, timeoutMessage, timeoutMs]);

  return { loading, loadError, run, retry: run, setLoadError };
}
