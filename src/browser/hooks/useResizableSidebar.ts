/**
 * useResizableSidebar - Custom hook for drag-based sidebar resizing
 *
 * Provides encapsulated resize logic without wrapping DOM elements, preserving
 * existing scroll container hierarchy. Uses global mouse listeners during drag
 * to track cursor position regardless of where the mouse moves.
 *
 * Design principles:
 * - No interference with scroll containers or flex layout
 * - Persistent width via localStorage
 * - Smooth dragging with visual feedback (cursor changes)
 * - Boundary enforcement (min/max constraints)
 * - Clean mount/unmount of event listeners
 *
 * @example
 * const { width, startResize } = useResizableSidebar({
 *   enabled: isReviewTab,
 *   defaultWidth: 600,
 *   minWidth: 300,
 *   maxWidth: 1200,
 *   storageKey: 'review-sidebar-width',
 * });
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { getStorageChangeEvent } from "@/common/constants/events";
import { readPersistedString, updatePersistedState } from "@/browser/hooks/usePersistedState";

interface UseResizableSidebarOptions {
  /** Enable/disable resize functionality (typically tied to tab state) */
  enabled: boolean;
  /** Initial width when no stored value exists */
  defaultWidth: number;
  /** Minimum allowed width (enforced during drag) */
  minWidth: number;
  /** Maximum allowed width (enforced during drag) */
  maxWidth: number;
  /** localStorage key for persisting width across sessions */
  storageKey: string;
}

interface UseResizableSidebarResult {
  /** Current sidebar width in pixels */
  width: number;
  /** Whether user is actively dragging the resize handle */
  isResizing: boolean;
  /** Function to call on handle mouseDown to initiate resize */
  startResize: (e: React.MouseEvent) => void;
  /** Placeholder for type compatibility (not used in render) */
  ResizeHandle: React.FC;
}

export function useResizableSidebar({
  enabled,
  defaultWidth,
  minWidth,
  maxWidth,
  storageKey,
}: UseResizableSidebarOptions): UseResizableSidebarResult {
  // Load persisted width from localStorage on mount
  // Always load persisted value regardless of enabled flag to maintain size across workspace switches
  const [width, setWidth] = useState<number>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const parsed = parseInt(stored, 10);
        if (!isNaN(parsed) && parsed >= minWidth && parsed <= maxWidth) {
          return parsed;
        }
      }
    } catch {
      // Ignore storage errors (private browsing, quota exceeded, etc.)
    }
    return defaultWidth;
  });

  const [isResizing, setIsResizing] = useState(false);

  // Refs to track drag state without causing re-renders
  const startXRef = useRef<number>(0); // Mouse X position when drag started
  const startWidthRef = useRef<number>(0); // Sidebar width when drag started

  // Persist width changes to localStorage
  useEffect(() => {
    if (!enabled) return;
    updatePersistedState<number>(storageKey, width);
  }, [width, storageKey, enabled]);

  // Keep width in sync when updated externally (e.g., layout presets)
  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleExternalUpdate = () => {
      if (isResizing) {
        return;
      }

      const stored = readPersistedString(storageKey);
      if (!stored) {
        return;
      }

      const parsed = parseInt(stored, 10);
      if (!Number.isFinite(parsed)) {
        return;
      }

      const clamped = Math.max(minWidth, Math.min(maxWidth, parsed));
      setWidth((prev) => (prev === clamped ? prev : clamped));
    };

    const eventName = getStorageChangeEvent(storageKey);
    window.addEventListener(eventName, handleExternalUpdate as EventListener);

    const handleStorage = (e: StorageEvent) => {
      if (e.key === storageKey) {
        handleExternalUpdate();
      }
    };
    window.addEventListener("storage", handleStorage);

    return () => {
      window.removeEventListener(eventName, handleExternalUpdate as EventListener);
      window.removeEventListener("storage", handleStorage);
    };
  }, [storageKey, minWidth, maxWidth, isResizing]);

  /**
   * Handle mouse movement during drag
   * Calculates new width based on horizontal mouse delta from start position
   * Width grows as mouse moves LEFT (expanding sidebar from right edge)
   */
  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isResizing) return;

      // Calculate delta from drag start position
      // Positive deltaX = mouse moved left = sidebar wider
      const deltaX = startXRef.current - e.clientX;
      const newWidth = Math.max(minWidth, Math.min(maxWidth, startWidthRef.current + deltaX));

      setWidth(newWidth);
    },
    [isResizing, minWidth, maxWidth]
  );

  /**
   * Handle mouse up to end drag session
   * Width is already persisted via useEffect, just need to clear drag state
   */
  const handleMouseUp = useCallback(() => {
    setIsResizing(false);
  }, []);

  /**
   * Attach/detach global mouse listeners during drag
   * Using document-level listeners ensures we track mouse even if it leaves
   * the resize handle area during drag (critical for smooth UX)
   */
  useEffect(() => {
    if (!isResizing) return;

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    // Prevent text selection and show resize cursor globally during drag
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [isResizing, handleMouseMove, handleMouseUp]);

  /**
   * Initiate drag session
   * Called by resize handle's onMouseDown event
   * Records starting position and width for delta calculations
   */
  const startResize = useCallback(
    (e: React.MouseEvent) => {
      if (!enabled) return;
      setIsResizing(true);
      startXRef.current = e.clientX;
      startWidthRef.current = width;
    },
    [enabled, width]
  );

  // Dummy component for type compatibility (not rendered, actual handle is in AIView)
  const ResizeHandle: React.FC = () => null;

  return {
    width: enabled ? width : defaultWidth,
    isResizing,
    startResize,
    ResizeHandle,
  };
}
