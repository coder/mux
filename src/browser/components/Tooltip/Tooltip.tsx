import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";

import { cn } from "@/common/lib/utils";

const TooltipProvider = TooltipPrimitive.Provider;

const Tooltip = TooltipPrimitive.Root;

const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipArrow = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Arrow>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Arrow>
>(({ className, ...props }, ref) => (
  <TooltipPrimitive.Arrow ref={ref} className={cn("fill-modal-bg", className)} {...props} />
));
TooltipArrow.displayName = TooltipPrimitive.Arrow.displayName;

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content> & {
    showArrow?: boolean;
  }
>(({ className, sideOffset = 8, showArrow = true, children, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "bg-modal-bg text-foreground z-[9999] rounded px-[10px] py-[6px]",
        "text-[11px] font-normal font-sans text-left",
        "border border-separator-light shadow-[0_2px_8px_rgba(0,0,0,0.4)]",
        "animate-in fade-in-0 zoom-in-95",
        "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
        "data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2",
        "data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
        className
      )}
      {...props}
    >
      {children}
      {showArrow && <TooltipArrow />}
    </TooltipPrimitive.Content>
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

const HelpIndicator = React.forwardRef<
  HTMLSpanElement,
  React.HTMLAttributes<HTMLSpanElement> & { className?: string; children?: React.ReactNode }
>(({ className, children, ...props }, ref) => (
  <span
    ref={ref}
    className={cn("text-muted flex cursor-help items-center text-[10px] leading-none", className)}
    {...props}
  >
    {children}
  </span>
));
HelpIndicator.displayName = "HelpIndicator";

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider, TooltipArrow, HelpIndicator };
