import { useThinking } from "@/browser/contexts/ThinkingContext";

/**
 * Custom hook for thinking level state.
 * Must be used within a ThinkingProvider (typically at workspace level).
 *
 * @returns [thinkingLevel, setThinkingLevel] tuple
 */
export function useThinkingLevel() {
  const { thinkingLevel, setThinkingLevel } = useThinking();
  return [thinkingLevel, setThinkingLevel] as const;
}
