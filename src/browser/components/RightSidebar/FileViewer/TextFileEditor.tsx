/**
 * TextFileEditor - Editable CodeMirror-backed viewer for text files.
 * Includes inline git diff indicators and save support.
 */

import React from "react";
import { parsePatch } from "diff";
import { Check, Copy, Save, RefreshCw, Undo2, Redo2 } from "lucide-react";
import {
  defaultKeymap,
  history,
  historyField,
  historyKeymap,
  indentWithTab,
  redo,
  redoDepth,
  undo,
  undoDepth,
} from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { go } from "@codemirror/lang-go";
import { java } from "@codemirror/lang-java";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { cpp } from "@codemirror/lang-cpp";
import {
  HighlightStyle,
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { highlightSelectionMatches } from "@codemirror/search";
import { php } from "@codemirror/lang-php";
import type { Extension, Range } from "@codemirror/state";
import { Compartment, EditorState, Prec, StateField, Text } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  rectangularSelection,
} from "@codemirror/view";
import { useCopyToClipboard } from "@/browser/hooks/useCopyToClipboard";
import type { DecorationSet } from "@codemirror/view";
import { useTheme } from "@/browser/contexts/ThemeContext";
import type { FileDraftHistory } from "@/browser/utils/rightSidebarLayout";
import { KEYBINDS, formatKeybind } from "@/browser/utils/ui/keybinds";
import { getLanguageFromPath, getLanguageDisplayName } from "@/common/utils/git/languageDetector";

interface TextFileEditorProps {
  content: string;
  /** Unsaved draft content to rehydrate (optional) */
  draftContent?: string | null;
  /** Serialized history state to restore (optional) */
  draftHistory?: FileDraftHistory | null;
  filePath: string;
  size: number;
  /** Git diff for uncommitted changes (null if no changes or error) */
  diff: string | null;
  /** Bump when content should reset dirty state */
  contentVersion: number;
  /** Save in-progress flag */
  isSaving?: boolean;
  /** Save error message */
  saveError?: string | null;
  /** Callback to refresh the file contents */
  onRefresh?: () => void;
  /** Callback when editor dirty state changes */
  onDirtyChange?: (dirty: boolean) => void;
  /** Callback when editor history changes */
  onHistoryChange?: (history: FileDraftHistory | null) => void;
  /** Callback when editor content changes */
  onContentChange?: (content: string) => void;
  /** Callback when save is requested */
  onSave?: (content: string) => Promise<void> | void;
  /** File changed on disk while dirty */
  externalChange?: boolean;
  onReloadExternal?: () => void;
  onDismissExternal?: () => void;
}

interface RemovedLineMarker {
  line: number;
  oldLineNumber: number;
  content: string;
}

interface DiffHighlights {
  addedLines: number[];
  removedLines: RemovedLineMarker[];
}

interface MinThemePalette {
  foreground: string;
  keyword: string;
  string: string;
  comment: string;
  number: string;
  variable: string;
  function: string;
  type: string;
  tag: string;
  attribute: string;
  property: string;
}

const MIN_DARK_COLORS: MinThemePalette = {
  foreground: "#B392F0",
  keyword: "#F97583",
  string: "#9DB1C5",
  comment: "#6B737C",
  number: "#F8F8F8",
  variable: "#79B8FF",
  function: "#B392F0",
  type: "#B392F0",
  tag: "#FFAB70",
  attribute: "#B392F0",
  property: "#79B8FF",
};

const MIN_LIGHT_COLORS: MinThemePalette = {
  foreground: "#24292E",
  keyword: "#D32F2F",
  string: "#2B5581",
  comment: "#C2C3C5",
  number: "#1976D2",
  variable: "#1976D2",
  function: "#6F42C1",
  type: "#6F42C1",
  tag: "#22863A",
  attribute: "#6F42C1",
  property: "#1976D2",
};

