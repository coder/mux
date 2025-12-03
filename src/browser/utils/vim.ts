/**
 * Core Vim text manipulation utilities.
 * All functions are pure and accept text + cursor position, returning new state.
 *
 * Keep in sync with:
 * - docs/vim-mode.md (user documentation)
 * - src/components/VimTextArea.tsx (React component integration)
 * - src/utils/vim.test.ts (integration tests)
 */

export type VimMode = "insert" | "normal";

export interface VimState {
  text: string;
  cursor: number;
  mode: VimMode;
  yankBuffer: string;
  desiredColumn: number | null;
  pendingOp: null | { op: "d" | "y" | "c"; at: number; args?: string[] };
}

export type VimAction = "undo" | "redo" | "escapeInNormalMode";

export type VimKeyResult =
  | { handled: false } // Browser should handle this key
  | { handled: true; newState: VimState; action?: VimAction }; // Vim handled it

export interface LinesInfo {
  lines: string[];
  starts: number[]; // start index of each line
}

/**
 * Parse text into lines and compute start indices.
 */
export function getLinesInfo(text: string): LinesInfo {
  const lines = text.split("\n");
  const starts: number[] = [];
  let acc = 0;
  for (let i = 0; i < lines.length; i++) {
    starts.push(acc);
    acc += lines[i].length + (i < lines.length - 1 ? 1 : 0);
  }
  return { lines, starts };
}

/**
 * Convert index to (row, col) coordinates.
 */
export function getRowCol(text: string, idx: number): { row: number; col: number } {
  const { starts } = getLinesInfo(text);
  let row = 0;
  while (row + 1 < starts.length && starts[row + 1] <= idx) row++;
  const col = idx - starts[row];
  return { row, col };
}

/**
 * Convert (row, col) to index, clamping to valid range.
 */
export function indexAt(text: string, row: number, col: number): number {
  const { lines, starts } = getLinesInfo(text);
  row = Math.max(0, Math.min(row, lines.length - 1));
  col = Math.max(0, Math.min(col, lines[row].length));
  return starts[row] + col;
}

/**
 * Get line bounds (start, end) for the line containing cursor.
 */
export function getLineBounds(
  text: string,
  cursor: number
): { lineStart: number; lineEnd: number; row: number } {
  const { row } = getRowCol(text, cursor);
  const { lines, starts } = getLinesInfo(text);
  const lineStart = starts[row];
  const lineEnd = lineStart + lines[row].length;
  return { lineStart, lineEnd, row };
}

/**
 * Move to first non-whitespace character on current line (like '_').
 */
export function moveToFirstNonWhitespace(text: string, cursor: number): number {
  const { lineStart, lineEnd } = getLineBounds(text, cursor);
  let i = lineStart;
  while (i < lineEnd && /\s/.test(text[i])) {
    i++;
  }
  // If entire line is whitespace, go to line start
  return i >= lineEnd ? lineStart : i;
}

/**
 * Move cursor vertically by delta lines, maintaining desiredColumn if provided.
 */
export function moveVertical(
  text: string,
  cursor: number,
  delta: number,
  desiredColumn: number | null
): { cursor: number; desiredColumn: number } {
  const { row, col } = getRowCol(text, cursor);
  const { lines } = getLinesInfo(text);
  const nextRow = Math.max(0, Math.min(lines.length - 1, row + delta));
  const goal = desiredColumn ?? col;
  const nextCol = Math.max(0, Math.min(goal, lines[nextRow].length));
  return {
    cursor: indexAt(text, nextRow, nextCol),
    desiredColumn: goal,
  };
}

/**
 * Move cursor to next word boundary (like 'w').
 * In normal mode, cursor should never go past the last character.
 */
export function moveWordForward(text: string, cursor: number): number {
  const n = text.length;
  if (n === 0) return 0;

  let i = Math.max(0, Math.min(cursor, n - 1));
  const isWord = (ch: string) => /[A-Za-z0-9_]/.test(ch);

  const advancePastWord = (idx: number): number => {
    let j = idx;
    while (j < n && isWord(text[j])) j++;
    return j;
  };

  const advanceToWord = (idx: number): number => {
    let j = idx;
    while (j < n && !isWord(text[j])) j++;
    return j;
  };

  if (isWord(text[i])) {
    i = advancePastWord(i);
  }

  i = advanceToWord(i);

  if (i >= n) {
    return Math.max(0, n - 1);
  }

  return i;
}

