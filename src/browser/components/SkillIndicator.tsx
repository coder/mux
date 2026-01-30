import React from "react";
import { Check } from "lucide-react";
import { cn } from "@/common/lib/utils";
import { SkillIcon } from "@/browser/components/icons/SkillIcon";
import { HoverClickPopover } from "@/browser/components/ui/hover-click-popover";
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

interface SkillsPopoverContentProps {
  loadedSkills: LoadedSkill[];
  availableSkills: AgentSkillDescriptor[];
}

const SkillsPopoverContent: React.FC<SkillsPopoverContentProps> = (props) => {
  const loadedSkillNames = new Set(props.loadedSkills.map((skill) => skill.name));

  const skillsByScope = new Map<AgentSkillScope, AgentSkillDescriptor[]>();
  for (const skill of props.availableSkills) {
    const existing = skillsByScope.get(skill.scope) ?? [];
    existing.push(skill);
    skillsByScope.set(skill.scope, existing);
  }

  return (
    <div className="flex flex-col gap-3">
      {SCOPE_CONFIG.map(({ scope, label }) => {
        const skills = skillsByScope.get(scope);
        if (!skills || skills.length === 0) return null;

        return (
          <div key={scope} className="flex flex-col gap-1.5">
            <div className="text-muted-foreground text-[10px] font-medium tracking-wider uppercase">
              {label} skills
            </div>
            {skills.map((skill) => {
              const isLoaded = loadedSkillNames.has(skill.name);
              return (
                <div key={skill.name} className="flex items-start gap-2">
                  <div className="bg-muted-foreground/30 mt-1.5 h-1 w-1 shrink-0 rounded-full" />
                  <div className="flex flex-col">
                    <span
                      className={cn(
                        "text-xs font-medium",
                        isLoaded ? "text-foreground" : "text-muted-foreground"
                      )}
                    >
                      {skill.name}
                      {isLoaded && <Check className="text-success ml-1 inline h-3 w-3" />}
                    </span>
                    <span className="text-muted-foreground text-[11px] leading-snug">
                      {skill.description}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
};

/**
 * Indicator showing loaded and available skills in a workspace.
 * Displays in the WorkspaceHeader to the right of the notification bell.
 * Hover to preview skills organized by scope (Project, Global, Built-in); click to pin the list open.
 */
export const SkillIndicator: React.FC<SkillIndicatorProps> = (props) => {
  const loadedCount = props.loadedSkills.length;
  const totalCount = props.availableSkills.length;

  // Don't render if no skills are available
  if (totalCount === 0) {
    return null;
  }

  // Hover previews skills; click pins the list open to match the context indicator behavior.
  return (
    <HoverClickPopover
      content={
        <SkillsPopoverContent
          loadedSkills={props.loadedSkills}
          availableSkills={props.availableSkills}
        />
      }
      side="bottom"
      align="end"
      sideOffset={8}
      contentClassName={cn(
        "bg-modal-bg text-foreground z-[9999] rounded px-[10px] py-[6px]",
        "text-[11px] font-normal font-sans text-left",
        "border border-separator-light shadow-[0_2px_8px_rgba(0,0,0,0.4)]",
        "animate-in fade-in-0 zoom-in-95",
        "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
        "data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2",
        "data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
        "max-w-[280px] w-auto min-w-0"
      )}
    >
      <button
        type="button"
        className={cn(
          "relative flex h-6 w-6 shrink-0 items-center justify-center rounded",
          "text-muted hover:bg-sidebar-hover hover:text-foreground",
          props.className
        )}
        aria-label={`${loadedCount} of ${totalCount} skill${totalCount === 1 ? "" : "s"} loaded`}
      >
        <span className="relative flex h-6 w-6 items-center justify-center">
          <SkillIcon className="h-4.5 w-4.5" />
          <span
            className={cn(
              "absolute -bottom-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center",
              "rounded-full border border-border bg-sidebar px-0.5 text-[9px] font-medium",
              loadedCount > 0 ? "text-foreground" : "text-muted"
            )}
          >
            {loadedCount}
          </span>
        </span>
      </button>
    </HoverClickPopover>
  );
};
