/**
 * TextFileEditor - Editable CodeMirror-backed viewer for text files.
 * Includes inline git diff indicators and save support.
 */

import React from "react";
import { parsePatch } from "diff";
import { Save, RefreshCw } from "lucide-react";
import { basicSetup } from "@codemirror/basic-setup";
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
import { php } from "@codemirror/lang-php";
import type { Extension, Range } from "@codemirror/state";
import { Compartment, EditorState, Prec, StateField, Text } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { useTheme } from "@/browser/contexts/ThemeContext";
import { KEYBINDS, formatKeybind } from "@/browser/utils/ui/keybinds";
import { getLanguageFromPath, getLanguageDisplayName } from "@/common/utils/git/languageDetector";

interface TextFileEditorProps {
  content: string;
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

// Format file size for display
const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

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

function createEditorTheme(isDark: boolean): Extension {
  return EditorView.theme(
    {
      "&": {
        backgroundColor: "var(--color-code-bg)",
        color: "var(--color-foreground)",
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
        caretColor: "var(--color-foreground)",
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
        borderLeftColor: "var(--color-foreground)",
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
  );
}

export const TextFileEditor: React.FC<TextFileEditorProps> = (props) => {
  const { theme: themeMode } = useTheme();
  const language = getLanguageFromPath(props.filePath);
  const languageDisplayName = getLanguageDisplayName(language);
  const isDark = themeMode !== "light" && !themeMode.endsWith("-light");

  const editorRootRef = React.useRef<HTMLDivElement | null>(null);
  const viewRef = React.useRef<EditorView | null>(null);
  const baseDocRef = React.useRef<Text>(Text.of(props.content.split("\n")));
  const contentRef = React.useRef(props.content);
  const dirtyRef = React.useRef(false);
  const lineCountRef = React.useRef(getDocLineCount(baseDocRef.current));

  const [lineCount, setLineCount] = React.useState(lineCountRef.current);
  const [isDirty, setIsDirty] = React.useState(false);

  const themeCompartmentRef = React.useRef(new Compartment());
  const languageCompartmentRef = React.useRef(new Compartment());
  const diffCompartmentRef = React.useRef(new Compartment());

  const themeExtensionRef = React.useRef<Extension>(createEditorTheme(isDark));
  const languageExtensionRef = React.useRef<Extension>(getLanguageExtension(language));
  const diffExtensionRef = React.useRef<Extension>(createDiffExtension(props.diff));

  const callbacksRef = React.useRef({
    onDirtyChange: props.onDirtyChange,
    onSave: props.onSave,
  });

  React.useEffect(() => {
    callbacksRef.current = {
      onDirtyChange: props.onDirtyChange,
      onSave: props.onSave,
    };
  }, [props.onDirtyChange, props.onSave]);

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

  const createEditorState = (doc: string): EditorState => {
    const updateListener = EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      const nextDoc = update.state.doc;
      contentRef.current = nextDoc.toString();
      updateLineCount(nextDoc);
      updateDirtyState(!nextDoc.eq(baseDocRef.current));
    });

    const saveKeymap = Prec.highest(
      keymap.of([
        {
          key: "Mod-s",
          run: () => requestSave(),
        },
      ])
    );

    return EditorState.create({
      doc,
      extensions: [
        basicSetup,
        EditorView.lineWrapping,
        saveKeymap,
        updateListener,
        themeCompartmentRef.current.of(themeExtensionRef.current),
        languageCompartmentRef.current.of(languageExtensionRef.current),
        diffCompartmentRef.current.of(diffExtensionRef.current),
      ],
    });
  };

  React.useEffect(() => {
    if (!editorRootRef.current) return;
    if (viewRef.current) return;

    const state = createEditorState(props.content);
    const view = new EditorView({ state, parent: editorRootRef.current });
    viewRef.current = view;
    updateLineCount(state.doc);
    updateDirtyState(false);
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

    baseDocRef.current = Text.of(props.content.split("\n"));
    contentRef.current = props.content;

    const nextState = createEditorState(props.content);
    view.setState(nextState);
    updateLineCount(nextState.doc);
    updateDirtyState(false);
    requestAnimationFrame(syncGutterWidth);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rebase only on content changes.
  }, [props.contentVersion, props.content]);

  React.useEffect(() => {
    themeExtensionRef.current = createEditorTheme(isDark);
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: themeCompartmentRef.current.reconfigure(themeExtensionRef.current),
    });
    requestAnimationFrame(syncGutterWidth);
  }, [isDark]);

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

  const saveKeybindLabel = formatKeybind(KEYBINDS.SAVE_FILE);

  return (
    <div data-testid="text-file-viewer" className="bg-background flex h-full flex-col">
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