/**
 * Move cursor to end of current/next word (like 'e').
 * If on a word character, goes to end of current word.
 * If already at end of word, goes to end of next word.
 * If on whitespace, goes to end of next word.
 */
export function moveWordEnd(text: string, cursor: number): number {
  const n = text.length;
  if (n === 0) return 0;
  if (cursor >= n - 1) return Math.max(0, n - 1);

  const clamp = Math.max(0, Math.min(cursor, n - 1));
  const isWord = (ch: string) => /[A-Za-z0-9_]/.test(ch);

  if (!isWord(text[clamp])) {
    let i = clamp;
    while (i < n && !isWord(text[i])) i++;
    if (i >= n) return Math.max(0, n - 1);
    while (i < n - 1 && isWord(text[i + 1])) i++;
    return i;
  }

  let endOfCurrent = clamp;
  while (endOfCurrent < n - 1 && isWord(text[endOfCurrent + 1])) endOfCurrent++;

  if (clamp < endOfCurrent) {
    return endOfCurrent;
  }

  let j = endOfCurrent + 1;
  while (j < n && !isWord(text[j])) j++;
  if (j >= n) return Math.max(0, n - 1);

  let endOfNext = j;
  while (endOfNext < n - 1 && isWord(text[endOfNext + 1])) endOfNext++;
  return endOfNext;
}

/**
 * Move cursor to previous word boundary (like 'b').
 * In normal mode, cursor should never go past the last character.
 */
export function moveWordBackward(text: string, cursor: number): number {
  let i = cursor - 1;
  while (i > 0 && /\s/.test(text[i])) i--;
  while (i > 0 && /[A-Za-z0-9_]/.test(text[i - 1])) i--;
  // Clamp to last character position in normal mode (never past the end)
  return Math.min(Math.max(0, i), Math.max(0, text.length - 1));
}

/**
 * Get word bounds at the given index.
 * If on whitespace, uses the next word to the right.
 */
export function wordBoundsAt(text: string, idx: number): { start: number; end: number } {
  const n = text.length;
  let i = Math.max(0, Math.min(n, idx));
  const isWord = (ch: string) => /[A-Za-z0-9_]/.test(ch);
  if (i >= n) i = n - 1;
  if (n === 0) return { start: 0, end: 0 };
  if (i < 0) i = 0;
  if (!isWord(text[i])) {
    let j = i;
    while (j < n && !isWord(text[j])) j++;
    if (j >= n) return { start: n, end: n };
    i = j;
  }
  let a = i;
  while (a > 0 && isWord(text[a - 1])) a--;
  let b = i + 1;
  while (b < n && isWord(text[b])) b++;
  return { start: a, end: b };
}

/**
 * Delete range [from, to) and optionally store in yankBuffer.
 */
export function deleteRange(
  text: string,
  from: number,
  to: number,
  yank: boolean,
  yankBuffer: string
): { text: string; cursor: number; yankBuffer: string } {
  const a = Math.max(0, Math.min(from, to));
  const b = Math.max(0, Math.max(from, to));
  const removed = text.slice(a, b);
  const newText = text.slice(0, a) + text.slice(b);
  return {
    text: newText,
    cursor: a,
    yankBuffer: yank ? removed : yankBuffer,
  };
}

/**
 * Delete the character under cursor (like 'x').
 */
export function deleteCharUnderCursor(
  text: string,
  cursor: number,
  yankBuffer: string
): { text: string; cursor: number; yankBuffer: string } {
  if (cursor >= text.length) return { text, cursor, yankBuffer };
  return deleteRange(text, cursor, cursor + 1, true, yankBuffer);
}

/**
 * Delete entire line (like 'dd').
 */
export function deleteLine(
  text: string,
  cursor: number,
  _yankBuffer: string
): { text: string; cursor: number; yankBuffer: string } {
  const { lineStart, lineEnd } = getLineBounds(text, cursor);
  const isLastLine = lineEnd === text.length;
  const to = isLastLine ? lineEnd : lineEnd + 1;
  const removed = text.slice(lineStart, to);
  const newText = text.slice(0, lineStart) + text.slice(to);
  return {
    text: newText,
    cursor: lineStart,
    yankBuffer: removed,
  };
}

/**
 * Yank entire line (like 'yy').
 */
