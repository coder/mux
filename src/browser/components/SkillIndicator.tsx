import React from "react";
import { Check } from "lucide-react";
import { cn } from "@/common/lib/utils";
import { SkillIcon } from "@/browser/components/icons/SkillIcon";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/browser/components/ui/tooltip";
import type { LoadedSkill } from "@/browser/utils/messages/StreamingMessageAggregator";
import type { AgentSkillDescriptor, AgentSkillScope } from "@/common/types/agentSkill";

interface SkillIndicatorProps {
  /** Skills that have been loaded in the current session */
  loadedSkills: LoadedSkill[];
  /** All available skills discovered for this project */
  availableSkills: AgentSkillDescriptor[];
  className?: string;
}

/** Scope display order and labels */
const SCOPE_CONFIG: Array<{ scope: AgentSkillScope; label: string }> = [
  { scope: "project", label: "Project" },
  { scope: "global", label: "Global" },
  { scope: "built-in", label: "Built-in" },
];

/**
 * Indicator showing loaded and available skills in a workspace.
 * Displays in the WorkspaceHeader to the right of the notification bell.
 * Hover to see skills organized by scope (Project, Global, Built-in).
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

  // Group skills by scope
  const skillsByScope = new Map<AgentSkillScope, AgentSkillDescriptor[]>();
  for (const skill of props.availableSkills) {
    const existing = skillsByScope.get(skill.scope) ?? [];
    existing.push(skill);
    skillsByScope.set(skill.scope, existing);
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
          aria-label={`${loadedCount} of ${totalCount} skill${totalCount === 1 ? "" : "s"} loaded`}
        >
          <SkillIcon className="h-4 w-4" />
          <span
            className={cn(
              "absolute -bottom-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center",
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
          {SCOPE_CONFIG.map(({ scope, label }) => {
            const skills = skillsByScope.get(scope);
            if (!skills || skills.length === 0) return null;

            return (
              <div key={scope} className="flex flex-col gap-1">
                <div className="text-muted-foreground text-[10px] font-medium tracking-wide uppercase">
                  {label}
                </div>
                <div className="flex flex-col gap-0.5">
                  {skills.map((skill) => {
                    const isLoaded = loadedSkillNames.has(skill.name);
                    return (
                      <div key={skill.name} className="flex flex-col">
                        <span
                          className={cn(
                            "flex items-center gap-1 text-xs",
                            isLoaded ? "font-medium text-foreground" : "text-muted-foreground/60"
                          )}
                        >
                          {skill.name}
                          {isLoaded && <Check className="text-success h-3 w-3" />}
                        </span>
                        <span
                          className={cn(
                            "line-clamp-2 text-[11px]",
                            isLoaded ? "text-muted-foreground" : "text-muted-foreground/40"
                          )}
                        >
                          {skill.description}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </TooltipContent>
    </Tooltip>
  );
};
