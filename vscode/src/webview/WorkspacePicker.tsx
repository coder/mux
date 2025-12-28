import React, { useEffect, useRef, useState } from "react";

import { Check, ChevronDown } from "lucide-react";

import { cn } from "mux/common/lib/utils";
import { LocalIcon, SSHIcon, WorktreeIcon } from "mux/browser/components/icons/RuntimeIcons";
import { Shimmer } from "mux/browser/components/ai-elements/shimmer";
import { Button } from "mux/browser/components/ui/button";
import { Input } from "mux/browser/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "mux/browser/components/ui/popover";

import type { UiWorkspace } from "./protocol";

const RUNTIME_BADGE_STYLES: Record<
  UiWorkspace["runtimeType"],
  {
    idle: string;
    working: string;
  }
> = {
  ssh: {
    idle: "bg-transparent text-muted border-[var(--color-runtime-ssh)]/50",
    working:
      "bg-[var(--color-runtime-ssh)]/20 text-[var(--color-runtime-ssh-text)] border-[var(--color-runtime-ssh)]/60 animate-pulse",
  },
  worktree: {
    idle: "bg-transparent text-muted border-[var(--color-runtime-worktree)]/50",
    working:
      "bg-[var(--color-runtime-worktree)]/20 text-[var(--color-runtime-worktree-text)] border-[var(--color-runtime-worktree)]/60 animate-pulse",
  },
  local: {
    idle: "bg-transparent text-muted border-[var(--color-runtime-local)]/50",
    working:
      "bg-[var(--color-runtime-local)]/30 text-[var(--color-runtime-local)] border-[var(--color-runtime-local)]/60 animate-pulse",
  },
} as const;

const RUNTIME_ICON: Record<
  UiWorkspace["runtimeType"],
  React.ComponentType<{ size?: number; className?: string }>
> = {
  local: LocalIcon,
  ssh: SSHIcon,
  worktree: WorktreeIcon,
} as const;

function formatWorkspaceTriggerLabel(workspace: UiWorkspace): string {
  if (workspace.runtimeType === "ssh" && workspace.sshHost) {
    return `[${workspace.projectName}] ${workspace.workspaceName} (ssh: ${workspace.sshHost})`;
  }

  return `[${workspace.projectName}] ${workspace.workspaceName}`;
}

function workspaceMatchesQuery(workspace: UiWorkspace, query: string): boolean {
  const q = query.toLowerCase();

  return (
    workspace.projectName.toLowerCase().includes(q) ||
    workspace.workspaceName.toLowerCase().includes(q) ||
    workspace.projectPath.toLowerCase().includes(q) ||
    workspace.runtimeType.toLowerCase().includes(q) ||
    (workspace.sshHost?.toLowerCase().includes(q) ?? false)
  );
}

export function WorkspacePicker(props: {
  workspaces: UiWorkspace[];
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (workspaceId: string | null) => void;
  onRequestRefresh?: (() => void) | undefined;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    // Ensure the popover content has mounted before focusing.
    const timeoutId = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 0);

    return () => {
      clearTimeout(timeoutId);
    };
  }, [open]);

  const selectedWorkspace = props.selectedWorkspaceId
    ? props.workspaces.find((workspace) => workspace.id === props.selectedWorkspaceId) ?? null
    : null;

  const normalizedQuery = query.trim().toLowerCase();
  const filteredWorkspaces = normalizedQuery
    ? props.workspaces.filter((workspace) => workspaceMatchesQuery(workspace, normalizedQuery))
    : props.workspaces;

  const triggerLabel = selectedWorkspace
    ? formatWorkspaceTriggerLabel(selectedWorkspace)
    : props.workspaces.length > 0
      ? "Select workspace…"
      : "No workspaces found";

  const isTriggerDisabled = props.workspaces.length === 0;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          props.onRequestRefresh?.();
        }

        setOpen(next);
        if (!next) {
          setQuery("");
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={isTriggerDisabled}
          className="min-w-0 flex-1 justify-between"
        >
          <span className="min-w-0 flex-1 truncate text-left">{triggerLabel}</span>
          <ChevronDown className="shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>

      <PopoverContent align="start" className="p-2">
        <Input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search workspaces…"
          className="h-8"
        />

        <div className="mt-2 max-h-72 overflow-y-auto">
          {filteredWorkspaces.length === 0 ? (
            <div className="text-muted px-2 py-6 text-center text-sm">No matching workspaces.</div>
          ) : (
            filteredWorkspaces.map((workspace) => {
              const isSelected = workspace.id === props.selectedWorkspaceId;
              const runtimeBadgeClassName = workspace.streaming
                ? RUNTIME_BADGE_STYLES[workspace.runtimeType].working
                : RUNTIME_BADGE_STYLES[workspace.runtimeType].idle;
              const RuntimeIcon = RUNTIME_ICON[workspace.runtimeType];

              return (
                <button
                  key={workspace.id}
                  type="button"
                  className={cn(
                    "hover:bg-hover flex w-full items-start gap-2 rounded-md px-2 py-2 text-left",
                    isSelected && "bg-hover"
                  )}
                  onClick={() => {
                    props.onSelectWorkspace(workspace.id);
                    setOpen(false);
                  }}
                >
                  <span
                    className={cn(
                      "mt-0.5 inline-flex shrink-0 items-center rounded border px-1 py-0.5 transition-colors",
                      runtimeBadgeClassName
                    )}
                  >
                    <RuntimeIcon />
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="min-w-0 truncate text-sm">
                      {workspace.streaming ? (
                        <Shimmer className="w-full truncate" colorClass="var(--color-foreground)">
                          {workspace.workspaceName}
                        </Shimmer>
                      ) : (
                        workspace.workspaceName
                      )}
                    </div>
                    <div className="text-muted truncate text-xs">
                      {workspace.projectName}
                      {workspace.runtimeType === "ssh" && workspace.sshHost
                        ? ` · ssh:${workspace.sshHost}`
                        : null}
                    </div>
                  </div>

                  {isSelected ? (
                    <Check className="size-4 shrink-0 self-center" />
                  ) : (
                    <span className="size-4 shrink-0 self-center" />
                  )}
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