export function yankLine(text: string, cursor: number): string {
  const { lineStart, lineEnd } = getLineBounds(text, cursor);
  const isLastLine = lineEnd === text.length;
  const to = isLastLine ? lineEnd : lineEnd + 1;
  return text.slice(lineStart, to);
}

/**
 * Paste yankBuffer after cursor (like 'p').
 */
export function pasteAfter(
  text: string,
  cursor: number,
  yankBuffer: string
): { text: string; cursor: number } {
  if (!yankBuffer) return { text, cursor };
  const newText = text.slice(0, cursor) + yankBuffer + text.slice(cursor);
  return { text: newText, cursor: cursor + yankBuffer.length };
}

/**
 * Paste yankBuffer before cursor (like 'P').
 */
export function pasteBefore(
  text: string,
  cursor: number,
  yankBuffer: string
): { text: string; cursor: number } {
  if (!yankBuffer) return { text, cursor };
  const newText = text.slice(0, cursor) + yankBuffer + text.slice(cursor);
  return { text: newText, cursor };
}

/**
 * Compute cursor placement for insert mode entry (i/a/I/A/o/O).
 */
export function getInsertCursorPos(
  text: string,
  cursor: number,
  mode: "i" | "a" | "I" | "A" | "o" | "O"
): { cursor: number; text: string } {
  const { lineStart, lineEnd } = getLineBounds(text, cursor);
  switch (mode) {
    case "i":
      return { cursor, text };
    case "a":
      return { cursor: Math.min(cursor + 1, text.length), text };
    case "I":
      return { cursor: lineStart, text };
    case "A":
      return { cursor: lineEnd, text };
    case "o": {
      const newText = text.slice(0, lineEnd) + "\n" + text.slice(lineEnd);
      return { cursor: lineEnd + 1, text: newText };
    }
    case "O": {
      const newText = text.slice(0, lineStart) + "\n" + text.slice(lineStart);
      return { cursor: lineStart, text: newText };
    }
  }
}

/**
 * Apply a change operator (delete + enter insert).
 */
export function changeRange(
  text: string,
  from: number,
  to: number,
  _yankBuffer: string
): { text: string; cursor: number; yankBuffer: string } {
  return deleteRange(text, from, to, true, _yankBuffer);
}

/**
 * Handle change entire line (cc).
 */
export function changeLine(
  text: string,
  cursor: number,
  yankBuffer: string
): { text: string; cursor: number; yankBuffer: string } {
  const { lineStart, lineEnd } = getLineBounds(text, cursor);
  return changeRange(text, lineStart, lineEnd, yankBuffer);
}

/**
 * ============================================================================
 * CENTRAL STATE MACHINE
 * ============================================================================
 * All Vim key handling logic is centralized here for testability.
 * The component just calls handleKeyPress() and applies the result.
 */

interface KeyModifiers {
  ctrl?: boolean;
  meta?: boolean;
  alt?: boolean;
}

/**
 * Main entry point for handling key presses in Vim mode.
 * Returns null if browser should handle the key (e.g., typing in insert mode).
 * Returns new state if Vim handled the key.
 */
export function handleKeyPress(
  state: VimState,
  key: string,
  modifiers: KeyModifiers
): VimKeyResult {
  if (state.mode === "insert") {
    return handleInsertModeKey(state, key, modifiers);
  } else {
    return handleNormalModeKey(state, key, modifiers);
  }
}

/**
 * Handle keys in insert mode.
 * Most keys return { handled: false } so browser can handle typing.
 */
function handleInsertModeKey(state: VimState, key: string, modifiers: KeyModifiers): VimKeyResult {
  // ESC or Ctrl-[ -> enter normal mode
  if (key === "Escape" || (key === "[" && modifiers.ctrl)) {
    // Clamp cursor to valid position (can't be past end in normal mode)
    const normalCursor = Math.min(state.cursor, Math.max(0, state.text.length - 1));
    return handleKey(state, {
      mode: "normal",
      cursor: normalCursor,
      desiredColumn: null,
    });
  }

  // Let browser handle all other keys in insert mode
  return { handled: false };
}

/**
 * Handle keys in normal mode.
 */
