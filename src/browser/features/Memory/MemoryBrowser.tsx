import { useEffect, useState } from "react";
import {
  Brain,
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  Pin,
  Trash2,
} from "lucide-react";

import { ConfirmationModal } from "@/browser/components/ConfirmationModal/ConfirmationModal";
import { useAPI } from "@/browser/contexts/API";
import { RowActionButton } from "@/browser/features/RightSidebar/GoalBoardSections";
import { isAbortError } from "@/browser/utils/isAbortError";
import { formatRelativeTime } from "@/browser/utils/ui/dateTime";
import { cn } from "@/common/lib/utils";
import { MEMORY_SCOPES, MEMORY_VIRTUAL_ROOT, type MemoryScope } from "@/common/constants/memory";
import type { MemoryFileInfo } from "@/common/orpc/schemas/memory";
import { getErrorMessage } from "@/common/utils/errors";
import { MemoryFileEditor } from "./MemoryFileEditor";

const SCOPE_LABELS: Record<MemoryScope, string> = {
  global: "Global",
  project: "Project",
  workspace: "Workspace",
};

/** File name shown in the list: path relative to its scope root. */
function scopeRelativeName(file: MemoryFileInfo): string {
  return file.path.slice(`${MEMORY_VIRTUAL_ROOT}/${file.scope}/`.length);
}

interface MemoryBrowserProps {
  /**
   * null = no workspace is associated with this surface (Settings → Memory);
   * the backend then only serves the global scope.
   */
  workspaceId: string | null;
  /** Scopes to display; defaults to all three. */
  scopes?: readonly MemoryScope[];
}

/**
 * Shared memory curation surface (experiment: "memory"): scope-grouped file
 * list + whole-file editor. Consumed by the right-sidebar Memory tab (all
 * scopes) and Settings → Memory (global scope only, no workspace).
 *
 * SECURITY: memory file contents and descriptions are attacker-influenceable
 * (project memories are repo-controlled), so everything renders as plain React
 * text — never through innerHTML-family sinks.
 */
