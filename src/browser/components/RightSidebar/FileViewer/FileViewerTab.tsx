/**
 * FileViewerTab - Main orchestrator for the file viewer pane.
 * Fetches file data via ORPC and routes to appropriate viewer component.
 * Auto-refreshes on file-modifying tool completion (debounced).
 */

import React from "react";
import { useAPI } from "@/browser/contexts/API";
import { workspaceStore } from "@/browser/stores/WorkspaceStore";
import { RefreshCw, AlertCircle } from "lucide-react";
import { TextFileEditor } from "./TextFileEditor";
import { ImageFileViewer } from "./ImageFileViewer";
import type { FileDraftHistory } from "@/browser/utils/rightSidebarLayout";
import {
  validateRelativePath,
  buildReadFileScript,
  buildFileDiffScript,
  buildWriteFileScript,
  processFileContents,
  EXIT_CODE_TOO_LARGE,
  MAX_FILE_SIZE,
  MAX_FILE_SIZE_LABEL,
  type FileContentsResult,
} from "@/browser/utils/fileExplorer";

interface FileViewerTabProps {
  workspaceId: string;
  relativePath: string;
  onDirtyChange?: (dirty: boolean) => void;
  draftContent?: string | null;
  draftHistory?: FileDraftHistory | null;
  onDraftChange?: (content: string | null) => void;
  onDraftHistoryChange?: (history: FileDraftHistory | null) => void;
}

interface LoadedData {
  data: FileContentsResult;
  diff: string | null;
}

const DRAFT_DEBOUNCE_MS = 300;
const ENCODE_CHUNK_SIZE = 0x8000;

const normalizeLineEndings = (content: string): string => content.replace(/\r\n/g, "\n");

interface DraftPersistenceParams {
  draftContent?: string | null;
  draftHistory?: FileDraftHistory | null;
  relativePath: string;
  onDraftChange?: (content: string | null) => void;
  onDraftHistoryChange?: (history: FileDraftHistory | null) => void;
}

const useDraftPersistence = (params: DraftPersistenceParams) => {
  const { draftContent, draftHistory, relativePath, onDraftChange, onDraftHistoryChange } = params;
  const draftRef = React.useRef<string | null>(draftContent ?? null);
  const draftHistoryRef = React.useRef<FileDraftHistory | null>(draftHistory ?? null);
  const draftTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearDraftTimeout = React.useCallback(() => {
    if (draftTimeoutRef.current) {
      clearTimeout(draftTimeoutRef.current);
      draftTimeoutRef.current = null;
    }
  }, []);

  const clearDraft = React.useCallback(() => {
    if (draftRef.current === null && !draftTimeoutRef.current && draftHistoryRef.current === null) {
      return;
    }
    clearDraftTimeout();
    draftRef.current = null;
    draftHistoryRef.current = null;
    onDraftChange?.(null);
    onDraftHistoryChange?.(null);
  }, [clearDraftTimeout, onDraftChange, onDraftHistoryChange]);

  const scheduleDraftPersist = React.useCallback(
    (content: string) => {
      draftRef.current = content;
      if (!onDraftChange && !onDraftHistoryChange) return;
      clearDraftTimeout();
      draftTimeoutRef.current = setTimeout(() => {
        draftTimeoutRef.current = null;
        onDraftChange?.(draftRef.current);
        onDraftHistoryChange?.(draftHistoryRef.current);
      }, DRAFT_DEBOUNCE_MS);
    },
    [clearDraftTimeout, onDraftChange, onDraftHistoryChange]
  );

  const setDraftHistory = React.useCallback((history: FileDraftHistory | null) => {
    draftHistoryRef.current = history;
  }, []);

  React.useEffect(() => {
    draftRef.current = draftContent ?? null;
    draftHistoryRef.current = draftHistory ?? null;
    clearDraftTimeout();
  }, [clearDraftTimeout, draftContent, draftHistory, relativePath]);

  React.useEffect(() => {
    return () => {
      if (!onDraftChange && !onDraftHistoryChange) return;
      if (draftTimeoutRef.current) {
        clearTimeout(draftTimeoutRef.current);
        draftTimeoutRef.current = null;
        if (draftRef.current !== null) {
          onDraftChange?.(draftRef.current);
          onDraftHistoryChange?.(draftHistoryRef.current);
        }
      }
    };
  }, [onDraftChange, onDraftHistoryChange]);

  return { draftRef, scheduleDraftPersist, clearDraft, setDraftHistory };
};
function encodeTextToBase64(content: string): { base64: string; size: number } {
  const bytes = new TextEncoder().encode(content);
  let binary = "";
  for (let i = 0; i < bytes.length; i += ENCODE_CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + ENCODE_CHUNK_SIZE);
    binary += String.fromCharCode(...chunk);
  }
  return { base64: btoa(binary), size: bytes.length };
}

