import React from "react";
import { MarkdownCore } from "./MarkdownCore";
import { cn } from "@/lib/utils";

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ content, className }) => {
  return (
    <div className={cn("markdown-content", className)}>
      <MarkdownCore content={content} />
    </div>
  );
};

// For plan-specific styling
export const PlanMarkdownContainer: React.FC<{ children: React.ReactNode; className?: string }> = ({
  children,
  className,
}) => {
  return (
    <div
      className={cn("markdown-content", className)}
      style={{
        // Plan-specific overrides
        // @ts-expect-error CSS custom property
        "--blockquote-color": "var(--color-plan-mode)",
        "--code-color": "var(--color-plan-mode-hover)",
      }}
    >
      {children}
    </div>
  );
};
