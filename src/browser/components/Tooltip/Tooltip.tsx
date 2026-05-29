import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";

import { cn } from "@/common/lib/utils";

const DEFAULT_TOOLTIP_DELAY_MS = 200;
const TooltipProviderPresenceContext = React.createContext(false);

const TooltipProvider: React.FC<
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Provider>
> = ({ children, ...props }) => (
  <TooltipProviderPresenceContext.Provider value={true}>
    <TooltipPrimitive.Provider {...props}>{children}</TooltipPrimitive.Provider>
  </TooltipProviderPresenceContext.Provider>
);

const Tooltip = TooltipPrimitive.Root;

const TooltipTrigger = TooltipPrimitive.Trigger;

const TOOLTIP_SURFACE_CLASSNAME = [
  "bg-modal-bg text-foreground z-[9999] max-w-80 rounded px-[10px] py-[6px]",
  "text-[11px] font-normal font-sans text-left whitespace-normal break-words",
  "border border-separator-light shadow-[0_2px_8px_rgba(0,0,0,0.4)]",
].join(" ");

function getTextContent(node: React.ReactNode): string {
  let text = "";

  React.Children.forEach(node, (child) => {
    if (typeof child === "string" || typeof child === "number") {
      text += String(child);
      return;
    }

    if (
      React.isValidElement<{
        children?: React.ReactNode;
        "aria-hidden"?: boolean | "true" | "false";
      }>(child)
    ) {
      if (child.props["aria-hidden"] === true || child.props["aria-hidden"] === "true") {
        return;
      }

      text += getTextContent(child.props.children);
    }
  });

  return text;
}

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
        TOOLTIP_SURFACE_CLASSNAME,
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

interface TooltipIfPresentProps extends Omit<
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>,
  "children" | "content"
> {
  children: React.ReactElement;
  tooltip?: React.ReactNode;
  showArrow?: boolean;
}

const TooltipIfPresent: React.FC<TooltipIfPresentProps> = ({
  children,
  tooltip,
  showArrow = true,
  ...props
}) => {
  const hasTooltipProvider = React.useContext(TooltipProviderPresenceContext);

  if (tooltip == null || tooltip === "") {
    return children;
  }

  const tooltipElement = (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent showArrow={showArrow} {...props}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );

  if (hasTooltipProvider) {
    return tooltipElement;
  }

  return (
    <TooltipProvider delayDuration={DEFAULT_TOOLTIP_DELAY_MS}>{tooltipElement}</TooltipProvider>
  );
};

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

export {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
  TOOLTIP_SURFACE_CLASSNAME,
  TooltipArrow,
  TooltipIfPresent,
  HelpIndicator,
  getTextContent,
};
