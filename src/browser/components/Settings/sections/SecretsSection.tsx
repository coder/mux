import React, { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { Secret } from "@/common/types/secrets";
import { useAPI } from "@/browser/contexts/API";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import { Button } from "@/browser/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/browser/components/ui/toggle-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/ui/select";

type SecretsScope = "global" | "project";

// Visibility toggle icon component
const ToggleVisibilityIcon: React.FC<{ visible: boolean }> = (props) => {
  if (props.visible) {
    // Eye-off icon (with slash) - password is visible
    return (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
        <line x1="1" y1="1" x2="23" y2="23" />
      </svg>
    );
  }

  // Eye icon - password is hidden
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
};

function secretsEqual(a: Secret[], b: Secret[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (!left || !right) return false;
    if (left.key !== right.key) return false;
    if (left.value !== right.value) return false;
  }
  return true;
}

export const SecretsSection: React.FC = () => {
  const { api } = useAPI();
  const { projects } = useProjectContext();
  const projectList = Array.from(projects.keys());

  const [scope, setScope] = useState<SecretsScope>("global");
  const [selectedProject, setSelectedProject] = useState<string>("");

  const [loadedSecrets, setLoadedSecrets] = useState<Secret[]>([]);
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [visibleSecrets, setVisibleSecrets] = useState<Set<number>>(() => new Set());

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scopeLabel = scope === "global" ? "Global" : "Project";

  // Default to the first project when switching into Project scope.
  useEffect(() => {
    if (scope !== "project") {
      return;
    }

    if (selectedProject && projectList.includes(selectedProject)) {
      return;
    }

    setSelectedProject(projectList[0] ?? "");
  }, [projectList, scope, selectedProject]);

  const currentProjectPath = scope === "project" ? selectedProject : undefined;

  const isDirty = !secretsEqual(secrets, loadedSecrets);

  const loadSecrets = useCallback(async () => {
    if (!api) {
      setLoadedSecrets([]);
      setSecrets([]);
      setVisibleSecrets(new Set());
      setError(null);
      return;
    }

    if (scope === "project" && !currentProjectPath) {
      setLoadedSecrets([]);
      setSecrets([]);
      setVisibleSecrets(new Set());
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const nextSecrets = await api.secrets.get(
        scope === "project" ? { projectPath: currentProjectPath } : {}
      );
      setLoadedSecrets(nextSecrets);
      setSecrets(nextSecrets);
      setVisibleSecrets(new Set());
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load secrets";
      setLoadedSecrets([]);
      setSecrets([]);
      setVisibleSecrets(new Set());
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [api, currentProjectPath, scope]);

  useEffect(() => {
    void loadSecrets();
  }, [loadSecrets]);

  const addSecret = useCallback(() => {
    setSecrets((prev) => [...prev, { key: "", value: "" }]);
  }, []);

  const removeSecret = useCallback((index: number) => {
    setSecrets((prev) => prev.filter((_, i) => i !== index));

    // Clean up visibility state.
    setVisibleSecrets((prev) => {
      const next = new Set(prev);
      next.delete(index);
      return next;
    });
  }, []);

  const updateSecret = useCallback((index: number, field: "key" | "value", value: string) => {
    setSecrets((prev) => {
      const next = [...prev];
      // Auto-capitalize key field for env variable convention.
      const processedValue = field === "key" ? value.toUpperCase() : value;
      next[index] = { ...next[index], [field]: processedValue };
      return next;
    });
  }, []);

  const toggleVisibility = useCallback((index: number) => {
    setVisibleSecrets((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }, []);

  const handleReset = useCallback(() => {
    setSecrets(loadedSecrets);
    setVisibleSecrets(new Set());
    setError(null);
  }, [loadedSecrets]);

  const handleSave = useCallback(async () => {
    if (!api) return;

    if (scope === "project" && !currentProjectPath) {
      setError("Select a project to save project secrets.");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      // Filter out empty rows.
      const validSecrets = secrets.filter((s) => s.key.trim() !== "" && s.value.trim() !== "");

      const result = await api.secrets.update(
        scope === "project"
          ? { projectPath: currentProjectPath, secrets: validSecrets }
          : { secrets: validSecrets }
      );

      if (!result.success) {
        setError(result.error ?? "Failed to save secrets");
        return;
      }

      setLoadedSecrets(validSecrets);
      setSecrets(validSecrets);
      setVisibleSecrets(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save secrets");
    } finally {
      setSaving(false);
    }
  }, [api, currentProjectPath, scope, secrets]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-muted text-xs">
            Secrets are stored in <code className="text-accent">~/.mux/secrets.json</code> (kept out
            of source control).
          </p>
          <p className="text-muted mt-1 text-xs">
            Scope: <span className="text-foreground">{scopeLabel}</span>
          </p>
        </div>

        <ToggleGroup
          type="single"
          value={scope}
          onValueChange={(value) => {
            if (value !== "global" && value !== "project") {
              return;
            }
            setScope(value);
          }}
          size="sm"
          className="h-9"
          disabled={saving}
        >
          <ToggleGroupItem value="global" size="sm" className="h-7 px-3 text-[13px]">
            Global
          </ToggleGroupItem>
          <ToggleGroupItem value="project" size="sm" className="h-7 px-3 text-[13px]">
            Project
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      {scope === "project" && (
        <div className="flex items-center justify-between">
          <div>
            <div className="text-foreground text-sm">Project</div>
            <div className="text-muted text-xs">Select a project to configure</div>
          </div>
          <Select value={selectedProject} onValueChange={setSelectedProject}>
            <SelectTrigger className="border-border-medium bg-background-secondary hover:bg-hover h-9 w-auto min-w-[160px] cursor-pointer rounded-md border px-3 text-sm transition-colors">
              <SelectValue placeholder="Select project" />
            </SelectTrigger>
            <SelectContent>
              {projectList.map((path) => (
                <SelectItem key={path} value={path}>
                  {path.split(/[\\/]/).pop() ?? path}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {error && (
        <div className="bg-destructive/10 text-destructive flex items-center gap-2 rounded-md px-3 py-2 text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-muted flex items-center gap-2 py-4 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading secrets…
        </div>
      ) : scope === "project" && !currentProjectPath ? (
        <div className="text-muted py-2 text-sm">
          No projects configured. Add a project first to manage project secrets.
        </div>
      ) : secrets.length === 0 ? (
        <div className="text-muted border-border-medium rounded-md border border-dashed px-3 py-3 text-center text-xs">
          No secrets configured
        </div>
      ) : (
        <div className="[&>label]:text-muted grid grid-cols-[1fr_1fr_auto_auto] items-end gap-1 [&>label]:mb-0.5 [&>label]:text-[11px]">
          <label>Key</label>
          <label>Value</label>
          <div />
          <div />

          {secrets.map((secret, index) => (
            <React.Fragment key={index}>
              <input
                type="text"
                value={secret.key}
                onChange={(e) => updateSecret(index, "key", e.target.value)}
                placeholder="SECRET_NAME"
                disabled={saving}
                spellCheck={false}
                className="bg-modal-bg border-border-medium focus:border-accent placeholder:text-dim w-full rounded border px-2.5 py-1.5 font-mono text-[13px] text-white focus:outline-none disabled:opacity-50"
              />
              <input
                type={visibleSecrets.has(index) ? "text" : "password"}
                value={secret.value}
                onChange={(e) => updateSecret(index, "value", e.target.value)}
                placeholder="secret value"
                disabled={saving}
                spellCheck={false}
                className="bg-modal-bg border-border-medium focus:border-accent placeholder:text-dim w-full rounded border px-2.5 py-1.5 font-mono text-[13px] text-white focus:outline-none disabled:opacity-50"
              />
              <button
                type="button"
                onClick={() => toggleVisibility(index)}
                disabled={saving}
                className="text-muted hover:text-foreground flex cursor-pointer items-center justify-center self-center rounded-sm border-none bg-transparent px-1 py-0.5 text-base transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50"
                aria-label={visibleSecrets.has(index) ? "Hide secret" : "Show secret"}
              >
                <ToggleVisibilityIcon visible={visibleSecrets.has(index)} />
              </button>
              <button
                type="button"
                onClick={() => removeSecret(index)}
                disabled={saving}
                className="text-danger-light border-danger-light hover:bg-danger-light/10 cursor-pointer rounded border bg-transparent px-2.5 py-1.5 text-[13px] transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50"
                aria-label="Remove secret"
              >
                ×
              </button>
            </React.Fragment>
          ))}
        </div>
      )}

      <button
        onClick={addSecret}
        disabled={saving || (scope === "project" && !currentProjectPath)}
        className="text-muted border-border-medium hover:bg-hover hover:border-border-darker hover:text-foreground w-full cursor-pointer rounded border border-dashed bg-transparent px-3 py-2 text-[13px] transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50"
      >
        + Add Secret
      </button>

      <div className="flex items-center justify-end gap-2">
        <Button
          variant="secondary"
          type="button"
          onClick={handleReset}
          disabled={!isDirty || saving || loading}
        >
          Reset
        </Button>
        <Button
          type="button"
          onClick={() => void handleSave()}
          disabled={!isDirty || saving || loading}
        >
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
};
