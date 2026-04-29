import type { SendMessageOptions } from "../common/orpc/types";
import { EXPERIMENT_IDS } from "../common/constants/experiments";

/**
 * Convert CLI experiment ids into the request-scoped experiment overrides used by mux run.
 * This keeps local autonomous CLI runs aligned with the same tool gates as the desktop app.
 */
export function buildExperimentsObject(experimentIds: string[]): SendMessageOptions["experiments"] {
  if (experimentIds.length === 0) return undefined;

  return {
    programmaticToolCalling: experimentIds.includes(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING),
    programmaticToolCallingExclusive: experimentIds.includes(
      EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING_EXCLUSIVE
    ),
    system1: experimentIds.includes(EXPERIMENT_IDS.SYSTEM_1),
    lspQuery: experimentIds.includes(EXPERIMENT_IDS.LSP_QUERY),
    execSubagentHardRestart: experimentIds.includes(EXPERIMENT_IDS.EXEC_SUBAGENT_HARD_RESTART),
  };
}
