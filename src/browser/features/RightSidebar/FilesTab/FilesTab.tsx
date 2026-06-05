import React, { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, File, Folder, FolderOpen } from "lucide-react";
import { useAPI } from "@/browser/contexts/API";
import { MarkdownRenderer } from "@/browser/features/Messages/MarkdownRenderer";
import { HighlightedCode } from "@/browser/features/Tools/Shared/HighlightedCode";
import { cn } from "@/common/lib/utils";

interface FilesTabProps {
  projectPath: string;
}

interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

// Maps common file extensions to Shiki language identifiers.
const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  c: "c",
  h: "c",
  hpp: "cpp",
  java: "java",
  cs: "csharp",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  xml: "xml",
  svg: "xml",
  json: "json",
  jsonc: "jsonc",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  vue: "vue",
  svelte: "svelte",
  lua: "lua",
  r: "r",
  pl: "perl",
  dockerfile: "dockerfile",
  mk: "makefile",
};

function getExtension(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower === "dockerfile" || lower === "makefile" || lower === "gemfile") return lower;
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

function isMarkdownFile(filename: string): boolean {
  const ext = getExtension(filename);
  return ext === "md" || ext === "mdx";
}

function getLanguage(filename: string): string {
  const ext = getExtension(filename);
  return EXTENSION_TO_LANGUAGE[ext] ?? "text";
}

// Cross-platform path utilities — handle both `/` (POSIX) and `\` (Windows).
function pathBasename(p: string): string {
  const lastSlash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return lastSlash >= 0 ? p.slice(lastSlash + 1) : p;
}

function pathDirname(p: string): string {
  const lastSlash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return lastSlash > 0 ? p.slice(0, lastSlash) : "";
}

interface BreadcrumbProps {
  projectPath: string;
  currentDir: string;
  onNavigate: (dir: string) => void;
}

