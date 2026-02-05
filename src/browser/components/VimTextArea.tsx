import React, { useEffect, useMemo, useRef, useState } from "react";
import { useAutoResizeTextarea } from "@/browser/hooks/useAutoResizeTextarea";
import * as vim from "@/browser/utils/vim";
import { Tooltip, TooltipTrigger, TooltipContent, HelpIndicator } from "./ui/tooltip";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { cn } from "@/common/lib/utils";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { VIM_ENABLED_KEY } from "@/common/constants/storage";

/**
 * VimTextArea – minimal Vim-like editing for a textarea.
 *
 * MVP goals:
 * - Modes: insert (default) and normal
 * - ESC / Ctrl-[ to enter normal mode; i/a/I/A/o/O to enter insert (with placement)
 * - Navigation: h/j/k/l, 0, $, w, b
 * - Edit: x (delete char), dd (delete line), yy (yank line), p/P (paste), u (undo), Ctrl-r (redo)
 * - Works alongside parent keybinds (send, cancel). Parent onKeyDown runs first; if it prevents default we do nothing.
 * - Respects a suppressKeys list (e.g. when command suggestions popover is open)
 *
 * Keep in sync with:
 * - docs/config/vim-mode.mdx (user documentation)
 * - src/browser/utils/vim.ts (core Vim logic)
 * - src/browser/utils/vim.test.ts (integration tests)
 */

export interface VimTextAreaProps extends Omit<
  React.TextareaHTMLAttributes<HTMLTextAreaElement>,
  "onChange" | "value"
> {
  value: string;
  onChange: (next: string) => void;
  isEditing?: boolean;
  suppressKeys?: string[]; // keys for which Vim should not interfere (e.g. ["Tab","ArrowUp","ArrowDown","Escape"]) when popovers are open
  trailingAction?: React.ReactNode;
  /** Called when Escape is pressed in normal mode (vim) - useful for cancel edit */
  onEscapeInNormalMode?: () => void;
  /** Focus border color (CSS color value). */
  focusBorderColor: string;
}

type VimMode = vim.VimMode;

