import { MemoryBrowser } from "@/browser/features/Memory/MemoryBrowser";

/**
 * Settings → Memory (experiment: "memory") — manages GLOBAL memory files
 * without a workspace: the memory.* routes are called with workspaceId null,
 * so only the global scope (~/.mux/memory) is reachable. Project/workspace
 * memories are curated from each workspace's Memory tab instead.
 */
export function MemorySection() {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-foreground mb-1 text-sm font-medium">Global Memories</h3>
        <p className="text-muted text-xs">
          Memory files the agent shares across every project and workspace. Project and workspace
          memories live in the Memory tab of each workspace.
        </p>
      </div>
      <MemoryBrowser workspaceId={null} scopes={["global"]} />
    </div>
  );
}
