import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { MessageListProvider } from "./MessageListContext";
import { markdownComponents } from "./MarkdownComponents";

interface HighlightRequest {
  code: string;
  language: string;
  theme: string;
  resolve: (html: string) => void;
  reject: (error: Error) => void;
}

const highlightRequests: HighlightRequest[] = [];

void mock.module("@/browser/utils/highlighting/highlightWorkerClient", () => ({
  highlightCode: (code: string, language: string, theme: string) =>
    new Promise<string>((resolve, reject) => {
      highlightRequests.push({ code, language, theme, resolve, reject });
    }),
}));

void mock.module("@/browser/utils/highlighting/shiki-shared", () => ({
  extractShikiLines: (html: string) => html.split("\n"),
}));

describe("MarkdownComponents command code blocks", () => {
  beforeEach(() => {
    highlightRequests.length = 0;
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();

    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("shows a Run button for bash blocks when terminal is available", () => {
    const openTerminal = mock(() => undefined);

    const element = markdownComponents.code({
      inline: false,
      className: "language-bash",
      children: "$ npm install\n",
    });

    const { getByRole } = render(
      <ThemeProvider forcedTheme="dark">
        <MessageListProvider
          value={{
            workspaceId: "ws-1",
            latestMessageId: null,
            openTerminal,
          }}
        >
          {element}
        </MessageListProvider>
      </ThemeProvider>
    );

    const runButton = getByRole("button", { name: "Run command" });
    fireEvent.click(runButton);

    expect(openTerminal).toHaveBeenCalledWith({ initialCommand: "npm install" });
  });

  test("strips PowerShell prompts", () => {
    const openTerminal = mock(() => undefined);

    const element = markdownComponents.code({
      inline: false,
      className: "language-powershell",
      children: "PS C:\\Users\\mike> npm install mux\n",
    });

    const { getByRole } = render(
      <ThemeProvider forcedTheme="dark">
        <MessageListProvider
          value={{
            workspaceId: "ws-1",
            latestMessageId: null,
            openTerminal,
          }}
        >
          {element}
        </MessageListProvider>
      </ThemeProvider>
    );

    const runButton = getByRole("button", { name: "Run command" });
    fireEvent.click(runButton);

    expect(openTerminal).toHaveBeenCalledWith({
      initialCommand: "npm install mux",
    });
  });

  test("strips cmd.exe prompts", () => {
    const openTerminal = mock(() => undefined);

    const element = markdownComponents.code({
      inline: false,
      className: "language-cmd",
      children: "C:\\Users\\mike> dir\n",
    });

    const { getByRole } = render(
      <ThemeProvider forcedTheme="dark">
        <MessageListProvider
          value={{
            workspaceId: "ws-1",
            latestMessageId: null,
            openTerminal,
          }}
        >
          {element}
        </MessageListProvider>
      </ThemeProvider>
    );

    const runButton = getByRole("button", { name: "Run command" });
    fireEvent.click(runButton);

    expect(openTerminal).toHaveBeenCalledWith({
      initialCommand: "dir",
    });
  });

  test("strips cmd.exe continuation prompts", () => {
    const openTerminal = mock(() => undefined);

    const element = markdownComponents.code({
      inline: false,
      className: "language-cmd",
      children: "C:\\> echo foo ^\n>bar\n",
    });

    const { getByRole } = render(
      <ThemeProvider forcedTheme="dark">
        <MessageListProvider
          value={{
            workspaceId: "ws-1",
            latestMessageId: null,
            openTerminal,
          }}
        >
          {element}
        </MessageListProvider>
      </ThemeProvider>
    );

    const runButton = getByRole("button", { name: "Run command" });
    fireEvent.click(runButton);

    expect(openTerminal).toHaveBeenCalledWith({
      initialCommand: "echo foo ^\nbar",
    });
  });
  test("strips multiline continuation prompts after a $ shell prompt", () => {
    const openTerminal = mock(() => undefined);

    const element = markdownComponents.code({
      inline: false,
      className: "language-bash",
      children: "$ cat <<EOF\n> line 1\n> EOF\n",
    });

    const { getByRole } = render(
      <ThemeProvider forcedTheme="dark">
        <MessageListProvider
          value={{
            workspaceId: "ws-1",
            latestMessageId: null,
            openTerminal,
          }}
        >
          {element}
        </MessageListProvider>
      </ThemeProvider>
    );

    const runButton = getByRole("button", { name: "Run command" });
    fireEvent.click(runButton);

    expect(openTerminal).toHaveBeenCalledWith({
      initialCommand: "cat <<EOF\nline 1\nEOF",
    });
  });

  test("does not show Run button for shell-session transcripts", () => {
    const openTerminal = mock(() => undefined);

    const element = markdownComponents.code({
      inline: false,
      className: "language-shell-session",
      children: "$ echo hello\nhello\n",
    });

    const { queryByRole } = render(
      <ThemeProvider forcedTheme="dark">
        <MessageListProvider
          value={{
            workspaceId: "ws-1",
            latestMessageId: null,
            openTerminal,
          }}
        >
          {element}
        </MessageListProvider>
      </ThemeProvider>
    );

    expect(queryByRole("button", { name: "Run command" })).toBeNull();
  });

  test("does not show Run button for non-shell languages", () => {
    const openTerminal = mock(() => undefined);

    const element = markdownComponents.code({
      inline: false,
      className: "language-typescript",
      children: "console.log('hello')\n",
    });

    const { queryByRole } = render(
      <ThemeProvider forcedTheme="dark">
        <MessageListProvider
          value={{
            workspaceId: "ws-1",
            latestMessageId: null,
            openTerminal,
          }}
        >
          {element}
        </MessageListProvider>
      </ThemeProvider>
    );

    expect(queryByRole("button", { name: "Run command" })).toBeNull();
  });

  test("renders current plain code immediately while a new highlight is pending", async () => {
    const firstElement = markdownComponents.code({
      inline: false,
      className: "language-typescript",
      children: "const oldValue = 1;\n",
    });

    const view = render(<ThemeProvider forcedTheme="dark">{firstElement}</ThemeProvider>);

    await waitFor(() => expect(highlightRequests).toHaveLength(1));
    act(() => {
      highlightRequests[0].resolve("<span>highlighted old value</span>");
    });
    await waitFor(() => expect(view.container.textContent).toContain("highlighted old value"));

    const nextElement = markdownComponents.code({
      inline: false,
      className: "language-typescript",
      children: "const nextValue = 2;\nconsole.log(nextValue);\n",
    });
    view.rerender(<ThemeProvider forcedTheme="dark">{nextElement}</ThemeProvider>);

    // The previous Shiki result has a different code key, so the same commit that
    // receives the new streaming chunk falls back to current plain text instead of
    // showing stale highlighted content/height until the highlighter effect clears.
    expect(view.container.textContent).not.toContain("highlighted old value");
    expect(view.container.textContent).toContain("const nextValue = 2;");
    expect(view.container.textContent).toContain("console.log(nextValue);");
    expect(view.container.querySelectorAll(".line-number")).toHaveLength(2);
  });
});

describe("MarkdownComponents anchors", () => {
  beforeEach(() => {
    highlightRequests.length = 0;
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();

    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("rewrites loopback hrefs when proxy template is configured", () => {
    window.location.href = "https://coder.example.com/@u/ws/apps/mux/";
    (window as Window & { __MUX_PROXY_URI_TEMPLATE__?: string }).__MUX_PROXY_URI_TEMPLATE__ =
      "https://proxy-{{port}}.{{host}}";

    const element = markdownComponents.a({
      href: "http://127.0.0.1:5173/docs?x=1#details",
      children: "Open local docs",
    });

    const { getByRole } = render(element);
    const link = getByRole("link", { name: "Open local docs" });

    expect(link.getAttribute("href")).toBe("https://proxy-5173.coder.example.com/docs?x=1#details");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  test("derives coder-style template from current host when injected template is missing", () => {
    window.location.href =
      "https://5173--dev--pog2--ethan--apps.sydney.fly.dev.coder.com/workspace/f5a5ed5f7e";
    (window as Window & { __MUX_PROXY_URI_TEMPLATE__?: string }).__MUX_PROXY_URI_TEMPLATE__ =
      undefined;

    const element = markdownComponents.a({
      href: "http://127.0.0.1:8080/api/health?x=1#ok",
      children: "Open forwarded health",
    });

    const { getByRole } = render(element);
    const link = getByRole("link", { name: "Open forwarded health" });

    expect(link.getAttribute("href")).toBe(
      "https://8080--dev--pog2--ethan--apps.sydney.fly.dev.coder.com/api/health?x=1#ok"
    );
  });

  test("keeps non-loopback hrefs unchanged", () => {
    window.location.href = "https://coder.example.com/@u/ws/apps/mux/";
    (window as Window & { __MUX_PROXY_URI_TEMPLATE__?: string }).__MUX_PROXY_URI_TEMPLATE__ =
      "https://proxy-{{port}}.{{host}}";

    const element = markdownComponents.a({
      href: "https://example.com/docs?x=1#details",
      children: "Open external docs",
    });

    const { getByRole } = render(element);
    const link = getByRole("link", { name: "Open external docs" });

    expect(link.getAttribute("href")).toBe("https://example.com/docs?x=1#details");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  test("keeps undefined href behavior unchanged", () => {
    const element = markdownComponents.a({
      href: undefined,
      children: "Missing href",
    });

    const { container } = render(element);
    const link = container.querySelector("a");

    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBeNull();
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });
});
