import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";

import { resolveCoderAvailability } from "@/browser/components/ChatInput/CoderControls";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/ui/select";
import { Switch } from "@/browser/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/ui/tooltip";
import { useAPI } from "@/browser/contexts/API";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import { useRuntimeEnablement } from "@/browser/hooks/useRuntimeEnablement";
import { RUNTIME_CHOICE_UI, type RuntimeUiSpec } from "@/browser/utils/runtimeUi";
import { cn } from "@/common/lib/utils";
import type { CoderInfo } from "@/common/orpc/schemas/coder";
import type {
  RuntimeAvailabilityStatus,
  RuntimeEnablement,
  RuntimeEnablementId,
  RuntimeMode,
} from "@/common/types/runtime";
import { RUNTIME_ENABLEMENT_IDS } from "@/common/types/runtime";

type RuntimeAvailabilityMap = Record<RuntimeMode, RuntimeAvailabilityStatus>;

type RuntimeRow = { id: RuntimeEnablementId } & RuntimeUiSpec;

type RuntimeAvailabilityState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "failed" }
  | { status: "loaded"; data: RuntimeAvailabilityMap };

interface RuntimeOverrideCacheEntry {
  enablement: RuntimeEnablement;
  defaultRuntime: RuntimeEnablementId | null;
}

const ALL_SCOPE_VALUE = "__all__";

const RUNTIME_ROWS: RuntimeRow[] = [
  { id: "local", ...RUNTIME_CHOICE_UI.local },
  { id: "worktree", ...RUNTIME_CHOICE_UI.worktree },
  { id: "ssh", ...RUNTIME_CHOICE_UI.ssh },
  { id: "coder", ...RUNTIME_CHOICE_UI.coder },
  { id: "docker", ...RUNTIME_CHOICE_UI.docker },
  { id: "devcontainer", ...RUNTIME_CHOICE_UI.devcontainer },
];

function getProjectLabel(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}

function mergeRuntimeEnablement(
  base: RuntimeEnablement,
  overrides?: Partial<Record<RuntimeEnablementId, false>>
): RuntimeEnablement {
  const merged: RuntimeEnablement = { ...base };

  if (!overrides) {
    return merged;
  }

  // Project configs store only disabled runtimes; merge so the UI reflects the effective values.
  for (const runtimeId of RUNTIME_ENABLEMENT_IDS) {
    if (overrides[runtimeId] === false) {
      merged[runtimeId] = false;
    }
  }

  return merged;
}

function getFallbackRuntime(enablement: RuntimeEnablement): RuntimeEnablementId | null {
  return RUNTIME_ROWS.find((runtime) => enablement[runtime.id])?.id ?? null;
}