export const VimTextArea = React.forwardRef<HTMLTextAreaElement, VimTextAreaProps>(
  (
    {
      value,
      onChange,
      isEditing,
      suppressKeys,
      onKeyDown,
      trailingAction,
      onEscapeInNormalMode,
      focusBorderColor,
      ...rest
    },
    ref
  ) => {
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    // Expose DOM ref to parent
    useEffect(() => {
      if (!ref) return;
      if (typeof ref === "function") ref(textareaRef.current);
      else ref.current = textareaRef.current;
    }, [ref]);
    const [vimEnabled] = usePersistedState(VIM_ENABLED_KEY, false, { listener: true });

    const [vimMode, setVimMode] = useState<VimMode>("insert");
    useEffect(() => {
      if (!vimEnabled) {
        setVimMode("insert");
        setVisualAnchor(null);
        setDesiredColumn(null);
        setCount(null);
        setPending(null);
        cursorRef.current = 0;

        yankBufferRef.current = "";
        lastFindRef.current = null;
        undoStackRef.current = [];
        redoStackRef.current = [];
        insertStartSnapshotRef.current = null;
        lastEditRef.current = null;
      }
    }, [vimEnabled]);

    const [desiredColumn, setDesiredColumn] = useState<number | null>(null);
    const [count, setCount] = useState<number | null>(null);
    const [pending, setPending] = useState<vim.Pending | null>(null);
    const [visualAnchor, setVisualAnchor] = useState<number | null>(null);
    const yankBufferRef = useRef<string>("");
    const lastFindRef = useRef<vim.LastFind | null>(null);
    const undoStackRef = useRef<vim.VimHistorySnapshot[]>([]);
    const redoStackRef = useRef<vim.VimHistorySnapshot[]>([]);
    const insertStartSnapshotRef = useRef<vim.VimHistorySnapshot | null>(null);
    const lastEditRef = useRef<vim.LastEdit | null>(null);
    const cursorRef = useRef<number>(0);

    useAutoResizeTextarea(textareaRef, value, 50);

    const suppressSet = useMemo(() => new Set(suppressKeys ?? []), [suppressKeys]);

    const withSelection = () => {
      const el = textareaRef.current!;
      return { start: el.selectionStart, end: el.selectionEnd };
    };

    const applyDomSelection = (next: Pick<vim.VimState, "cursor" | "mode" | "visualAnchor">) => {
      const el = textareaRef.current!;
      const domText = el.value;
      const clamp = (pos: number) => Math.max(0, Math.min(domText.length, pos));

      cursorRef.current = next.cursor;

      if (next.mode === "insert") {
        const p = clamp(next.cursor);
        el.selectionStart = p;
        el.selectionEnd = p;
        return;
      }

      if (next.mode === "normal") {
        const p = clamp(next.cursor);
        el.selectionStart = p;
        // In normal mode, show a 1-char selection (block cursor effect) when possible.
        // Show cursor if there's a character under it (including at end of line before newline).
        el.selectionEnd = p < domText.length ? p + 1 : p;
        return;
      }

      const range = vim.getVisualRange({
        text: domText,
        cursor: next.cursor,
        mode: next.mode,
        visualAnchor: next.visualAnchor,
      });

      if (!range) {
        // Shouldn't happen, but avoid setting an invalid selection.
        const p = clamp(next.cursor);
        el.selectionStart = p;
        el.selectionEnd = p;
        return;
      }

      el.selectionStart = clamp(range.start);
      el.selectionEnd = clamp(range.end);
    };

    const handleKeyDownInternal = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Let parent handle first (send, cancel, etc.)
      onKeyDown?.(e);
      if (e.defaultPrevented) return;

      if (!vimEnabled) return;

      // If suggestions or external popovers are active, do not intercept navigation keys
      if (suppressSet.has(e.key)) return;

      // Build current Vim state
      const selection = withSelection();
      const cursor =
        vimMode === "visual" || vimMode === "visualLine" ? cursorRef.current : selection.start;

      // Keep the cursor ref in sync for mode transitions (normal -> visual, etc.).
      cursorRef.current = cursor;

      const vimState: vim.VimState = {
        text: value,
        cursor,
        mode: vimMode,
        visualAnchor,
        yankBuffer: yankBufferRef.current,
        desiredColumn,
        lastFind: lastFindRef.current,
        count,
        pending,
        undoStack: undoStackRef.current,
        redoStack: redoStackRef.current,
        insertStartSnapshot: insertStartSnapshotRef.current,
        lastEdit: lastEditRef.current,
      };

      // Handle key press through centralized state machine
      const result = vim.handleKeyPress(vimState, e.key, {
        ctrl: e.ctrlKey,
        meta: e.metaKey,
        alt: e.altKey,
      });

      if (!result.handled) return; // Let browser handle (e.g., typing in insert mode)

      e.preventDefault();

      // Handle side effects
      if (result.action === "escapeInNormalMode") {
        stopKeyboardPropagation(e);
        onEscapeInNormalMode?.();
        return;
      }

      // Apply new state to React
      const newState = result.newState;

      // Cursor position is required in visual mode even though the DOM selection is a range.
      cursorRef.current = newState.cursor;

      if (newState.text !== value) {
        onChange(newState.text);
      }
      if (newState.mode !== vimMode) {
        setVimMode(newState.mode);
      }
      if (newState.visualAnchor !== visualAnchor) {
        setVisualAnchor(newState.visualAnchor);
      }
      if (newState.yankBuffer !== yankBufferRef.current) {
        yankBufferRef.current = newState.yankBuffer;
      }
      if (newState.lastFind !== lastFindRef.current) {
        lastFindRef.current = newState.lastFind;
      }
      if (newState.undoStack !== undoStackRef.current) {
        undoStackRef.current = newState.undoStack;
      }
      if (newState.redoStack !== redoStackRef.current) {
        redoStackRef.current = newState.redoStack;
      }
      if (newState.insertStartSnapshot !== insertStartSnapshotRef.current) {
        insertStartSnapshotRef.current = newState.insertStartSnapshot;
      }
      if (newState.lastEdit !== lastEditRef.current) {
        lastEditRef.current = newState.lastEdit;
      }
      if (newState.desiredColumn !== desiredColumn) {
        setDesiredColumn(newState.desiredColumn);
      }
      if (newState.count !== count) {
        setCount(newState.count);
      }
      if (newState.pending !== pending) {
        setPending(newState.pending);
      }

      // Apply DOM selection after React state updates (important for mode transitions)
      setTimeout(() => applyDomSelection(newState), 0);
    };

    // Build mode indicator content
    const showVimMode = vimEnabled && vimMode !== "insert";
    const modeLabel =
      vimMode === "normal" ? "normal" : vimMode === "visual" ? "visual" : "visual line";
    const pendingCommand = showVimMode ? vim.formatPendingCommand(pending, count) : "";

    return (
      <div style={{ width: "100%" }} data-component="VimTextAreaContainer">
        <div
          className="text-vim-status mb-px flex h-[11px] items-center justify-between gap-1 text-[9px] leading-[11px] tracking-[0.8px] select-none"
          aria-live="polite"
        >
          <div className="flex items-center gap-1">
            {showVimMode && (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <HelpIndicator>?</HelpIndicator>
                  </TooltipTrigger>
                  <TooltipContent align="start" className="max-w-80 whitespace-normal">
                    <strong>Vim Mode Enabled</strong>
                    <br />
                    <br />
                    Press <strong>ESC</strong> for normal mode, <strong>i</strong> to return to
                    insert mode.
                    <br />
                    <br />
                    See{" "}
                    <a
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        try {
                          window.open("https://mux.coder.com/config/vim-mode", "_blank");
                        } catch {
                          /* ignore */
                        }
                      }}
                    >
                      Vim Mode docs
                    </a>{" "}
                    for full command reference.
                  </TooltipContent>
                </Tooltip>
                <span className="uppercase">{modeLabel}</span>
                {pendingCommand && <span>{pendingCommand}</span>}
              </>
            )}
          </div>
        </div>
        <div style={{ position: "relative" }} data-component="VimTextAreaWrapper">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDownInternal}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="none"
            autoComplete="off"
            // Optimize for iPadOS/iOS keyboard behavior
            enterKeyHint="send"
            {...rest}
            style={
              {
                ...(rest.style ?? {}),
                ...(trailingAction ? { scrollbarGutter: "stable both-edges" } : {}),
                // Focus border color from agent definition
                "--focus-border-color": !isEditing ? focusBorderColor : undefined,
              } as React.CSSProperties
            }
            className={cn(
              "w-full border text-light py-1.5 px-2 rounded text-[13px] resize-none min-h-8 max-h-[50vh] overflow-y-auto",
              vimEnabled ? "font-monospace" : "font-sans",
              "placeholder:text-placeholder",
              "focus:outline-none",
              trailingAction && "pr-10",
              isEditing
                ? "bg-editing-mode-alpha border-editing-mode focus:border-editing-mode"
                : "bg-dark border-border-light focus:border-[var(--focus-border-color)]",
              vimMode === "insert"
                ? "caret-current selection:bg-selection"
                : "caret-transparent selection:bg-white/50",
              rest.className
            )}
          />
          {trailingAction && (
            <div className="pointer-events-none absolute right-3.5 bottom-2.5 flex items-center">
              <div className="pointer-events-auto">{trailingAction}</div>
            </div>
          )}
          {vimEnabled && vimMode === "normal" && value.length === 0 && (
            <div className="pointer-events-none absolute top-1.5 left-2 h-4 w-2 bg-white/50" />
          )}
        </div>
      </div>
    );
  }
);

VimTextArea.displayName = "VimTextArea";
