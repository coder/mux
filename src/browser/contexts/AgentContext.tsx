import type { Dispatch, ReactNode, SetStateAction } from "react";
import React, { createContext, useContext } from "react";

import type { AgentDefinitionDescriptor } from "@/common/types/agentDefinition";

export interface AgentContextValue {
  agentId: string;
  setAgentId: Dispatch<SetStateAction<string>>;
  agents: AgentDefinitionDescriptor[];
  loaded: boolean;
  loadFailed: boolean;
  /** Reload agent definitions from the backend */
  refresh: () => Promise<void>;
  /** True while a refresh is in progress */
  refreshing: boolean;
}

const AgentContext = createContext<AgentContextValue | undefined>(undefined);

export function AgentProvider(props: { value: AgentContextValue; children: ReactNode }) {
  return <AgentContext.Provider value={props.value}>{props.children}</AgentContext.Provider>;
}

export function useAgent(): AgentContextValue {
  const ctx = useContext(AgentContext);
  if (!ctx) {
    throw new Error("useAgent must be used within an AgentProvider");
  }
  return ctx;
}
