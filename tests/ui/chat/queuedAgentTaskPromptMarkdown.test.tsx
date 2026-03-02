import "../dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { MarkdownRenderer } from "@/browser/features/Messages/MarkdownRenderer";
import { installDom } from "../dom";

describe("Queued agent task prompt markdown rendering", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("renders markdown list items instead of raw syntax", () => {
    const view = render(
      <MarkdownRenderer
        content={"- First item\n- Second item\n- Third item"}
        className="user-message-markdown"
        preserveLineBreaks
      />
    );

    const listItems = view.container.querySelectorAll("li");
    expect(listItems.length).toBe(3);
    expect(listItems[0].textContent).toBe("First item");
    expect(listItems[1].textContent).toBe("Second item");
  });

  test("renders fenced code blocks as pre/code elements", () => {
    const view = render(
      <MarkdownRenderer
        content={"```\nconst x = 1;\n```"}
        className="user-message-markdown"
        preserveLineBreaks
      />
    );

    const preElement = view.container.querySelector("pre");
    const codeElement = view.container.querySelector("code");
    expect(preElement).toBeTruthy();
    expect(codeElement).toBeTruthy();
    expect(codeElement!.textContent).toContain("const x = 1;");
  });

  test("renders markdown links as anchor elements", () => {
    const view = render(
      <MarkdownRenderer
        content={"Check [this link](https://example.com) for details"}
        className="user-message-markdown"
        preserveLineBreaks
      />
    );

    const anchor = view.container.querySelector("a");
    expect(anchor).toBeTruthy();
    expect(anchor!.getAttribute("href")).toBe("https://example.com/");
    expect(anchor!.textContent).toBe("this link");
  });

  test("renders inline code with code element", () => {
    const view = render(
      <MarkdownRenderer
        content={"Run `make test` to verify"}
        className="user-message-markdown"
        preserveLineBreaks
      />
    );

    const codeElement = view.container.querySelector("code");
    expect(codeElement).toBeTruthy();
    expect(codeElement!.textContent).toBe("make test");
  });
});