export function RuntimesSection() {
  const { api } = useAPI();
  const { projects, refreshProjects } = useProjectContext();
  const { enablement, setRuntimeEnabled, defaultRuntime, setDefaultRuntime } =
    useRuntimeEnablement();

  const projectList = Array.from(projects.keys());

  const [selectedScope, setSelectedScope] = useState(ALL_SCOPE_VALUE);
  const [projectOverrideEnabled, setProjectOverrideEnabled] = useState(false);
  const [projectEnablement, setProjectEnablement] = useState<RuntimeEnablement>(enablement);
  const [projectDefaultRuntime, setProjectDefaultRuntime] = useState<RuntimeEnablementId | null>(
    defaultRuntime
  );
  const [runtimeAvailabilityState, setRuntimeAvailabilityState] =
    useState<RuntimeAvailabilityState>({ status: "idle" });
  const [coderInfo, setCoderInfo] = useState<CoderInfo | null>(null);
  // Cache per-project overrides locally because config writes don't refresh the project context.
  const overrideCacheRef = useRef(new Map<string, RuntimeOverrideCacheEntry>());

  const selectedProjectPath = selectedScope === ALL_SCOPE_VALUE ? null : selectedScope;
  const isProjectScope = Boolean(selectedProjectPath);
  const isProjectOverrideActive = isProjectScope && projectOverrideEnabled;

  const syncProjects = () => {
    refreshProjects().catch(() => {
      // Best-effort only.
    });
  };

  useEffect(() => {
    if (selectedScope === ALL_SCOPE_VALUE) {
      return;
    }

    if (!projects.has(selectedScope)) {
      setSelectedScope(ALL_SCOPE_VALUE);
    }
  }, [projects, selectedScope]);

  useEffect(() => {
    if (!selectedProjectPath) {
      setProjectOverrideEnabled(false);
      setProjectEnablement(enablement);
      setProjectDefaultRuntime(defaultRuntime ?? null);
      return;
    }

    // Check local cache first (backend writes aren't reflected in context until reload).
    const cached = overrideCacheRef.current.get(selectedProjectPath);
    if (cached) {
      setProjectOverrideEnabled(true);
      setProjectEnablement(cached.enablement);
      setProjectDefaultRuntime(cached.defaultRuntime);
      return;
    }

    const projectConfig = projects.get(selectedProjectPath);
    const hasOverrides =
      projectConfig?.runtimeOverridesEnabled === true ||
      Boolean(projectConfig?.runtimeEnablement) ||
      projectConfig?.defaultRuntime !== undefined;

    setProjectOverrideEnabled(hasOverrides);
    setProjectEnablement(mergeRuntimeEnablement(enablement, projectConfig?.runtimeEnablement));
    setProjectDefaultRuntime(projectConfig?.defaultRuntime ?? defaultRuntime ?? null);
  }, [defaultRuntime, enablement, projects, selectedProjectPath]);

  useEffect(() => {
    if (!api || !selectedProjectPath) {
      setRuntimeAvailabilityState({ status: "idle" });
      return;
    }

    let active = true;
    setRuntimeAvailabilityState({ status: "loading" });

    api.projects
      .runtimeAvailability({ projectPath: selectedProjectPath })
      .then((availability) => {
        if (active) {
          setRuntimeAvailabilityState({ status: "loaded", data: availability });
        }
      })
      .catch(() => {
        if (active) {
          setRuntimeAvailabilityState({ status: "failed" });
        }
      });

    return () => {
      active = false;
    };
  }, [api, selectedProjectPath]);

  useEffect(() => {
    if (!api) {
      setCoderInfo(null);
      return;
    }

    let active = true;

    api.coder
      .getInfo()
      .then((info) => {
        if (active) {
          setCoderInfo(info);
        }
      })
      .catch(() => {
        if (active) {
          setCoderInfo({
            state: "unavailable",
            reason: { kind: "error", message: "Failed to fetch" },
          });
        }
      });

    return () => {
      active = false;
    };
  }, [api]);

  const coderAvailability = resolveCoderAvailability(coderInfo);
  const availabilityMap =
    runtimeAvailabilityState.status === "loaded" ? runtimeAvailabilityState.data : null;

  const effectiveEnablement = isProjectOverrideActive ? projectEnablement : enablement;
  const effectiveDefaultRuntime = isProjectOverrideActive ? projectDefaultRuntime : defaultRuntime;

  const enabledRuntimeOptions = RUNTIME_ROWS.filter((runtime) => effectiveEnablement[runtime.id]);
  const enabledRuntimeCount = enabledRuntimeOptions.length;

  const defaultRuntimeValue =
    effectiveDefaultRuntime && effectiveEnablement[effectiveDefaultRuntime]
      ? effectiveDefaultRuntime
      : "";
  const defaultRuntimePlaceholder =
    enabledRuntimeOptions.length === 0 ? "No runtimes enabled" : "Select default runtime";
  const defaultRuntimeDisabled =
    enabledRuntimeOptions.length === 0 || (isProjectScope && !projectOverrideEnabled);

  const handleOverrideToggle = (checked: boolean) => {
    if (!selectedProjectPath) {
      return;
    }

    if (!checked) {
      setProjectOverrideEnabled(false);
      setProjectEnablement(enablement);
      setProjectDefaultRuntime(defaultRuntime ?? null);
      overrideCacheRef.current.delete(selectedProjectPath);
      api?.config
        ?.updateRuntimeEnablement({
          projectPath: selectedProjectPath,
          runtimeEnablement: null,
          defaultRuntime: null,
          runtimeOverridesEnabled: null,
        })
        .then(() => {
          syncProjects();
        })
        .catch(() => {
          // Best-effort only.
        });
      return;
    }

    const nextEnablement = { ...enablement };
    setProjectOverrideEnabled(true);
    setProjectEnablement(nextEnablement);
    setProjectDefaultRuntime(defaultRuntime ?? null);
    overrideCacheRef.current.set(selectedProjectPath, {
      enablement: nextEnablement,
      defaultRuntime: defaultRuntime ?? null,
    });

    api?.config
      ?.updateRuntimeEnablement({
        projectPath: selectedProjectPath,
        runtimeEnablement: nextEnablement,
        defaultRuntime: defaultRuntime ?? null,
        runtimeOverridesEnabled: true,
      })
      .then(() => {
        syncProjects();
      })
      .catch(() => {
        // Best-effort only.
      });
  };

  const handleRuntimeToggle = (runtimeId: RuntimeEnablementId, enabled: boolean) => {
    if (!enabled) {
      // Keep at least one runtime enabled to avoid leaving users without a fallback.
      const currentEnabledCount = RUNTIME_ROWS.filter(
        (runtime) => effectiveEnablement[runtime.id]
      ).length;
      if (currentEnabledCount <= 1) {
        return;
      }
    }

    const nextEnablement: RuntimeEnablement = {
      ...effectiveEnablement,
      [runtimeId]: enabled,
    };

    if (!isProjectScope) {
      setRuntimeEnabled(runtimeId, enabled);
      if (defaultRuntime && !nextEnablement[defaultRuntime]) {
        setDefaultRuntime(getFallbackRuntime(nextEnablement));
      }
      return;
    }

    if (!selectedProjectPath || !projectOverrideEnabled) {
      return;
    }

    setProjectEnablement(nextEnablement);

    let nextDefaultRuntime = projectDefaultRuntime ?? null;
    if (nextDefaultRuntime && !nextEnablement[nextDefaultRuntime]) {
      nextDefaultRuntime = getFallbackRuntime(nextEnablement);
      setProjectDefaultRuntime(nextDefaultRuntime);
    }
    overrideCacheRef.current.set(selectedProjectPath, {
      enablement: nextEnablement,
      defaultRuntime: nextDefaultRuntime,
    });

    const updatePayload: {
      projectPath: string;
      runtimeEnablement: RuntimeEnablement;
      defaultRuntime?: RuntimeEnablementId | null;
      runtimeOverridesEnabled?: boolean;
    } = {
      projectPath: selectedProjectPath,
      runtimeEnablement: nextEnablement,
      runtimeOverridesEnabled: true,
    };

    if (nextDefaultRuntime !== projectDefaultRuntime) {
      updatePayload.defaultRuntime = nextDefaultRuntime ?? null;
    }

    api?.config
      ?.updateRuntimeEnablement(updatePayload)
      .then(() => {
        syncProjects();
      })
      .catch(() => {
        // Best-effort only.
      });
  };

  const handleDefaultRuntimeChange = (value: string) => {
    const runtimeId = value as RuntimeEnablementId;

    if (!isProjectScope) {
      setDefaultRuntime(runtimeId);
      return;
    }

    if (!selectedProjectPath || !projectOverrideEnabled) {
      return;
    }

    setProjectDefaultRuntime(runtimeId);
    overrideCacheRef.current.set(selectedProjectPath, {
      enablement: projectEnablement,
      defaultRuntime: runtimeId,
    });
    api?.config
      ?.updateRuntimeEnablement({
        projectPath: selectedProjectPath,
        defaultRuntime: runtimeId,
        runtimeOverridesEnabled: true,
      })
      .then(() => {
        syncProjects();
      })
      .catch(() => {
        // Best-effort only.
      });
  };

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-foreground text-sm">Scope</div>
            <div className="text-muted text-xs">Manage runtimes globally or per project.</div>
          </div>
          <Select value={selectedScope} onValueChange={setSelectedScope}>
            <SelectTrigger
              className="border-border-medium bg-background-secondary hover:bg-hover h-9 w-auto min-w-[160px] cursor-pointer rounded-md border px-3 text-sm transition-colors"
              aria-label="Scope"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_SCOPE_VALUE}>All</SelectItem>
              {projectList.map((path) => (
                <SelectItem key={path} value={path}>
                  {getProjectLabel(path)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {isProjectScope ? (
          <div className="border-border-light bg-background-secondary flex items-center justify-between gap-4 rounded-md border px-3 py-2">
            <div>
              <div className="text-foreground text-sm">Override project settings</div>
              <div className="text-muted text-xs">
                Keep global defaults or customize enabled runtimes for this project.
              </div>
            </div>
            <Switch
              checked={projectOverrideEnabled}
              onCheckedChange={handleOverrideToggle}
              aria-label="Override project runtime settings"
            />
          </div>
        ) : null}
      </div>

      <div className="space-y-4">
        <div
          className={cn(
            "flex items-center justify-between gap-4",
            isProjectScope && !projectOverrideEnabled && "opacity-60"
          )}
        >
          <div>
            <div className="text-foreground text-sm">Default runtime</div>
            <div className="text-muted text-xs">
              {isProjectScope
                ? "Applied to new workspaces in this project."
                : "Applied to new workspaces by default."}
            </div>
          </div>
          <Select
            value={defaultRuntimeValue}
            onValueChange={handleDefaultRuntimeChange}
            disabled={defaultRuntimeDisabled}
          >
            <SelectTrigger className="border-border-medium bg-background-secondary hover:bg-hover h-9 w-auto min-w-[180px] cursor-pointer rounded-md border px-3 text-sm transition-colors">
              <SelectValue placeholder={defaultRuntimePlaceholder} />
            </SelectTrigger>
            <SelectContent>
              {enabledRuntimeOptions.map((runtime) => (
                <SelectItem key={runtime.id} value={runtime.id}>
                  {runtime.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="divide-border-light divide-y">
          {RUNTIME_ROWS.map((runtime) => {
            const Icon = runtime.Icon;
            const isCoder = runtime.id === "coder";
            const availability = isCoder
              ? null
              : (availabilityMap?.[runtime.id as RuntimeMode] ?? null);
            const availabilityReason = isProjectScope
              ? isCoder
                ? coderAvailability.state !== "available" && coderAvailability.state !== "loading"
                  ? coderAvailability.reason
                  : null
                : availability && !availability.available
                  ? availability.reason
                  : null
              : null;
            const showLoading = isProjectScope
              ? isCoder
                ? coderAvailability.state === "loading"
                : runtimeAvailabilityState.status === "loading"
              : false;
            const rowDisabled = isProjectScope && !projectOverrideEnabled;
            const isLastEnabled = effectiveEnablement[runtime.id] && enabledRuntimeCount <= 1;
            const switchDisabled = rowDisabled || isLastEnabled;
            const switchControl = (
              <Switch
                checked={effectiveEnablement[runtime.id]}
                disabled={switchDisabled}
                onCheckedChange={(checked) => handleRuntimeToggle(runtime.id, checked)}
                aria-label={`Toggle ${runtime.label} runtime`}
              />
            );
            const switchNode =
              isLastEnabled && !rowDisabled ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex">{switchControl}</span>
                  </TooltipTrigger>
                  <TooltipContent align="end">At least one runtime must be enabled.</TooltipContent>
                </Tooltip>
              ) : (
                switchControl
              );

            // Inline status indicators keep availability feedback from shifting row layout.
            return (
              <div
                key={runtime.id}
                className={cn(
                  "flex items-start justify-between gap-4 py-3",
                  rowDisabled && "opacity-60"
                )}
              >
                <div className="flex flex-1 gap-3 pr-4">
                  <Icon size={16} className="text-muted mt-0.5" />
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <div className="text-foreground text-sm">{runtime.label}</div>
                      {availabilityReason ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="bg-warning/10 text-warning border-warning/30 inline-flex cursor-help items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px]">
                              <AlertTriangle className="h-3 w-3" />
                              Unavailable
                            </span>
                          </TooltipTrigger>
                          <TooltipContent align="start" className="max-w-64 whitespace-normal">
                            {availabilityReason}
                          </TooltipContent>
                        </Tooltip>
                      ) : null}
                    </div>
                    <div className="text-muted text-xs">{runtime.description}</div>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex h-4 w-4 items-center justify-center">
                    {showLoading ? <Loader2 className="text-muted h-4 w-4 animate-spin" /> : null}
                  </div>
                  {switchNode}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
