import React, { useCallback, useState } from "react";
import { GitBranch, Loader2 } from "lucide-react";
import { useAPI } from "@/browser/contexts/API";

interface GitInitBannerProps {
  projectPath: string;
  onSuccess: () => void | Promise<void>;
}

/**
 * Banner prompting user to run git init for non-git directories.
 * Shown on the creation screen when the project is not a git repository.
 */
export function GitInitBanner(props: GitInitBannerProps) {
  const { api } = useAPI();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleGitInit = useCallback(async () => {
    if (!api || isLoading) return;
    setIsLoading(true);
    setError(null);

    try {
      const result = await api.projects.gitInit({ projectPath: props.projectPath });
      if (result.success) {
        await props.onSuccess();
      } else {
        setError(result.error);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to initialize git repository");
    } finally {
      setIsLoading(false);
    }
  }, [api, isLoading, props]);

  return (
    <div
      className="bg-bg-dark border-border-medium flex items-center gap-3 rounded-lg border px-4 py-3"
      data-testid="git-init-banner"
    >
      <GitBranch className="text-muted-foreground h-5 w-5 shrink-0" />
      <div className="flex flex-1 flex-col gap-0.5">
        <span className="text-foreground text-sm font-medium">
          This directory is not a git repository
        </span>
        <span className="text-muted-foreground text-xs">
          Run <code className="bg-bg-dark-hover rounded px-1 font-mono">git init</code> to enable
          Worktree and SSH runtimes
        </span>
        {error && (
          <span className="text-xs text-red-500" data-testid="git-init-error">
            {error}
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={() => void handleGitInit()}
        disabled={isLoading}
        className="bg-accent hover:bg-accent/80 text-accent-foreground inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50"
        data-testid="git-init-button"
      >
        {isLoading ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Running...
          </>
        ) : (
          "Run git init"
        )}
      </button>
    </div>
  );
}
