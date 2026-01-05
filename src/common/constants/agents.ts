export const BUILT_IN_SUBAGENT_TYPES = ["explore", "exec"] as const;
export type BuiltInSubagentType = (typeof BUILT_IN_SUBAGENT_TYPES)[number];

export const BUILT_IN_SUBAGENTS = [{ agentType: "explore", label: "Explore" }] as const;
