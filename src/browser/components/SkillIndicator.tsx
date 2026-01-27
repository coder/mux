import React from "react";
import { cn } from "@/common/lib/utils";
import { SkillIcon } from "@/browser/components/icons/SkillIcon";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/browser/components/ui/tooltip";
import type { LoadedSkill } from "@/browser/utils/messages/StreamingMessageAggregator";

interface SkillIndicatorProps {
  skills: LoadedSkill[];
  className?: string;
}

/**
 * Indicator showing the number of loaded skills in a workspace.
 * Displays in the WorkspaceHeader to the right of the notification bell.
 * Hover to see the list of loaded skills.
 */
export const SkillIndicator: React.FC<SkillIndicatorProps> = (props) => {
  if (props.skills.length === 0) {
    return null;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            "relative flex h-6 w-6 shrink-0 items-center justify-center rounded",
            "text-muted hover:bg-sidebar-hover hover:text-foreground",
            props.className
          )}
          aria-label={`${props.skills.length} skill${props.skills.length === 1 ? "" : "s"} loaded`}
        >
          <SkillIcon className="h-4 w-4" />
          <span
            className={cn(
              "absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center",
              "rounded-full border border-border bg-sidebar px-0.5 text-[9px] font-medium text-muted"
            )}
          >
            {props.skills.length}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="end" className="max-w-[300px]">
        <div className="flex flex-col gap-1.5">
          <div className="text-xs font-medium">
            Loaded Skill{props.skills.length === 1 ? "" : "s"}
          </div>
          <div className="flex flex-col gap-1">
            {props.skills.map((skill) => (
              <div key={skill.name} className="flex flex-col">
                <div className="flex items-center gap-1.5">
                  <span className="text-foreground text-xs font-medium">{skill.name}</span>
                  <span className="text-muted-foreground text-[10px]">({skill.scope})</span>
                </div>
                <span className="text-muted-foreground line-clamp-2 text-[11px]">
                  {skill.description}
                </span>
              </div>
            ))}
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
};
