export const BUILT_IN_SUBAGENTS = [
  { agentType: "research", label: "Research" },
  { agentType: "explore", label: "Explore" },
] as const;

export type BuiltInSubagentType = (typeof BUILT_IN_SUBAGENTS)[number]["agentType"];
