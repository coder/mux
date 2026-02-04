import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAutoResizeContentEditable } from "@/browser/hooks/useAutoResizeContentEditable";
import { isVscodeWebview } from "@/browser/utils/env";
import * as vim from "@/browser/utils/vim";
import { Tooltip, TooltipTrigger, TooltipContent, HelpIndicator } from "./ui/tooltip";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { cn } from "@/common/lib/utils";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { VIM_ENABLED_KEY } from "@/common/constants/storage";
import { CommandPrefixText, extractCommandPrefix } from "./CommandHighlightOverlay";
import {
  getSelectionRange,
  normalizeContentEditableText,
  setSelectionRange,
  type SelectionRange,
} from "@/browser/utils/contentEditableSelection";

/**
 * RichTextInput – minimal Vim-like editing for a contenteditable input.
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
 * - docs/vim-mode.md (user documentation)
 * - src/utils/vim.ts (core Vim logic)
 * - src/utils/vim.test.ts (integration tests)
 */

export interface RichTextInputProps extends Omit<
  React.HTMLAttributes<HTMLDivElement>,
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
  /** Placeholder text (renders when the input is empty). */
  placeholder?: string;
  /** Disable editing and focus. */
  disabled?: boolean;
}

type VimMode = vim.VimMode;

function renderTextWithLineBreaks(text: string, keyPrefix: string): React.ReactNode[] {
  if (text.length === 0) {
    return [];
  }

  const parts = text.split("\n");
  const nodes: React.ReactNode[] = [];
  parts.forEach((part, index) => {
    if (part.length > 0) {
      nodes.push(<React.Fragment key={`${keyPrefix}-text-${index}`}>{part}</React.Fragment>);
    }
    if (index < parts.length - 1) {
      nodes.push(<br key={`${keyPrefix}-br-${index}`} />);
    }
  });
  return nodes;
}