const createMinHighlightStyle = (colors: MinThemePalette): HighlightStyle =>
  HighlightStyle.define([
    {
      tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment],
      color: colors.comment,
    },
    {
      tag: [
        tags.string,
        tags.docString,
        tags.character,
        tags.attributeValue,
        tags.special(tags.string),
        tags.regexp,
      ],
      color: colors.string,
    },
    {
      tag: [tags.number, tags.integer, tags.float],
      color: colors.number,
    },
    {
      tag: [tags.bool, tags.null, tags.atom, tags.unit],
      color: colors.variable,
    },
    {
      tag: [
        tags.keyword,
        tags.controlKeyword,
        tags.definitionKeyword,
        tags.moduleKeyword,
        tags.modifier,
        tags.operatorKeyword,
      ],
      color: colors.keyword,
    },
    {
      tag: [
        tags.operator,
        tags.compareOperator,
        tags.logicOperator,
        tags.bitwiseOperator,
        tags.arithmeticOperator,
        tags.updateOperator,
        tags.definitionOperator,
        tags.typeOperator,
        tags.controlOperator,
      ],
      color: colors.keyword,
    },
    {
      tag: [tags.variableName, tags.self, tags.special(tags.variableName)],
      color: colors.variable,
    },
    {
      tag: [tags.propertyName],
      color: colors.property,
    },
    {
      tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
      color: colors.function,
    },
    {
      tag: [tags.typeName, tags.className],
      color: colors.type,
    },
    {
      tag: [tags.tagName],
      color: colors.tag,
    },
    {
      tag: [tags.attributeName],
      color: colors.attribute,
    },
    {
      tag: [tags.link, tags.url],
      color: colors.string,
    },
  ]);

const MIN_DARK_HIGHLIGHT_STYLE = createMinHighlightStyle(MIN_DARK_COLORS);
const MIN_LIGHT_HIGHLIGHT_STYLE = createMinHighlightStyle(MIN_LIGHT_COLORS);

const getMinThemePalette = (isDark: boolean): MinThemePalette =>
  isDark ? MIN_DARK_COLORS : MIN_LIGHT_COLORS;

const getMinHighlightStyle = (isDark: boolean): HighlightStyle =>
  isDark ? MIN_DARK_HIGHLIGHT_STYLE : MIN_LIGHT_HIGHLIGHT_STYLE;
// Normalize line endings for consistent dirty tracking
const normalizeLineEndings = (content: string): string => content.replace(/\r\n/g, "\n");

// Format file size for display
const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const baseExtensions: Extension = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  history(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  bracketMatching(),
  foldGutter(),
  highlightActiveLine(),
  highlightSelectionMatches(),
  rectangularSelection(),
  keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
];

function getDocLineCount(doc: Text): number {
  if (doc.lines === 0) return 0;
  const lastLine = doc.line(doc.lines);
  return lastLine.length === 0 ? Math.max(doc.lines - 1, 0) : doc.lines;
}

function parseDiffHighlights(diffText: string | null): DiffHighlights {
  if (!diffText) {
    return { addedLines: [], removedLines: [] };
  }

  try {
    const patches = parsePatch(diffText);
    if (patches.length === 0) {
      return { addedLines: [], removedLines: [] };
    }

    const addedLines: number[] = [];
    const removedLines: RemovedLineMarker[] = [];

    for (const patch of patches) {
      if (!patch.hunks) continue;

      for (const hunk of patch.hunks) {
        let oldLineNumber = hunk.oldStart;
        let newLineNumber = hunk.newStart;

        for (const line of hunk.lines) {
          const prefix = line[0];
          const content = line.slice(1);

          if (prefix === "+") {
            addedLines.push(newLineNumber);
            newLineNumber += 1;
            continue;
          }

          if (prefix === "-") {
            removedLines.push({
              line: newLineNumber,
              oldLineNumber,
              content,
            });
            oldLineNumber += 1;
            continue;
          }

          if (prefix === " ") {
            oldLineNumber += 1;
            newLineNumber += 1;
          }
        }
      }
    }

    return { addedLines, removedLines };
  } catch {
    return { addedLines: [], removedLines: [] };
  }
}

class RemovedLineWidget extends WidgetType {
  private readonly text: string;
  private readonly oldLineNumber: number;

  constructor(text: string, oldLineNumber: number) {
    super();
    this.text = text;
    this.oldLineNumber = oldLineNumber;
  }

  eq(other: RemovedLineWidget): boolean {
    return other.text === this.text && other.oldLineNumber === this.oldLineNumber;
  }

  toDOM(): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "cm-diff-removed-line";

    const gutter = document.createElement("span");
    gutter.className = "cm-diff-removed-gutter";
    gutter.textContent = this.oldLineNumber ? String(this.oldLineNumber) : "";

