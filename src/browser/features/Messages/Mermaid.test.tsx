import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { StreamingContext } from "./StreamingContext";
import { Mermaid } from "./Mermaid";

const DEFAULT_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" /></svg>';

const mermaidInitialize = mock(() => undefined);
const mermaidParse = mock((_chart: string) => Promise.resolve());
const mermaidRender = mock((_id: string, _chart: string) => Promise.resolve({ svg: DEFAULT_SVG }));

void mock.module("mermaid", () => ({
  default: {
    initialize: mermaidInitialize,
    parse: (chart: string) => mermaidParse(chart),
    render: (id: string, chart: string) => mermaidRender(id, chart),
  },
}));

function renderMermaid(props: { chart?: string; isStreaming?: boolean } = {}) {
  return render(
    <StreamingContext.Provider value={{ isStreaming: props.isStreaming ?? false }}>
      <Mermaid chart={props.chart ?? "graph TD\nA-->B"} />
    </StreamingContext.Provider>
  );
}

describe("Mermaid layout stability", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;
  let originalDOMParser: typeof globalThis.DOMParser;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalDOMParser = globalThis.DOMParser;

    const domWindow = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.window = domWindow;
    globalThis.document = domWindow.document;
    globalThis.DOMParser = domWindow.DOMParser;

    mermaidParse.mockImplementation(() => Promise.resolve());
    mermaidRender.mockImplementation(() => Promise.resolve({ svg: DEFAULT_SVG }));
  });

  afterEach(() => {
    cleanup();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.DOMParser = originalDOMParser;
    mermaidParse.mockClear();
    mermaidRender.mockClear();
  });

  test("reserves diagram height while a streaming diagram is still rendering", () => {
    mermaidParse.mockImplementation(
      () =>
        new Promise<never>((resolve) => {
          void resolve;
        })
    );

    const view = renderMermaid({ isStreaming: true });

    const container = view.container.querySelector<HTMLElement>(".mermaid-container");
    expect(container).not.toBeNull();
    expect(container?.style.minHeight).toBe("300px");
    expect(container?.textContent).toBe("Rendering diagram...");
  });

  test("keeps the stable diagram frame for streaming parse errors", async () => {
    mermaidParse.mockImplementation(() => Promise.reject(new Error("diagram is incomplete")));

    const view = renderMermaid({ isStreaming: true });

    await waitFor(() => expect(mermaidParse).toHaveBeenCalled());
    const container = view.container.querySelector<HTMLElement>(".mermaid-container");
    expect(container).not.toBeNull();
    expect(container?.style.minHeight).toBe("300px");
    expect(view.container.textContent).toContain("Rendering diagram...");
    expect(view.container.textContent).not.toContain("Mermaid Error");
  });

  test("shows parse errors after streaming settles", async () => {
    mermaidParse.mockImplementation(() => Promise.reject(new Error("bad diagram")));

    const view = renderMermaid({ isStreaming: false });

    await waitFor(() => expect(view.container.textContent).toContain("Mermaid Error: bad diagram"));
    expect(view.container.querySelector(".mermaid-container")).toBeNull();
  });

  test("renders sanitized SVG inside the stable container", async () => {
    mermaidRender.mockImplementation(() =>
      Promise.resolve({
        svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script><rect width="10" height="10" /></svg>',
      })
    );

    const view = renderMermaid();

    await waitFor(() => {
      const svg = view.container.querySelector(".mermaid-container svg");
      expect(svg).not.toBeNull();
    });
    expect(view.container.querySelector("script")).toBeNull();
  });
});
