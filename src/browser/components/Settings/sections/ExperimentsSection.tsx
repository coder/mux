import React, { useCallback, useMemo } from "react";
import { useExperiment, useRemoteExperimentValue } from "@/browser/contexts/ExperimentsContext";
import {
  getExperimentList,
  EXPERIMENT_IDS,
  type ExperimentId,
} from "@/common/constants/experiments";
import { Switch } from "@/browser/components/ui/switch";
import { useFeatureFlags, type StatsTabOverride } from "@/browser/contexts/FeatureFlagsContext";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { useTelemetry } from "@/browser/hooks/useTelemetry";

interface ExperimentRowProps {
  experimentId: ExperimentId;
  name: string;
  description: string;
  onToggle?: (enabled: boolean) => void;
}

function ExperimentRow(props: ExperimentRowProps) {
  const [enabled, setEnabled] = useExperiment(props.experimentId);
  const remote = useRemoteExperimentValue(props.experimentId);
  const telemetry = useTelemetry();
  const { onToggle, experimentId } = props;

  const handleToggle = useCallback(
    (value: boolean) => {
      setEnabled(value);
      // Track the override for analytics
      telemetry.experimentOverridden(experimentId, remote?.value ?? null, value);
      onToggle?.(value);
    },
    [setEnabled, telemetry, experimentId, remote?.value, onToggle]
  );

  return (
    <div className="flex items-center justify-between py-3">
      <div className="flex-1 pr-4">
        <div className="text-foreground text-sm font-medium">{props.name}</div>
        <div className="text-muted mt-0.5 text-xs">{props.description}</div>
      </div>
      <Switch
        checked={enabled}
        onCheckedChange={handleToggle}
        aria-label={`Toggle ${props.name}`}
      />
    </div>
  );
}

function StatsTabOverrideRow() {
  const { statsTabState, setStatsTabOverride } = useFeatureFlags();

  const onChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value as StatsTabOverride;
    setStatsTabOverride(value).catch(() => {
      // ignore
    });
  };

  return (
    <div className="flex items-center justify-between py-3">
      <div className="flex-1 pr-4">
        <div className="text-foreground text-sm font-medium">Stats tab</div>
        <div className="text-muted mt-0.5 text-xs">
          PostHog experiment-gated timing stats sidebar. Experiment variant:{" "}
          {statsTabState?.variant ?? "—"}.
        </div>
      </div>
      <select
        className="bg-background text-foreground border-border-light rounded-md border px-2 py-1 text-xs"
        value={statsTabState?.override ?? "default"}
        onChange={onChange}
        aria-label="Stats tab override"
      >
        <option value="default">Default (experiment)</option>
        <option value="on">Always on</option>
        <option value="off">Always off</option>
      </select>
    </div>
  );
}

export function ExperimentsSection() {
  const allExperiments = getExperimentList();
  const { refreshWorkspaceMetadata } = useWorkspaceContext();

  // Only show user-overridable experiments (non-overridable ones are hidden since users can't change them)
  const experiments = useMemo(
    () =>
      allExperiments.filter((exp) => exp.showInSettings !== false && exp.userOverridable === true),
    [allExperiments]
  );

  // When post-compaction experiment is toggled, refresh metadata to fetch/clear bundled state
  const handlePostCompactionToggle = useCallback(() => {
    refreshWorkspaceMetadata().catch(() => {
      // ignore
    });
  }, [refreshWorkspaceMetadata]);

  return (
    <div className="space-y-2">
      <p className="text-muted mb-4 text-xs">
        Experimental features that are still in development. Enable at your own risk.
      </p>
      <div className="divide-border-light divide-y">
        <StatsTabOverrideRow />
        {experiments.map((exp) => (
          <ExperimentRow
            key={exp.id}
            experimentId={exp.id}
            name={exp.name}
            description={exp.description}
            onToggle={
              exp.id === EXPERIMENT_IDS.POST_COMPACTION_CONTEXT
                ? handlePostCompactionToggle
                : undefined
            }
          />
        ))}
      </div>
      {experiments.length === 0 && (
        <p className="text-muted py-4 text-center text-sm">
          No experiments available at this time.
        </p>
      )}
    </div>
  );
}
