import { cleanup, render, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { installDom } from "../../../../../tests/ui/dom";

let apiMock: {
  config: {
    getConfig: ReturnType<typeof mock>;
    updateModelClasses: ReturnType<typeof mock>;
    onConfigChanged: ReturnType<typeof mock>;
  };
} | null = null;

/** Providers map for the availability warning; null = still loading (warning suppressed). */
let providersConfigMock: Record<string, { isConfigured: boolean; isEnabled?: boolean }> | null =
  null;

void mock.module("@/browser/contexts/API", () => ({
  useOptionalAPI: () => (apiMock ? { api: apiMock } : null),
  // useRouting (imported by the editor) reads the API through useAPI.
  useAPI: () => ({ api: apiMock }),
}));

void mock.module("@/browser/hooks/useProvidersConfig", () => ({
  useProvidersConfig: () => ({ config: providersConfigMock, loading: providersConfigMock == null }),
}));

void mock.module("@/browser/hooks/useModelsFromSettings", () => ({
  useModelsFromSettings: () => ({
    models: ["anthropic:claude-haiku-4-5", "anthropic:claude-sonnet-5", "anthropic:claude-fable-5"],
    hiddenModelsForSelector: [],
  }),
}));

import { ModelClassesEditor } from "./ModelClassesEditor";

function createApiMock(modelClasses: Record<string, string>) {
  return {
    config: {
      getConfig: mock(() => Promise.resolve({ modelClasses })),
      updateModelClasses: mock(() => Promise.resolve(undefined)),
      onConfigChanged: mock((_input: undefined, _opts: { signal?: AbortSignal }) =>
        Promise.resolve(
          (async function* (): AsyncGenerator<void> {
            // Subscription that ends immediately: the hook's initial fetch has
            // already run; these tests drive state via direct interactions.
            await Promise.resolve();
            yield* [] as void[];
          })()
        )
      ),
    },
  };
}

describe("ModelClassesEditor", () => {
  let restoreDom: (() => void) | null = null;

  beforeEach(() => {
    restoreDom = installDom();
  });

  afterEach(() => {
    cleanup();
    restoreDom?.();
    restoreDom = null;
    apiMock = null;
    providersConfigMock = null;
  });

  test("renders the three canonical class rows; clear button only on configured classes", async () => {
    apiMock = createApiMock({ small: "anthropic:claude-haiku-4-5+0" });
    // Row presence is asserted via the labeled row groups, not the select
    // triggers: other suites in the same process (TasksSection) mock
    // SelectPrimitive with native elements, and bun's mock.module leaks across
    // test files, so select internals are not stable to assert on.
    const { getByRole, queryByLabelText } = render(<ModelClassesEditor />);

    await waitFor(() => {
      expect(apiMock?.config.getConfig).toHaveBeenCalled();
      expect(queryByLabelText("Clear model class small")).not.toBeNull();
    });

    for (const name of ["large", "medium", "small"]) {
      expect(getByRole("group", { name: `Model class ${name}` })).toBeTruthy();
    }
    // Unset classes have nothing to clear.
    expect(queryByLabelText("Clear model class large")).toBeNull();
    expect(queryByLabelText("Clear model class medium")).toBeNull();
  });

  test("clearing a canonical class preserves hand-edited custom classes in the write", async () => {
    apiMock = createApiMock({
      small: "anthropic:claude-haiku-4-5+0",
      "my-custom": "anthropic:claude-fable-5+max",
    });
    const { getByLabelText, queryByLabelText } = render(<ModelClassesEditor />);

    await waitFor(() => expect(queryByLabelText("Clear model class small")).not.toBeNull());
    fireEvent.click(getByLabelText("Clear model class small"));

    await waitFor(() => expect(apiMock?.config.updateModelClasses).toHaveBeenCalled());
    expect(apiMock?.config.updateModelClasses).toHaveBeenCalledWith({
      modelClasses: { "my-custom": "anthropic:claude-fable-5+max" },
    });
  });

  test("edits preserve custom classes this build cannot parse", async () => {
    // "my-local-llm" has no provider prefix, so parseModelClassValue rejects
    // it — the write must still carry it verbatim rather than deleting the
    // user's hand-edited entry as a side effect of clearing another row.
    apiMock = createApiMock({
      small: "anthropic:claude-haiku-4-5+0",
      tiny: "my-local-llm",
    });
    const { getByLabelText, queryByLabelText } = render(<ModelClassesEditor />);

    await waitFor(() => expect(queryByLabelText("Clear model class small")).not.toBeNull());
    fireEvent.click(getByLabelText("Clear model class small"));

    await waitFor(() => expect(apiMock?.config.updateModelClasses).toHaveBeenCalled());
    expect(apiMock?.config.updateModelClasses).toHaveBeenCalledWith({
      modelClasses: { tiny: "my-local-llm" },
    });
  });

  test("lists custom classes as config-managed instead of hiding them", async () => {
    apiMock = createApiMock({ "my-custom": "anthropic:claude-fable-5+max" });
    const { findByText } = render(<ModelClassesEditor />);

    expect(await findByText(/my-custom → anthropic:claude-fable-5\+max/)).toBeTruthy();
  });

  test("flags an unparseable configured value instead of silently dropping it", async () => {
    apiMock = createApiMock({ small: "garbage" });
    const { findByText } = render(<ModelClassesEditor />);

    expect(await findByText(/invalid value: garbage/)).toBeTruthy();
  });

  test("warns when no configured route can serve a class model", async () => {
    apiMock = createApiMock({ small: "anthropic:claude-haiku-4-5+0" });
    providersConfigMock = { anthropic: { isConfigured: false } };
    const { findByText } = render(<ModelClassesEditor />);

    expect(await findByText(/no configured route can serve this model/)).toBeTruthy();
  });

  test("does not warn when the class model has a configured route", async () => {
    apiMock = createApiMock({ small: "anthropic:claude-haiku-4-5+0" });
    providersConfigMock = { anthropic: { isConfigured: true, isEnabled: true } };
    const { queryByText, queryByLabelText } = render(<ModelClassesEditor />);

    await waitFor(() => expect(queryByLabelText("Clear model class small")).not.toBeNull());
    expect(queryByText(/no configured route can serve this model/)).toBeNull();
  });
});
