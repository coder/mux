import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import { TooltipProvider } from "@radix-ui/react-tooltip";

import { NestedToolRenderer } from "./NestedToolRenderer";

let windowInstance: GlobalWindow | null = null;

beforeEach(() => {
  windowInstance = new GlobalWindow();
  globalThis.window = windowInstance as unknown as Window & typeof globalThis;
  globalThis.document = windowInstance.document as unknown as Document;
});

afterEach(() => {
  cleanup();
  void windowInstance?.happyDOM.abort();
  windowInstance = null;
  delete (globalThis as { window?: Window }).window;
  delete (globalThis as { document?: Document }).document;
});

describe("NestedToolRenderer", () => {
  test("renders hook output for nested tool results", () => {
    const { getByText } = render(
      <TooltipProvider>
        <NestedToolRenderer
          toolName="bash"
          input={{ script: "echo hook" }}
          output={{ success: true, hook_output: "post hook ran", hook_duration_ms: 42 }}
          status="completed"
        />
      </TooltipProvider>
    );

    expect(getByText("hook output")).toBeDefined();
  });
});
