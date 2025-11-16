import React from "react";
import { use1MContext } from "@/browser/hooks/use1MContext";
import { supports1MContext } from "@/utils/ai/models";
import { TooltipWrapper, Tooltip } from "./Tooltip";

interface Context1MCheckboxProps {
  modelString: string;
}

export const Context1MCheckbox: React.FC<Context1MCheckboxProps> = ({ modelString }) => {
  const [use1M, setUse1M] = use1MContext();
  const isSupported = supports1MContext(modelString);

  if (!isSupported) {
    return null;
  }

  return (
    <div className="flex items-center gap-1.5">
      <label className="text-foreground flex cursor-pointer items-center gap-1 truncate text-[10px] select-none hover:text-white">
        <input type="checkbox" checked={use1M} onChange={(e) => setUse1M(e.target.checked)} />
        1M
      </label>
      <TooltipWrapper inline>
        <span className="text-muted flex cursor-help items-center text-[10px] leading-none">?</span>
        <Tooltip className="tooltip" align="center" width="auto">
          Enable 1M token context window (beta feature for Claude Sonnet 4/4.5)
        </Tooltip>
      </TooltipWrapper>
    </div>
  );
};
