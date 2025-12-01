import React, { useState, useRef, useLayoutEffect, createContext, useContext } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/common/lib/utils";

// Context for passing hover state and trigger ref from wrapper to tooltip
interface TooltipContextValue {
  isHovered: boolean;
  setIsHovered: (value: boolean) => void;
  triggerRef: React.RefObject<HTMLElement> | null;
}

const TooltipContext = createContext<TooltipContextValue>({
  isHovered: false,
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  setIsHovered: () => {},
  triggerRef: null,
});

// TooltipWrapper - React component that tracks hover state
interface TooltipWrapperProps {
  inline?: boolean;
  children: React.ReactNode;
}

export const TooltipWrapper: React.FC<TooltipWrapperProps> = ({ inline = false, children }) => {
  const [isHovered, setIsHovered] = useState(false);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const leaveTimerRef = useRef<NodeJS.Timeout | null>(null);

  const handleMouseEnter = () => {
    if (leaveTimerRef.current) {
      clearTimeout(leaveTimerRef.current);
      leaveTimerRef.current = null;
    }
    setIsHovered(true);
  };

  const handleMouseLeave = () => {
    // Delay hiding to allow moving mouse to tooltip
    leaveTimerRef.current = setTimeout(() => {
      setIsHovered(false);
    }, 100);
  };

  return (
    <TooltipContext.Provider value={{ isHovered, setIsHovered, triggerRef }}>
      <span
        ref={triggerRef}
        className={cn("relative", inline ? "inline-flex items-center" : "block")}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {children}
      </span>
    </TooltipContext.Provider>
  );
};

// Tooltip - Portal-based component with collision detection
interface TooltipProps {
  align?: "left" | "center" | "right";
  width?: "auto" | "wide";
  position?: "top" | "bottom" | "left" | "right";
  children: React.ReactNode;
  className?: string;
  interactive?: boolean;
}

