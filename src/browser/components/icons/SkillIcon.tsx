import React from "react";
import { GraduationCap } from "lucide-react";
import { cn } from "@/common/lib/utils";

interface SkillIconProps {
  className?: string;
}

/**
 * Icon representing agent skills.
 * Used in skill tool call displays and the skill indicator in WorkspaceHeader.
 */
export const SkillIcon: React.FC<SkillIconProps> = (props) => {
  return <GraduationCap aria-hidden="true" className={cn("h-4 w-4", props.className)} />;
};
