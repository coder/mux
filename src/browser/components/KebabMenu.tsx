import React, { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import { cn } from "@/common/lib/utils";

export interface KebabMenuItem {
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  emoji?: string;
  tooltip?: string;
}

interface KebabMenuProps {
  items: KebabMenuItem[];
  className?: string;
}

/**
 * A kebab menu (three vertical dots) that displays a dropdown of menu items.
 *
 * Reduces header clutter by collapsing multiple actions into a single button,
 * saving significant horizontal space compared to individual buttons.
 *
 * Uses React Portal to render dropdown at document.body, preventing clipping
 * by parent containers with overflow constraints.
 */
export const KebabMenu: React.FC<KebabMenuProps> = ({ items, className }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const handleToggle = () => {
    if (!isOpen && buttonRef.current) {
      // Calculate position when opening (not via effect)
      const rect = buttonRef.current.getBoundingClientRect();
      setDropdownPosition({
        top: rect.bottom + 4, // 4px gap below button
        left: rect.right - 160, // Align right edge (160px = min-width)
      });
    }
    setIsOpen(!isOpen);
  };

  // Close menu when clicking outside
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      // Check both button and dropdown (which is now in portal)
      if (
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node) &&
        menuRef.current &&
        !menuRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  const handleItemClick = (item: KebabMenuItem) => {
    if (item.disabled) return;
    item.onClick();
    setIsOpen(false);
  };

  return (
    <>
      <div className="relative">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              ref={buttonRef}
              onClick={handleToggle}
              className={cn(
                "border border-white/20 text-foreground text-[10px] py-0.5 px-2 rounded-[3px] cursor-pointer transition-all duration-200 font-primary flex items-center justify-center whitespace-nowrap",
                isOpen ? "bg-white/10" : "bg-none",
                "hover:bg-white/10 hover:border-white/30",
                "disabled:opacity-50 disabled:cursor-not-allowed",
                className
              )}
            >
              ⋮
            </button>
          </TooltipTrigger>
          <TooltipContent align="center">More actions</TooltipContent>
        </Tooltip>
      </div>

      {isOpen &&
        createPortal(
          <div
            ref={menuRef}
            className="bg-dark border-border-light pointer-events-auto fixed z-[10000] min-w-40 overflow-hidden rounded-[3px] border shadow-[0_4px_16px_rgba(0,0,0,0.8)]"
            style={{
              top: `${dropdownPosition.top}px`,
              left: `${dropdownPosition.left}px`,
            }}
          >
            {items.map((item, index) => (
              <button
                key={index}
                onClick={() => handleItemClick(item)}
                title={item.tooltip}
                className={cn(
                  "w-full border-none border-b border-modal-bg text-xs py-2 px-3 text-left transition-all duration-150 font-primary flex items-center gap-2",
                  "last:border-b-0",
                  item.disabled
                    ? "bg-dark text-muted-light cursor-not-allowed opacity-50 hover:bg-dark hover:text-muted-light"
                    : item.active
                      ? "bg-white/15 text-foreground cursor-pointer hover:bg-white/15 hover:text-[var(--color-hover-foreground)]"
                      : "bg-dark text-foreground cursor-pointer hover:bg-white/15 hover:text-[var(--color-hover-foreground)]"
                )}
              >
                {item.emoji && (
                  <span className="w-4 shrink-0 text-center text-[13px]">{item.emoji}</span>
                )}
                <span className="flex-1">{item.label}</span>
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  );
};
