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
import {
  validateRelativePath,
  buildReadFileScript,
  buildFileDiffScript,
  processFileContents,
  EXIT_CODE_TOO_LARGE,
  type FileContentsResult,
} from "@/browser/utils/fileExplorer";

interface FileViewerTabProps {
  workspaceId: string;
  relativePath: string;
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; data: FileContentsResult; diff: string | null };

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

    // Validate path before making request
    const pathError = validateRelativePath(props.relativePath);
    if (pathError) {
      setState({ status: "error", message: pathError });
      return;
    }

    // Empty path is not valid for file viewing
    if (!props.relativePath) {
      setState({ status: "error", message: "No file selected" });
      return;
    }

    let cancelled = false;
    setState({ status: "loading" });

    async function fetchFile() {
      try {
        // Fetch file contents and diff in parallel via bash
        const [fileResult, diffResult] = await Promise.all([
          api!.workspace.executeBash({
            workspaceId: props.workspaceId,
            script: buildReadFileScript(props.relativePath),
          }),
          api!.workspace.executeBash({
            workspaceId: props.workspaceId,
            script: buildFileDiffScript(props.relativePath),
          }),
        ]);

        if (cancelled) return;

        // Handle ORPC-level errors
        if (!fileResult.success) {
          setState({ status: "error", message: fileResult.error });
          return;
        }

        const bashResult = fileResult.data;

        // Check for "too large" exit code (custom exit code from our script)
        if (bashResult.exitCode === EXIT_CODE_TOO_LARGE) {
          setState({
            status: "loaded",
            data: { type: "error", message: "File is too large to display. Maximum: 10 MB." },
            diff: null,
          });
          return;
        }

        // Check for bash command failure with no usable output
        if (!bashResult.success && !bashResult.output) {
          const errorMsg = bashResult.error ?? "Failed to read file";
          setState({
            status: "error",
            message: errorMsg.length > 128 ? errorMsg.slice(0, 128) + "..." : errorMsg,
          });
          return;
        }

        // Process file contents - detect image types via magic bytes, text vs binary
        // Even if bashResult.success is false, try to process if we have output
        const data = processFileContents(bashResult.output ?? "", bashResult.exitCode);

        if (cancelled) return;

        // Diff is optional - don't fail if it errors
        let diff: string | null = null;
        if (diffResult.success && diffResult.data.success) {
          diff = diffResult.data.output;
        }

        setState({ status: "loaded", data, diff });
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
    return <ImageFileViewer base64={data.base64} mimeType={data.mimeType} size={data.size} />;
  }

  // This shouldn't happen, but handle it gracefully
  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-muted-foreground text-sm">Unknown file type</p>
    </div>
  );
};