const Breadcrumb: React.FC<BreadcrumbProps> = ({ projectPath, currentDir, onNavigate }) => {
  const rootName = pathBasename(projectPath) || projectPath;

  if (currentDir === projectPath) {
    return (
      <div className="text-muted flex items-center gap-0.5 truncate text-[11px]">
        <span className="text-foreground font-medium">{rootName}</span>
      </div>
    );
  }

  // Walk upward from currentDir to projectPath, collecting each ancestor.
  // This avoids string-splitting on the separator (fragile cross-platform).
  const ancestors: { name: string; path: string }[] = [];
  let cursor = currentDir;
  while (cursor !== projectPath) {
    ancestors.unshift({ name: pathBasename(cursor), path: cursor });
    const parent = pathDirname(cursor);
    if (!parent || parent === cursor) break;
    cursor = parent;
  }

  return (
    <div className="text-muted flex items-center gap-0.5 overflow-hidden text-[11px]">
      <button
        type="button"
        className="hover:text-foreground shrink-0 truncate transition-colors"
        onClick={() => onNavigate(projectPath)}
      >
        {rootName}
      </button>
      {ancestors.map(({ name, path }, i) => {
        const isLast = i === ancestors.length - 1;
        return (
          <React.Fragment key={path}>
            <ChevronRight className="h-2.5 w-2.5 shrink-0 opacity-40" />
            {isLast ? (
              <span className="text-foreground truncate font-medium">{name}</span>
            ) : (
              <button
                type="button"
                className="hover:text-foreground shrink-0 truncate transition-colors"
                onClick={() => onNavigate(path)}
              >
                {name}
              </button>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
};

interface FileTreeProps {
  entries: FileEntry[];
  selectedPath: string | null;
  onSelectDir: (entry: FileEntry) => void;
  onSelectFile: (entry: FileEntry) => void;
}

const FileTree: React.FC<FileTreeProps> = ({ entries, selectedPath, onSelectDir, onSelectFile }) => {
  // Directories first, then files, both alphabetically.
  const sorted = [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  if (sorted.length === 0) {
    return <p className="text-muted px-3 py-2 text-[11px]">Empty directory</p>;
  }

  return (
    <ul className="m-0 list-none p-0">
      {sorted.map((entry) => {
        const isSelected = entry.path === selectedPath;
        return (
          <li key={entry.path}>
            <button
              type="button"
              className={cn(
                "flex w-full items-center gap-1.5 px-2 py-1 text-left text-[12px] transition-colors",
                isSelected
                  ? "bg-white/10 text-foreground"
                  : "text-muted hover:bg-white/5 hover:text-foreground"
              )}
              onClick={() => (entry.isDirectory ? onSelectDir(entry) : onSelectFile(entry))}
              title={entry.name}
            >
              {entry.isDirectory ? (
                <Folder className="h-3.5 w-3.5 shrink-0 text-yellow-500/80" />
              ) : (
                <File className="h-3.5 w-3.5 shrink-0 opacity-60" />
              )}
              <span className="truncate">{entry.name}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
};

interface FileViewerProps {
  filename: string;
  content: string;
  truncated: boolean;
}

const FileViewer: React.FC<FileViewerProps> = ({ filename, content, truncated }) => {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="text-muted border-border-medium flex shrink-0 items-center border-b px-3 py-1.5 text-[11px]">
        <span className="truncate font-mono">{filename}</span>
        {truncated && (
          <span className="text-warning ml-auto shrink-0 pl-2">(truncated at 512 KB)</span>
        )}
      </div>
      {isMarkdownFile(filename) ? (
        <div className="flex-1 overflow-y-auto p-4">
          <MarkdownRenderer content={content} />
        </div>
      ) : (
        <div className="flex-1 overflow-auto p-2">
          <HighlightedCode
            code={content}
            language={getLanguage(filename)}
            showLineNumbers
            className="text-[11px]"
          />
        </div>
      )}
    </div>
  );
};

export const FilesTab: React.FC<FilesTabProps> = ({ projectPath }) => {
  const { api } = useAPI();
  const [currentDir, setCurrentDir] = useState<string>(projectPath);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loadingDir, setLoadingDir] = useState(false);
  const [dirError, setDirError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<FileEntry | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileTruncated, setFileTruncated] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  // Incremented on every loadFile call; checked after await to discard stale results.
  const fileLoadIdRef = useRef(0);

  const loadDir = useCallback(
    async (dirPath: string, signal: AbortSignal) => {
      if (!api) return;
      setLoadingDir(true);
      setDirError(null);
      try {
        const result = await api.general.listProjectFiles(
          { rootPath: projectPath, dirPath },
          { signal }
        );
        if (signal.aborted) return;
        if (result.success) {
          setEntries(result.data);
        } else {
          setDirError(result.error);
        }
      } catch (err) {
        if (signal.aborted) return;
        setDirError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!signal.aborted) setLoadingDir(false);
      }
    },
    [api, projectPath]
  );

  const loadFile = useCallback(
    async (entry: FileEntry) => {
      if (!api) return;
      const loadId = ++fileLoadIdRef.current;
      setSelectedFile(entry);
      setFileContent(null);
      setFileError(null);
      setLoadingFile(true);
      try {
        const result = await api.general.readProjectFile({
          rootPath: projectPath,
          filePath: entry.path,
        });
        if (fileLoadIdRef.current !== loadId) return;
        if (result.success) {
          setFileContent(result.data.content);
          setFileTruncated(result.data.truncated);
        } else {
          setFileError(result.error);
        }
      } catch (err) {
        if (fileLoadIdRef.current !== loadId) return;
        setFileError(err instanceof Error ? err.message : String(err));
      } finally {
        if (fileLoadIdRef.current === loadId) setLoadingFile(false);
      }
    },
    [api, projectPath]
  );

  const navigateDir = useCallback((entry: FileEntry) => {
    setSelectedFile(null);
    setFileContent(null);
    setFileError(null);
    setCurrentDir(entry.path);
  }, []);

  const navigateTo = useCallback((dirPath: string) => {
    setSelectedFile(null);
    setFileContent(null);
    setFileError(null);
    setCurrentDir(dirPath);
  }, []);

  const navigateUp = useCallback(() => {
    const parent = pathDirname(currentDir);
    if (!parent || parent.length < projectPath.length) return;
    navigateTo(parent);
  }, [currentDir, projectPath, navigateTo]);

  // Reload directory listing whenever currentDir changes; cancel stale requests.
  useEffect(() => {
    const controller = new AbortController();
    void loadDir(currentDir, controller.signal);
    return () => controller.abort();
  }, [currentDir, loadDir]);

  const atRoot = currentDir === projectPath;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Top bar: breadcrumb + up button */}
      <div className="border-border-medium flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
        {!atRoot && (
          <button
            type="button"
            className="text-muted hover:text-foreground shrink-0 rounded p-0.5 transition-colors"
            onClick={navigateUp}
            title="Go up"
            aria-label="Navigate to parent directory"
          >
            <FolderOpen className="h-3.5 w-3.5" />
          </button>
        )}
        <Breadcrumb projectPath={projectPath} currentDir={currentDir} onNavigate={navigateTo} />
      </div>

      {/* Main area: file tree (left) + viewer (right) */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* File tree */}
        <div className="border-border-medium flex w-44 shrink-0 flex-col overflow-hidden border-r">
          <div className="flex-1 overflow-y-auto">
            {loadingDir ? (
              <p className="text-muted px-3 py-2 text-[11px]">Loading…</p>
            ) : dirError ? (
              <p className="text-destructive px-3 py-2 text-[11px]">{dirError}</p>
            ) : (
              <FileTree
                entries={entries}
                selectedPath={selectedFile?.path ?? null}
                onSelectDir={navigateDir}
                onSelectFile={loadFile}
              />
            )}
          </div>
        </div>

        {/* File viewer */}
        <div className="min-w-0 flex-1 overflow-hidden">
          {loadingFile ? (
            <div className="text-muted flex h-full items-center justify-center text-[11px]">
              Loading file…
            </div>
          ) : fileError ? (
            <div className="text-destructive flex h-full items-center justify-center px-4 text-center text-[11px]">
              {fileError}
            </div>
          ) : fileContent !== null && selectedFile !== null ? (
            <FileViewer
              filename={selectedFile.name}
              content={fileContent}
              truncated={fileTruncated}
            />
          ) : (
            <div className="text-muted flex h-full items-center justify-center text-[11px]">
              Select a file to view
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
