import React, { useState, useRef, useEffect } from "react";
import { Plus } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";

interface AddSectionButtonProps {
  onCreateSection: (name: string) => void;
}

export const AddSectionButton: React.FC<AddSectionButtonProps> = ({ onCreateSection }) => {
  const [isCreating, setIsCreating] = useState(false);
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isCreating && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isCreating]);

  const handleSubmit = () => {
    const trimmed = name.trim();
    if (trimmed) {
      onCreateSection(trimmed);
    }
    setName("");
    setIsCreating(false);
  };

  if (isCreating) {
    return (
      <div className="flex items-center gap-1 px-2 py-0.5">
        <div className="flex h-5 w-5 shrink-0 items-center justify-center">
          <Plus size={12} className="text-muted/60" />
        </div>
        <input
          ref={inputRef}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={handleSubmit}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSubmit();
            if (e.key === "Escape") {
              setName("");
              setIsCreating(false);
            }
          }}
          placeholder="Section name..."
          data-testid="add-section-input"
          className="bg-background/50 text-foreground min-w-0 flex-1 rounded border border-white/20 px-1.5 py-0.5 text-[11px] outline-none"
        />
      </div>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={() => setIsCreating(true)}
          data-testid="add-section-button"
          className="text-muted/60 hover:text-muted flex w-full cursor-pointer items-center justify-center gap-1 border-none bg-transparent px-2 py-0.5 text-[11px] transition-colors"
        >
          <Plus size={12} />
          <span>Add section</span>
        </button>
      </TooltipTrigger>
      <TooltipContent>Create a new section to organize workspaces</TooltipContent>
    </Tooltip>
  );
};
