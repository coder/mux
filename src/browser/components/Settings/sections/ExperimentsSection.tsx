import React, { useCallback, useMemo } from "react";
import { useExperiment, useRemoteExperimentValue } from "@/browser/contexts/ExperimentsContext";
import {
  getExperimentList,
  EXPERIMENT_IDS,
  type ExperimentId,
} from "@/common/constants/experiments";
import { Switch } from "@/browser/components/ui/switch";
import { useFeatureFlags } from "@/browser/contexts/FeatureFlagsContext";
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

function StatsTabRow() {
  const { statsTabState, setStatsTabEnabled } = useFeatureFlags();

  const handleToggle = useCallback(
    (enabled: boolean) => {
      setStatsTabEnabled(enabled).catch(() => {
        // ignore
      });
    },
    [setStatsTabEnabled]
  );

  return (
    <div className="flex items-center justify-between py-3">
      <div className="flex-1 pr-4">
        <div className="text-foreground text-sm font-medium">Stats tab</div>
        <div className="text-muted mt-0.5 text-xs">Show timing statistics in the right sidebar</div>
      </div>
      <Switch
        checked={statsTabState?.enabled ?? false}
        onCheckedChange={handleToggle}
        aria-label="Toggle Stats tab"
      />
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
        <StatsTabRow />
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