function handleNormalModeKey(state: VimState, key: string, modifiers: KeyModifiers): VimKeyResult {
  const now = Date.now();

  // Check for timeout on pending operator (800ms like Vim)
  let pending = state.pendingOp;
  if (pending && now - pending.at > 800) {
    pending = null;
  }

  // Handle pending operator + motion/text-object
  if (pending) {
    const result = handlePendingOperator(state, pending, key, modifiers, now);
    if (result) return result;
  }

  // Handle undo/redo
  if (key === "u") {
    return { handled: true, newState: state, action: "undo" };
  }
  if (key === "r" && modifiers.ctrl) {
    return { handled: true, newState: state, action: "redo" };
  }

  // Handle mode transitions (i/a/I/A/o/O)
  const insertResult = tryEnterInsertMode(state, key);
  if (insertResult) return insertResult;

  // Handle navigation
  const navResult = tryHandleNavigation(state, key);
  if (navResult) return navResult;

  // Handle edit commands
  const editResult = tryHandleEdit(state, key);
  if (editResult) return editResult;

  // Handle operators (d/c/y/D/C)
  const opResult = tryHandleOperator(state, key, now);
  if (opResult) return opResult;

  // Escape in normal mode - signal to parent (e.g., to cancel edit mode)
  if (key === "Escape" || (key === "[" && modifiers.ctrl)) {
    return { handled: true, newState: state, action: "escapeInNormalMode" };
  }

  // Swallow all other single-character keys in normal mode (don't type letters)
  if (key.length === 1 && !modifiers.ctrl && !modifiers.meta && !modifiers.alt) {
    return { handled: true, newState: state };
  }

  // Unknown key - let browser handle
  return { handled: false };
}

/**
 * Handle pending operator + motion/text-object combinations.
 */
function handlePendingOperator(
  state: VimState,
  pending: NonNullable<VimState["pendingOp"]>,
  key: string,
  _modifiers: KeyModifiers,
  now: number
): VimKeyResult | null {
  const args = pending.args ?? [];

  // Handle doubled operator (dd, yy, cc) -> line operation
  if (args.length === 0 && key === pending.op) {
    return { handled: true, newState: applyOperatorMotion(state, pending.op, "line") };
  }

  // Handle text objects (currently just "iw")
  if (args.length === 1 && args[0] === "i" && key === "w") {
    return { handled: true, newState: applyOperatorTextObject(state, pending.op, "iw") };
  }

  // Handle motions when no text object is pending
  if (args.length === 0) {
    // Word motions
    if (key === "w" || key === "W") {
      return { handled: true, newState: applyOperatorMotion(state, pending.op, "w") };
    }
    if (key === "b" || key === "B") {
      return { handled: true, newState: applyOperatorMotion(state, pending.op, "b") };
    }
    if (key === "e" || key === "E") {
      return { handled: true, newState: applyOperatorMotion(state, pending.op, "e") };
    }
    // Line motions
    if (key === "$" || key === "End") {
      return { handled: true, newState: applyOperatorMotion(state, pending.op, "$") };
    }
    if (key === "0" || key === "Home") {
      return { handled: true, newState: applyOperatorMotion(state, pending.op, "0") };
    }
    if (key === "_") {
      return { handled: true, newState: applyOperatorMotion(state, pending.op, "_") };
    }
    // Text object prefix
    if (key === "i") {
      return handleKey(state, { pendingOp: { op: pending.op, at: now, args: ["i"] } });
    }
  }

  // Unknown motion - cancel pending operation
  return handleKey(state, { pendingOp: null });
}

/**
 * Helper to complete an operation and clear pending state.
 */
function completeOperation(state: VimState, updates: Partial<VimState>): VimState {
  return {
    ...state,
    ...updates,
    pendingOp: null,
    desiredColumn: null,
  };
}

/**
 * Helper to create a handled key result with updated state.
 */
function handleKey(state: VimState, updates: Partial<VimState>): VimKeyResult {
  return {
    handled: true,
    newState: { ...state, ...updates },
  };
}

/**
 * Calculate the range (from, to) for a motion.
 * Returns null for "line" motion (requires special handling).
 */
function getMotionRange(
  text: string,
  cursor: number,
  motion: "w" | "b" | "e" | "$" | "0" | "_" | "line"
): { from: number; to: number } | null {
  switch (motion) {
    case "w":
      return { from: cursor, to: moveWordForward(text, cursor) };
    case "b":
      return { from: moveWordBackward(text, cursor), to: cursor };
    case "e":
      return { from: cursor, to: moveWordEnd(text, cursor) + 1 };
    case "$": {
      const { lineEnd } = getLineBounds(text, cursor);
      return { from: cursor, to: lineEnd };
    }
    case "0": {
      const { lineStart } = getLineBounds(text, cursor);
      return { from: lineStart, to: cursor };
    }
    case "_":
      // '_' is a linewise motion in Vim - operates on whole lines
      return null; // Use linewise handling like 'dd'
    case "line":
      return null; // Special case: handled separately
  }
}

