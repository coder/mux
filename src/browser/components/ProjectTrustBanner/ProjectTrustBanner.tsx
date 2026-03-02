import { useState } from "react";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import { ConfirmationModal } from "@/browser/components/ConfirmationModal/ConfirmationModal";
import { useAPI } from "@/browser/contexts/API";

interface ProjectTrustBannerProps {
  projectPath: string;
  onTrusted: () => void;
}

/**
 * Warning banner shown when the current project has not been explicitly trusted.
 * Hooks and user scripts (.mux/tool_env, .mux/tool_pre, .mux/tool_post, git hooks)
 * are disabled until the user confirms trust.
 */
export function ProjectTrustBanner(props: ProjectTrustBannerProps) {
  const { api } = useAPI();
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async () => {
    if (!api) return;
    try {
      setError(null);
      await api.projects.setTrust({ projectPath: props.projectPath, trusted: true });
      setShowConfirm(false);
      props.onTrusted();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update trust setting");
    }
  };

  return (
    <>
      <div className="border-warning/30 bg-warning/10 text-warning flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
        <ShieldAlert className="size-4 shrink-0" />
        <span className="flex-1">
          This project is not trusted. Hooks and scripts are disabled.
          {error && <span className="text-destructive ml-2">{error}</span>}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="shrink-0"
          onClick={() => setShowConfirm(true)}
        >
          Trust this project
        </Button>
      </div>
      <ConfirmationModal
        isOpen={showConfirm}
        title="Trust this project?"
        description="Trusting this project allows Mux to run hooks and scripts from this repository."
        warning="This includes .mux/tool_env, .mux/tool_pre, .mux/tool_post, and git hooks. Only trust projects from sources you trust."
        confirmLabel="I trust this project"
        cancelLabel="Cancel"
        onConfirm={handleConfirm}
        onCancel={() => setShowConfirm(false)}
      />
    </>
  );
}
