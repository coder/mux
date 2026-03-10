/**
 * Pre-resolved scope for mux-managed resource tools (skills, AGENTS.md, config).
 *
 * Global: tools operate under ~/.mux/ (system workspace, Chat with Mux).
 * Project: tools operate under the project root (any project workspace).
 *
 * `projectRoot` is a **host-local** filesystem root used by mux tools that call
 * Node `fs/promises`. For remote/container runtime-backed workspaces (ssh, docker),
 * this intentionally differs from the runtime execution cwd (workspacePath).
 */
export type ProjectStorageAuthority = "host-local" | "runtime";

export type MuxToolScope =
  | { readonly type: "global"; readonly muxHome: string }
  | {
      readonly type: "project";
      readonly muxHome: string;
      readonly projectRoot: string;
      readonly projectStorageAuthority: ProjectStorageAuthority;
    };