/**
 * Apply operator + motion combination.
 */
function applyOperatorMotion(
  state: VimState,
  op: "d" | "c" | "y",
  motion: "w" | "b" | "e" | "$" | "0" | "_" | "line"
): VimState {
  const { text, cursor, yankBuffer } = state;

  // Line operations use special functions (dd, cc, yy, d_, c_, y_)
  if (motion === "line" || motion === "_") {
    if (op === "d") {
      const result = deleteLine(text, cursor, yankBuffer);
      return completeOperation(state, {
        text: result.text,
        cursor: result.cursor,
        yankBuffer: result.yankBuffer,
      });
    }
    if (op === "c") {
      const result = changeLine(text, cursor, yankBuffer);
      return completeOperation(state, {
        mode: "insert",
        text: result.text,
        cursor: result.cursor,
        yankBuffer: result.yankBuffer,
      });
    }
    if (op === "y") {
      return completeOperation(state, {
        yankBuffer: yankLine(text, cursor),
      });
    }
  }

  // Calculate range for all other motions
  const range = getMotionRange(text, cursor, motion);
  if (!range) return state; // Shouldn't happen, but type safety

  // Apply operator to range
  if (op === "d") {
    const result = deleteRange(text, range.from, range.to, true, yankBuffer);
    return completeOperation(state, {
      text: result.text,
      cursor: result.cursor,
      yankBuffer: result.yankBuffer,
    });
  }

  if (op === "c") {
    const result = changeRange(text, range.from, range.to, yankBuffer);
    return completeOperation(state, {
      mode: "insert",
      text: result.text,
      cursor: result.cursor,
      yankBuffer: result.yankBuffer,
    });
  }

  if (op === "y") {
    return completeOperation(state, {
      yankBuffer: text.slice(range.from, range.to),
    });
  }

  return state;
}

/**
 * Apply operator + text object combination.
 * Currently only supports "iw" (inner word).
 */
function applyOperatorTextObject(state: VimState, op: "d" | "c" | "y", textObj: "iw"): VimState {
  if (textObj !== "iw") return state;

  const { text, cursor, yankBuffer } = state;
  const { start, end } = wordBoundsAt(text, cursor);

  // Apply operator to range [start, end)
  if (op === "d") {
    const result = deleteRange(text, start, end, true, yankBuffer);
    return completeOperation(state, {
      text: result.text,
      cursor: result.cursor,
      yankBuffer: result.yankBuffer,
    });
  }

  if (op === "c") {
    const result = changeRange(text, start, end, yankBuffer);
    return completeOperation(state, {
      mode: "insert",
      text: result.text,
      cursor: result.cursor,
      yankBuffer: result.yankBuffer,
    });
  }

  if (op === "y") {
    return completeOperation(state, {
      yankBuffer: text.slice(start, end),
    });
  }

  return state;
}

type InsertKey = "i" | "a" | "I" | "A" | "o" | "O";

/**
 * Type guard to check if key is a valid insert mode key.
 */
function isInsertKey(key: string): key is InsertKey {
  return ["i", "a", "I", "A", "o", "O"].includes(key);
}

/**
 * Try to handle insert mode entry (i/a/I/A/o/O).
 */
function tryEnterInsertMode(state: VimState, key: string): VimKeyResult | null {
  if (!isInsertKey(key)) return null;

  const result = getInsertCursorPos(state.text, state.cursor, key);
  return handleKey(state, {
    mode: "insert",
    text: result.text,
    cursor: result.cursor,
    desiredColumn: null,
  });
}

/**
 * Try to handle navigation commands (h/j/k/l/w/b/0/$).
 */
