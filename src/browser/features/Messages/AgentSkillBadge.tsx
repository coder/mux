import React from "react";
import { cn } from "@/common/lib/utils";

/** Shared visual badge for slash and inline agent skill references. */
export const AgentSkillBadge = React.forwardRef<
  HTMLSpanElement,
  React.HTMLAttributes<HTMLSpanElement>
>(({ className, children, ...rest }, ref) => (
  <span
    ref={ref}
    className={cn(
      "font-mono text-[13px] font-medium text-[var(--color-plan-mode-light)]",
      className
    )}
    data-component="AgentSkillBadge"
    {...rest}
  >
    {children}
  </span>
));

AgentSkillBadge.displayName = "AgentSkillBadge";
