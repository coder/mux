import React, { useCallback } from "react";
import { useExperiment } from "@/browser/contexts/ExperimentsContext";
import {
  getExperimentList,
  EXPERIMENT_IDS,
  type ExperimentId,
} from "@/common/constants/experiments";
import { Switch } from "@/browser/components/ui/switch";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";

interface ExperimentRowProps {
  experimentId: ExperimentId;
  name: string;
  description: string;
  onToggle?: (enabled: boolean) => void;
}

function ExperimentRow(props: ExperimentRowProps) {
  const [enabled, setEnabled] = useExperiment(props.experimentId);
  const { onToggle } = props;

  const handleToggle = useCallback(
    (value: boolean) => {
      setEnabled(value);
      onToggle?.(value);
    },
    [setEnabled, onToggle]
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

export function ExperimentsSection() {
  const experiments = getExperimentList();
  const { refreshWorkspaceMetadata } = useWorkspaceContext();

  // When post-compaction experiment is toggled, refresh metadata to fetch/clear bundled state
  const handlePostCompactionToggle = useCallback(() => {
    void refreshWorkspaceMetadata();
  }, [refreshWorkspaceMetadata]);

  return (
    <div className="space-y-2">
      <p className="text-muted mb-4 text-xs">
        Experimental features that are still in development. Enable at your own risk.
      </p>
      <div className="divide-border-light divide-y">
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
