import React from "react";

import { useAgent } from "@/browser/contexts/AgentContext";
import {
  HelpIndicator,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/browser/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/ui/select";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { sortAgentsStable } from "@/browser/utils/agents";
import { cn } from "@/common/lib/utils";

interface AgentSelectorProps {
  className?: string;
}

const AgentHelpTooltip: React.FC = () => (
  <Tooltip>
    <TooltipTrigger asChild>
      <HelpIndicator>?</HelpIndicator>
    </TooltipTrigger>
    <TooltipContent align="center" className="max-w-80 whitespace-normal">
      Selects an agent definition (system prompt + tool policy).
      <br />
      <br />
      Open picker: {formatKeybind(KEYBINDS.TOGGLE_AGENT)}
      <br />
      Cycle agents: {formatKeybind(KEYBINDS.CYCLE_AGENT)}
    </TooltipContent>
  </Tooltip>
);

export const AgentSelector: React.FC<AgentSelectorProps> = (props) => {
  const { agentId, setAgentId, agents, loaded } = useAgent();

  const selectable = agents.filter((entry) => entry.uiSelectable);

  const options =
    selectable.length > 0
      ? sortAgentsStable(selectable)
      : [
          { id: "exec", name: "Exec" },
          { id: "plan", name: "Plan" },
        ];

  const selectedLabel =
    options.find((option) => option.id === agentId)?.name ?? (loaded ? agentId : "Agent");

  return (
    <div className={cn("flex items-center gap-1.5", props.className)}>
      <Select value={agentId} onValueChange={(next) => setAgentId(next)}>
        <SelectTrigger className="h-6 w-[120px] px-2 text-[11px]">
          <SelectValue>{selectedLabel}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <AgentHelpTooltip />
    </div>
  );
};
