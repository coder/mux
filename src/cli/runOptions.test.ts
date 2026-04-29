import { describe, expect, test } from "bun:test";

import { EXPERIMENT_IDS } from "@/common/constants/experiments";

import { buildExperimentsObject } from "./runOptions";

describe("buildExperimentsObject", () => {
  test("returns undefined when no CLI experiments are enabled", () => {
    expect(buildExperimentsObject([])).toBeUndefined();
  });

  test("maps lsp-query into request-scoped send options", () => {
    expect(buildExperimentsObject([EXPERIMENT_IDS.LSP_QUERY])).toEqual({
      programmaticToolCalling: false,
      programmaticToolCallingExclusive: false,
      system1: false,
      lspQuery: true,
      execSubagentHardRestart: false,
    });
  });
});
