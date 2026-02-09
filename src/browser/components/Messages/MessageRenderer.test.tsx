import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import type { DisplayedMessage } from "@/common/types/message";
import { MessageRenderer } from "./MessageRenderer";

describe("MessageRenderer compaction boundary rows", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();

    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("renders start compaction boundary rows", () => {
    const message: DisplayedMessage = {
      type: "compaction-boundary",
      id: "boundary-start",
      historySequence: 10,
      position: "start",
      compactionEpoch: 4,
    };

    const { getByTestId, getByText } = render(<MessageRenderer message={message} />);

    const boundary = getByTestId("compaction-boundary");
    expect(boundary).toBeDefined();
    expect(boundary.getAttribute("role")).toBe("separator");
    expect(boundary.getAttribute("aria-orientation")).toBe("horizontal");
    expect(boundary.getAttribute("aria-label")).toBe("Compaction boundary #4");
    expect(getByText("Compaction boundary #4")).toBeDefined();
  });

  test("renders compaction boundary label for legacy end rows", () => {
    const message: DisplayedMessage = {
      type: "compaction-boundary",
      id: "boundary-end",
      historySequence: 10,
      position: "end",
      compactionEpoch: 4,
    };

    const { getByTestId, getByText } = render(<MessageRenderer message={message} />);

    const boundary = getByTestId("compaction-boundary");
    expect(boundary.getAttribute("aria-label")).toBe("Compaction boundary #4");
    expect(getByText("Compaction boundary #4")).toBeDefined();
  });
});
