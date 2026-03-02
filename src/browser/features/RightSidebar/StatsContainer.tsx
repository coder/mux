/**
 * StatsContainer — unified "Stats" top-level tab with sub-tabs.
 *
 * Sub-tabs:
 * - "Cost" (always shown) — renders CostsTab
 * - "Timing" (feature-flagged) — renders TimingPanel from StatsTab
 * - "Models" (feature-flagged) — renders ModelBreakdownPanel from StatsTab
 *
 * The "Timing" and "Models" sub-tabs only appear when the `statsTab` feature flag is enabled.
 * If the persisted sub-tab becomes hidden (flag toggled off), falls back to "cost".
 */

import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { useFeatureFlags } from "@/browser/contexts/FeatureFlagsContext";
import { ToggleGroup, type ToggleOption } from "@/browser/components/ToggleGroup/ToggleGroup";
import { CostsTab } from "./CostsTab";
import { TimingPanel, ModelBreakdownPanel } from "./StatsTab";

type StatsSubTab = "cost" | "timing" | "models";

const BASE_OPTIONS: Array<ToggleOption<StatsSubTab>> = [{ value: "cost", label: "Cost" }];

const ALL_OPTIONS: Array<ToggleOption<StatsSubTab>> = [
  { value: "cost", label: "Cost" },
  { value: "timing", label: "Timing" },
  { value: "models", label: "Models" },
];

interface StatsContainerProps {
  workspaceId: string;
}

export function StatsContainer(props: StatsContainerProps) {
  const { statsTabState } = useFeatureFlags();
  const perfEnabled = Boolean(statsTabState?.enabled);

  const options = perfEnabled ? ALL_OPTIONS : BASE_OPTIONS;

  const [subTab, setSubTab] = usePersistedState<StatsSubTab>("statsContainer:subTab", "cost");

  // Fall back to "cost" if the selected sub-tab is hidden (e.g. flag toggled off)
  const effectiveTab = options.some((o) => o.value === subTab) ? subTab : "cost";

  return (
    <div>
      {options.length > 1 && (
        <div className="mb-3">
          <ToggleGroup options={options} value={effectiveTab} onChange={setSubTab} />
        </div>
      )}
      {effectiveTab === "cost" && <CostsTab workspaceId={props.workspaceId} />}
      {effectiveTab === "timing" && <TimingPanel workspaceId={props.workspaceId} />}
      {effectiveTab === "models" && <ModelBreakdownPanel workspaceId={props.workspaceId} />}
    </div>
  );
}
