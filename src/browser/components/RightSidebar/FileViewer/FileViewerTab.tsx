/**
 * FileViewerTab - Main orchestrator for the file viewer pane.
 * Fetches file data via ORPC and routes to appropriate viewer component.
 * Auto-refreshes on file-modifying tool completion (debounced).
 */

import React from "react";
import { useAPI } from "@/browser/contexts/API";
import { workspaceStore } from "@/browser/stores/WorkspaceStore";
import { RefreshCw, AlertCircle } from "lucide-react";
import { TextFileViewer } from "./TextFileViewer";
import { ImageFileViewer } from "./ImageFileViewer";
import type { FileContentsResponse } from "@/common/orpc/schemas/api";

interface FileViewerTabProps {
  workspaceId: string;
  relativePath: string;
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; data: FileContentsResponse; diff: string | null };

const DEBOUNCE_MS = 2000;

export const FileViewerTab: React.FC<FileViewerTabProps> = (props) => {
  const { api } = useAPI();
  const [state, setState] = React.useState<LoadState>({ status: "loading" });
  // Refresh counter to trigger re-fetch
  const [refreshCounter, setRefreshCounter] = React.useState(0);

  // Subscribe to file-modifying tool events and debounce refresh
  React.useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const unsubscribe = workspaceStore.subscribeFileModifyingTool(() => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        setRefreshCounter((c) => c + 1);
      }, DEBOUNCE_MS);
    }, props.workspaceId);

    return () => {
      unsubscribe();
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [props.workspaceId]);

  React.useEffect(() => {
    if (!api) return;

    let cancelled = false;
    setState({ status: "loading" });

    async function fetchFile() {
      try {
        // Fetch file contents and diff in parallel
        const [contentsResult, diffResult] = await Promise.all([
          api!.general.getFileContents({
            workspaceId: props.workspaceId,
            relativePath: props.relativePath,
          }),
          api!.general.getFileDiff({
            workspaceId: props.workspaceId,
            relativePath: props.relativePath,
          }),
        ]);

        if (cancelled) return;

        if (!contentsResult.success) {
          setState({ status: "error", message: contentsResult.error });
          return;
        }

        // Diff is optional - don't fail if it errors
        const diff = diffResult.success ? diffResult.data.diff : null;

        setState({ status: "loaded", data: contentsResult.data, diff });
      } catch (err) {
        if (cancelled) return;
        setState({
          status: "error",
          message: err instanceof Error ? err.message : "Failed to load file",
        });
      }
    }

    void fetchFile();

    return () => {
      cancelled = true;
    };
  }, [api, props.workspaceId, props.relativePath, refreshCounter]);

  if (state.status === "loading") {
    return (
      <div className="flex h-full items-center justify-center">
        <RefreshCw className="text-muted h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4">
        <AlertCircle className="text-destructive h-8 w-8" />
        <p className="text-destructive text-center text-sm">{state.message}</p>
      </div>
    );
  }

  const { data } = state;

  // Handle error response from API (file too large, binary, etc.)
  if (data.type === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4">
        <AlertCircle className="text-muted h-8 w-8" />
        <p className="text-muted-foreground text-center text-sm">{data.message}</p>
      </div>
    );
  }

  const handleRefresh = () => setRefreshCounter((c) => c + 1);

  // Route to appropriate viewer
  if (data.type === "text") {
    return (
      <TextFileViewer
        content={data.content}
        filePath={props.relativePath}
        size={data.size}
        diff={state.diff}
        onRefresh={handleRefresh}
      />
    );
  }

  if (data.type === "image") {
    return (
      <ImageFileViewer
        base64={data.base64}
        mimeType={data.mimeType}
        size={data.size}
        width={data.width}
        height={data.height}
      />
    );
  }

  // This shouldn't happen, but handle it gracefully
  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-muted-foreground text-sm">Unknown file type</p>
    </div>
  );
};