    const marker = document.createElement("span");
    marker.className = "cm-diff-removed-marker";
    marker.textContent = "−";

    const content = document.createElement("span");
    content.className = "cm-diff-removed-content";
    content.textContent = this.text || "\u00A0";

    wrapper.append(gutter, marker, content);
    return wrapper;
  }
}

function createDiffDecorations(doc: Text, diff: DiffHighlights): DecorationSet {
  const decorations: Array<Range<Decoration>> = [];

  for (const lineNumber of diff.addedLines) {
    if (lineNumber <= 0 || lineNumber > doc.lines) continue;
    const line = doc.line(lineNumber);
    decorations.push(Decoration.line({ class: "cm-diff-added-line" }).range(line.from));
  }

  for (const removedLine of diff.removedLines) {
    const anchorLine = Math.min(Math.max(removedLine.line, 1), doc.lines || 1);
    const line = doc.line(anchorLine);
    const insertBefore = removedLine.line <= doc.lines;
    const pos = insertBefore ? line.from : line.to;
    decorations.push(
      Decoration.widget({
        widget: new RemovedLineWidget(removedLine.content, removedLine.oldLineNumber),
        side: insertBefore ? -1 : 1,
        block: true,
      }).range(pos)
    );
  }

  return Decoration.set(decorations, true);
}

function createDiffExtension(diffText: string | null): Extension {
  const highlights = parseDiffHighlights(diffText);
  if (highlights.addedLines.length === 0 && highlights.removedLines.length === 0) {
    return [];
  }

  const field = StateField.define<DecorationSet>({
    create(state) {
      return createDiffDecorations(state.doc, highlights);
    },
    update(decorations, transaction) {
      return decorations.map(transaction.changes);
    },
    provide: (field) => EditorView.decorations.from(field),
  });

  return [field];
}

function getLanguageExtension(language: string): Extension {
  switch (language) {
    case "typescript":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "javascript":
      return javascript({ typescript: false });
    case "jsx":
      return javascript({ typescript: false, jsx: true });
    case "html":
      return html();
    case "css":
    case "scss":
    case "sass":
    case "less":
      return css();
    case "json":
      return json();
    case "markdown":
      return markdown();
    case "python":
      return python();
    case "rust":
      return rust();
    case "go":
      return go();
    case "java":
      return java();
    case "sql":
      return sql();
    case "xml":
      return xml();
    case "yaml":
      return yaml();
    case "c":
    case "cpp":
      return cpp();
    case "php":
      return php();
    default:
      return [];
  }
}

function createEditorTheme(isDark: boolean, useNeutralForeground: boolean): Extension {
  const palette = getMinThemePalette(isDark);
  const baseForeground = useNeutralForeground ? "var(--color-foreground)" : palette.foreground;

  return [
    EditorView.theme(
      {
        "&": {
          backgroundColor: "var(--color-code-bg)",
          color: baseForeground,
          height: "100%",
          fontFamily: "var(--font-monospace)",
          "--mux-editor-gutter-width": "3.5rem",
        },
        ".cm-scroller": {
          fontFamily: "var(--font-monospace)",
          fontSize: "11px",
          lineHeight: "1.6",
        },
        ".cm-content": {
          padding: "6px 0",
          caretColor: baseForeground,
        },
        ".cm-line": {
          padding: "0 8px",
        },
        ".cm-gutters": {
          backgroundColor: "var(--color-line-number-bg)",
          color: "var(--color-line-number-text)",
          borderRight: "1px solid var(--color-line-number-border)",
        },
        ".cm-lineNumbers .cm-gutterElement": {
          padding: "0 8px 0 6px",
        },
        ".cm-activeLine": {
          backgroundColor: "color-mix(in srgb, var(--color-foreground) 6%, transparent)",
        },
        ".cm-activeLineGutter": {
          backgroundColor: "color-mix(in srgb, var(--color-foreground) 6%, transparent)",
        },
        ".cm-selectionBackground": {
          backgroundColor: "color-mix(in srgb, var(--color-accent) 35%, transparent)",
        },
        "&.cm-focused .cm-selectionBackground": {
          backgroundColor: "color-mix(in srgb, var(--color-accent) 45%, transparent)",
        },
        ".cm-cursor": {
          borderLeftColor: baseForeground,
        },
        ".cm-diff-added-line": {
          backgroundColor: "color-mix(in srgb, var(--color-success) 20%, transparent)",
        },
        ".cm-diff-removed-line": {
          display: "grid",
          gridTemplateColumns: "var(--mux-editor-gutter-width) 16px 1fr",
          alignItems: "center",
          padding: "0 8px 0 0",
          fontFamily: "var(--font-monospace)",
          fontSize: "11px",
          lineHeight: "1.6",
          backgroundColor: "color-mix(in srgb, var(--color-danger) 18%, transparent)",
        },
        ".cm-diff-removed-gutter": {
          padding: "0 8px 0 6px",
          textAlign: "right",
          color: "var(--color-line-number-text)",
          borderRight: "1px solid var(--color-line-number-border)",
        },
        ".cm-diff-removed-marker": {
          textAlign: "center",
          color: "var(--color-danger)",
          fontWeight: "600",
        },
        ".cm-diff-removed-content": {
          paddingLeft: "8px",
          whiteSpace: "pre-wrap",
        },
      },
      { dark: isDark }
    ),
    syntaxHighlighting(getMinHighlightStyle(isDark), { fallback: true }),
  ];
}

