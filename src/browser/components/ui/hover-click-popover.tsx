import * as React from "react";

import { cn } from "@/common/lib/utils";

import { Popover, PopoverAnchor, PopoverContent } from "./popover";

type PopoverContentProps = React.ComponentPropsWithoutRef<typeof PopoverContent>;

interface HoverClickPopoverProps {
  /** Trigger element for the popover. */
  children: React.ReactElement;
  /** Content to render inside the popover. */
  content: React.ReactNode;
  side?: PopoverContentProps["side"];
  align?: PopoverContentProps["align"];
  sideOffset?: PopoverContentProps["sideOffset"];
  contentClassName?: string;
  contentProps?: Omit<PopoverContentProps, "children">;
  /** Track pointer down/up to avoid closing during drag interactions. */
  interactiveContent?: boolean;
  onOpenChange?: (open: boolean) => void;
}

// Invisible hit-area bridge for bottom-aligned hover popovers; covers the sideOffset gap.
const HOVER_BRIDGE_CLASSNAME =
  "overflow-visible before:pointer-events-auto before:absolute before:-top-2 before:right-0 before:left-0 before:h-2 before:content-['']";

function composeEventHandlers<E extends { defaultPrevented?: boolean }>(
  userHandler: ((event: E) => void) | undefined,
  ourHandler: ((event: E) => void) | undefined
) {
  return (event: E) => {
    userHandler?.(event);
    if (event.defaultPrevented) return;
    ourHandler?.(event);
  };
}

/**
 * Hover previews the content; click pins it open.
 * This keeps indicator popovers quick to inspect but persistent on demand.
 */
export const HoverClickPopover: React.FC<HoverClickPopoverProps> = (props) => {
  const [isPinned, setIsPinned] = React.useState(false);
  const [isHovering, setIsHovering] = React.useState(false);
  const [isInteracting, setIsInteracting] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const closeTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup timeout on unmount
  React.useEffect(() => {
    return () => {
      if (closeTimeoutRef.current) clearTimeout(closeTimeoutRef.current);
    };
  }, []);

  const isOpen = isPinned || isHovering;

  const cancelPendingClose = () => {
    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
  };

  const scheduleClose = () => {
    if (isPinned || (props.interactiveContent && isInteracting)) return;
    cancelPendingClose();
    closeTimeoutRef.current = setTimeout(() => {
      setIsHovering(false);
    }, 100); // Grace period for pointer to travel between elements
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      cancelPendingClose();
      setIsPinned(false);
      setIsHovering(false);
      setIsInteracting(false);
    }
    props.onOpenChange?.(open);
  };

  const handleTriggerClick = () => {
    setIsPinned((prev) => !prev);
  };

  const handleTriggerPointerEnter = (event: React.PointerEvent<HTMLButtonElement>) => {
    // Avoid disabling hover for mouse on hybrid devices: only ignore *touch* pointers.
    if (event.pointerType === "touch") return;
    cancelPendingClose();
    setIsHovering(true);
  };

  const handleTriggerPointerLeave = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "touch") return;
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && contentRef.current?.contains(relatedTarget)) {
      return;
    }
    scheduleClose();
  };

  const handleContentPointerEnter = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") return;
    cancelPendingClose();
    setIsHovering(true);
  };

  const handleContentPointerLeave = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") return;
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && triggerRef.current?.contains(relatedTarget)) {
      return;
    }
    scheduleClose();
  };

  const handleContentMouseDown = () => {
    if (props.interactiveContent) setIsInteracting(true);
  };

  const handleContentMouseUp = () => {
    if (props.interactiveContent) setIsInteracting(false);
  };

  const triggerProps = props.children.props as React.ButtonHTMLAttributes<HTMLButtonElement>;
  const trigger = React.cloneElement(props.children, {
    ref: triggerRef,
    "aria-expanded": isOpen,
    "aria-haspopup": triggerProps["aria-haspopup"] ?? "dialog",
    onClick: composeEventHandlers(triggerProps.onClick, handleTriggerClick),
    onPointerEnter: composeEventHandlers(triggerProps.onPointerEnter, handleTriggerPointerEnter),
    onPointerLeave: composeEventHandlers(triggerProps.onPointerLeave, handleTriggerPointerLeave),
  });

  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      <PopoverAnchor asChild>{trigger}</PopoverAnchor>
      <PopoverContent
        {...props.contentProps}
        ref={contentRef}
        side={props.side}
        align={props.align}
        sideOffset={props.sideOffset}
        className={cn(
          HOVER_BRIDGE_CLASSNAME,
          props.contentClassName,
          props.contentProps?.className
        )}
        onPointerEnter={composeEventHandlers(
          props.contentProps?.onPointerEnter,
          handleContentPointerEnter
        )}
        onPointerLeave={composeEventHandlers(
          props.contentProps?.onPointerLeave,
          handleContentPointerLeave
        )}
        onMouseDown={composeEventHandlers(props.contentProps?.onMouseDown, handleContentMouseDown)}
        onMouseUp={composeEventHandlers(props.contentProps?.onMouseUp, handleContentMouseUp)}
      >
        {props.content}
      </PopoverContent>
    </Popover>
  );
};