export const FileViewerTab: React.FC<FileViewerTabProps> = (props) => {
  const { api } = useAPI();
  const {
    workspaceId,
    relativePath,
    onDirtyChange,
    draftContent,
    draftHistory,
    onDraftChange,
    onDraftHistoryChange,
  } = props;
  // Separate loading flag from loaded data - keeps content visible during refresh
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [loaded, setLoaded] = React.useState<LoadedData | null>(null);
  // Track which path the loaded data is for (to detect file switches)
  // Using ref to avoid effect dep issues - we only read this to decide loading state
  const loadedPathRef = React.useRef<string | null>(null);
  const [contentVersion, setContentVersion] = React.useState(0);
  const [pendingExternalChange, setPendingExternalChange] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const dirtyRef = React.useRef(false);
  const fileModifyingIgnoreRef = React.useRef(0);
  const lineEndingRef = React.useRef<"lf" | "crlf">("lf");

  const { draftRef, scheduleDraftPersist, clearDraft, setDraftHistory } = useDraftPersistence({
    draftContent,
    draftHistory,
    relativePath,
    onDraftChange,
    onDraftHistoryChange,
  });

  // Refresh counter to trigger re-fetch
  const [refreshCounter, setRefreshCounter] = React.useState(0);

  // Reset editor state when switching files
  React.useEffect(() => {
    dirtyRef.current = false;
    setPendingExternalChange(false);
    setIsSaving(false);
    setSaveError(null);
  }, [relativePath]);

  // Subscribe to file-modifying tool events and surface a reload banner.
  React.useEffect(() => {
    const unsubscribe = workspaceStore.subscribeFileModifyingTool(() => {
      if (fileModifyingIgnoreRef.current > 0) {
        fileModifyingIgnoreRef.current = Math.max(0, fileModifyingIgnoreRef.current - 1);
        return;
      }
      setPendingExternalChange(true);
    }, workspaceId);

    return () => {
      unsubscribe();
    };
  }, [workspaceId]);

  React.useEffect(() => {
    if (!api) return;

    // Validate path before making request
    const pathError = validateRelativePath(relativePath);
    if (pathError) {
      setError(pathError);
      setIsLoading(false);
      return;
    }

    // Empty path is not valid for file viewing
    if (!relativePath) {
      setError("No file selected");
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    // Show loading spinner on initial load or when switching files, but not on refresh
    const isSameFile = loadedPathRef.current === relativePath;
    if (!isSameFile) {
      setIsLoading(true);
    }
    setError(null);

    async function fetchFile() {
      try {
        // Fetch file contents and diff in parallel via bash
        const [fileResult, diffResult] = await Promise.all([
          api!.workspace.executeBash({
            workspaceId,
            script: buildReadFileScript(relativePath),
          }),
          api!.workspace.executeBash({
            workspaceId,
            script: buildFileDiffScript(relativePath),
          }),
        ]);

        if (cancelled) return;

        // Handle ORPC-level errors
        if (!fileResult.success) {
          setError(fileResult.error);
          setIsLoading(false);
          return;
        }

        const bashResult = fileResult.data;

        // Check for "too large" exit code (custom exit code from our script)
        if (bashResult.exitCode === EXIT_CODE_TOO_LARGE) {
          setLoaded({
            data: {
              type: "error",
              message: `File is too large to display. Maximum: ${MAX_FILE_SIZE_LABEL}.`,
            },
            diff: null,
          });
          loadedPathRef.current = relativePath;
          setIsLoading(false);
          setSaveError(null);
          setPendingExternalChange(false);
          dirtyRef.current = false;
          return;
        }

        // Check for bash command failure with no usable output
        if (!bashResult.success && !bashResult.output) {
          const errorMsg = bashResult.error ?? "Failed to read file";
          setError(errorMsg.length > 128 ? errorMsg.slice(0, 128) + "..." : errorMsg);
          setIsLoading(false);
          return;
        }

        // Process file contents - detect image types via magic bytes, text vs binary
        // Even if bashResult.success is false, try to process if we have output
        const data = processFileContents(bashResult.output ?? "", bashResult.exitCode);

        if (cancelled) return;

        if (data.type === "text") {
          lineEndingRef.current = data.content.includes("\r\n") ? "crlf" : "lf";
        }

        // Diff is optional - don't fail if it errors
        let diff: string | null = null;
        if (diffResult.success && diffResult.data.success) {
          diff = diffResult.data.output;
        }

        setLoaded({ data, diff });
        loadedPathRef.current = relativePath;
        setIsLoading(false);
        setSaveError(null);
        setPendingExternalChange(false);
        if (data.type === "text") {
          const draftContent = draftRef.current;
          const hasDraft =
            draftContent !== null &&
            normalizeLineEndings(draftContent) !== normalizeLineEndings(data.content);
          dirtyRef.current = hasDraft;
          if (!hasDraft && (draftRef.current !== null || draftHistory !== null)) {
            clearDraft();
          }
          setContentVersion((version) => version + 1);
        } else {
          dirtyRef.current = false;
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load file");
        setIsLoading(false);
      }
    }

    void fetchFile();

    return () => {
      cancelled = true;
    };
  }, [api, workspaceId, relativePath, refreshCounter, draftRef, draftHistory, clearDraft]);

  const handleDirtyChange = (dirty: boolean) => {
    dirtyRef.current = dirty;
    if (!dirty) {
      setSaveError(null);
      clearDraft();
    }
    onDirtyChange?.(dirty);
  };

  const handleHistoryChange = React.useCallback(
    (nextHistory: FileDraftHistory | null) => {
      setDraftHistory(nextHistory);
    },
    [setDraftHistory]
  );

  const handleContentChange = React.useCallback(
    (nextContent: string) => {
      draftRef.current = nextContent;
      if (!dirtyRef.current) return;
      scheduleDraftPersist(nextContent);
    },
    [draftRef, scheduleDraftPersist]
  );

  // Check if we have valid cached content for the current file
  const hasValidCache = loaded && loadedPathRef.current === relativePath;

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

  const handleDismissExternal = () => {
    setPendingExternalChange(false);
  };

  const handleReloadExternal = () => {
    setPendingExternalChange(false);
    dirtyRef.current = false;
    setSaveError(null);
    clearDraft();
    setRefreshCounter((c) => c + 1);
  };
  const handleRefresh = () => {
    if (dirtyRef.current) {
      setPendingExternalChange(true);
      return;
    }
    setPendingExternalChange(false);
    setRefreshCounter((c) => c + 1);
  };

  // Route to appropriate viewer
  if (data.type === "text") {
    const handleSave = async (nextContent: string) => {
      if (!api) {
        setSaveError("API not available");
        return;
      }
      if (isSaving) return;
      setIsSaving(true);
      setSaveError(null);

      try {
        const contentToWrite =
          lineEndingRef.current === "crlf" ? nextContent.replace(/\n/g, "\r\n") : nextContent;
        const { base64, size } = encodeTextToBase64(contentToWrite);
        if (size > MAX_FILE_SIZE) {
          setSaveError(`File is too large to save. Maximum: ${MAX_FILE_SIZE_LABEL}.`);
          return;
        }
        const writeResult = await api.workspace.executeBash({
          workspaceId,
          script: buildWriteFileScript(relativePath, base64),
        });

        if (!writeResult.success) {
          setSaveError(writeResult.error ?? "Failed to save file");
          return;
        }

        const bashResult = writeResult.data;
        if (!bashResult.success) {
          const errorMsg = bashResult.error ?? "Failed to save file";
          setSaveError(errorMsg.length > 128 ? errorMsg.slice(0, 128) + "..." : errorMsg);
          return;
        }

        let updatedDiff: string | null = null;
        const diffResult = await api.workspace.executeBash({
          workspaceId,
          script: buildFileDiffScript(relativePath),
        });
        if (diffResult.success && diffResult.data.success) {
          updatedDiff = diffResult.data.output;
        }

        setLoaded({
          data: { type: "text", content: contentToWrite, size },
          diff: updatedDiff,
        });
        loadedPathRef.current = relativePath;
        setContentVersion((version) => version + 1);
        dirtyRef.current = false;
        setPendingExternalChange(false);
        clearDraft();
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : "Failed to save file");
      } finally {
        setIsSaving(false);
      }
    };

    return (
      <TextFileEditor
        content={data.content}
        draftHistory={draftHistory}
        draftContent={draftContent}
        contentVersion={contentVersion}
        filePath={relativePath}
        size={data.size}
        diff={diff}
        externalChange={pendingExternalChange}
        isSaving={isSaving}
        saveError={saveError}
        onDirtyChange={handleDirtyChange}
        onHistoryChange={handleHistoryChange}
        onContentChange={handleContentChange}
        onRefresh={handleRefresh}
        onSave={handleSave}
        onReloadExternal={handleReloadExternal}
        onDismissExternal={handleDismissExternal}
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
