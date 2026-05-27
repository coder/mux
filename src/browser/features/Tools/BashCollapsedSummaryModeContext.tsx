import { createContext, useContext, type ReactNode } from "react";
import {
  BASH_COLLAPSED_SUMMARY_MODE_KEY,
  DEFAULT_BASH_COLLAPSED_SUMMARY_MODE,
  normalizeBashCollapsedSummaryMode,
  type BashCollapsedSummaryMode,
} from "@/common/constants/storage";
import { readPersistedState, usePersistedState } from "@/browser/hooks/usePersistedState";

const BashCollapsedSummaryModeContext = createContext<BashCollapsedSummaryMode | null>(null);

export function BashCollapsedSummaryModeProvider(props: { children: ReactNode }) {
  const [rawMode] = usePersistedState<unknown>(
    BASH_COLLAPSED_SUMMARY_MODE_KEY,
    DEFAULT_BASH_COLLAPSED_SUMMARY_MODE,
    { listener: true }
  );
  const mode = normalizeBashCollapsedSummaryMode(rawMode);

  return (
    <BashCollapsedSummaryModeContext.Provider value={mode}>
      {props.children}
    </BashCollapsedSummaryModeContext.Provider>
  );
}

export function useBashCollapsedSummaryMode(): BashCollapsedSummaryMode {
  const contextMode = useContext(BashCollapsedSummaryModeContext);
  if (contextMode !== null) {
    return contextMode;
  }

  return normalizeBashCollapsedSummaryMode(
    readPersistedState(BASH_COLLAPSED_SUMMARY_MODE_KEY, DEFAULT_BASH_COLLAPSED_SUMMARY_MODE)
  );
}
