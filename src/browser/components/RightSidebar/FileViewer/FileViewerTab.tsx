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
import {
  getCachedFileContent,
  setCachedFileContent,
  removeCachedFileContent,
  cacheToResult,
} from "@/browser/utils/fileContentCache";
import type { ReviewNoteData } from "@/common/types/review";

interface FileViewerTabProps {
  workspaceId: string;
  relativePath: string;
  onReviewNote?: (data: ReviewNoteData) => void;
}

interface LoadedData {
  data: FileContentsResult;
  diff: string | null;
}

const DEBOUNCE_MS = 2000;

export const FileViewerTab: React.FC<FileViewerTabProps> = (props) => {
  const { api } = useAPI();

  // Initialize from cache if available
  const initialCached = React.useMemo(() => {
    if (!props.relativePath) return null;
    const cached = getCachedFileContent(props.workspaceId, props.relativePath);
    if (!cached) return null;
    return { data: cacheToResult(cached), diff: cached.diff ?? null };
  }, [props.workspaceId, props.relativePath]);

  // Separate loading flag from loaded data - keeps content visible during refresh
  const [isLoading, setIsLoading] = React.useState(!initialCached);
  // Track background refresh state (showing cached content while fetching fresh)
  const [isRefreshing, setIsRefreshing] = React.useState(!!initialCached);
  const [error, setError] = React.useState<string | null>(null);
  const [loaded, setLoaded] = React.useState<LoadedData | null>(initialCached);
  // Track which path the loaded data is for (to detect file switches)
  // Using ref to avoid effect dep issues - we only read this to decide loading state
  const loadedPathRef = React.useRef<string | null>(initialCached ? props.relativePath : null);
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
      setError(pathError);
      setIsLoading(false);
      return;
    }

    // Empty path is not valid for file viewing
    if (!props.relativePath) {
      setError("No file selected");
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    // Show loading spinner on initial load or when switching files, but not on refresh
    const isSameFile = loadedPathRef.current === props.relativePath;
    if (!isSameFile) {
      setIsLoading(true);
    } else {
      // Same file - this is a background refresh
      setIsRefreshing(true);
    }
    setError(null);

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
          setError(fileResult.error);
          setIsLoading(false);
          setIsRefreshing(false);
          return;
        }

        const bashResult = fileResult.data;

        // Check for "too large" exit code (custom exit code from our script)
        if (bashResult.exitCode === EXIT_CODE_TOO_LARGE) {
          setLoaded({
            data: { type: "error", message: "File is too large to display. Maximum: 10 MB." },
            diff: null,
          });
          loadedPathRef.current = props.relativePath;
          setIsLoading(false);
          setIsRefreshing(false);
          return;
        }

        // Check for bash command failure with no usable output
        if (!bashResult.success && !bashResult.output) {
          const errorMsg = bashResult.error ?? "Failed to read file";
          // Remove from cache if file appears to be deleted/not found
          removeCachedFileContent(props.workspaceId, props.relativePath);
          setError(errorMsg.length > 128 ? errorMsg.slice(0, 128) + "..." : errorMsg);
          setIsLoading(false);
          setIsRefreshing(false);
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

        // Update cache with fresh data
        setCachedFileContent(props.workspaceId, props.relativePath, data, diff);

        setLoaded({ data, diff });
        loadedPathRef.current = props.relativePath;
        setIsLoading(false);
        setIsRefreshing(false);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load file");
        setIsLoading(false);
        setIsRefreshing(false);
      }
    }

    void fetchFile();

    return () => {
      cancelled = true;
    };
  }, [api, props.workspaceId, props.relativePath, refreshCounter]);

  // Check if we have valid cached content for the current file
  const hasValidCache = loaded && loadedPathRef.current === props.relativePath;

  // Show loading spinner only on initial load or file switch (no valid cached content)
  if (isLoading && !hasValidCache) {
    return (
      <div className="flex h-full items-center justify-center">
        <RefreshCw className="text-muted h-5 w-5 animate-spin" />
      </div>
    );
  }

  // Show error only if we have no content to fall back to
  if (error && !hasValidCache) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4">
        <AlertCircle className="text-destructive h-8 w-8" />
        <p className="text-destructive text-center text-sm">{error}</p>
      </div>
    );
  }

  // No data at all (shouldn't happen but handle gracefully)
  if (!hasValidCache) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted-foreground text-sm">No file loaded</p>
      </div>
    );
  }

  const { data, diff } = loaded;

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
        workspaceId={props.workspaceId}
        content={data.content}
        filePath={props.relativePath}
        size={data.size}
        diff={diff}
        onRefresh={handleRefresh}
        isRefreshing={isRefreshing}
        onReviewNote={props.onReviewNote}
      />
    );
  }

  if (data.type === "image") {
    return (
      <ImageFileViewer
        base64={data.base64}
        mimeType={data.mimeType}
        size={data.size}
        filePath={props.relativePath}
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