export const RichTextInput = React.forwardRef<HTMLDivElement, RichTextInputProps>((props, ref) => {
  const {
    value,
    onChange,
    isEditing,
    suppressKeys,
    trailingAction,
    onEscapeInNormalMode,
    focusBorderColor,
    placeholder,
    disabled,
    className,
    onKeyDown,
    onFocus,
    onBlur,
    onInput,
    onCompositionStart,
    onCompositionEnd,
    onPaste,
    ...rest
  } = props;
  const editorRef = useRef<HTMLDivElement | null>(null);
  const pendingSelectionRef = useRef<SelectionRange | null>(null);
  const isComposingRef = useRef(false);
  // Expose DOM ref to parent
  useEffect(() => {
    if (!ref) return;
    if (typeof ref === "function") ref(editorRef.current);
    else ref.current = editorRef.current;
  }, [ref]);
  const [vimEnabled] = usePersistedState(VIM_ENABLED_KEY, false, { listener: true });

  const [vimMode, setVimMode] = useState<VimMode>("insert");
  useEffect(() => {
    if (!vimEnabled) {
      setVimMode("insert");
    }
  }, [vimEnabled]);

  const [isFocused, setIsFocused] = useState(false);
  const [desiredColumn, setDesiredColumn] = useState<number | null>(null);
  const [pendingOp, setPendingOp] = useState<null | {
    op: "d" | "y" | "c";
    at: number;
    args?: string[];
  }>(null);
  const yankBufferRef = useRef<string>("");

  useAutoResizeContentEditable(editorRef, value, 50);

  const suppressSet = new Set(suppressKeys ?? []);

  const withSelection = () => {
    const selection = getSelectionRange(editorRef.current);
    if (!selection) {
      return { start: value.length, end: value.length };
    }
    return selection;
  };

  const setCursor = (pos: number, mode?: vim.VimMode) => {
    const el = editorRef.current;
    if (!el) {
      return;
    }
    const p = Math.max(0, Math.min(value.length, pos));
    // In normal mode, show a 1-char selection (block cursor effect) when possible
    // Show cursor if there's a character under it (including at end of line before newline)
    const effectiveMode = mode ?? vimMode;
    const end = effectiveMode === "normal" && p < value.length ? p + 1 : p;
    setSelectionRange(el, { start: p, end });
    setDesiredColumn(null);
  };

  const syncValueFromDom = () => {
    const el = editorRef.current;
    if (!el) {
      return;
    }

    const next = normalizeContentEditableText(el);
    if (next !== value) {
      const selection = getSelectionRange(el);
      if (selection) {
        pendingSelectionRef.current = selection;
      }
      onChange(next);
    }
  };

  const handleInputInternal = (event: React.FormEvent<HTMLDivElement>) => {
    if (!isComposingRef.current) {
      syncValueFromDom();
    }
    onInput?.(event);
  };

  const handleCompositionStartInternal = (event: React.CompositionEvent<HTMLDivElement>) => {
    isComposingRef.current = true;
    onCompositionStart?.(event);
  };

  const handleCompositionEndInternal = (event: React.CompositionEvent<HTMLDivElement>) => {
    isComposingRef.current = false;
    syncValueFromDom();
    onCompositionEnd?.(event);
  };

  const handlePasteInternal = (event: React.ClipboardEvent<HTMLDivElement>) => {
    onPaste?.(event);
    if (event.defaultPrevented) {
      return;
    }

    const text = event.clipboardData?.getData("text/plain");
    if (typeof text !== "string" || text.length === 0) {
      return;
    }

    // Strip HTML on paste to keep the editor in plain-text mode.
    event.preventDefault();
    document.execCommand("insertText", false, text);
  };

  useLayoutEffect(() => {
    const selection = pendingSelectionRef.current;
    if (!selection) {
      return;
    }
    if (isComposingRef.current) {
      return;
    }
    const el = editorRef.current;
    if (!el) {
      return;
    }
    setSelectionRange(el, selection);
    pendingSelectionRef.current = null;
  }, [value]);

  const handleKeyDownInternal = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // Let parent handle first (send, cancel, etc.)
    onKeyDown?.(event);
    if (event.defaultPrevented) return;

    if (!vimEnabled) return;

    // If suggestions or external popovers are active, do not intercept navigation keys
    if (suppressSet.has(event.key)) return;

    // Build current Vim state
    const selection = withSelection();
    const vimState: vim.VimState = {
      text: value,
      cursor: selection.start,
      mode: vimMode,
      yankBuffer: yankBufferRef.current,
      desiredColumn,
      pendingOp,
    };

    // Handle key press through centralized state machine
    const result = vim.handleKeyPress(vimState, event.key, {
      ctrl: event.ctrlKey,
      meta: event.metaKey,
      alt: event.altKey,
    });

    if (!result.handled) return; // Let browser handle (e.g., typing in insert mode)

    event.preventDefault();

    // Handle side effects (undo/redo/escapeInNormalMode)
    if (result.action === "undo") {
      document.execCommand("undo");
      return;
    }
    if (result.action === "redo") {
      document.execCommand("redo");
      return;
    }
    if (result.action === "escapeInNormalMode") {
      stopKeyboardPropagation(event);
      onEscapeInNormalMode?.();
      return;
    }

    // Apply new state to React
    const newState = result.newState;

    if (newState.text !== value) {
      onChange(newState.text);
    }
    if (newState.mode !== vimMode) {
      setVimMode(newState.mode);
    }
    if (newState.yankBuffer !== yankBufferRef.current) {
      yankBufferRef.current = newState.yankBuffer;
    }
    if (newState.desiredColumn !== desiredColumn) {
      setDesiredColumn(newState.desiredColumn);
    }
    if (newState.pendingOp !== pendingOp) {
      setPendingOp(newState.pendingOp);
    }

    // Set cursor after React state updates (important for mode transitions)
    // Pass the new mode explicitly to avoid stale closure issues
    setTimeout(() => setCursor(newState.cursor, newState.mode), 0);
  };

  // Build mode indicator content
  const showVimMode = vimEnabled && vimMode === "normal";
  const pendingCommand = showVimMode ? vim.formatPendingCommand(pendingOp) : "";
  const showFocusHint = !isFocused && !isVscodeWebview();

  // Check if there's a command prefix to highlight
  const commandPrefix = extractCommandPrefix(value);
  const isEmptyValue = value.length === 0;

  return (
    <div style={{ width: "100%" }} data-component="RichTextInputContainer">
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
                  Press <strong>ESC</strong> for normal mode, <strong>i</strong> to return to insert
                  mode.
                  <br />
                  <br />
                  See{" "}
                  <a
                    href="#"
                    onClick={(event) => {
                      event.preventDefault();
                      window.open("/docs/vim-mode.md");
                    }}
                  >
                    Vim Mode docs
                  </a>{" "}
                  for full command reference.
                </TooltipContent>
              </Tooltip>
              <span className="uppercase">normal</span>
              {pendingCommand && <span>{pendingCommand}</span>}
            </>
          )}
        </div>
        {showFocusHint && (
          <div className="ml-auto flex items-center gap-1 font-mono">
            <span>{formatKeybind(KEYBINDS.FOCUS_CHAT)} to focus</span>
          </div>
        )}
      </div>
      {/*
        Wrapper owns ALL shared typography (font, size, line-height).
        This ensures the contenteditable and placeholder align with legacy textarea styles.
      */}
      <div
        className={cn(
          "relative rounded text-[13px]",
          vimEnabled ? "font-monospace" : "font-sans",
          isEditing ? "bg-editing-mode-alpha" : "bg-dark"
        )}
        data-component="RichTextInputWrapper"
      >
        {placeholder && value.length === 0 && (
          <div
            className="text-placeholder pointer-events-none absolute top-1.5 left-2"
            aria-hidden="true"
          >
            {placeholder}
          </div>
        )}
        {/*
          Contenteditable keeps the baseline ChatInput visuals intact while letting us style the
          command prefix inline (avoiding the overlay alignment regressions of the textarea hack).
        */}
        <div
          ref={editorRef}
          contentEditable={!disabled}
          role="textbox"
          aria-multiline="true"
          aria-disabled={disabled ? "true" : undefined}
          aria-placeholder={placeholder}
          spellCheck={false}
          suppressContentEditableWarning
          onInput={handleInputInternal}
          onKeyDown={handleKeyDownInternal}
          onFocus={(event) => {
            setIsFocused(true);
            onFocus?.(event);
          }}
          onBlur={(event) => {
            setIsFocused(false);
            onBlur?.(event);
          }}
          onCompositionStart={handleCompositionStartInternal}
          onCompositionEnd={handleCompositionEndInternal}
          onPaste={handlePasteInternal}
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
            // Layout & sizing
            "relative w-full rounded px-2 py-1.5 min-h-8 max-h-[50vh] overflow-y-auto",
            // Typography inherited from wrapper
            "text-light font-[inherit] whitespace-pre-wrap break-words",
            // Border
            "border",
            // Background
            "bg-transparent",
            // Focus
            "focus:outline-none",
            // Trailing action padding
            trailingAction && "pr-10",
            // Border colors based on state
            isEditing
              ? "border-editing-mode focus:border-editing-mode"
              : "border-border-light focus:border-[var(--focus-border-color)]",
            // Caret: keep visible alongside inline command prefix styling.
            // In vim normal mode, hide caret and show block selection
            vimMode === "normal"
              ? "caret-transparent selection:bg-white/50"
              : "caret-light selection:bg-selection",
            className
          )}
        >
          {commandPrefix ? (
            <>
              <CommandPrefixText>{commandPrefix}</CommandPrefixText>
              {value.length > commandPrefix.length &&
                renderTextWithLineBreaks(value.slice(commandPrefix.length), "command-rest")}
            </>
          ) : isEmptyValue ? (
            <br />
          ) : (
            renderTextWithLineBreaks(value, "content")
          )}
        </div>
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
});

RichTextInput.displayName = "RichTextInput";
