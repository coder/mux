/**
 * Project secrets management section for Settings modal.
 * Manages environment secrets that are injected into agent tools.
 */

import React, { useState, useEffect, useCallback } from "react";
import { Eye, EyeOff, Trash2, Plus, Import, Loader2 } from "lucide-react";
import { Button } from "@/browser/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/ui/select";
import type { Secret } from "@/common/types/secrets";
import { useProjectContext } from "@/browser/contexts/ProjectContext";

interface ProjectSecretsSectionProps {
  projectPath: string;
}

export const ProjectSecretsSection: React.FC<ProjectSecretsSectionProps> = ({ projectPath }) => {
  const { projects, getSecrets, updateSecrets } = useProjectContext();
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [visibleSecrets, setVisibleSecrets] = useState<Set<number>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [originalSecrets, setOriginalSecrets] = useState<Secret[]>([]);

  // Get other projects (excluding current one) for import dropdown
  const otherProjects = Array.from(projects.entries()).filter(([path]) => path !== projectPath);

  // Load secrets when project changes
  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setHasChanges(false);

    (async () => {
      try {
        const loaded = await getSecrets(projectPath);
        if (cancelled) return;
        setSecrets(loaded);
        setOriginalSecrets(loaded);
        setVisibleSecrets(new Set());
      } catch (err) {
        if (cancelled) return;
        console.error("Failed to load secrets:", err);
        setSecrets([]);
        setOriginalSecrets([]);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [getSecrets, projectPath]);

  // Track changes
  useEffect(() => {
    const changed =
      secrets.length !== originalSecrets.length ||
      secrets.some(
        (s, i) => s.key !== originalSecrets[i]?.key || s.value !== originalSecrets[i]?.value
      );
    setHasChanges(changed);
  }, [secrets, originalSecrets]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      // Filter out empty secrets
      const validSecrets = secrets.filter((s) => s.key.trim() !== "" && s.value.trim() !== "");
      await updateSecrets(projectPath, validSecrets);
      setOriginalSecrets(validSecrets);
      setSecrets(validSecrets);
      setHasChanges(false);
    } catch (err) {
      console.error("Failed to save secrets:", err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDiscard = () => {
    setSecrets(originalSecrets);
    setHasChanges(false);
  };

  const addSecret = () => {
    setSecrets([...secrets, { key: "", value: "" }]);
  };

  const removeSecret = (index: number) => {
    setSecrets(secrets.filter((_, i) => i !== index));
    const newVisible = new Set(visibleSecrets);
    newVisible.delete(index);
    setVisibleSecrets(newVisible);
  };

  const updateSecret = (index: number, field: "key" | "value", value: string) => {
    const newSecrets = [...secrets];
    // Auto-capitalize key field for env variable convention
    const processedValue = field === "key" ? value.toUpperCase() : value;
    newSecrets[index] = { ...newSecrets[index], [field]: processedValue };
    setSecrets(newSecrets);
  };

  const toggleVisibility = (index: number) => {
    const newVisible = new Set(visibleSecrets);
    if (newVisible.has(index)) {
      newVisible.delete(index);
    } else {
      newVisible.add(index);
    }
    setVisibleSecrets(newVisible);
  };

  // Track the current project path to cancel stale imports
  const currentProjectRef = React.useRef(projectPath);
  useEffect(() => {
    currentProjectRef.current = projectPath;
  }, [projectPath]);

  // Import secrets from another project (doesn't overwrite existing keys)
  const handleImportFromProject = useCallback(
    async (sourceProjectPath: string) => {
      const targetProject = currentProjectRef.current;
      setIsImporting(true);
      try {
        const sourceSecrets = await getSecrets(sourceProjectPath);
        // Cancel if project changed during the async fetch
        if (currentProjectRef.current !== targetProject) return;
        if (sourceSecrets.length === 0) return;

        setSecrets((current) => {
          const existingKeys = new Set(current.map((s) => s.key.toUpperCase()));
          const newSecrets = sourceSecrets.filter((s) => !existingKeys.has(s.key.toUpperCase()));
          return newSecrets.length > 0 ? [...current, ...newSecrets] : current;
        });
      } catch (err) {
        console.error("Failed to import secrets:", err);
      } finally {
        // Only clear importing if we're still on the same project
        if (currentProjectRef.current === targetProject) {
          setIsImporting(false);
        }
      }
    },
    [getSecrets]
  );

  if (isLoading) {
    return (
      <div className="text-muted flex items-center gap-2 py-4 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading secrets…
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Toolbar with Add + Import */}
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={addSecret}
          disabled={isSaving || isImporting}
          className="text-muted hover:text-foreground h-7 gap-1.5 px-2 text-xs"
        >
          <Plus className="h-3.5 w-3.5" />
          Add
        </Button>
        {otherProjects.length > 0 && (
          <Select
            value=""
            onValueChange={(path) => void handleImportFromProject(path)}
            disabled={isSaving || isImporting}
          >
            <SelectTrigger className="text-muted hover:text-foreground border-border-medium hover:bg-hover h-7 w-auto gap-1.5 border bg-transparent px-2 text-xs">
              <Import className="h-3.5 w-3.5" />
              <SelectValue placeholder={isImporting ? "Importing..." : "Import"} />
            </SelectTrigger>
            <SelectContent>
              {otherProjects.map(([path]) => {
                const name = path.split("/").pop() ?? path;
                return (
                  <SelectItem key={path} value={path}>
                    {name}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        )}
        {/* Save/Discard buttons when there are changes */}
        {hasChanges && (
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDiscard}
              disabled={isSaving}
              className="text-muted hover:text-foreground h-7 px-2 text-xs"
            >
              Discard
            </Button>
            <Button
              size="sm"
              onClick={() => void handleSave()}
              disabled={isSaving}
              className="h-7 px-2 text-xs"
            >
              {isSaving ? "Saving..." : "Save"}
            </Button>
          </div>
        )}
      </div>

      {/* Secrets list */}
      {secrets.length === 0 ? (
        <p className="text-muted py-2 text-sm">No secrets configured yet.</p>
      ) : (
        <div className="space-y-2">
          {/* Column headers */}
          <div className="grid grid-cols-[1fr_1fr_auto_auto] items-center gap-2 px-0.5">
            <span className="text-muted text-[10px] tracking-wide uppercase">Key</span>
            <span className="text-muted text-[10px] tracking-wide uppercase">Value</span>
            <div className="w-7" />
            <div className="w-7" />
          </div>
          {/* Secret rows */}
          {secrets.map((secret, index) => (
            <div key={index} className="grid grid-cols-[1fr_1fr_auto_auto] items-center gap-2">
              <input
                type="text"
                value={secret.key}
                onChange={(e) => updateSecret(index, "key", e.target.value)}
                placeholder="SECRET_NAME"
                disabled={isSaving}
                className="bg-modal-bg border-border-medium focus:border-accent placeholder:text-dim h-8 w-full rounded border px-2.5 font-mono text-xs text-white focus:outline-none"
              />
              <input
                type={visibleSecrets.has(index) ? "text" : "password"}
                value={secret.value}
                onChange={(e) => updateSecret(index, "value", e.target.value)}
                placeholder="secret value"
                disabled={isSaving}
                className="bg-modal-bg border-border-medium focus:border-accent placeholder:text-dim h-8 w-full rounded border px-2.5 font-mono text-xs text-white focus:outline-none"
              />
              <Button
                variant="ghost"
                size="icon"
                onClick={() => toggleVisibility(index)}
                disabled={isSaving}
                className="text-muted hover:text-foreground h-7 w-7"
                aria-label={visibleSecrets.has(index) ? "Hide value" : "Show value"}
              >
                {visibleSecrets.has(index) ? (
                  <EyeOff className="h-3.5 w-3.5" />
                ) : (
                  <Eye className="h-3.5 w-3.5" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => removeSecret(index)}
                disabled={isSaving}
                className="text-muted hover:text-danger-light h-7 w-7"
                aria-label="Delete secret"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* Info text */}
      <p className="text-muted text-xs">
        Secrets are stored in <code className="text-accent">~/.mux/secrets.json</code> and injected
        as environment variables to agent tools.
      </p>
    </div>
  );
};