export function MemoryBrowser(props: MemoryBrowserProps) {
  const { api } = useAPI();
  const scopes = props.scopes ?? MEMORY_SCOPES;
  const [files, setFiles] = useState<MemoryFileInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MemoryFileInfo | null>(null);
  // Virtual paths the agent touched since the user last opened them.
  const [agentEditedPaths, setAgentEditedPaths] = useState<ReadonlySet<string>>(new Set());
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    if (!api) return;
    const controller = new AbortController();
    api.memory
      .list({ workspaceId: props.workspaceId }, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.success) {
          setFiles(result.data.files);
          setError(null);
        } else {
          setError(result.error);
        }
      })
      .catch((err: unknown) => {
        if (isAbortError(err) || controller.signal.aborted) return;
        setError(getErrorMessage(err));
      });
    return () => controller.abort();
  }, [api, props.workspaceId, refreshTick]);

  // Live updates: any memory change (agent tool call or UI edit) in a
  // displayed scope refreshes the list; agent edits additionally badge the
  // touched file. The scope filter keeps Settings → Memory (global only)
  // from reacting to project/workspace traffic. The backend subscription
  // already drops workspace/project-scope events from other workspaces/
  // projects (the same virtual path elsewhere is a different file).
  useEffect(() => {
    if (!api) return;
    const controller = new AbortController();
    (async () => {
      try {
        const iterator = await api.memory.onChange(
          { workspaceId: props.workspaceId },
          { signal: controller.signal }
        );
        for await (const event of iterator) {
          if (controller.signal.aborted) break;
          if (!scopes.includes(event.scope)) continue;
          if (event.actor === "agent") {
            setAgentEditedPaths((prev) => {
              if (prev.has(event.path)) return prev;
              const next = new Set(prev);
              next.add(event.path);
              return next;
            });
          }
          setRefreshTick((n) => n + 1);
        }
      } catch (err) {
        if (!controller.signal.aborted && !isAbortError(err)) {
          console.error("Memory change subscription failed:", err);
        }
      }
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scopes is a stable constant per consumer
  }, [api, props.workspaceId]);

  const openFile = (path: string) => {
    setSelectedPath(path);
    // Opening a file acknowledges its agent-edited badge.
    setAgentEditedPaths((prev) => {
      if (!prev.has(path)) return prev;
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
  };

  const handleTogglePin = async (file: MemoryFileInfo) => {
    if (!api) return;
    try {
      const result = await api.memory.setPinned({
        workspaceId: props.workspaceId,
        path: file.path,
        pinned: !file.pinned,
      });
      if (!result.success) {
        setError(result.error);
        return;
      }
      setRefreshTick((n) => n + 1);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  const handleDelete = async (file: MemoryFileInfo) => {
    if (!api) return;
    try {
      const result = await api.memory.delete({
        workspaceId: props.workspaceId,
        path: file.path,
      });
      if (!result.success) {
        setError(result.error);
        return;
      }
      if (selectedPath === file.path) {
        setSelectedPath(null);
      }
      setRefreshTick((n) => n + 1);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  if (selectedPath !== null) {
    return (
      <MemoryFileEditor
        workspaceId={props.workspaceId}
        path={selectedPath}
        onBack={() => setSelectedPath(null)}
      />
    );
  }

  const visibleScopes = scopes.filter((scope) => files?.some((file) => file.scope === scope));

  return (
    <div className="flex h-full min-h-0 flex-col">
      {error !== null && (
        <div className="text-error px-3 py-2 text-xs" role="alert">
          {error}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {files !== null && files.length === 0 && error === null && (
          <div className="text-muted border-border-light flex flex-col items-center justify-center gap-2 rounded-md border border-dashed p-6 text-center text-sm">
            <Brain className="h-5 w-5" aria-hidden="true" />
            <p>
              No memory files yet. The agent records durable facts and preferences here as it works.
            </p>
          </div>
        )}
        <div className="flex flex-col gap-3">
          {visibleScopes.map((scope) => (
            <ScopeSection
              key={scope}
              title={SCOPE_LABELS[scope]}
              files={(files ?? []).filter((file) => file.scope === scope)}
              agentEditedPaths={agentEditedPaths}
              onOpen={openFile}
              onTogglePin={(file) => void handleTogglePin(file)}
              onRequestDelete={setDeleteTarget}
            />
          ))}
        </div>
      </div>
      {deleteTarget !== null && (
        <ConfirmationModal
          isOpen
          title="Delete memory file?"
          description={`${scopeRelativeName(deleteTarget)} will be deleted. This cannot be undone.`}
          confirmLabel="Delete"
          confirmVariant="destructive"
          onConfirm={async () => {
            await handleDelete(deleteTarget);
            setDeleteTarget(null);
          }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}

interface ScopeSectionProps {
  title: string;
  files: MemoryFileInfo[];
  agentEditedPaths: ReadonlySet<string>;
  onOpen: (path: string) => void;
  onTogglePin: (file: MemoryFileInfo) => void;
  onRequestDelete: (file: MemoryFileInfo) => void;
}

/** Directory node in the per-scope file tree. */
interface TreeDir {
  name: string;
  dirs: TreeDir[];
  files: MemoryFileInfo[];
  /** Recursive file count (includes nested subdirectories). */
  fileCount: number;
}

/**
 * Groups a scope's files into a directory tree keyed on the `/`-separated
 * segments of their scope-relative paths. Dirs sort before files, each
 * alphabetically (standard file-tree convention).
 */
function buildTree(files: MemoryFileInfo[]): TreeDir {
  const root: TreeDir = { name: "", dirs: [], files: [], fileCount: 0 };
  for (const file of files) {
    const segments = scopeRelativeName(file).split("/");
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      let child = node.dirs.find((dir) => dir.name === segment);
      if (!child) {
        child = { name: segment, dirs: [], files: [], fileCount: 0 };
        node.dirs.push(child);
      }
      node = child;
      node.fileCount++;
    }
    node.files.push(file);
  }
  const sortTree = (dir: TreeDir) => {
    dir.dirs.sort((a, b) => a.name.localeCompare(b.name));
    dir.files.sort((a, b) => scopeRelativeName(a).localeCompare(scopeRelativeName(b)));
    dir.dirs.forEach(sortTree);
  };
  sortTree(root);
  return root;
}

/** Collapsible scope section, mirroring the GoalBoardSections shell. */
function ScopeSection(props: ScopeSectionProps) {
  const [isOpen, setIsOpen] = useState(true);
  return (
    <section className="border-border-light bg-surface-secondary rounded-md border">
      <button
        type="button"
        className="hover:bg-surface-tertiary flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-xs tracking-wide uppercase"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((prev) => !prev)}
      >
        {isOpen ? (
          <ChevronDown className="text-muted h-3 w-3" aria-hidden="true" />
        ) : (
          <ChevronRight className="text-muted h-3 w-3" aria-hidden="true" />
        )}
        <span className="text-foreground font-medium">{props.title}</span>
        <span className="text-muted lowercase">({props.files.length})</span>
      </button>
      {isOpen && (
        <div className="border-border-light flex flex-col gap-px border-t p-2">
          <TreeNodes
            dir={buildTree(props.files)}
            agentEditedPaths={props.agentEditedPaths}
            onOpen={props.onOpen}
            onTogglePin={props.onTogglePin}
            onRequestDelete={props.onRequestDelete}
          />
        </div>
      )}
    </section>
  );
}

interface TreeNodesProps {
  dir: TreeDir;
  agentEditedPaths: ReadonlySet<string>;
  onOpen: (path: string) => void;
  onTogglePin: (file: MemoryFileInfo) => void;
  onRequestDelete: (file: MemoryFileInfo) => void;
}

/** A directory's children: subdirectories first, then file leaves. */
function TreeNodes(props: TreeNodesProps) {
  return (
    <>
      {props.dir.dirs.map((dir) => (
        <DirRow key={dir.name} {...props} dir={dir} />
      ))}
      {props.dir.files.map((file) => (
        <MemoryFileRow
          key={file.path}
          file={file}
          agentEdited={props.agentEditedPaths.has(file.path)}
          onOpen={() => props.onOpen(file.path)}
          onTogglePin={() => props.onTogglePin(file)}
          onRequestDelete={() => props.onRequestDelete(file)}
        />
      ))}
    </>
  );
}

/** Collapsible directory row; default expanded, state is per-render only. */
function DirRow(props: TreeNodesProps) {
  const [isOpen, setIsOpen] = useState(true);
  return (
    <div>
      <button
        type="button"
        className="hover:bg-hover flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((prev) => !prev)}
      >
        {isOpen ? (
          <ChevronDown className="text-muted h-3 w-3 shrink-0" aria-hidden="true" />
        ) : (
          <ChevronRight className="text-muted h-3 w-3 shrink-0" aria-hidden="true" />
        )}
        {isOpen ? (
          <FolderOpen className="text-muted h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        ) : (
          <Folder className="text-muted h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        )}
        <span className="min-w-0 truncate">{props.dir.name}</span>
        <span className="text-muted counter-nums text-xs">({props.dir.fileCount})</span>
      </button>
      {isOpen && (
        <div className="border-border-light ml-[13px] flex flex-col gap-px border-l pl-1.5">
          <TreeNodes {...props} />
        </div>
      )}
    </div>
  );
}

interface MemoryFileRowProps {
  file: MemoryFileInfo;
  agentEdited: boolean;
  onOpen: () => void;
  onTogglePin: () => void;
  onRequestDelete: () => void;
}

function MemoryFileRow(props: MemoryFileRowProps) {
  // aria-labels keep the full scope-relative name for uniqueness; the visible
  // label is just the basename since the tree expresses the directory path.
  const name = scopeRelativeName(props.file);
  const base = name.slice(name.lastIndexOf("/") + 1);
  return (
    <div className="group hover:bg-hover rounded-md px-1.5 py-1">
      <div className="flex items-center gap-2">
        <FileText className="text-muted h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm"
          onClick={props.onOpen}
        >
          <span className="truncate">{base}</span>
          {props.agentEdited && (
            <span className="bg-accent/15 text-accent shrink-0 rounded px-1.5 py-px text-[10px] font-medium">
              agent edited
            </span>
          )}
        </button>
        {props.file.pinned && (
          <Pin className="text-accent h-3.5 w-3.5 shrink-0 fill-current" aria-hidden="true" />
        )}
        {/* Reserved-width actions revealed on hover/focus so rows stay quiet
            at rest without layout shift. */}
        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          <RowActionButton
            aria-label={`${props.file.pinned ? "Unpin" : "Pin"} ${name}`}
            onClick={props.onTogglePin}
          >
            <Pin
              className={cn("h-3 w-3", props.file.pinned && "fill-current")}
              aria-hidden="true"
            />
          </RowActionButton>
          <RowActionButton
            tone="destructive"
            aria-label={`Delete ${name}`}
            onClick={props.onRequestDelete}
          >
            <Trash2 className="h-3 w-3" aria-hidden="true" />
          </RowActionButton>
        </div>
      </div>
      {props.file.description !== "" && (
        <div className="text-muted truncate pl-[22px] text-xs">{props.file.description}</div>
      )}
      {props.file.accessCount > 0 && props.file.lastAccessedAt !== null && (
        <div className="text-muted counter-nums pl-[22px] text-[10px]">
          Used {props.file.accessCount}× · {formatRelativeTime(props.file.lastAccessedAt)}
        </div>
      )}
    </div>
  );
}
