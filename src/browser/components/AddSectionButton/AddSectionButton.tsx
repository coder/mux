import React, { useState, useRef, useEffect } from "react";
import { Plus } from "lucide-react";
// import { Tooltip, TooltipTrigger, TooltipContent } from "../Tooltip/Tooltip";

interface AddSectionButtonProps {
  onCreateSection: (name: string) => Promise<boolean>;
}

const alignWithSectionCaretStyle: React.CSSProperties = {
  borderLeftWidth: 3,
  borderLeftColor: "transparent",
};

export const AddSectionButton: React.FC<AddSectionButtonProps> = ({ onCreateSection }) => {
  const [isCreating, setIsCreating] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isCreating && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isCreating]);

  const handleSubmit = async () => {
    if (isSubmitting) {
      return;
    }

    const trimmed = name.trim();
    if (!trimmed) {
      setName("");
      setIsCreating(false);
      return;
    }

    setIsSubmitting(true);
    try {
      // Keep the input open until creation succeeds so backend/IPC failures do not
      // look like they created a section successfully.
      const didCreateSection = await onCreateSection(trimmed);
      if (!didCreateSection) {
        return;
      }
      setName("");
      setIsCreating(false);
    } catch {
      // The caller owns error presentation; keep the current draft visible so the
      // user can retry instead of losing their typed section name.
    } finally {
      setIsSubmitting(false);
    }
  };

  const submitWithoutThrowing = () => {
    handleSubmit().catch(() => undefined);
  };

  if (isCreating) {
    return (
      <div
        // Match the section header's reserved 3px color rail so the add affordance's
        // plus icon stays horizontally aligned with the section caret.
        className="flex items-center gap-1 px-2 py-0.5"
        style={alignWithSectionCaretStyle}
      >
        <div className="flex h-5 w-5 shrink-0 items-center justify-center">
          <Plus size={12} className="text-muted/60" />
        </div>
        <input
          ref={inputRef}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={isSubmitting}
          onBlur={submitWithoutThrowing}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              submitWithoutThrowing();
            }
            if (e.key === "Escape") {
              setName("");
              setIsCreating(false);
            }
          }}
          placeholder="Section name..."
          data-testid="add-section-input"
          className="bg-background/50 text-foreground min-w-0 flex-1 rounded border border-white/20 px-1.5 py-0.5 text-[11px] outline-none select-text"
        />
      </div>
    );
  }

  return (
    <button
      onClick={() => setIsCreating(true)}
      data-testid="add-section-button"
      // Keep the affordance in the same icon/text columns as section rows so the
      // add-sub-folder action reads as part of the project hierarchy.
      className="text-muted/60 hover:text-muted flex w-full cursor-pointer items-center gap-1 border-none bg-transparent px-2 py-0.5 text-left text-[11px] transition-colors"
      style={alignWithSectionCaretStyle}
    >
      <div className="flex h-5 w-5 shrink-0 items-center justify-center">
        <Plus size={12} />
      </div>
      <span>Add section</span>
    </button>
  );
};
