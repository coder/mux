import { describe, expect, test } from "bun:test";
import { EXPERIMENTS, EXPERIMENT_IDS, getExperimentList } from "./experiments";

describe("experiments registry", () => {
  test("keeps multi-project workspaces visible in Settings while remaining opt-in", () => {
    const experiment = EXPERIMENTS[EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES];

    expect(experiment.enabledByDefault).toBe(false);
    expect(experiment.userOverridable).toBe(true);
    expect(experiment.showInSettings).toBe(true);
  });

  test("includes the multi-project workspaces experiment in the Settings-visible list", () => {
    const experiment = getExperimentList().find(
      (candidate) => candidate.id === EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES
    );

    if (!experiment) {
      throw new Error("Expected multi-project workspaces experiment to be registered");
    }

    expect(experiment.showInSettings !== false && experiment.userOverridable === true).toBe(true);
  });

  test("keeps portable desktop visible in Settings while remaining opt-in", () => {
    const experiment = EXPERIMENTS[EXPERIMENT_IDS.PORTABLE_DESKTOP];

    expect(experiment.enabledByDefault).toBe(false);
    expect(experiment.userOverridable).toBe(true);
    expect(experiment.showInSettings).toBe(true);
  });
});
