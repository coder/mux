import React, { useCallback, useEffect, useRef, useState } from "react";
import { KeyRound, Loader2, Trash2 } from "lucide-react";
import { isOpSecretValue, type Secret } from "@/common/types/secrets";
import { useAPI } from "@/browser/contexts/API";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { Button } from "@/browser/components/Button/Button";
import { Input } from "@/browser/components/Input/Input";
import { Switch } from "@/browser/components/Switch/Switch";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/browser/components/Tooltip/Tooltip";
import { OnePasswordPicker } from "../Components/OnePasswordPicker";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/browser/components/ToggleGroupPrimitive/ToggleGroupPrimitive";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/SelectPrimitive/SelectPrimitive";

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

function isSecretReferenceValue(value: Secret["value"]): value is { secret: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "secret" in value &&
    typeof (value as { secret?: unknown }).secret === "string"
  );
}

function secretValuesEqual(a: Secret["value"], b: Secret["value"]): boolean {
  if (typeof a === "string" && typeof b === "string") {
    return a === b;
  }

  if (isSecretReferenceValue(a) && isSecretReferenceValue(b)) {
    return a.secret === b.secret;
  }

  if (isOpSecretValue(a) && isOpSecretValue(b)) {
    return a.op === b.op && a.opLabel === b.opLabel;
  }

  return false;
}

function secretValueIsNonEmpty(value: Secret["value"]): boolean {
  if (typeof value === "string") {
    return value.trim() !== "";
  }

  if (isSecretReferenceValue(value)) {
    return value.secret.trim() !== "";
  }

  if (isOpSecretValue(value)) {
    return value.op.trim() !== "";
  }

  return false;
}

function secretsEqual(a: Secret[], b: Secret[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (!left || !right) return false;
    if (left.key !== right.key) return false;
    if (!secretValuesEqual(left.value, right.value)) return false;
    if (!!left.injectAll !== !!right.injectAll) return false;
  }
  return true;
}