export const TextFileEditor: React.FC<TextFileEditorProps> = (props) => {
  const { theme: themeMode } = useTheme();
  const { copied, copyToClipboard } = useCopyToClipboard();
  const normalizedBaseContent = normalizeLineEndings(props.content);
  const draftContent = props.draftContent;
  const normalizedInitialContent =
    draftContent !== null && draftContent !== undefined
      ? normalizeLineEndings(draftContent)
      : normalizedBaseContent;
  const language = getLanguageFromPath(props.filePath);
  const languageDisplayName = getLanguageDisplayName(language);
  const isMarkdown = language === "markdown";
  const isDark = themeMode !== "light" && !themeMode.endsWith("-light");

  const editorRootRef = React.useRef<HTMLDivElement | null>(null);
  const viewRef = React.useRef<EditorView | null>(null);
  const baseDocRef = React.useRef<Text>(Text.of(normalizedBaseContent.split("\n")));
  const contentRef = React.useRef(normalizedInitialContent);
  const dirtyRef = React.useRef(false);
  const historyStateRef = React.useRef({ canUndo: false, canRedo: false });

  const [canUndo, setCanUndo] = React.useState(false);
  const [canRedo, setCanRedo] = React.useState(false);
  const lineCountRef = React.useRef(getDocLineCount(Text.of(normalizedInitialContent.split("\n"))));

  const [lineCount, setLineCount] = React.useState(lineCountRef.current);
  const [isDirty, setIsDirty] = React.useState(false);

  const themeCompartmentRef = React.useRef(new Compartment());
  const languageCompartmentRef = React.useRef(new Compartment());
  const diffCompartmentRef = React.useRef(new Compartment());

  const themeExtensionRef = React.useRef<Extension>(createEditorTheme(isDark, isMarkdown));
  const languageExtensionRef = React.useRef<Extension>(getLanguageExtension(language));
  const diffExtensionRef = React.useRef<Extension>(createDiffExtension(props.diff));

  const callbacksRef = React.useRef({
    onDirtyChange: props.onDirtyChange,
    onHistoryChange: props.onHistoryChange,
    onContentChange: props.onContentChange,
    onSave: props.onSave,
  });

  React.useEffect(() => {
    callbacksRef.current = {
      onDirtyChange: props.onDirtyChange,
      onHistoryChange: props.onHistoryChange,
      onContentChange: props.onContentChange,
      onSave: props.onSave,
    };
  }, [props.onContentChange, props.onDirtyChange, props.onHistoryChange, props.onSave]);

  const diffHighlights = parseDiffHighlights(props.diff);
  const addedCount = diffHighlights.addedLines.length;
  const removedCount = diffHighlights.removedLines.length;

  const syncGutterWidth = () => {
    const view = viewRef.current;
    if (!view) return;
    const gutters = view.dom.querySelector(".cm-gutters");
    if (!(gutters instanceof HTMLElement)) return;
    const width = gutters.getBoundingClientRect().width;
    view.dom.style.setProperty("--mux-editor-gutter-width", `${width}px`);
  };

  const updateDirtyState = (nextDirty: boolean) => {
    if (dirtyRef.current === nextDirty) return;
    dirtyRef.current = nextDirty;
    setIsDirty(nextDirty);
    callbacksRef.current.onDirtyChange?.(nextDirty);
  };

  const updateHistoryState = (state: EditorState) => {
    const nextCanUndo = undoDepth(state) > 0;
    const nextCanRedo = redoDepth(state) > 0;
    if (historyStateRef.current.canUndo !== nextCanUndo) {
      historyStateRef.current.canUndo = nextCanUndo;
      setCanUndo(nextCanUndo);
    }
    if (historyStateRef.current.canRedo !== nextCanRedo) {
      historyStateRef.current.canRedo = nextCanRedo;
      setCanRedo(nextCanRedo);
    }
  };

  const handleUndo = () => {
    const view = viewRef.current;
    if (!view) return;
    if (undo(view)) {
      view.focus();
    }
  };

  const handleRedo = () => {
    const view = viewRef.current;
    if (!view) return;
    if (redo(view)) {
      view.focus();
    }
  };

  const updateLineCount = (doc: Text) => {
    const nextCount = getDocLineCount(doc);
    if (lineCountRef.current === nextCount) return;
    lineCountRef.current = nextCount;
    setLineCount(nextCount);
    requestAnimationFrame(syncGutterWidth);
  };

  const requestSave = () => {
    const onSave = callbacksRef.current.onSave;
    if (!onSave) return true;
    if (!dirtyRef.current) return true;
    const content = contentRef.current;
    const result = onSave(content);
    if (result && typeof result.catch === "function") {
      result.catch(() => undefined);
    }
    return true;
  };

  const createEditorState = (doc: string, historyState?: FileDraftHistory | null): EditorState => {
    const updateListener = EditorView.updateListener.of((update) => {
      updateHistoryState(update.state);
      if (!update.docChanged) return;
      const nextDoc = update.state.doc;
      contentRef.current = nextDoc.toString();
      updateLineCount(nextDoc);
      updateDirtyState(!nextDoc.eq(baseDocRef.current));
      callbacksRef.current.onContentChange?.(contentRef.current);
      callbacksRef.current.onHistoryChange?.(
        update.state.toJSON({ history: historyField }) as FileDraftHistory
      );
    });

    const saveKeymap = Prec.highest(
      keymap.of([
        {
          key: "Mod-s",
          run: () => requestSave(),
        },
      ])
    );

    const extensions = [
      baseExtensions,
      EditorView.lineWrapping,
      saveKeymap,
      updateListener,
      themeCompartmentRef.current.of(themeExtensionRef.current),
      languageCompartmentRef.current.of(languageExtensionRef.current),
      diffCompartmentRef.current.of(diffExtensionRef.current),
    ];

    if (historyState && typeof historyState === "object") {
      try {
        const historyDoc = historyState.doc;
        if (typeof historyDoc === "string" && normalizeLineEndings(historyDoc) === doc) {
          return EditorState.fromJSON(historyState, { extensions }, { history: historyField });
        }
      } catch {
        // Fall back to fresh state if history cannot be restored.
      }
    }

    return EditorState.create({
      doc,
      extensions,
    });
  };

  React.useEffect(() => {
    if (!editorRootRef.current) return;
    if (viewRef.current) return;

    const state = createEditorState(normalizedInitialContent, props.draftHistory);
    const view = new EditorView({ state, parent: editorRootRef.current });
    viewRef.current = view;
    updateLineCount(state.doc);
    updateDirtyState(!state.doc.eq(baseDocRef.current));
    updateHistoryState(state);
    requestAnimationFrame(syncGutterWidth);

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initialize editor once.
  }, []);

  React.useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    const normalizedBase = normalizeLineEndings(props.content);
    const draftContentValue = props.draftContent;
    const normalizedDraft =
      draftContentValue !== null && draftContentValue !== undefined
        ? normalizeLineEndings(draftContentValue)
        : null;
    const normalizedContent = normalizedDraft ?? normalizedBase;
    baseDocRef.current = Text.of(normalizedBase.split("\n"));
    contentRef.current = normalizedContent;

    const nextState = createEditorState(normalizedContent, props.draftHistory);
    view.setState(nextState);
    updateLineCount(nextState.doc);
    updateDirtyState(!nextState.doc.eq(baseDocRef.current));
    updateHistoryState(nextState);
    requestAnimationFrame(syncGutterWidth);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- avoid reinitializing on draft/history persistence.
  }, [props.contentVersion, props.content]);

  React.useEffect(() => {
    themeExtensionRef.current = createEditorTheme(isDark, isMarkdown);
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: themeCompartmentRef.current.reconfigure(themeExtensionRef.current),
    });
    requestAnimationFrame(syncGutterWidth);
  }, [isDark, isMarkdown]);

  React.useEffect(() => {
    languageExtensionRef.current = getLanguageExtension(language);
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: languageCompartmentRef.current.reconfigure(languageExtensionRef.current),
    });
  }, [language]);

  React.useEffect(() => {
    diffExtensionRef.current = createDiffExtension(props.diff);
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: diffCompartmentRef.current.reconfigure(diffExtensionRef.current),
    });
  }, [props.diff]);

  const undoKeybindLabel = formatKeybind(KEYBINDS.UNDO);
  const redoKeybindLabel = formatKeybind(KEYBINDS.REDO);
  const saveKeybindLabel = formatKeybind(KEYBINDS.SAVE_FILE);

  return (
    <div data-testid="text-file-viewer" className="bg-background flex h-full flex-col">
      <div className="group border-border-light text-muted-foreground flex items-center gap-2 border-b px-2 py-1 text-xs">
        <span className="min-w-0 flex-1 truncate font-mono" title={props.filePath}>
          {props.filePath}
        </span>
        <button
          type="button"
          className="text-muted hover:text-foreground opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
          onClick={() => void copyToClipboard(props.filePath)}
          aria-label="Copy file path"
          title={copied ? "Copied" : "Copy file path"}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>
      {props.externalChange && (
        <div className="border-border-light text-muted-foreground flex items-center gap-2 border-b px-2 py-1 text-xs">
          <span>File changed on disk.</span>
          <button
            type="button"
            className="text-foreground hover:bg-accent/50 rounded px-1.5 py-0.5"
            onClick={props.onReloadExternal}
          >
            Reload
          </button>
          <button
            type="button"
            className="text-muted hover:bg-accent/50 rounded px-1.5 py-0.5"
            onClick={props.onDismissExternal}
          >
            Keep editing
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        <div ref={editorRootRef} className="h-full" />
      </div>

      {props.saveError && (
        <div className="border-border-light text-destructive border-t px-2 py-1 text-xs">
          {props.saveError}
        </div>
      )}

      {/* Status line */}
      <div className="border-border-light text-muted-foreground flex shrink-0 items-center gap-3 border-t px-2 py-1 text-xs">
        <span>{formatSize(props.size)}</span>
        <span>{lineCount.toLocaleString()} lines</span>
        {(addedCount > 0 || removedCount > 0) && (
          <span>
            <span className="text-green-600 dark:text-green-500">+{addedCount}</span>
            <span className="text-muted-foreground">/</span>
            <span className="text-red-600 dark:text-red-500">-{removedCount}</span>
          </span>
        )}
        {isDirty && <span className="text-warning">Unsaved</span>}
        <span className="ml-auto">{languageDisplayName}</span>
        <button
          type="button"
          className="text-muted hover:bg-accent/50 hover:text-foreground rounded p-0.5 disabled:opacity-50"
          onClick={handleUndo}
          title={`Undo (${undoKeybindLabel})`}
          disabled={!canUndo}
        >
          <Undo2 className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className="text-muted hover:bg-accent/50 hover:text-foreground rounded p-0.5 disabled:opacity-50"
          onClick={handleRedo}
          title={`Redo (${redoKeybindLabel})`}
          disabled={!canRedo}
        >
          <Redo2 className="h-3.5 w-3.5" />
        </button>
        {props.onSave && (
          <button
            type="button"
            className="text-muted hover:bg-accent/50 hover:text-foreground rounded p-0.5 disabled:opacity-50"
            onClick={requestSave}
            title={`Save file (${saveKeybindLabel})`}
            disabled={props.isSaving === true || !isDirty}
          >
            <Save className="h-3.5 w-3.5" />
          </button>
        )}
        {props.onRefresh && (
          <button
            type="button"
            className="text-muted hover:bg-accent/50 hover:text-foreground rounded p-0.5"
            onClick={props.onRefresh}
            title="Refresh file"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
};
