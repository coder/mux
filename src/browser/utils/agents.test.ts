import { describe, expect, test } from "bun:test";
import { sortAgentsStable } from "./agents";

describe("sortAgentsStable", () => {
  test("sorts built-in agents in stable order", () => {
    const agents = [
      { id: "plan", name: "Plan" },
      { id: "exec", name: "Exec" },
    ];

    const sorted = sortAgentsStable(agents);
    expect(sorted.map((a) => a.id)).toEqual(["exec", "plan"]);
  });

  test("places custom agents after built-ins, sorted alphabetically", () => {
    const agents = [
      { id: "zebra", name: "Zebra Agent" },
      { id: "plan", name: "Plan" },
      { id: "alpha", name: "Alpha Agent" },
      { id: "exec", name: "Exec" },
    ];

    const sorted = sortAgentsStable(agents);
    expect(sorted.map((a) => a.id)).toEqual(["exec", "plan", "alpha", "zebra"]);
  });

  test("handles only custom agents", () => {
    const agents = [
      { id: "beta", name: "Beta" },
      { id: "alpha", name: "Alpha" },
    ];

    const sorted = sortAgentsStable(agents);
    expect(sorted.map((a) => a.id)).toEqual(["alpha", "beta"]);
  });

  test("does not mutate the original array", () => {
    const agents = [
      { id: "plan", name: "Plan" },
      { id: "exec", name: "Exec" },
    ];
    const original = [...agents];

    sortAgentsStable(agents);
    expect(agents).toEqual(original);
  });
});