export const SecretsSection: React.FC = () => {
  const { api } = useAPI();
  const { userProjects } = useProjectContext();
  const { secretsProjectPath, setSecretsProjectPath } = useSettings();
  const projectList = Array.from(userProjects.keys());

  // Consume one-shot project scope hint from the sidebar secrets button.
  const initialScope: SecretsScope =
    secretsProjectPath && userProjects.has(secretsProjectPath) ? "project" : "global";
  const initialProject = initialScope === "project" ? secretsProjectPath! : "";

  const [scope, setScope] = useState<SecretsScope>(initialScope);
  const [selectedProject, setSelectedProject] = useState<string>(initialProject);

  const [loadedSecrets, setLoadedSecrets] = useState<Secret[]>([]);
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [visibleSecrets, setVisibleSecrets] = useState<Set<number>>(() => new Set());

  const [globalSecretKeys, setGlobalSecretKeys] = useState<string[]>([]);
  const [opAvailable, setOpAvailable] = useState(false);
  const [opPickerIndex, setOpPickerIndex] = useState<number | null>(null);

  const [opAccountName, setOpAccountName] = useState("");
  const [opAvailabilityVersion, setOpAvailabilityVersion] = useState(0);
  const [injectedGlobalSecretKeys, setInjectedGlobalSecretKeys] = useState<string[]>([]);

  // Track the last plaintext value per row index so toggling Source back to
  // "Value" restores the user's input instead of clearing it.
  const lastLiteralValuesRef = useRef<Map<number, string>>(new Map());

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scopeLabel = scope === "global" ? "Global" : "Project";
  const showSourceColumn = scope === "project" || opAvailable;

  // When re-opened with a new project hint (e.g., clicking the secrets button again
  // for a different project), sync the scope and clear the one-shot hint.
  // Only clear the hint once the project is actually found in the project list;
  // projects load asynchronously, so we must keep the hint alive until then.
  useEffect(() => {
    if (!secretsProjectPath) return;
    if (!userProjects.has(secretsProjectPath)) return;
    setScope("project");
    setSelectedProject(secretsProjectPath);
    setSecretsProjectPath(null);
  }, [secretsProjectPath, userProjects, setSecretsProjectPath]);

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

  const sortedGlobalSecretKeys = globalSecretKeys
    .slice()
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

  const sortedInjectedGlobalSecretKeys = injectedGlobalSecretKeys
    .slice()
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

  const loadSecrets = useCallback(async () => {
    if (!api) {
      setLoadedSecrets([]);
      setSecrets([]);
      setInjectedGlobalSecretKeys([]);
      setVisibleSecrets(new Set());
      setOpPickerIndex(null);
      setError(null);
      return;
    }

    if (scope === "project" && !currentProjectPath) {
      setLoadedSecrets([]);
      setSecrets([]);
      setInjectedGlobalSecretKeys([]);
      setVisibleSecrets(new Set());
      setOpPickerIndex(null);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      if (scope === "project") {
        const projectPath = currentProjectPath;
        if (!projectPath) {
          setLoadedSecrets([]);
          setSecrets([]);
          setInjectedGlobalSecretKeys([]);
          setVisibleSecrets(new Set());
          setError(null);
          return;
        }

        const [nextSecrets, injectedKeys] = await Promise.all([
          api.secrets.get({ projectPath }),
          api.secrets.getInjectedGlobals({ projectPath }),
        ]);
        setLoadedSecrets(nextSecrets);
        setSecrets(nextSecrets);
        setInjectedGlobalSecretKeys(injectedKeys);
      } else {
        const nextSecrets = await api.secrets.get({});
        setLoadedSecrets(nextSecrets);
        setSecrets(nextSecrets);
        setInjectedGlobalSecretKeys([]);
      }

      setVisibleSecrets(new Set());
      setOpPickerIndex(null);
      lastLiteralValuesRef.current = new Map();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load secrets";
      setLoadedSecrets([]);
      setSecrets([]);
      setInjectedGlobalSecretKeys([]);
      setVisibleSecrets(new Set());
      setOpPickerIndex(null);
      lastLiteralValuesRef.current = new Map();
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [api, currentProjectPath, scope]);

  useEffect(() => {
    void loadSecrets();
  }, [loadSecrets]);

  useEffect(() => {
    if (!api) {
      setOpAvailable(false);
      setOpPickerIndex(null);
      return;
    }

    let cancelled = false;
    void api.onePassword
      .isAvailable()
      .then((result) => {
        if (cancelled) {
          return;
        }

        setOpAvailable(result.available);
        if (!result.available) {
          setOpPickerIndex(null);
        }
      })
      .catch(() => {
        if (cancelled) {
          return;
        }

        setOpAvailable(false);
        setOpPickerIndex(null);
      });

    return () => {
      cancelled = true;
    };
  }, [api, opAvailabilityVersion]);

  useEffect(() => {
    if (!api) {
      setOpAccountName("");
      return;
    }

    let cancelled = false;
    void api.config
      .getConfig()
      .then((config) => {
        if (cancelled) {
          return;
        }

        setOpAccountName(config.onePasswordAccountName ?? "");
      })
      .catch(() => {
        // Best-effort only.
      });

    return () => {
      cancelled = true;
    };
  }, [api]);

  const handleOpAccountNameChange = useCallback((value: string) => {
    setOpAccountName(value);
  }, []);

  const handleOpAccountNameBlur = useCallback(
    (value: string) => {
      void api?.config
        .updateOnePasswordAccountName({ onePasswordAccountName: value || null })
        .then(() => {
          // Trigger a fresh availability check after account changes.
          setOpAvailabilityVersion((version) => version + 1);
        });
    },
    [api]
  );

  // Load global secret keys (used for {secret:"KEY"} project secret values).
  useEffect(() => {
    if (!api) {
      setGlobalSecretKeys([]);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const secrets = await api.secrets.get({});
        if (cancelled) return;
        setGlobalSecretKeys(secrets.map((s) => s.key));
      } catch (err) {
        if (cancelled) return;
        console.error("Failed to load global secrets:", err);
        setGlobalSecretKeys([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [api]);

  const addSecret = useCallback(() => {
    setSecrets((prev) => [...prev, { key: "", value: "" }]);
  }, []);

  const removeSecret = useCallback((index: number) => {
    setSecrets((prev) => prev.filter((_, i) => i !== index));

    // Keep visibility state aligned with the remaining rows.
    //
    // Visibility is tracked by array index; deleting a row shifts later indices.
    // If we don't shift the visibility set too, we can end up revealing a different secret.
    setVisibleSecrets((prev) => {
      const next = new Set<number>();
      for (const visibleIndex of prev) {
        if (visibleIndex === index) {
          continue;
        }
        next.add(visibleIndex > index ? visibleIndex - 1 : visibleIndex);
      }
      return next;
    });

    setOpPickerIndex((prev) => {
      if (prev == null) {
        return prev;
      }

      if (prev === index) {
        return null;
      }

      return prev > index ? prev - 1 : prev;
    });

    // Shift cached literal values the same way so the right value is restored
    // if the user toggles the source back on a shifted row.
    const cache = lastLiteralValuesRef.current;
    const shifted = new Map<number, string>();
    for (const [i, val] of cache) {
      if (i === index) continue;
      shifted.set(i > index ? i - 1 : i, val);
    }
    lastLiteralValuesRef.current = shifted;
  }, []);

  const updateSecretKey = useCallback((index: number, value: string) => {
    setSecrets((prev) => {
      const next = [...prev];
      const existing = next[index] ?? { key: "", value: "" };

      // Auto-capitalize key field for env variable convention.
      next[index] = { ...existing, key: value.toUpperCase() };
      return next;
    });
  }, []);

  const updateSecretValue = useCallback((index: number, value: Secret["value"]) => {
    setSecrets((prev) => {
      const next = [...prev];
      const existing = next[index] ?? { key: "", value: "" };
      next[index] = { ...existing, value };
      return next;
    });
  }, []);

  const updateSecretInjectAll = useCallback((index: number, checked: boolean) => {
    setSecrets((prev) => {
      const next = [...prev];
      const existing = next[index] ?? { key: "", value: "" };
      next[index] = {
        ...existing,
        injectAll: checked || undefined,
      };
      return next;
    });
  }, []);

  const updateSecretValueKind = useCallback(
    (index: number, kind: "literal" | "global") => {
      setSecrets((prev) => {
        const next = [...prev];
        const existing = next[index] ?? { key: "", value: "" };
        const cache = lastLiteralValuesRef.current;

        if (kind === "literal") {
          // Restore the last plaintext value the user typed, if any.
          const restored = cache.get(index) ?? "";
          next[index] = {
            ...existing,
            value: typeof existing.value === "string" ? existing.value : restored,
          };
          return next;
        }

        if (isSecretReferenceValue(existing.value)) {
          return next;
        }

        // Stash the current plaintext value before switching to a global ref.
        if (typeof existing.value === "string") {
          cache.set(index, existing.value);
        }

        const defaultKey = globalSecretKeys[0] ?? "";
        next[index] = {
          ...existing,
          value: { secret: defaultKey },
        };
        return next;
      });
    },
    [globalSecretKeys]
  );

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
    setOpPickerIndex(null);
    lastLiteralValuesRef.current = new Map();
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
      const validSecrets = secrets.filter(
        (s) => s.key.trim() !== "" && secretValueIsNonEmpty(s.value)
      );

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

      if (scope === "global") {
        setGlobalSecretKeys(validSecrets.map((s) => s.key));
        setInjectedGlobalSecretKeys([]);
      } else {
        const projectPath = currentProjectPath;
        if (!projectPath) {
          setInjectedGlobalSecretKeys([]);
        } else {
          const injectedKeys = await api.secrets.getInjectedGlobals({ projectPath });
          setInjectedGlobalSecretKeys(injectedKeys);
        }
      }
      setVisibleSecrets(new Set());
      setOpPickerIndex(null);
      // Save compacts rows (filters out empty entries), which shifts indices.
      // Clear the cached literal values so stale entries can't be misattributed.
      lastLiteralValuesRef.current = new Map();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save secrets");
    } finally {
      setSaving(false);
    }
  }, [api, currentProjectPath, scope, secrets]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex-1">
          <div className="text-foreground text-sm">1Password Account</div>
          <div className="text-muted text-xs">
            Your 1Password account name (for example &apos;my-team.1password.com&apos;). Required
            for 1Password integration.
          </div>
        </div>
        <Input
          value={opAccountName}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            handleOpAccountNameChange(e.target.value)
          }
          onBlur={(e: React.FocusEvent<HTMLInputElement>) =>
            handleOpAccountNameBlur(e.target.value)
          }
          placeholder="my-team.1password.com"
          className="border-border-medium bg-background-secondary h-9 w-64"
        />
      </div>

      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-muted text-xs">
            Secrets are stored in <code className="text-accent">~/.mux/secrets.json</code> (kept out
            of source control).
          </p>
          <p className="text-muted mt-1 text-xs">
            Scope: <span className="text-foreground">{scopeLabel}</span>
          </p>
          <p className="text-muted mt-1 text-xs">
            Toggle Inject on a global secret to automatically inject it into every project.
          </p>
          <p className="text-muted mt-1 text-xs">
            Project secrets control injection. Use Type: Global to reference a global value.
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
            <SelectTrigger
              className="border-border-medium bg-background-secondary hover:bg-hover h-9 w-auto min-w-[160px] cursor-pointer rounded-md border px-3 text-sm transition-colors"
              aria-label="Project"
            >
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

      {scope === "project" && currentProjectPath && (
        <div className="space-y-2">
          <div>
            <div className="text-foreground text-sm">Injected from Global</div>
            <div className="text-muted text-xs">
              Read-only. Project secrets override injected globals when keys match.
            </div>
          </div>

          {sortedInjectedGlobalSecretKeys.length === 0 ? (
            <div className="text-muted border-border-medium rounded-md border border-dashed px-3 py-2 text-xs">
              No global secrets are currently injected into this project.
            </div>
          ) : (
            <div className="border-border-medium bg-background-secondary rounded-md border px-3 py-2">
              <div className="flex flex-wrap gap-1.5">
                {sortedInjectedGlobalSecretKeys.map((key) => (
                  <code
                    key={key}
                    className="bg-modal-bg border-border-medium text-foreground inline-flex items-center rounded border px-2 py-0.5 font-mono text-[12px]"
                  >
                    {key}
                  </code>
                ))}
              </div>
            </div>
          )}
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
        <div
          className={`[&>label]:text-muted grid ${
            showSourceColumn
              ? "grid-cols-[1fr_auto_1fr_auto_auto]"
              : "grid-cols-[1fr_1fr_auto_auto_auto]"
          } items-end gap-1 [&>label]:mb-0.5 [&>label]:text-[11px]`}
        >
          <label>Key</label>
          {showSourceColumn && <label>Source</label>}
          <label>Value</label>
          <div />
          {scope === "global" && <label className="text-center">Inject</label>}
          <div />

          {secrets.map((secret, index) => {
            const secretValue = secret.value;
            const isOp = isOpSecretValue(secretValue);
            const isReference = scope === "project" && isSecretReferenceValue(secretValue);
            const kind: "literal" | "global" | "op" = isOp
              ? "op"
              : isReference
                ? "global"
                : "literal";
            const referencedKey = isSecretReferenceValue(secretValue) ? secretValue.secret : "";
            const opReference = isOp ? secretValue.op : "";
            const opLabel = isOp ? secretValue.opLabel : undefined;
            const availableKeys =
              referencedKey && !sortedGlobalSecretKeys.includes(referencedKey)
                ? [referencedKey, ...sortedGlobalSecretKeys]
                : sortedGlobalSecretKeys;

            return (
              <React.Fragment key={index}>
                <input
                  type="text"
                  value={secret.key}
                  onChange={(e) => updateSecretKey(index, e.target.value)}
                  placeholder="SECRET_NAME"
                  aria-label="Secret key"
                  disabled={saving}
                  spellCheck={false}
                  className="bg-modal-bg border-border-medium focus:border-accent placeholder:text-dim text-foreground w-full rounded border px-2.5 py-1.5 font-mono text-[13px] focus:outline-none disabled:opacity-50"
                />

                {showSourceColumn && (
                  <Select
                    value={kind}
                    onValueChange={(value) => {
                      if (value === "op") {
                        if (!opAvailable) {
                          return;
                        }

                        setOpPickerIndex(index);
                        return;
                      }

                      if (value !== "literal" && value !== "global") {
                        return;
                      }

                      if (value === "global" && scope !== "project") {
                        return;
                      }

                      setOpPickerIndex(null);
                      updateSecretValueKind(index, value);
                    }}
                    disabled={saving}
                  >
                    <SelectTrigger
                      className="border-border-medium bg-modal-bg hover:bg-hover h-[34px] w-[100px] px-2.5 text-[13px]"
                      aria-label="Secret source"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="literal">Value</SelectItem>
                      {scope === "project" && (
                        <SelectItem value="global" disabled={availableKeys.length === 0}>
                          Global
                        </SelectItem>
                      )}
                      {opAvailable && <SelectItem value="op">1Password</SelectItem>}
                    </SelectContent>
                  </Select>
                )}

                {isOp ? (
                  <span className="text-foreground flex items-center gap-1 self-center px-2.5 font-mono text-[13px]">
                    <KeyRound className="h-3 w-3 shrink-0" />
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="truncate">{opLabel ?? opReference}</span>
                      </TooltipTrigger>
                      <TooltipContent side="top">{opReference}</TooltipContent>
                    </Tooltip>
                  </span>
                ) : isReference ? (
                  <Select
                    value={referencedKey || undefined}
                    onValueChange={(value) => updateSecretValue(index, { secret: value })}
                    disabled={saving}
                  >
                    <SelectTrigger
                      className="border-border-medium bg-modal-bg hover:bg-hover h-[34px] w-full px-2.5 font-mono text-[13px]"
                      aria-label="Global secret key"
                    >
                      <SelectValue placeholder="Select global secret" />
                    </SelectTrigger>
                    <SelectContent>
                      {availableKeys.map((key) => (
                        <SelectItem key={key} value={key}>
                          {key}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <input
                    type={visibleSecrets.has(index) ? "text" : "password"}
                    value={
                      typeof secret.value === "string"
                        ? secret.value
                        : isSecretReferenceValue(secret.value)
                          ? secret.value.secret
                          : ""
                    }
                    onChange={(e) => updateSecretValue(index, e.target.value)}
                    placeholder="secret value"
                    aria-label="Secret value"
                    disabled={saving}
                    spellCheck={false}
                    className="bg-modal-bg border-border-medium focus:border-accent placeholder:text-dim text-foreground w-full rounded border px-2.5 py-1.5 font-mono text-[13px] focus:outline-none disabled:opacity-50"
                  />
                )}

                {isReference || isOp ? (
                  <div />
                ) : (
                  <button
                    type="button"
                    onClick={() => toggleVisibility(index)}
                    disabled={saving}
                    className="text-muted hover:text-foreground flex cursor-pointer items-center justify-center self-center rounded-sm border-none bg-transparent px-1 py-0.5 text-base transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50"
                    aria-label={visibleSecrets.has(index) ? "Hide secret" : "Show secret"}
                  >
                    <ToggleVisibilityIcon visible={visibleSecrets.has(index)} />
                  </button>
                )}

                {scope === "global" && (
                  <div className="flex items-center justify-center self-center">
                    <Switch
                      size="sm"
                      checked={!!secret.injectAll}
                      onCheckedChange={(checked) => updateSecretInjectAll(index, checked)}
                      disabled={saving}
                      aria-label="Inject into all projects"
                      title="Inject into all projects"
                    />
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => removeSecret(index)}
                  disabled={saving}
                  className="text-danger-light border-danger-light hover:bg-danger-light/10 cursor-pointer rounded border bg-transparent px-2.5 py-1.5 text-[13px] transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label="Remove secret"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
                {opPickerIndex === index && (
                  <div className="col-span-full">
                    <OnePasswordPicker
                      onSelect={(opRef, opLabel) => {
                        setOpPickerIndex(null);
                        setVisibleSecrets((prev) => {
                          if (!prev.has(index)) {
                            return prev;
                          }

                          const next = new Set(prev);
                          next.delete(index);
                          return next;
                        });
                        updateSecretValue(index, { op: opRef, opLabel });
                      }}
                      onCancel={() => setOpPickerIndex(null)}
                    />
                  </div>
                )}
              </React.Fragment>
            );
          })}
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
