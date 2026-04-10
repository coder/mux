import React from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import * as ActualSelectPrimitiveModule from "@/browser/components/SelectPrimitive/SelectPrimitive";
import { DEFAULT_TASK_SETTINGS, type TaskSettings } from "@/common/types/tasks";
import { installDom } from "../../../../../tests/ui/dom";

interface MockConfig {
  taskSettings: TaskSettings;
  advisorModelString: string | null;
  advisorMaxUsesPerTurn: number | null;
}

interface SaveConfigInput {
  taskSettings: TaskSettings;
  advisorModelString?: string | null;
  advisorMaxUsesPerTurn?: number | null;
}

interface MockAPIClient {
  config: {
    getConfig: () => Promise<MockConfig>;
    saveConfig: (input: SaveConfigInput) => Promise<void>;
  };
}

let mockApi: MockAPIClient;

void mock.module("@/browser/components/SelectPrimitive/SelectPrimitive", () => {
  const SelectContext = React.createContext<{
    value?: string;
    disabled?: boolean;
    open: boolean;
    options: Map<string, React.ReactNode>;
    onValueChange?: (value: string) => void;
    setOpen: (open: boolean) => void;
  } | null>(null);

  function collectOptions(children: React.ReactNode, options = new Map<string, React.ReactNode>()) {
    React.Children.forEach(children, (child) => {
      if (!React.isValidElement<{ value?: string; children?: React.ReactNode }>(child)) {
        return;
      }

      if (typeof child.props.value === "string") {
        options.set(child.props.value, child.props.children);
      }

      if (child.props.children) {
        collectOptions(child.props.children, options);
      }
    });

    return options;
  }

  function Select(props: {
    value?: string;
    disabled?: boolean;
    onValueChange?: (value: string) => void;
    children: React.ReactNode;
  }) {
    const [open, setOpen] = React.useState(false);
    const options = React.useMemo(() => collectOptions(props.children), [props.children]);
    return (
      <SelectContext.Provider
        value={{
          value: props.value,
          disabled: props.disabled,
          open,
          options,
          onValueChange: props.onValueChange,
          setOpen,
        }}
      >
        {props.children}
      </SelectContext.Provider>
    );
  }

  const SelectTrigger = React.forwardRef<
    HTMLButtonElement,
    React.ComponentPropsWithoutRef<"button">
  >((props, ref) => {
    const context = React.useContext(SelectContext);
    return (
      <button
        {...props}
        ref={ref}
        type="button"
        role="combobox"
        disabled={context?.disabled}
        aria-expanded={context?.open ?? false}
        onPointerDown={(event) => {
          props.onPointerDown?.(event);
          if (!context?.disabled) {
            context?.setOpen(true);
          }
        }}
      >
        {props.children}
      </button>
    );
  });
  SelectTrigger.displayName = "MockSelectTrigger";

  function SelectValue() {
    const context = React.useContext(SelectContext);
    return <span>{context?.options.get(context?.value ?? "") ?? context?.value ?? ""}</span>;
  }

  function SelectContent(props: { children: React.ReactNode }) {
    const context = React.useContext(SelectContext);
    return context?.open ? <div>{props.children}</div> : null;
  }

  function SelectItem(props: { value: string; children: React.ReactNode }) {
    const context = React.useContext(SelectContext);
    return (
      <button
        type="button"
        onClick={() => {
          context?.onValueChange?.(props.value);
          context?.setOpen(false);
        }}
      >
        {props.children}
      </button>
    );
  }

  return {
    Select,
    SelectTrigger,
    SelectValue,
    SelectContent,
    SelectItem,
  };
});

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: mockApi,
    status: "connected" as const,
    error: null,
    authenticate: () => undefined,
    retry: () => undefined,
  }),
}));

void mock.module("@/browser/hooks/useModelsFromSettings", () => ({
  useModelsFromSettings: () => ({
    models: ["openai:gpt-4o", "anthropic:claude-sonnet-4-5"],
    hiddenModelsForSelector: ["hidden:model"],
  }),
}));

void mock.module("@/browser/components/ModelSelector/ModelSelector", () => ({
  ModelSelector: (props: {
    value: string;
    onChange: (value: string) => void;
    models: string[];
    emptyLabel?: string;
  }) => (
    <button
      type="button"
      aria-label="Advisor model selector"
      onClick={() => props.onChange(props.models[0] ?? "")}
    >
      {props.value !== "" ? props.value : (props.emptyLabel ?? "Select model")}
    </button>
  ),
}));