function tryHandleNavigation(state: VimState, key: string): VimKeyResult | null {
  const { text, cursor, desiredColumn } = state;

  switch (key) {
    case "h":
      return handleKey(state, { cursor: Math.max(0, cursor - 1), desiredColumn: null });

    case "l":
      return handleKey(state, {
        cursor: Math.min(cursor + 1, Math.max(0, text.length - 1)),
        desiredColumn: null,
      });

    case "j": {
      const result = moveVertical(text, cursor, 1, desiredColumn);
      return handleKey(state, { cursor: result.cursor, desiredColumn: result.desiredColumn });
    }

    case "k": {
      const result = moveVertical(text, cursor, -1, desiredColumn);
      return handleKey(state, { cursor: result.cursor, desiredColumn: result.desiredColumn });
    }

    case "w":
    case "W":
      return handleKey(state, { cursor: moveWordForward(text, cursor), desiredColumn: null });

    case "b":
    case "B":
      return handleKey(state, { cursor: moveWordBackward(text, cursor), desiredColumn: null });

    case "e":
    case "E":
      return handleKey(state, { cursor: moveWordEnd(text, cursor), desiredColumn: null });

    case "0":
    case "Home": {
      const { lineStart } = getLineBounds(text, cursor);
      return handleKey(state, { cursor: lineStart, desiredColumn: null });
    }

    case "_":
      return handleKey(state, {
        cursor: moveToFirstNonWhitespace(text, cursor),
        desiredColumn: null,
      });

    case "$":
    case "End": {
      const { lineStart, lineEnd } = getLineBounds(text, cursor);
      // In normal mode, $ goes to last character, not after it
      // Special case: empty line stays at lineStart
      const newCursor = lineEnd > lineStart ? lineEnd - 1 : lineStart;
      return handleKey(state, { cursor: newCursor, desiredColumn: null });
    }
  }

  return null;
}

/**
 * Try to handle edit commands (x/p/P).
 */
function tryHandleEdit(state: VimState, key: string): VimKeyResult | null {
  const { text, cursor, yankBuffer } = state;

  switch (key) {
    case "x": {
      if (cursor >= text.length) return null;
      const result = deleteCharUnderCursor(text, cursor, yankBuffer);
      return handleKey(state, {
        text: result.text,
        cursor: result.cursor,
        yankBuffer: result.yankBuffer,
        desiredColumn: null,
      });
    }

    case "p": {
      // In normal mode, cursor is ON a character. Paste AFTER means after that character.
      const result = pasteAfter(text, cursor + 1, yankBuffer);
      return handleKey(state, {
        text: result.text,
        cursor: result.cursor - 1, // Adjust back to normal mode positioning
        desiredColumn: null,
      });
    }

    case "P": {
      const result = pasteBefore(text, cursor, yankBuffer);
      return handleKey(state, {
        text: result.text,
        cursor: result.cursor,
        desiredColumn: null,
      });
    }

    case "s": {
      if (cursor >= text.length) return null;
      const result = deleteCharUnderCursor(text, cursor, yankBuffer);
      return handleKey(state, {
        text: result.text,
        cursor: result.cursor,
        yankBuffer: result.yankBuffer,
        mode: "insert",
        desiredColumn: null,
        pendingOp: null,
      });
    }

    case "~": {
      if (cursor >= text.length) return null;
      const char = text[cursor];
      const toggled = char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase();
      const newText = text.slice(0, cursor) + toggled + text.slice(cursor + 1);
      const newCursor = Math.min(cursor + 1, Math.max(0, newText.length - 1));
      return handleKey(state, {
        text: newText,
        cursor: newCursor,
        desiredColumn: null,
        pendingOp: null,
      });
    }
  }

  return null;
}

/**
 * Try to handle operator commands (d/c/y/D/C).
 */
function tryHandleOperator(state: VimState, key: string, now: number): VimKeyResult | null {
  switch (key) {
    case "d":
      return handleKey(state, { pendingOp: { op: "d", at: now, args: [] } });

    case "c":
      return handleKey(state, { pendingOp: { op: "c", at: now, args: [] } });

    case "y":
      return handleKey(state, { pendingOp: { op: "y", at: now, args: [] } });

    case "D":
      return { handled: true, newState: applyOperatorMotion(state, "d", "$") };

    case "C":
      return { handled: true, newState: applyOperatorMotion(state, "c", "$") };
  }

  return null;
}

/**
 * Format pending operator command for display in mode indicator.
 * Returns empty string if no pending command.
 * Examples: "d", "c", "ci", "di"
 */
export function formatPendingCommand(pendingOp: VimState["pendingOp"]): string {
  if (!pendingOp) return "";
  const args = pendingOp.args?.join("") ?? "";
  return `${pendingOp.op}${args}`;
}
