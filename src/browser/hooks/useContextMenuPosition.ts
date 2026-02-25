import type React from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export interface ContextMenuPosition {
  x: number;
  y: number;
}

interface UseContextMenuPositionOptions {
  /** Enable 500ms long-press for touch devices (default: false) */
  longPress?: boolean;
  /** Guard callback — return false to prevent opening (e.g. when disabled) */
  canOpen?: () => boolean;
}

export interface UseContextMenuPositionReturn {
  position: ContextMenuPosition | null;
  isOpen: boolean;
  /** Pass as onContextMenu to the trigger element */
  onContextMenu: (e: React.MouseEvent) => void;
  /** Pass as onOpenChange to the PositionedMenu */
  onOpenChange: (open: boolean) => void;
  /** Touch handlers — spread onto the trigger element when longPress is enabled */
  touchHandlers: {
    onTouchStart: (e: React.TouchEvent) => void;
    onTouchEnd: () => void;
    onTouchMove: (e: React.TouchEvent) => void;
  };
  /** Call in onClick to suppress the click that follows a long-press. Returns true if suppressed. */
  suppressClickIfLongPress: () => boolean;
  /** Programmatically close the menu */
  close: () => void;
}

/**
 * Manages position state, open/close, and optional long-press for positioned context menus.
 *
 * Extracts the duplicated Popover+PopoverAnchor positioning pattern used by
 * WorkspaceListItem (draft + regular) and ChatPane's transcript right-click menu.
 */
export function useContextMenuPosition(
  options?: UseContextMenuPositionOptions
): UseContextMenuPositionReturn {
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState<ContextMenuPosition | null>(null);

  // Long-press refs (only used when longPress option is enabled)
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchStartPosRef = useRef<ContextMenuPosition | null>(null);
  const longPressTriggeredRef = useRef(false);

  // When opening at cursor coordinates, render once with the anchor mounted first,
  // then flip open in a layout effect. This avoids a one-frame "flash" at an
  // incorrect fallback anchor before Popover finishes resolving the new anchor.
  const pendingPositionOpenRef = useRef(false);
  // Keep canOpen guard fresh so delayed callbacks (like long-press timers)
  // use the latest availability instead of stale render-time closures.
  const canOpenRef = useRef(options?.canOpen);
  canOpenRef.current = options?.canOpen;
  const canOpenMenu = useCallback(() => {
    const guard = canOpenRef.current;
    return guard ? guard() : true;
  }, []);

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
      }
    };
  }, []);

  const openAtPosition = useCallback((nextPosition: ContextMenuPosition) => {
    pendingPositionOpenRef.current = true;
    setIsOpen(false);
    setPosition(nextPosition);
  }, []);

  const close = useCallback(() => {
    pendingPositionOpenRef.current = false;
    setIsOpen(false);
    setPosition(null);
  }, []);

  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (!canOpenMenu()) return;
      e.preventDefault();
      e.stopPropagation();
      openAtPosition({ x: e.clientX, y: e.clientY });
    },
    [canOpenMenu, openAtPosition]
  );

  const onOpenChange = useCallback((open: boolean) => {
    if (!open) {
      pendingPositionOpenRef.current = false;
      setIsOpen(false);
      setPosition(null);
      return;
    }

    // Trigger-based openings (e.g. overflow button) should open immediately.
    setIsOpen(true);
  }, []);

  useLayoutEffect(() => {
    if (!pendingPositionOpenRef.current || position === null) {
      return;
    }

    pendingPositionOpenRef.current = false;
    setIsOpen(true);
  }, [position]);

  // Long-press touch handlers
  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (!options?.longPress) return;
      if (!canOpenMenu()) return;
      const touch = e.touches[0];
      const touchPosition = { x: touch.clientX, y: touch.clientY };
      touchStartPosRef.current = touchPosition;
      longPressTriggeredRef.current = false;
      longPressTimerRef.current = setTimeout(() => {
        // Guard again at fire time: long-press can outlive the render where it started.
        if (!canOpenMenu()) {
          longPressTimerRef.current = null;
          return;
        }

        longPressTriggeredRef.current = true;
        openAtPosition(touchPosition);
        longPressTimerRef.current = null;
      }, 500);
    },
    [canOpenMenu, openAtPosition, options?.longPress]
  );

  const onTouchEnd = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    // Cancel long press if finger moves more than 10px (likely scrolling)
    if (longPressTimerRef.current && touchStartPosRef.current) {
      const touch = e.touches[0];
      const dx = touch.clientX - touchStartPosRef.current.x;
      const dy = touch.clientY - touchStartPosRef.current.y;
      if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
    }
  }, []);

  const suppressClickIfLongPress = useCallback((): boolean => {
    if (longPressTriggeredRef.current) {
      longPressTriggeredRef.current = false;
      return true;
    }
    return false;
  }, []);

  return {
    position,
    isOpen,
    onContextMenu,
    onOpenChange,
    touchHandlers: {
      onTouchStart,
      onTouchEnd,
      onTouchMove,
    },
    suppressClickIfLongPress,
    close,
  };
}