export const Tooltip: React.FC<TooltipProps> = ({
  align = "left",
  width = "auto",
  position = "top",
  children,
  className = "tooltip",
  interactive = false,
}) => {
  const { isHovered, setIsHovered, triggerRef } = useContext(TooltipContext);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const leaveTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [tooltipState, setTooltipState] = useState<{
    style: React.CSSProperties;
    arrowStyle: React.CSSProperties;
    isPositioned: boolean;
  }>({
    style: {},
    arrowStyle: {},
    isPositioned: false,
  });

  // Use useLayoutEffect to measure and position synchronously before paint
  useLayoutEffect(() => {
    if (!isHovered || !triggerRef?.current || !tooltipRef.current) {
      // Reset when hidden
      setTooltipState({ style: {}, arrowStyle: {}, isPositioned: false });
      return;
    }

    // Measure and position immediately in useLayoutEffect
    // This runs synchronously before browser paint, preventing flash
    const measure = () => {
      if (!triggerRef?.current || !tooltipRef.current) return;

      const trigger = triggerRef.current.getBoundingClientRect();
      const tooltip = tooltipRef.current.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      let top: number;
      let left: number;
      let finalPosition = position;
      const gap = 8; // Gap between trigger and tooltip
      const isHorizontalPosition = position === "left" || position === "right";

      if (isHorizontalPosition) {
        // Horizontal positioning (left/right of trigger)
        top = trigger.top + trigger.height / 2 - tooltip.height / 2;

        if (position === "left") {
          left = trigger.left - tooltip.width - gap;
          // Check if tooltip would overflow left of viewport
          if (left < 8) {
            finalPosition = "right";
            left = trigger.right + gap;
          }
        } else {
          // position === "right"
          left = trigger.right + gap;
          // Check if tooltip would overflow right of viewport
          if (left + tooltip.width > viewportWidth - 8) {
            finalPosition = "left";
            left = trigger.left - tooltip.width - gap;
          }
        }

        // Vertical collision detection for horizontal tooltips
        top = Math.max(8, Math.min(viewportHeight - tooltip.height - 8, top));
      } else {
        // Vertical positioning (top/bottom of trigger) with collision detection
        if (position === "bottom") {
          top = trigger.bottom + gap;
          // Check if tooltip would overflow bottom of viewport
          if (top + tooltip.height > viewportHeight) {
            // Flip to top
            finalPosition = "top";
            top = trigger.top - tooltip.height - gap;
          }
        } else {
          // position === "top"
          top = trigger.top - tooltip.height - gap;
          // Check if tooltip would overflow top of viewport
          if (top < 0) {
            // Flip to bottom
            finalPosition = "bottom";
            top = trigger.bottom + gap;
          }
        }

        // Horizontal positioning based on align
        if (align === "left") {
          left = trigger.left;
        } else if (align === "right") {
          left = trigger.right - tooltip.width;
        } else {
          // center
          left = trigger.left + trigger.width / 2 - tooltip.width / 2;
        }

        // Horizontal collision detection
        const minLeft = 8; // Min distance from viewport edge
        const maxLeft = viewportWidth - tooltip.width - 8;
        left = Math.max(minLeft, Math.min(maxLeft, left));
      }

      // Calculate arrow style based on final position
      const arrowStyle: React.CSSProperties = {};
      const finalIsHorizontal = finalPosition === "left" || finalPosition === "right";

      if (finalIsHorizontal) {
        // Arrow on left or right side of tooltip, vertically centered
        arrowStyle.top = "50%";
        arrowStyle.transform = "translateY(-50%)";
        if (finalPosition === "left") {
          arrowStyle.left = "100%";
          arrowStyle.borderColor = "transparent transparent transparent #2d2d30";
        } else {
          arrowStyle.right = "100%";
          arrowStyle.borderColor = "transparent #2d2d30 transparent transparent";
        }
      } else {
        // Arrow on top or bottom of tooltip
        let arrowLeft: number;
        if (align === "center") {
          arrowLeft = trigger.left + trigger.width / 2 - left;
        } else if (align === "right") {
          arrowLeft = tooltip.width - 15;
        } else {
          arrowLeft = Math.max(10, Math.min(trigger.left - left + 10, tooltip.width - 15));
        }
        arrowStyle.left = `${arrowLeft}px`;
        arrowStyle[finalPosition === "bottom" ? "bottom" : "top"] = "100%";
        arrowStyle.borderColor =
          finalPosition === "bottom"
            ? "transparent transparent #2d2d30 transparent"
            : "#2d2d30 transparent transparent transparent";
      }

      // Update all state atomically to prevent flashing
      setTooltipState({
        style: {
          position: "fixed",
          top: `${top}px`,
          left: `${left}px`,
          visibility: "visible",
          opacity: 1,
        },
        arrowStyle,
        isPositioned: true,
      });
    };

    // Try immediate measurement first
    measure();

    // If fonts aren't loaded yet, measure again after RAF
    // This handles the edge case of first render before fonts load
    const rafId = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(rafId);
  }, [isHovered, align, position, triggerRef]);

  const handleTooltipMouseEnter = () => {
    if (interactive) {
      if (leaveTimerRef.current) {
        clearTimeout(leaveTimerRef.current);
        leaveTimerRef.current = null;
      }
      setIsHovered(true);
    }
  };

  const handleTooltipMouseLeave = () => {
    if (interactive) {
      setIsHovered(false);
    }
  };

  if (!isHovered) {
    return null;
  }

  return createPortal(
    <div
      ref={tooltipRef}
      style={{
        // Always include position styles for measurement
        position: "fixed",
        ...tooltipState.style,
        // Keep hidden until positioned
        visibility: tooltipState.isPositioned ? "visible" : "hidden",
        opacity: tooltipState.isPositioned ? 1 : 0,
      }}
      className={cn(
        "bg-modal-bg text-foreground text-left rounded px-[10px] py-[6px] z-[9999]",
        "text-[11px] font-normal font-sans border border-separator-light shadow-[0_2px_8px_rgba(0,0,0,0.4)]",
        width === "wide" ? "whitespace-normal max-w-80 w-max" : "whitespace-nowrap",
        interactive ? "pointer-events-auto" : "pointer-events-none",
        className
      )}
      onMouseEnter={handleTooltipMouseEnter}
      onMouseLeave={handleTooltipMouseLeave}
    >
      {children}
      <div
        className="absolute -translate-x-1/2 border-[5px] border-solid"
        style={tooltipState.arrowStyle}
      />
    </div>,
    document.body
  );
};

export const HelpIndicator: React.FC<{ className?: string; children?: React.ReactNode }> = ({
  className,
  children,
}) => (
  <span
    className={cn("text-muted flex cursor-help items-center text-[10px] leading-none", className)}
  >
    {children}
  </span>
);
