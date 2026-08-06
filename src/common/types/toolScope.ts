/**
 * Pre-resolved scope for mux-managed resource tools (skills, AGENTS.md, config).
 *
 * Global: tools operate under ~/.mux/.
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
      /**
       * Host checkout root when it differs from `projectRoot` (workspaces with
       * a `subProjectPath` execute in a subdirectory of the checkout). Agent
       * Plugins containers live at the checkout root, matching the UI-facing
       * discovery paths (agent-plugins experiment).
       */
      readonly checkoutRoot?: string;
    };
