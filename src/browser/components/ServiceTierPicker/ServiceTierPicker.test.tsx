import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";

import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { getServiceTierKey } from "@/common/constants/storage";
import { ServiceTierPicker } from "./ServiceTierPicker";

const OPENAI_MODEL = "openai:gpt-5.5";
const ANTHROPIC_MODEL = "anthropic:claude-haiku-4-5";
const SCOPE = "ws-service-tier-test";

let cleanupDom: (() => void) | null = null;

function renderPicker(modelString: string) {
  return render(
    <TooltipProvider>
      <ServiceTierPicker modelString={modelString} scopeId={SCOPE} />
    </TooltipProvider>
  );
}

describe("ServiceTierPicker", () => {
  beforeEach(() => {
    cleanupDom = installDom();
    globalThis.window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("renders nothing for models without service-tier support", () => {
    const { queryByTestId } = renderPicker(ANTHROPIC_MODEL);
    expect(queryByTestId("service-tier-trigger")).toBeNull();
  });

  test("shows the neutral (default) state for a supported model with no override", () => {
    const { getByTestId } = renderPicker(OPENAI_MODEL);
    const trigger = getByTestId("service-tier-trigger");
    expect(trigger.getAttribute("data-service-tier")).toBe("default");
  });

  test("opens a menu and applies the Fast override", async () => {
    const { getByTestId, queryByTestId, getAllByTestId } = renderPicker(OPENAI_MODEL);

    // Menu is closed initially.
    expect(queryByTestId("service-tier-option")).toBeNull();

    fireEvent.click(getByTestId("service-tier-trigger"));

    await waitFor(() => {
      expect(getAllByTestId("service-tier-option").length).toBe(3);
    });

    const fast = getAllByTestId("service-tier-option").find(
      (el) => el.getAttribute("data-speed") === "fast"
    );
    expect(fast).toBeTruthy();
    fireEvent.click(fast!);

    await waitFor(() => {
      expect(getByTestId("service-tier-trigger").getAttribute("data-service-tier")).toBe("fast");
    });

    // Override is persisted under the scoped key as the provider wire value.
    expect(globalThis.window.localStorage.getItem(getServiceTierKey(SCOPE))).toBe(
      JSON.stringify("priority")
    );
    // Menu closes after selection.
    expect(queryByTestId("service-tier-option")).toBeNull();
  });

  test("applies the Slow override", async () => {
    const { getByTestId, getAllByTestId } = renderPicker(OPENAI_MODEL);
    fireEvent.click(getByTestId("service-tier-trigger"));

    await waitFor(() => expect(getAllByTestId("service-tier-option").length).toBe(3));
    const slow = getAllByTestId("service-tier-option").find(
      (el) => el.getAttribute("data-speed") === "slow"
    );
    fireEvent.click(slow!);

    await waitFor(() => {
      expect(getByTestId("service-tier-trigger").getAttribute("data-service-tier")).toBe("slow");
    });
    expect(globalThis.window.localStorage.getItem(getServiceTierKey(SCOPE))).toBe(
      JSON.stringify("flex")
    );
  });

  test("selecting Auto clears an existing override", async () => {
    // Seed an existing Fast override.
    globalThis.window.localStorage.setItem(getServiceTierKey(SCOPE), JSON.stringify("priority"));

    const { getByTestId, getAllByTestId } = renderPicker(OPENAI_MODEL);
    expect(getByTestId("service-tier-trigger").getAttribute("data-service-tier")).toBe("fast");

    fireEvent.click(getByTestId("service-tier-trigger"));
    await waitFor(() => expect(getAllByTestId("service-tier-option").length).toBe(3));
    const auto = getAllByTestId("service-tier-option").find(
      (el) => el.getAttribute("data-speed") === "default"
    );
    fireEvent.click(auto!);

    await waitFor(() => {
      expect(getByTestId("service-tier-trigger").getAttribute("data-service-tier")).toBe("default");
    });
    // Auto clears the override entirely (key removed), so the provider/global default applies.
    expect(globalThis.window.localStorage.getItem(getServiceTierKey(SCOPE))).toBeNull();
  });
});
