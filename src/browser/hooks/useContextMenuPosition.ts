import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";

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

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
      }
    };
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    setPosition(null);
  }, []);

  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (options?.canOpen && !options.canOpen()) return;
      e.preventDefault();
      e.stopPropagation();
      setPosition({ x: e.clientX, y: e.clientY });
      setIsOpen(true);
    },
    [options]
  );

  const onOpenChange = useCallback((open: boolean) => {
    setIsOpen(open);
    if (!open) setPosition(null);
  }, []);

  // Long-press touch handlers
  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (!options?.longPress) return;
      if (options.canOpen && !options.canOpen()) return;
      const touch = e.touches[0];
      touchStartPosRef.current = { x: touch.clientX, y: touch.clientY };
      longPressTriggeredRef.current = false;
      longPressTimerRef.current = setTimeout(() => {
        longPressTriggeredRef.current = true;
        setPosition({ x: touch.clientX, y: touch.clientY });
        setIsOpen(true);
        longPressTimerRef.current = null;
      }, 500);
    },
    [options]
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
