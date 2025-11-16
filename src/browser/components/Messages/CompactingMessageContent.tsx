import React from "react";

/**
 * Wrapper for compaction streaming content
 * Provides max-height constraint with fade effect to imply content above
 * No scrolling - content stays anchored to bottom, older content fades at top
 */

interface CompactingMessageContentProps {
  children: React.ReactNode;
}

export const CompactingMessageContent: React.FC<CompactingMessageContentProps> = ({ children }) => {
  return (
    <div
      className="relative flex max-h-[300px] flex-col justify-end overflow-hidden"
      style={{
        maskImage:
          "linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.3) 5%, rgba(0,0,0,0.6) 10%, rgba(0,0,0,0.85) 15%, black 20%)",
        WebkitMaskImage:
          "linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.3) 5%, rgba(0,0,0,0.6) 10%, rgba(0,0,0,0.85) 15%, black 20%)",
      }}
    >
      {children}
    </div>
  );
};
