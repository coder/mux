import React from "react";
import { ThinkingSliderComponent } from "./ThinkingSlider";
import { Context1MCheckbox } from "./Context1MCheckbox";

interface ChatTogglesProps {
  modelString: string;
  children: React.ReactNode;
}

export const ChatToggles: React.FC<ChatTogglesProps> = ({ modelString, children }) => {
  return (
    <div className="flex items-center gap-3">
      {children}
      <ThinkingSliderComponent modelString={modelString} />
      <Context1MCheckbox modelString={modelString} />
    </div>
  );
};

// Export for backwards compatibility
export const TogglesContainer: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="flex items-center gap-3">{children}</div>
);
