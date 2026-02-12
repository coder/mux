import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { resolveCoderAvailability } from "@/browser/components/ChatInput/CoderControls";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/ui/select";
import { Switch } from "@/browser/components/ui/switch";
import { useAPI } from "@/browser/contexts/API";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import { useRuntimeEnablement } from "@/browser/hooks/useRuntimeEnablement";
import { RUNTIME_CHOICE_UI, type RuntimeUiSpec } from "@/browser/utils/runtimeUi";
import type { CoderInfo } from "@/common/orpc/schemas/coder";
import type {
  RuntimeAvailabilityStatus,
  RuntimeEnablementId,
  RuntimeMode,
} from "@/common/types/runtime";

type RuntimeAvailabilityMap = Record<RuntimeMode, RuntimeAvailabilityStatus>;

type RuntimeRow = { id: RuntimeEnablementId } & RuntimeUiSpec;

type RuntimeAvailabilityState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "failed" }
  | { status: "loaded"; data: RuntimeAvailabilityMap };

export function RuntimesSection() {
  const { api } = useAPI();
  const { projects } = useProjectContext();
  const { enablement, setRuntimeEnabled } = useRuntimeEnablement();

  const projectList = Array.from(projects.keys());
  const hasProjects = projectList.length > 0;

  const [selectedProject, setSelectedProject] = useState("");
  const [runtimeAvailabilityState, setRuntimeAvailabilityState] =
    useState<RuntimeAvailabilityState>({ status: "idle" });
  const [coderInfo, setCoderInfo] = useState<CoderInfo | null>(null);

  // Runtime availability is project-scoped, so keep the selection aligned with known projects.
  useEffect(() => {
    if (projects.size === 0) {
      if (selectedProject) {
        setSelectedProject("");
      }
      return;
    }

    if (!selectedProject || !projects.has(selectedProject)) {
      const firstProject = Array.from(projects.keys())[0] ?? "";
      if (firstProject && firstProject !== selectedProject) {
        setSelectedProject(firstProject);
      }
    }
  }, [projects, selectedProject]);

  useEffect(() => {
    if (!api || !selectedProject) {
      setRuntimeAvailabilityState({ status: "idle" });
      return;
    }

    let active = true;
    setRuntimeAvailabilityState({ status: "loading" });

    api.projects
      .runtimeAvailability({ projectPath: selectedProject })
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
  }, [api, selectedProject]);

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
  const showAvailabilityLoading =
    runtimeAvailabilityState.status === "loading" || coderAvailability.state === "loading";

  const RUNTIME_ROWS: RuntimeRow[] = [
    { id: "local", ...RUNTIME_CHOICE_UI.local },
    { id: "worktree", ...RUNTIME_CHOICE_UI.worktree },
    { id: "ssh", ...RUNTIME_CHOICE_UI.ssh },
    { id: "coder", ...RUNTIME_CHOICE_UI.coder },
    { id: "docker", ...RUNTIME_CHOICE_UI.docker },
    { id: "devcontainer", ...RUNTIME_CHOICE_UI.devcontainer },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-foreground mb-4 text-sm font-medium">Runtime availability</h3>
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-foreground text-sm">Project</div>
              <div className="text-muted text-xs">Select a project to check availability</div>
            </div>
            <Select
              value={selectedProject}
              onValueChange={setSelectedProject}
              disabled={!hasProjects}
            >
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

          {!hasProjects ? (
            <div className="text-muted text-sm">Add a project to see runtime availability.</div>
          ) : null}

          {showAvailabilityLoading ? (
            <div className="text-muted flex items-center gap-2 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              Checking runtime availability…
            </div>
          ) : null}
        </div>
      </div>

      <div>
        <h3 className="text-foreground mb-4 text-sm font-medium">Enabled runtimes</h3>
        <div className="divide-border-light divide-y">
          {RUNTIME_ROWS.map((runtime) => {
            const Icon = runtime.Icon;
            const isCoder = runtime.id === "coder";
            const availability = isCoder ? null : availabilityMap?.[runtime.id as RuntimeMode];
            const availabilityReason = isCoder
              ? coderAvailability.state !== "available" && coderAvailability.state !== "loading"
                ? coderAvailability.reason
                : null
              : availability && !availability.available
                ? availability.reason
                : null;

            return (
              <div key={runtime.id} className="flex items-start justify-between gap-4 py-3">
                <div className="flex flex-1 gap-3 pr-4">
                  <Icon size={16} className="text-muted mt-0.5" />
                  <div className="flex-1">
                    <div className="text-foreground text-sm">{runtime.label}</div>
                    <div className="text-muted text-xs">{runtime.description}</div>
                    {availabilityReason ? (
                      <p className="mt-1 text-xs text-yellow-500">{availabilityReason}</p>
                    ) : null}
                  </div>
                </div>
                <Switch
                  checked={enablement[runtime.id]}
                  onCheckedChange={(checked) => setRuntimeEnabled(runtime.id, checked)}
                  aria-label={`Toggle ${runtime.label} runtime`}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
