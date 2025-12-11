import React, { useMemo, useState } from "react";
import { ChevronRight, FileText, ExternalLink, Check, Eye, EyeOff } from "lucide-react";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { useOpenInEditor } from "@/browser/hooks/useOpenInEditor";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/ui/tooltip";

interface PostCompactionSectionProps {
  workspaceId: string;
  planPath: string | null;
  trackedFilePaths: string[];
  excludedItems: Set<string>;
  onToggleExclusion: (itemId: string) => Promise<void>;
}

/** Extract just the filename from a full path */
function getFileName(filePath: string): string {
  return filePath.split("/").pop() ?? filePath;
}

/**
 * Displays what context will be injected after compaction.
 * Collapsible section in the right sidebar below the context usage bar.
 */
export const PostCompactionSection: React.FC<PostCompactionSectionProps> = (props) => {
  const openInEditor = useOpenInEditor();
  const [collapsed, setCollapsed] = usePersistedState("postCompaction:collapsed", true);
  const [filesExpanded, setFilesExpanded] = usePersistedState(
    "postCompaction:filesExpanded",
    false
  );
  const [copied, setCopied] = useState(false);

  const handleCopyPath = async () => {
    if (!props.planPath) return;
    await navigator.clipboard.writeText(props.planPath);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleOpenPlan = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!props.planPath) return;
    void openInEditor(props.workspaceId, props.planPath);
  };

  // Derive values from props
  const planExists = props.planPath !== null;
  const trackedFilesCount = props.trackedFilePaths.length;
  const isPlanExcluded = props.excludedItems.has("plan");

  // Format file names for display - show just filename, with parent dir if duplicates
  const formattedFiles = useMemo(() => {
    const nameCount = new Map<string, number>();
    props.trackedFilePaths.forEach((p) => {
      const name = getFileName(p);
      nameCount.set(name, (nameCount.get(name) ?? 0) + 1);
    });

    return props.trackedFilePaths.map((fullPath) => {
      const name = getFileName(fullPath);
      const needsContext = (nameCount.get(name) ?? 0) > 1;
      const parts = fullPath.split("/");
      const displayName = needsContext && parts.length > 1 ? parts.slice(-2).join("/") : name;
      const itemId = `file:${fullPath}`;
      const isExcluded = props.excludedItems.has(itemId);
      return { fullPath, displayName, itemId, isExcluded };
    });
  }, [props.trackedFilePaths, props.excludedItems]);

  // Count how many items are included (not excluded)
  const includedFilesCount = formattedFiles.filter((f) => !f.isExcluded).length;

  // Don't render if nothing will be injected
  if (!planExists && trackedFilesCount === 0) {
    return null;
  }

  return (
    <div className="border-border-light mt-4 border-t pt-4">
      <button
        onClick={() => setCollapsed((prev) => !prev)}
        className="flex w-full items-center justify-between text-left"
        type="button"
      >
        <span className="text-muted text-xs font-medium">Post-Compaction Context</span>
        <ChevronRight
          className={`text-muted h-3.5 w-3.5 transition-transform duration-200 ${
            collapsed ? "" : "rotate-90"
          }`}
        />
      </button>

      {!collapsed && (
        <div className="mt-2 flex flex-col gap-2">
          {planExists && props.planPath && (
            <div className={`flex items-center gap-1 ${isPlanExcluded ? "opacity-50" : ""}`}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => void props.onToggleExclusion("plan")}
                    className="text-subtle hover:text-foreground p-0.5 transition-colors"
                    type="button"
                  >
                    {isPlanExcluded ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" showArrow={false}>
                  {isPlanExcluded ? "Include in context" : "Exclude from context"}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => void handleCopyPath()}
                    className={`text-subtle hover:text-foreground flex items-center gap-2 text-left text-xs transition-colors ${isPlanExcluded ? "line-through" : ""}`}
                    type="button"
                  >
                    <FileText className="h-3.5 w-3.5" />
                    <span>Plan file</span>
                    {copied && <Check className="h-3 w-3 text-green-500" />}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" showArrow={false}>
                  Click to copy path
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={handleOpenPlan}
                    className="text-subtle hover:text-foreground p-0.5 transition-colors"
                    type="button"
                  >
                    <ExternalLink className="h-3 w-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" showArrow={false}>
                  Open in editor
                </TooltipContent>
              </Tooltip>
            </div>
          )}

          {trackedFilesCount > 0 && (
            <div className="flex flex-col">
              <div className="flex items-center gap-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        // Toggle all files: if any included, exclude all; otherwise include all
                        const shouldExclude = includedFilesCount > 0;
                        void (async () => {
                          for (const file of formattedFiles) {
                            if (shouldExclude !== file.isExcluded) {
                              await props.onToggleExclusion(file.itemId);
                            }
                          }
                        })();
                      }}
                      className="text-subtle hover:text-foreground p-0.5 transition-colors"
                      type="button"
                    >
                      {includedFilesCount === 0 ? (
                        <EyeOff className="h-3 w-3" />
                      ) : (
                        <Eye className="h-3 w-3" />
                      )}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" showArrow={false}>
                    {includedFilesCount === 0 ? "Include all files" : "Exclude all files"}
                  </TooltipContent>
                </Tooltip>
                <button
                  onClick={() => setFilesExpanded((prev) => !prev)}
                  className="text-subtle hover:text-foreground flex items-center gap-2 text-left text-xs transition-colors"
                  type="button"
                >
                  <ChevronRight
                    className={`h-3 w-3 transition-transform duration-200 ${filesExpanded ? "rotate-90" : ""}`}
                  />
                  <span>
                    {includedFilesCount}/{trackedFilesCount} file diff
                    {trackedFilesCount !== 1 ? "s" : ""}
                  </span>
                </button>
              </div>

              {filesExpanded && formattedFiles.length > 0 && (
                <div className="mt-1 ml-5 flex flex-col gap-0.5">
                  {formattedFiles.map((file) => (
                    <div
                      key={file.fullPath}
                      className={`flex items-center gap-1 ${file.isExcluded ? "opacity-50" : ""}`}
                    >
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            onClick={() => void props.onToggleExclusion(file.itemId)}
                            className="text-subtle hover:text-foreground p-0.5 transition-colors"
                            type="button"
                          >
                            {file.isExcluded ? (
                              <EyeOff className="h-2.5 w-2.5" />
                            ) : (
                              <Eye className="h-2.5 w-2.5" />
                            )}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="top" showArrow={false}>
                          {file.isExcluded ? "Include in context" : "Exclude from context"}
                        </TooltipContent>
                      </Tooltip>
                      <span
                        className={`text-muted text-[10px] ${file.isExcluded ? "line-through" : ""}`}
                      >
                        {file.displayName}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <p className="text-muted mt-1 text-[10px] italic">
            Keeps agent aligned with your plan and prior edits
          </p>
        </div>
      )}
    </div>
  );
};
