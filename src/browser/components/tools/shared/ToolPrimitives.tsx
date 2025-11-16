import React from "react";
import { cn } from "@/lib/utils";

/**
 * Shared styled components for tool UI
 * These primitives provide consistent styling across all tool components
 */

interface ToolContainerProps extends React.HTMLAttributes<HTMLDivElement> {
  expanded: boolean;
}

export const ToolContainer: React.FC<ToolContainerProps> = ({ expanded, className, ...props }) => (
  <div
    className={cn(
      "my-2 rounded font-mono text-[11px] transition-all duration-200",
      "[container-type:inline-size]",
      expanded ? "py-2 px-3" : "py-1 px-3",
      className
    )}
    {...props}
  />
);

export const ToolHeader: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className,
  ...props
}) => (
  <div
    className={cn(
      "flex items-center gap-2 cursor-pointer select-none text-secondary hover:text-foreground",
      className
    )}
    {...props}
  />
);

interface ExpandIconProps extends React.HTMLAttributes<HTMLSpanElement> {
  expanded: boolean;
}

export const ExpandIcon: React.FC<ExpandIconProps> = ({ expanded, className, ...props }) => (
  <span
    className={cn(
      "inline-block transition-transform duration-200 text-[10px]",
      expanded ? "rotate-90" : "rotate-0",
      className
    )}
    {...props}
  />
);

export const ToolName: React.FC<React.HTMLAttributes<HTMLSpanElement>> = ({
  className,
  ...props
}) => <span className={cn("font-medium", className)} {...props} />;

interface StatusIndicatorProps extends React.HTMLAttributes<HTMLSpanElement> {
  status: string;
}

const getStatusColor = (status: string) => {
  switch (status) {
    case "executing":
      return "text-pending";
    case "completed":
      return "text-success";
    case "failed":
      return "text-danger";
    case "interrupted":
      return "text-interrupted";
    default:
      return "text-foreground-secondary";
  }
};

export const StatusIndicator: React.FC<StatusIndicatorProps> = ({
  status,
  className,
  children,
  ...props
}) => (
  <span
    className={cn(
      "text-[10px] ml-auto opacity-80 whitespace-nowrap shrink-0",
      "[&_.status-text]:inline [@container(max-width:500px)]:&:has(.status-text):after:content-['']  [@container(max-width:500px)]:&_.status-text]:hidden",
      getStatusColor(status),
      className
    )}
    {...props}
  >
    {children}
  </span>
);

export const ToolDetails: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className,
  ...props
}) => (
  <div className={cn("mt-2 pt-2 border-t border-white/5 text-foreground", className)} {...props} />
);

export const DetailSection: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className,
  ...props
}) => <div className={cn("my-1.5", className)} {...props} />;

export const DetailLabel: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className,
  ...props
}) => (
  <div
    className={cn("text-[10px] text-foreground-secondary mb-1 uppercase tracking-wide", className)}
    {...props}
  />
);

export const DetailContent: React.FC<React.HTMLAttributes<HTMLPreElement>> = ({
  className,
  ...props
}) => (
  <pre
    className={cn(
      "m-0 px-2 py-1.5 bg-code-bg rounded-sm text-[11px] leading-relaxed whitespace-pre-wrap break-words max-h-[200px] overflow-y-auto",
      className
    )}
    {...props}
  />
);

export const LoadingDots: React.FC<React.HTMLAttributes<HTMLSpanElement>> = ({
  className,
  ...props
}) => (
  <span
    className={cn(
      "after:content-['...'] after:animate-[dots_1.5s_infinite]",
      "[&]:after:[@keyframes_dots]{0%,20%{content:'.'};40%{content:'..'};60%,100%{content:'...'}}",
      className
    )}
    {...props}
  />
);

interface HeaderButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
}

export const HeaderButton: React.FC<HeaderButtonProps> = ({ active, className, ...props }) => (
  <button
    className={cn(
      "border border-white/20 text-foreground px-2 py-0.5 rounded-sm cursor-pointer text-[10px]",
      "transition-all duration-200 whitespace-nowrap hover:bg-white/10 hover:border-white/30",
      active && "bg-white/10",
      className
    )}
    {...props}
  />
);
