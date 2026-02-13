import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";

import { StreamingBarrierView } from "./StreamingBarrierView";

describe("StreamingBarrierView", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("renders cancel hint as a button when onCancel is provided", () => {
    const onCancel = mock(() => undefined);

    const view = render(
      <StreamingBarrierView
        statusText="streaming..."
        cancelText="hit Esc to cancel"
        onCancel={onCancel}
      />
    );

    fireEvent.click(view.getByRole("button", { name: "Interrupt streaming" }));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test("renders cancel hint as plain text when onCancel is omitted", () => {
    const view = render(
      <StreamingBarrierView statusText="streaming..." cancelText="hit Esc to cancel" />
    );

    expect(view.getByText("hit Esc to cancel")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Interrupt streaming" })).toBeNull();
  });
});