import { AdvisorSection } from "./AdvisorSection";

function createMockAPI(configOverrides: Partial<MockConfig> = {}) {
  const config: MockConfig = {
    taskSettings: DEFAULT_TASK_SETTINGS,
    advisorModelString: null,
    advisorMaxUsesPerTurn: null,
    ...configOverrides,
  };

  const getConfigMock = mock(() =>
    Promise.resolve({
      taskSettings: config.taskSettings,
      advisorModelString: config.advisorModelString,
      advisorMaxUsesPerTurn: config.advisorMaxUsesPerTurn,
    })
  );

  const saveConfigMock = mock((input: SaveConfigInput) => {
    config.taskSettings = input.taskSettings;
    config.advisorModelString = input.advisorModelString?.trim()
      ? input.advisorModelString.trim()
      : null;
    config.advisorMaxUsesPerTurn = input.advisorMaxUsesPerTurn ?? null;
    return Promise.resolve();
  });

  return {
    api: {
      config: {
        getConfig: getConfigMock,
        saveConfig: saveConfigMock,
      },
    },
    getConfigMock,
    saveConfigMock,
  };
}

describe("AdvisorSection", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    void mock.module(
      "@/browser/components/SelectPrimitive/SelectPrimitive",
      () => ActualSelectPrimitiveModule
    );
    cleanupDom?.();
    cleanupDom = null;
  });

  function renderAdvisorSection(configOverrides: Partial<MockConfig> = {}) {
    const { api, saveConfigMock } = createMockAPI(configOverrides);
    mockApi = api;

    const view = render(
      <ThemeProvider forcedTheme="dark">
        <AdvisorSection />
      </ThemeProvider>
    );

    return { view, saveConfigMock };
  }

  function getSelectTrigger(view: ReturnType<typeof render>, label: string): HTMLElement {
    const labelElement = view.getByText(label);
    let container: HTMLElement | null = labelElement.parentElement;

    while (container && !container.querySelector('[role="combobox"]')) {
      container = container.parentElement;
    }

    const trigger = container?.querySelector('[role="combobox"]');
    if (!(trigger instanceof window.HTMLElement)) {
      throw new Error(`Could not find select trigger for ${label}`);
    }

    return trigger;
  }

  function chooseSelectOption(view: ReturnType<typeof render>, label: string, optionText: string) {
    const trigger = getSelectTrigger(view, label);
    fireEvent.pointerDown(trigger);
    fireEvent.click(view.getByText(optionText));
  }

  test("seeds limited mode with 3 when switching from unlimited", async () => {
    const { view, saveConfigMock } = renderAdvisorSection();

    await waitFor(() => {
      expect(view.getByText("Advisor Defaults")).toBeDefined();
    });

    chooseSelectOption(view, "Max Uses / Turn", "Limited");

    const limitInput = (await waitFor(() =>
      view.getByLabelText("Advisor max uses per turn")
    )) as HTMLInputElement;

    expect(limitInput.value).toBe("3");

    await waitFor(() => {
      expect(saveConfigMock.mock.calls.at(-1)?.[0]).toEqual({
        taskSettings: DEFAULT_TASK_SETTINGS,
        advisorModelString: null,
        advisorMaxUsesPerTurn: 3,
      });
    });
  });

  test("restores the existing limit after toggling back from unlimited", async () => {
    const { view, saveConfigMock } = renderAdvisorSection({ advisorMaxUsesPerTurn: 5 });

    const limitInput = (await waitFor(() =>
      view.getByLabelText("Advisor max uses per turn")
    )) as HTMLInputElement;

    expect(limitInput.value).toBe("5");

    chooseSelectOption(view, "Max Uses / Turn", "Unlimited");

    await waitFor(() => {
      expect(saveConfigMock.mock.calls.at(-1)?.[0]).toEqual({
        taskSettings: DEFAULT_TASK_SETTINGS,
        advisorModelString: null,
        advisorMaxUsesPerTurn: null,
      });
    });

    chooseSelectOption(view, "Max Uses / Turn", "Limited");

    const restoredInput = (await waitFor(() =>
      view.getByLabelText("Advisor max uses per turn")
    )) as HTMLInputElement;

    expect(restoredInput.value).toBe("5");
  });
});
