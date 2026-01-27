import React from "react";
import { cn } from "@/common/lib/utils";
import { SkillIcon } from "@/browser/components/icons/SkillIcon";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/browser/components/ui/tooltip";
import type { LoadedSkill } from "@/browser/utils/messages/StreamingMessageAggregator";
import type { AgentSkillDescriptor } from "@/common/types/agentSkill";

interface SkillIndicatorProps {
  /** Skills that have been loaded in the current session */
  loadedSkills: LoadedSkill[];
  /** All available skills discovered for this project */
  availableSkills: AgentSkillDescriptor[];
  className?: string;
}

/**
 * Indicator showing loaded and available skills in a workspace.
 * Displays in the WorkspaceHeader to the right of the notification bell.
 * Hover to see the list of loaded and unloaded skills.
 */
export const SkillIndicator: React.FC<SkillIndicatorProps> = (props) => {
  const loadedCount = props.loadedSkills.length;
  const totalCount = props.availableSkills.length;

  // Don't render if no skills are available
  if (totalCount === 0) {
    return null;
  }

  // Build set of loaded skill names for quick lookup
  const loadedSkillNames = new Set(props.loadedSkills.map((s) => s.name));

  // Separate available skills into loaded and unloaded
  const unloadedSkills = props.availableSkills.filter((s) => !loadedSkillNames.has(s.name));

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
          aria-label={`${loadedCount} of ${totalCount} skill${totalCount === 1 ? "" : "s"} loaded`}
        >
          <SkillIcon className="h-4 w-4" />
          <span
            className={cn(
              "absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center",
              "rounded-full border border-border bg-sidebar px-0.5 text-[9px] font-medium",
              loadedCount > 0 ? "text-foreground" : "text-muted"
            )}
          >
            {loadedCount}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="end" className="max-w-[300px]">
        <div className="flex flex-col gap-2">
          {/* Loaded skills section */}
          {props.loadedSkills.length > 0 && (
            <div className="flex flex-col gap-1">
              <div className="text-xs font-medium">Loaded ({props.loadedSkills.length})</div>
              <div className="flex flex-col gap-1">
                {props.loadedSkills.map((skill) => (
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
          )}

          {/* Unloaded skills section */}
          {unloadedSkills.length > 0 && (
            <div className="flex flex-col gap-1">
              <div className="text-muted-foreground text-xs font-medium">
                Available ({unloadedSkills.length})
              </div>
              <div className="flex flex-col gap-1">
                {unloadedSkills.map((skill) => (
                  <div key={skill.name} className="flex flex-col">
                    <div className="flex items-center gap-1.5">
                      <span className="text-muted-foreground text-xs">{skill.name}</span>
                      <span className="text-muted-foreground/70 text-[10px]">({skill.scope})</span>
                    </div>
                    <span className="text-muted-foreground/70 line-clamp-2 text-[11px]">
                      {skill.description}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
};
